import { validatePeerHttpBaseUrl } from "@openstreamgrid/common";
import type { TransportAdapter, TransportOptions, TransportStats } from "./transport.js";
import type { FetchFunction, SegmentIntegrityVerifier } from "./verifier.js";
import { keepAliveFetch } from "./http-client.js";

const DEFAULT_P2P_TIMEOUT_MS = 2_000;

interface HttpTransportOptions {
  /** Custom fetch implementation (default: global fetch). */
  fetchImpl?: FetchFunction;
  /** Optional segment integrity verifier. */
  verifier?: SegmentIntegrityVerifier;
  /** Timeout per segment request in milliseconds (default: 2000). */
  p2pTimeoutMs?: number;
}

/** HTTP implementation of peer-to-peer segment transport. */
export class HttpTransport implements TransportAdapter {
  readonly name = "http";
  private readonly fetchImpl: FetchFunction;
  private readonly verifier: SegmentIntegrityVerifier | undefined;
  private readonly p2pTimeoutMs: number;
  private activePeers: string[] = [];
  private readonly authorizationTokens = new Map<string, string>();
  private readonly stats: TransportStats = {
    segmentsFetched: 0,
    segmentsFailed: 0,
    bytesTransferred: 0,
    latencyMs: { min: Infinity, max: 0, average: 0 },
  };

  constructor(options: HttpTransportOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? keepAliveFetch;
    this.verifier = options.verifier;
    this.p2pTimeoutMs = options.p2pTimeoutMs ?? DEFAULT_P2P_TIMEOUT_MS;
  }

  async start(_options: TransportOptions): Promise<void> {
    // HTTP transport needs no persistent state to start.
    // The peer list is updated externally via setPeers().
  }

  async stop(): Promise<void> {
    this.activePeers = [];
    this.authorizationTokens.clear();
  }

  get peers(): string[] {
    return [...this.activePeers];
  }

  /** Update the known peer address list. */
  setPeers(
    peers: Array<string | { address: string; authorizationToken?: string }>,
  ): void {
    const normalized = peers.map((peer) =>
      typeof peer === "string" ? { address: peer } : peer,
    );
    this.activePeers = normalized.map((peer) => peer.address);
    this.authorizationTokens.clear();
    for (const peer of normalized) {
      if (peer.authorizationToken) {
        this.authorizationTokens.set(peer.address, peer.authorizationToken);
      }
    }
  }

  setPeerAuthorization(address: string, token: string | undefined): void {
    if (token) this.authorizationTokens.set(address, token);
    else this.authorizationTokens.delete(address);
  }

  async requestSegment(
    peerAddress: string,
    segmentName: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const startedAt = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("P2P request timed out")),
      this.p2pTimeoutMs,
    );
    timer.unref();

    // Forward the outer signal so abort from either side works.
    const onOuterAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onOuterAbort, { once: true });
    if (signal?.aborted) onOuterAbort();

    try {
      const baseUrl = validatePeerHttpBaseUrl(peerAddress);
      const url = new URL(
        `/segments/${encodeURIComponent(segmentName)}`,
        baseUrl,
      );
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        ...(this.authorizationTokens.has(peerAddress)
          ? {
              headers: {
                Authorization: `Bearer ${this.authorizationTokens.get(peerAddress)}`,
              },
            }
          : {}),
      });
      if (!response.ok) {
        throw new Error(`Peer returned HTTP ${response.status}`);
      }
      const data = Buffer.from(await response.arrayBuffer());

      if (this.verifier && !(await this.verifier.verify(segmentName, data))) {
        throw new Error("Segment integrity verification failed");
      }

      this.recordSuccess(data.byteLength, performance.now() - startedAt);
      return data;
    } catch (error) {
      this.recordFailure();
      if (controller.signal.aborted && signal?.aborted) {
        throw error instanceof Error ? error : new Error("Request aborted");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  getStats(): TransportStats {
    return this.copyStats();
  }

  resetStats(): void {
    this.stats.segmentsFetched = 0;
    this.stats.segmentsFailed = 0;
    this.stats.bytesTransferred = 0;
    this.stats.latencyMs = { min: Infinity, max: 0, average: 0 };
  }

  private recordSuccess(bytes: number, latencyMs: number): void {
    this.stats.segmentsFetched += 1;
    this.stats.bytesTransferred += bytes;
    const count = this.stats.segmentsFetched;
    const previous = this.stats.latencyMs;
    this.stats.latencyMs = {
      min: Math.min(previous.min, latencyMs),
      max: Math.max(previous.max, latencyMs),
      average: previous.average + (latencyMs - previous.average) / count,
    };
  }

  private recordFailure(): void {
    this.stats.segmentsFailed += 1;
  }

  private copyStats(): TransportStats {
    return {
      segmentsFetched: this.stats.segmentsFetched,
      segmentsFailed: this.stats.segmentsFailed,
      bytesTransferred: this.stats.bytesTransferred,
      latencyMs: { ...this.stats.latencyMs },
    };
  }
}
