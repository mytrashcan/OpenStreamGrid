import type { Peer, PeerFailureReport } from "@openstreamgrid/common";
import type { SegmentCache } from "./cache.js";
import type { TrafficStats } from "./stats.js";
import type {
  FetchFunction,
  SegmentIntegrityVerifier,
} from "./verifier.js";
import type { TransportManager } from "./transport-manager.js";

const DEFAULT_P2P_TIMEOUT_MS = 2_000;
const DEFAULT_URGENT_THRESHOLD_SEGMENTS = 2;
const DEFAULT_MAX_PARALLEL_DOWNLOADS = 3;
const MINIMUM_TRUST_SCORE = 0.3;
const METRIC_EMA_ALPHA = 0.3;

const LATENCY_WEIGHT = 0.3;
const SUCCESS_RATE_WEIGHT = 0.3;
const UPLOAD_BANDWIDTH_WEIGHT = 0.2;
const TRUST_SCORE_WEIGHT = 0.2;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

export interface PeerQualityMetrics {
  latencyMs: number;
  successRate: number;
  uploadBandwidthBps: number;
  trustScore: number;
}

export const exponentialMovingAverage = (
  previous: number,
  observed: number,
): number => METRIC_EMA_ALPHA * observed + (1 - METRIC_EMA_ALPHA) * previous;

export const calculatePeerScore = (
  metrics: PeerQualityMetrics,
  maximumUploadBandwidthBps: number,
): number => {
  const latencyScore = 1 - Math.min(Math.max(metrics.latencyMs, 0) / 1_000, 1);
  const successRateScore = clamp(metrics.successRate, 0, 1);
  const uploadBandwidthScore =
    maximumUploadBandwidthBps <= 0
      ? 0
      : clamp(metrics.uploadBandwidthBps / maximumUploadBandwidthBps, 0, 1);
  const trustScore = clamp(metrics.trustScore, 0, 1);
  return (
    LATENCY_WEIGHT * latencyScore +
    SUCCESS_RATE_WEIGHT * successRateScore +
    UPLOAD_BANDWIDTH_WEIGHT * uploadBandwidthScore +
    TRUST_SCORE_WEIGHT * trustScore
  );
};

export interface PeerDirectory {
  listPeers(segmentName: string): Promise<Peer[]>;
  reportFailure(peerId: string, reason: PeerFailureReport["reason"]): Promise<void>;
}

interface FetcherOptions {
  selfPeerId: string;
  originBaseUrl: URL;
  cache: SegmentCache;
  directory: PeerDirectory;
  verifier: SegmentIntegrityVerifier;
  stats: TrafficStats;
  fetchImpl?: FetchFunction;
  p2pTimeoutMs?: number;
  urgentThresholdSegments?: number;
  maxParallel?: number;
  transportManager?: TransportManager;
}

export interface SegmentFetchResult {
  data: Buffer;
  source: "cache" | "p2p" | "origin";
}

class PeerFetchError extends Error {
  constructor(
    message: string,
    readonly reason: PeerFailureReport["reason"],
  ) {
    super(message);
  }
}

export class HybridSegmentFetcher {
  private readonly fetchImpl: FetchFunction;
  private readonly p2pTimeoutMs: number;
  private readonly urgentThresholdSegments: number;
  private readonly maxParallel: number;
  private readonly peerMetrics = new Map<string, PeerQualityMetrics>();
  private readonly inFlightSegments = new Map<
    string,
    { peerId?: string; promise: Promise<SegmentFetchResult> }
  >();
  private readonly lastSources = new Map<
    string,
    SegmentFetchResult["source"]
  >();

  constructor(private readonly options: FetcherOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.p2pTimeoutMs = options.p2pTimeoutMs ?? DEFAULT_P2P_TIMEOUT_MS;
    this.urgentThresholdSegments =
      options.urgentThresholdSegments ?? DEFAULT_URGENT_THRESHOLD_SEGMENTS;
    this.maxParallel = options.maxParallel ?? DEFAULT_MAX_PARALLEL_DOWNLOADS;
    if (!Number.isSafeInteger(this.maxParallel) || this.maxParallel <= 0) {
      throw new Error("Maximum parallel downloads must be a positive integer");
    }
  }

