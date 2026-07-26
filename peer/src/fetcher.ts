import {
  createLogger,
  validatePeerHttpBaseUrl,
  type Peer,
  type PeerFailureReport,
  type SchedulerDecision,
  type SchedulingPeer,
  type SegmentScheduler,
  type SegmentSchedulingContext,
} from "@openstreamgrid/common";
import type { SegmentCache } from "./cache.js";
import type { TrafficStats } from "./stats.js";
import type {
  FetchFunction,
  SegmentIntegrityVerifier,
} from "./verifier.js";
import type { TransportManager } from "./transport-manager.js";
import { keepAliveFetch } from "./http-client.js";
import {
  MAX_PARALLEL_DOWNLOADS_VALUE,
  schedulerDecisionFor,
  planSegmentSafely,
  URGENT_THRESHOLD_SEGMENTS_VALUE,
  WeightedScoreScheduler,
} from "./weighted-score-scheduler.js";

const DEFAULT_P2P_TIMEOUT_MS = 2_000;
const DEFAULT_ORIGIN_TIMEOUT_MS = 10_000;
const MAX_TRACKED_SEGMENT_SOURCES = 2_000;

const logger = createLogger("peer");

export {
  calculatePeerScore,
  clamp,
  exponentialMovingAverage,
  LATENCY_WEIGHT_VALUE,
  MAX_PARALLEL_DOWNLOADS_VALUE,
  METRIC_EMA_ALPHA_VALUE,
  MINIMUM_TRUST_SCORE_VALUE,
  SUCCESS_RATE_WEIGHT_VALUE,
  TRUST_SCORE_WEIGHT_VALUE,
  UPLOAD_BANDWIDTH_WEIGHT_VALUE,
  URGENT_THRESHOLD_SEGMENTS_VALUE,
} from "./weighted-score-scheduler.js";
export type { PeerQualityMetrics } from "./weighted-score-scheduler.js";

/** Peer discovery and failure-reporting operations required by the fetcher. */
export interface PeerDirectory {
  listPeers(segmentName: string): Promise<Peer[]>;
  reportFailure(peerId: string, reason: PeerFailureReport["reason"]): Promise<void>;
}

export interface FetcherOptions {
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
  scheduler?: SegmentScheduler;
  onSchedulerDecision?: (decision: SchedulerDecision) => void;
}

/** Segment bytes and the delivery path that supplied them. */
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

/** Fetches verified segments from cache, peers, or origin in priority order. */
export class HybridSegmentFetcher {
  private readonly fetchImpl: FetchFunction;
  private readonly p2pTimeoutMs: number;
  private readonly urgentThresholdSegments: number;
  private readonly maxParallel: number;
  private readonly scheduler: SegmentScheduler;
  private readonly inFlightSegments = new Map<
    string,
    { peerId?: string; promise: Promise<SegmentFetchResult> }
  >();
  private readonly lastSources = new Map<
    string,
    SegmentFetchResult["source"]
  >();
  private readonly shutdownController = new AbortController();

  constructor(private readonly options: FetcherOptions) {
    this.fetchImpl = options.fetchImpl ?? keepAliveFetch;
    this.p2pTimeoutMs = options.p2pTimeoutMs ?? DEFAULT_P2P_TIMEOUT_MS;
    this.urgentThresholdSegments =
      options.urgentThresholdSegments ?? URGENT_THRESHOLD_SEGMENTS_VALUE;
    this.maxParallel = options.maxParallel ?? MAX_PARALLEL_DOWNLOADS_VALUE;
    if (!Number.isSafeInteger(this.maxParallel) || this.maxParallel <= 0) {
      throw new Error("Maximum parallel downloads must be a positive integer");
    }
    this.scheduler =
      options.scheduler ??
      new WeightedScoreScheduler({
        urgentThresholdSegments: this.urgentThresholdSegments,
      });
  }

  async fetchSegment(
    segmentName: string,
    segmentsAhead: number,
  ): Promise<SegmentFetchResult> {
    const cached = this.options.cache.get(segmentName);
    if (cached) {
      this.setLastSource(segmentName, "cache");
      return { data: cached, source: "cache" };
    }

    const existing = this.inFlightSegments.get(segmentName);
    if (existing) {
      const result = await existing.promise;
      this.setLastSource(segmentName, result.source);
      return result;
    }

    const promise = this.fetchUncachedSegment(segmentName, segmentsAhead).finally(
      () => {
        const current = this.inFlightSegments.get(segmentName);
        if (current?.promise === promise) this.inFlightSegments.delete(segmentName);
      },
    );
    this.inFlightSegments.set(segmentName, { promise });
    return promise;
  }

