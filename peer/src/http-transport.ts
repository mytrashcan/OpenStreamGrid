import type { TransportAdapter, TransportOptions, TransportStats } from "./transport.js";
import type { FetchFunction } from "./verifier.js";
import type { SegmentIntegrityVerifier } from "./verifier.js";

const DEFAULT_P2P_TIMEOUT_MS = 2_000;

interface HttpTransportOptions {
  /** Custom fetch implementation (default: global fetch). */
  fetchImpl?: FetchFunction;
  /** Optional segment integrity verifier. */
  verifier?: SegmentIntegrityVerifier;
  /** Timeout per segment request in milliseconds (default: 2000). */
  p2pTimeoutMs?: number;
}

export class HttpTransport implements TransportAdapter {
  readonly name = "http";
  private readonly fetchImpl: FetchFunction;
  private readonly verifier: SegmentIntegrityVerifier | undefined;
  private readonly p2pTimeoutMs: number;
  private activePeers: string[] = [];
  private readonly stats: TransportStats = {
    segmentsFetched: 0,
    segmentsFailed: 0,
    bytesTransferred: 0,
    latencyMs: { min: Infinity, max: 0, average: 0 },
  };
  private latencies: number[] = [];

  constructor(options: HttpTransportOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.verifier = options.verifier;
    this.p2pTimeoutMs = options.p2pTimeoutMs ?? DEFAULT_P2P_TIMEOUT_MS;
  }

  async start(_options: TransportOptions): Promise<void> {
    // HTTP transport needs no persistent state to start.
    // The peer list is updated externally via setPeers().
  }

  async stop(): Promise<void> {
    this.activePeers = [];
  }

  get peers(): string[] {
    return [...this.activePeers];
  }

  /** Update the known peer address list. */
  setPeers(addresses: string[]): void {
    this.activePeers = [...addresses];
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

    try {
      const url = new URL(
        `/segments/${encodeURIComponent(segmentName)}`,
        peerAddress,
      );
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Peer returned HTTP ${response.status}`);
      }
      const data = Buffer.from(await response.arrayBuffer());

      // Optional integrity verification
      if (this.verifier && !(await this.verifier.verify(segmentName, data))) {
        this.recordFailure();
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
    this.latencies = [];
  }

  private recordSuccess(bytes: number, latencyMs: number): void {
    this.stats.segmentsFetched += 1;
    this.stats.bytesTransferred += bytes;
    this.latencies.push(latencyMs);
    this.recomputeLatencyStats();
  }

  private recordFailure(): void {
    this.stats.segmentsFailed += 1;
  }

  private recomputeLatencyStats(): void {
    const count = this.latencies.length;
    if (count === 0) {
      this.stats.latencyMs = { min: Infinity, max: 0, average: 0 };
      return;
    }
    let sum = 0;
    let min = Infinity;
    let max = 0;
    for (const ms of this.latencies) {
      sum += ms;
      if (ms < min) min = ms;
      if (ms > max) max = ms;
    }
    this.stats.latencyMs = { min, max, average: sum / count };
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