  async fetchSegment(
    segmentName: string,
    segmentsAhead: number,
  ): Promise<SegmentFetchResult> {
    const cached = this.options.cache.get(segmentName);
    if (cached) {
      this.lastSources.set(segmentName, "cache");
      return { data: cached, source: "cache" };
    }

    if (segmentsAhead >= this.urgentThresholdSegments) {
      let peers: Peer[] = [];
      try {
        peers = this.rankPeers(
          await this.options.directory.listPeers(segmentName),
        );
      } catch (error) {
        this.options.stats.recordFallback();
        console.error("peer discovery failed; using origin", error);
      }
      const peer = peers[0];
      if (peer) {
        const startedAt = performance.now();
        try {
          const data = await this.fetchFromPeer(peer, segmentName);
          this.observePeer(peer, performance.now() - startedAt, true, data.byteLength);
          this.cache(segmentName, data);
          this.lastSources.set(segmentName, "p2p");
          return { data, source: "p2p" };
        } catch (error) {
          const failure =
            error instanceof PeerFetchError
              ? error
              : new PeerFetchError("Peer request failed", "connection");
          this.observePeer(
            peer,
            performance.now() - startedAt,
            false,
            0,
            failure.reason,
          );
          this.options.stats.recordP2PFailure();
          this.options.stats.recordFallback();
          void this.options.directory
            .reportFailure(peer.id, failure.reason)
            .catch((reportError: unknown) => {
              console.error("failed to report peer failure", reportError);
            });
        }
      }
    }

    const data = await this.fetchFromOrigin(segmentName);
    this.cache(segmentName, data);
    this.lastSources.set(segmentName, "origin");
    return { data, source: "origin" };
  }

