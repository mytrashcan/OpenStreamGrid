import {
  createEmptyPeerTrafficStats,
  type PeerTrafficStats,
} from "@openstreamgrid/common";

/** Mutable peer traffic counters with immutable snapshot access. */
export class TrafficStats {
  private readonly values = createEmptyPeerTrafficStats();

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