  private async fetchUncachedSegment(
    segmentName: string,
    segmentsAhead: number,
  ): Promise<SegmentFetchResult> {
    if (segmentsAhead >= this.urgentThresholdSegments) {
      let peers: Peer[] = [];
      try {
        peers = this.rankPeers(
          await this.options.directory.listPeers(segmentName),
          segmentName,
          segmentsAhead,
        );
      } catch (error) {
        this.options.stats.recordFallback();
        logger.error("peer_discovery_failed", error, { segmentName });
      }
      const peer = peers[0];
      if (peer) {
        const startedAt = performance.now();
        try {
          const data = await this.fetchFromPeer(peer, segmentName);
          this.scheduler.observePeer?.({
            peerId: peer.id,
            succeeded: true,
            latencyMs: performance.now() - startedAt,
            bytes: data.byteLength,
          });
          this.cache(segmentName, data);
          this.setLastSource(segmentName, "p2p");
          return { data, source: "p2p" };
        } catch (error) {
          const failure =
            error instanceof PeerFetchError
              ? error
              : new PeerFetchError("Peer request failed", "connection");
          this.scheduler.observePeer?.({
            peerId: peer.id,
            succeeded: false,
            latencyMs: performance.now() - startedAt,
            bytes: 0,
            failureReason: failure.reason,
          });
          this.options.stats.recordP2PFailure();
          this.options.stats.recordFallback();
          void this.options.directory
            .reportFailure(peer.id, failure.reason)
            .catch((reportError: unknown) => {
              logger.error("peer_failure_report_failed", reportError, {
                peerId: peer.id,
              });
            });
        }
      }
    }

    const data = await this.fetchFromOrigin(segmentName);
    this.cache(segmentName, data);
    this.setLastSource(segmentName, "origin");
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
          this.setLastSource(segmentName, "cache");
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
          this.setLastSource(segmentName, result.value.source);
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

  /** Aborts outstanding peer and Origin requests during application shutdown. */
  stop(): void {
    if (!this.shutdownController.signal.aborted) {
      this.shutdownController.abort(new Error("Segment fetcher stopped"));
    }
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
        this.scheduler.observePeer?.({
          peerId: peer.id,
          succeeded: true,
          latencyMs: performance.now() - startedAt,
          bytes: data.byteLength,
        });
        this.cache(segmentName, data);
        return { data, source: "p2p" };
      } catch (error) {
        const failure =
          error instanceof PeerFetchError
            ? error
            : new PeerFetchError("Peer request failed", "connection");
        this.scheduler.observePeer?.({
          peerId: peer.id,
          succeeded: false,
          latencyMs: performance.now() - startedAt,
          bytes: 0,
          failureReason: failure.reason,
        });
        this.options.stats.recordP2PFailure();
        this.options.stats.recordFallback();
        void this.options.directory
          .reportFailure(peer.id, failure.reason)
          .catch((reportError: unknown) => {
            logger.error("peer_failure_report_failed", reportError, {
              peerId: peer.id,
            });
          });
      }
    }

    const data = await this.fetchFromOrigin(segmentName);
    this.cache(segmentName, data);
    return { data, source: "origin" };
  }

  private rankPeers(
    peers: Peer[],
    segmentName = "",
    segmentsAhead?: number,
  ): Peer[] {
    const candidates: SchedulingPeer[] = peers.map((peer, originalIndex) => ({
      id: peer.id,
      latencyMs: peer.latencyMs,
      successRate: peer.successRate,
      uploadBandwidthBps: peer.uploadBandwidthBps ?? 0,
      trustScore: peer.trustScore,
      segments: peer.segments,
      originalIndex,
    }));
    const context: SegmentSchedulingContext = {
      segmentId: segmentName,
      ...(segmentsAhead === undefined ? {} : { segmentsAhead }),
      candidates,
      selfPeerId: this.options.selfPeerId,
      maximumParallelism: this.maxParallel,
    };
    const plan = planSegmentSafely(
      this.scheduler,
      context,
      (event, warningContext) => logger.warn(event, warningContext),
    );
    this.recordSchedulerDecision(schedulerDecisionFor(plan, candidates.length));
    if (plan.mode === "origin") return [];

    const peersById = new Map(peers.map((peer) => [peer.id, peer]));
    const orderedPeerIds = [
      ...plan.peerIds,
      ...plan.rankedPeers
        .map(({ peerId }) => peerId)
        .filter((peerId) => !plan.peerIds.includes(peerId)),
    ];
    return orderedPeerIds.flatMap((peerId) => {
      const peer = peersById.get(peerId);
      return peer ? [peer] : [];
    });
  }

  private recordSchedulerDecision(decision: SchedulerDecision): void {
    try {
      this.options.onSchedulerDecision?.(decision);
    } catch (error) {
      logger.warn("scheduler_decision_callback_failed", {
        policy: decision.policy,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async fetchFromPeer(peer: Peer, segmentName: string): Promise<Buffer> {
    this.options.stats.recordP2PRequest();
    const controller = new AbortController();
    const onShutdown = (): void => {
      controller.abort(
        this.shutdownController.signal.reason ?? new Error("Segment fetcher stopped"),
      );
    };
    this.shutdownController.signal.addEventListener("abort", onShutdown, {
      once: true,
    });
    if (this.shutdownController.signal.aborted) onShutdown();
    const timer = this.options.transportManager
      ? undefined
      : setTimeout(
          () => controller.abort(new Error("P2P request timed out")),
          this.p2pTimeoutMs,
        );
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
            new URL(
              `/segments/${encodeURIComponent(segmentName)}`,
              validatePeerHttpBaseUrl(peer.address),
            ),
            {
              signal: controller.signal,
              ...(peer.metadata?.uploadToken
                ? {
                    headers: {
                      Authorization: `Bearer ${peer.metadata.uploadToken}`,
                    },
                  }
                : {}),
            },
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
      this.shutdownController.signal.removeEventListener("abort", onShutdown);
    }
  }

  private async fetchFromOrigin(segmentName: string): Promise<Buffer> {
    const signal = AbortSignal.any([
      this.shutdownController.signal,
      AbortSignal.timeout(DEFAULT_ORIGIN_TIMEOUT_MS),
    ]);
    const response = await this.fetchImpl(
      new URL(encodeURIComponent(segmentName), this.options.originBaseUrl),
      { signal },
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

  private setLastSource(
    segmentName: string,
    source: SegmentFetchResult["source"],
  ): void {
    this.lastSources.delete(segmentName);
    this.lastSources.set(segmentName, source);
    while (this.lastSources.size > MAX_TRACKED_SEGMENT_SOURCES) {
      const oldest = this.lastSources.keys().next().value;
      if (oldest === undefined) break;
      this.lastSources.delete(oldest);
    }
  }
}
