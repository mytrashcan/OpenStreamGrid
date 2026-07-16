import type { PeerTrafficStats } from "@openstreamgrid/common";
import type { SegmentCache } from "./cache.js";
import type { FetchFunction } from "./verifier.js";

const REPORT_INTERVAL_MS = 5_000;

const emptyStats = (): PeerTrafficStats => ({
  bytesDownloadedP2P: 0,
  bytesDownloadedOrigin: 0,
  bytesUploadedP2P: 0,
  p2pRequests: 0,
  p2pSuccesses: 0,
  p2pFailures: 0,
  originRequests: 0,
  integrityFailures: 0,
  fallbacks: 0,
  segmentsCached: 0,
});

export class TrafficStats {
  private readonly values = emptyStats();

  snapshot(): PeerTrafficStats {
    return { ...this.values };
  }

  get p2pSuccessRate(): number {
    return this.values.p2pRequests === 0
      ? 1
      : this.values.p2pSuccesses / this.values.p2pRequests;
  }

  recordP2PRequest(): void {
    this.values.p2pRequests += 1;
  }

  recordP2PSuccess(bytes: number): void {
    this.values.p2pSuccesses += 1;
    this.values.bytesDownloadedP2P += bytes;
  }

  recordP2PFailure(): void {
    this.values.p2pFailures += 1;
  }

  recordOriginDownload(bytes: number): void {
    this.values.originRequests += 1;
    this.values.bytesDownloadedOrigin += bytes;
  }

  recordUpload(bytes: number): void {
    this.values.bytesUploadedP2P += bytes;
  }

  recordIntegrityFailure(): void {
    this.values.integrityFailures += 1;
  }

  recordFallback(): void {
    this.values.fallbacks += 1;
  }

  setSegmentsCached(count: number): void {
    this.values.segmentsCached = count;
  }
}

interface StatsReporterOptions {
  trackerUrl: string;
  broadcastId: string;
  peerId: string;
  uploadBandwidthBps: number;
  stats: TrafficStats;
  cache: SegmentCache;
  fetchImpl?: FetchFunction;
  intervalMs?: number;
}

export class StatsReporter {
  private readonly fetchImpl: FetchFunction;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private lastLatencyMs = 0;

  constructor(private readonly options: StatsReporterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.intervalMs = options.intervalMs ?? REPORT_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.report().catch((error: unknown) => {
        console.error("failed to report peer stats", error);
      }),
      this.intervalMs,
    );
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.report();
  }

  async report(): Promise<void> {
    const startedAt = performance.now();
    await Promise.all([
      this.request("heartbeat", "PUT", {
        latencyMs: this.lastLatencyMs,
        uploadBandwidthBps: this.options.uploadBandwidthBps,
        successRate: this.options.stats.p2pSuccessRate,
      }),
      this.request("stats", "POST", { stats: this.options.stats.snapshot() }),
      this.reportSegments(),
    ]);
    this.lastLatencyMs = performance.now() - startedAt;
  }

  async reportSegments(): Promise<void> {
    await this.request("segments", "POST", {
      segments: this.options.cache.keys(),
      replace: true,
    });
  }

  private async request(
    action: "heartbeat" | "stats" | "segments",
    method: "PUT" | "POST",
    body: unknown,
  ): Promise<void> {
    const endpoint = new URL(
      `/api/v1/broadcasts/${encodeURIComponent(this.options.broadcastId)}/peers/${encodeURIComponent(this.options.peerId)}/${action}`,
      this.options.trackerUrl,
    );
    const response = await this.fetchImpl(endpoint, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Tracker ${action} returned HTTP ${response.status}`);
    }
  }
}
