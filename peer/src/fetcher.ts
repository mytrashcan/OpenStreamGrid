import type { Peer, PeerFailureReport } from "@openstreamgrid/common";
import type { SegmentCache } from "./cache.js";
import type { TrafficStats } from "./stats.js";
import type {
  FetchFunction,
  SegmentIntegrityVerifier,
} from "./verifier.js";

const DEFAULT_P2P_TIMEOUT_MS = 2_000;
const DEFAULT_URGENT_THRESHOLD_SEGMENTS = 2;
const MINIMUM_TRUST_SCORE = 0.3;

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

  constructor(private readonly options: FetcherOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.p2pTimeoutMs = options.p2pTimeoutMs ?? DEFAULT_P2P_TIMEOUT_MS;
    this.urgentThresholdSegments =
      options.urgentThresholdSegments ?? DEFAULT_URGENT_THRESHOLD_SEGMENTS;
  }

  async fetchSegment(
    segmentName: string,
    segmentsAhead: number,
  ): Promise<SegmentFetchResult> {
    const cached = this.options.cache.get(segmentName);
    if (cached) return { data: cached, source: "cache" };

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
        try {
          const data = await this.fetchFromPeer(peer, segmentName);
          this.cache(segmentName, data);
          return { data, source: "p2p" };
        } catch (error) {
          const failure =
            error instanceof PeerFetchError
              ? error
              : new PeerFetchError("Peer request failed", "connection");
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
    return { data, source: "origin" };
  }

  private rankPeers(peers: Peer[]): Peer[] {
    return peers
      .filter(
        (peer) =>
          peer.id !== this.options.selfPeerId && peer.trustScore >= MINIMUM_TRUST_SCORE,
      )
      .sort((left, right) => {
        if (left.successRate !== right.successRate) {
          return right.successRate - left.successRate;
        }
        if (left.latencyMs !== right.latencyMs) {
          return left.latencyMs - right.latencyMs;
        }
        if (left.trustScore !== right.trustScore) {
          return right.trustScore - left.trustScore;
        }
        return (
          (right.uploadBandwidthBps ?? 0) - (left.uploadBandwidthBps ?? 0)
        );
      });
  }

  private async fetchFromPeer(peer: Peer, segmentName: string): Promise<Buffer> {
    this.options.stats.recordP2PRequest();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("P2P request timed out")),
      this.p2pTimeoutMs,
    );
    timer.unref();
    try {
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
      const data = Buffer.from(await response.arrayBuffer());
      if (!(await this.options.verifier.verify(segmentName, data))) {
        this.options.stats.recordIntegrityFailure();
        throw new PeerFetchError("Peer segment integrity check failed", "integrity");
      }
      this.options.stats.recordP2PSuccess(data.byteLength);
      return data;
    } finally {
      clearTimeout(timer);
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