  /**
   * Fetches playlist-ordered segments, prioritizing later (more urgent) entries.
   */
  async fetchSegments(
    segments: string[],
    peers: Peer[],
  ): Promise<Map<string, Buffer>> {
    const prioritizedSegments = [...new Set(segments)].reverse();
    const fetched = new Map<string, Buffer>();
    const failures: unknown[] = [];

    for (
      let offset = 0;
      offset < prioritizedSegments.length;
      offset += this.maxParallel
    ) {
      const wave = prioritizedSegments.slice(offset, offset + this.maxParallel);
      const rankedPeers = this.rankPeers(peers);
      const assignedPeerIds = new Set<string>();
      const tasks = wave.map((segmentName) => {
        const cached = this.options.cache.get(segmentName);
        if (cached) {
          this.lastSources.set(segmentName, "cache");
          return Promise.resolve<SegmentFetchResult>({
            data: cached,
            source: "cache",
          });
        }

        const existing = this.inFlightSegments.get(segmentName);
        if (existing) {
          if (existing.peerId) assignedPeerIds.add(existing.peerId);
          return existing.promise;
        }

        const peer = rankedPeers.find(
          (candidate) =>
            !assignedPeerIds.has(candidate.id) &&
            candidate.segments.includes(segmentName),
        );
        if (peer) assignedPeerIds.add(peer.id);
        return this.startSegmentFetch(segmentName, peer);
      });

      const settled = await Promise.allSettled(tasks);
      for (const [index, result] of settled.entries()) {
        const segmentName = wave[index];
        if (!segmentName) continue;
        if (result.status === "fulfilled") {
          fetched.set(segmentName, result.value.data);
          this.lastSources.set(segmentName, result.value.source);
        } else {
          failures.push(result.reason);
        }
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more segments could not be fetched");
    }
    return fetched;
  }

  getLastSource(segmentName: string): SegmentFetchResult["source"] | undefined {
    return this.lastSources.get(segmentName);
  }

  private startSegmentFetch(
    segmentName: string,
    peer: Peer | undefined,
  ): Promise<SegmentFetchResult> {
    const promise = this.fetchAssignedSegment(segmentName, peer).finally(() => {
      const current = this.inFlightSegments.get(segmentName);
      if (current?.promise === promise) this.inFlightSegments.delete(segmentName);
    });
    this.inFlightSegments.set(segmentName, {
      ...(peer ? { peerId: peer.id } : {}),
      promise,
    });
    return promise;
  }

  private async fetchAssignedSegment(
    segmentName: string,
    peer: Peer | undefined,
  ): Promise<SegmentFetchResult> {
    if (peer) {
      const startedAt = performance.now();
      try {
        const data = await this.fetchFromPeer(peer, segmentName);
        this.observePeer(peer, performance.now() - startedAt, true, data.byteLength);
        this.cache(segmentName, data);
        return { data, source: "p2p" };
      } catch (error) {
        const failure =
          error instanceof PeerFetchError
            ? error
            : new PeerFetchError("Peer request failed", "connection");
        this.observePeer(
          peer,
          performance.now() - startedAt,
          false,
          0,
          failure.reason,
        );
        this.options.stats.recordP2PFailure();
        this.options.stats.recordFallback();
        void this.options.directory
          .reportFailure(peer.id, failure.reason)
          .catch((reportError: unknown) => {
            console.error("failed to report peer failure", reportError);
          });
      }
    }

    const data = await this.fetchFromOrigin(segmentName);
    this.cache(segmentName, data);
    return { data, source: "origin" };
  }

  private rankPeers(peers: Peer[]): Peer[] {
    const candidates = peers
      .filter(
        (peer) =>
          peer.id !== this.options.selfPeerId &&
          peer.trustScore >= MINIMUM_TRUST_SCORE,
      )
      .map((peer) => ({ peer, metrics: this.metricsFor(peer) }))
      .filter(({ metrics }) => metrics.trustScore >= MINIMUM_TRUST_SCORE);
    const maximumUploadBandwidthBps = Math.max(
      0,
      ...candidates.map(({ metrics }) => metrics.uploadBandwidthBps),
    );
    return candidates
      .map(({ peer, metrics }) => ({
        peer,
        score: calculatePeerScore(metrics, maximumUploadBandwidthBps),
      }))
      .sort((left, right) => right.score - left.score)
      .map(({ peer }) => peer);
  }

  private metricsFor(peer: Peer): PeerQualityMetrics {
    const observed: PeerQualityMetrics = {
      latencyMs: Math.max(0, peer.latencyMs),
      successRate: clamp(peer.successRate, 0, 1),
      uploadBandwidthBps: Math.max(0, peer.uploadBandwidthBps ?? 0),
      trustScore: clamp(peer.trustScore, 0, 1),
    };
    const previous = this.peerMetrics.get(peer.id);
    if (!previous) {
      this.peerMetrics.set(peer.id, observed);
      return observed;
    }
    const smoothed = this.smoothMetrics(previous, observed);
    this.peerMetrics.set(peer.id, smoothed);
    return smoothed;
  }

  private observePeer(
    peer: Peer,
    latencyMs: number,
    succeeded: boolean,
    bytes: number,
    failureReason?: PeerFailureReport["reason"],
  ): void {
    const previous = this.peerMetrics.get(peer.id) ?? this.metricsFor(peer);
    const elapsedSeconds = Math.max(latencyMs, 1) / 1_000;
    const observed: PeerQualityMetrics = {
      latencyMs,
      successRate: succeeded ? 1 : 0,
      uploadBandwidthBps: succeeded ? (bytes * 8) / elapsedSeconds : 0,
      trustScore: failureReason === "integrity" ? 0 : peer.trustScore,
    };
    this.peerMetrics.set(peer.id, this.smoothMetrics(previous, observed));
  }

  private smoothMetrics(
    previous: PeerQualityMetrics,
    observed: PeerQualityMetrics,
  ): PeerQualityMetrics {
    return {
      latencyMs: exponentialMovingAverage(
        previous.latencyMs,
        observed.latencyMs,
      ),
      successRate: exponentialMovingAverage(
        previous.successRate,
        observed.successRate,
      ),
      uploadBandwidthBps: exponentialMovingAverage(
        previous.uploadBandwidthBps,
        observed.uploadBandwidthBps,
      ),
      trustScore: exponentialMovingAverage(
        previous.trustScore,
        observed.trustScore,
      ),
    };
  }

  private async fetchFromPeer(peer: Peer, segmentName: string): Promise<Buffer> {
    this.options.stats.recordP2PRequest();
    const controller = new AbortController();
    const timer = this.options.transportManager
      ? undefined
      : setTimeout(
          () => controller.abort(new Error("P2P request timed out")),
          this.p2pTimeoutMs,
        );
    timer?.unref();
    try {
      let data: Buffer;
      if (this.options.transportManager) {
        this.options.transportManager.registerPeer(peer);
        try {
          data = await this.options.transportManager.fetchSegment(
            segmentName,
            peer.address,
            controller.signal,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Peer connection failed";
          const reason = /HTTP \d+/i.test(message)
            ? "http"
            : /timed out|abort/i.test(message)
              ? "timeout"
              : "connection";
          throw new PeerFetchError(message, reason);
        }
      } else {
        let response: Response;
        try {
          response = await this.fetchImpl(
            new URL(`/segments/${encodeURIComponent(segmentName)}`, peer.address),
            { signal: controller.signal },
          );
        } catch (error) {
          throw new PeerFetchError(
            error instanceof Error ? error.message : "Peer connection failed",
            controller.signal.aborted ? "timeout" : "connection",
          );
        }
        if (!response.ok) {
          throw new PeerFetchError(`Peer returned HTTP ${response.status}`, "http");
        }
        data = Buffer.from(await response.arrayBuffer());
      }
      if (!(await this.options.verifier.verify(segmentName, data))) {
        this.options.stats.recordIntegrityFailure();
        throw new PeerFetchError("Peer segment integrity check failed", "integrity");
      }
      this.options.stats.recordP2PSuccess(data.byteLength);
      return data;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async fetchFromOrigin(segmentName: string): Promise<Buffer> {
    const response = await this.fetchImpl(
      new URL(encodeURIComponent(segmentName), this.options.originBaseUrl),
    );
    if (!response.ok) {
      throw new Error(`Origin returned HTTP ${response.status} for '${segmentName}'`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    this.options.stats.recordOriginDownload(data.byteLength);
    if (!(await this.options.verifier.verify(segmentName, data))) {
      this.options.stats.recordIntegrityFailure();
      throw new Error(`Origin segment '${segmentName}' failed integrity verification`);
    }
    return data;
  }

  private cache(segmentName: string, data: Buffer): void {
    this.options.cache.set(segmentName, data);
    this.options.stats.setSegmentsCached(this.options.cache.size);
  }
}
