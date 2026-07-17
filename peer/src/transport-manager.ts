import type {
  TransportAdapter,
  TransportOptions,
  TransportStats,
} from "./transport.js";
import { HttpTransport } from "./http-transport.js";
import {
  WebRtcTransport,
  type WebRtcTransportOptions,
} from "./webrtc-transport.js";
import type { FetchFunction, SegmentIntegrityVerifier } from "./verifier.js";

export type ManagedTransportName = "webrtc" | "http";

const MAX_TRACKED_PEERS = 2_000;

export interface TransportAttemptStats {
  successes: number;
  failures: number;
}

export interface TransportManagerStats {
  lastTransport: ManagedTransportName | null;
  webrtc: TransportAttemptStats;
  http: TransportAttemptStats;
}

export interface TransportPeer {
  id: string;
  address: string;
}

export interface TransportManagerOptions
  extends Pick<
    TransportOptions,
    "signalUrl" | "peerId" | "broadcastId" | "signal"
  > {
  fetchImpl?: FetchFunction;
  verifier?: SegmentIntegrityVerifier;
  p2pTimeoutMs?: number;
  webRtcEnabled?: boolean;
  webRtc?: WebRtcTransportOptions;
  /** Dependency injection hooks used by transport-level unit tests. */
  webRtcTransport?: TransportAdapter;
  httpTransport?: TransportAdapter;
}

/** Tries WebRTC first and transparently falls back to the HTTP adapter. */
export class TransportManager {
  private readonly webRtcTransport: TransportAdapter;
  private readonly httpTransport: TransportAdapter;
  private readonly transportOptions: TransportOptions;
  private readonly webRtcEnabled: boolean;
  private readonly peerIdsByAddress = new Map<string, string>();
  private readonly usage: TransportManagerStats = {
    lastTransport: null,
    webrtc: { successes: 0, failures: 0 },
    http: { successes: 0, failures: 0 },
  };
  private started = false;

  constructor(options: TransportManagerOptions = {}) {
    this.webRtcEnabled = options.webRtcEnabled ?? true;
    this.webRtcTransport =
      options.webRtcTransport ??
      new WebRtcTransport({
        ...options.webRtc,
        ...(options.webRtc?.verifier ?? options.verifier
          ? { verifier: options.webRtc?.verifier ?? options.verifier }
          : {}),
      });
    this.httpTransport =
      options.httpTransport ??
      new HttpTransport({
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.verifier ? { verifier: options.verifier } : {}),
        ...(options.p2pTimeoutMs
          ? { p2pTimeoutMs: options.p2pTimeoutMs }
          : {}),
      });
    this.transportOptions = {
      ...(options.signalUrl ? { signalUrl: options.signalUrl } : {}),
      ...(options.peerId ? { peerId: options.peerId } : {}),
      ...(options.broadcastId ? { broadcastId: options.broadcastId } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await Promise.all([
        this.httpTransport.start(this.transportOptions),
        this.startWebRtc(),
      ]);
    } catch (error) {
      this.started = false;
      await Promise.allSettled([
        this.httpTransport.stop(),
        this.webRtcTransport.stop(),
      ]);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    await Promise.allSettled([
      this.webRtcTransport.stop(),
      this.httpTransport.stop(),
    ]);
    this.peerIdsByAddress.clear();
  }

  async fetchSegment(
    segmentName: string,
    peerAddress: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const webRtcPeerId = this.peerIdsByAddress.get(peerAddress) ?? peerAddress;
    if (this.webRtcEnabled) {
      try {
        const data = await this.webRtcTransport.requestSegment(
          webRtcPeerId,
          segmentName,
          signal,
        );
        this.recordSuccess("webrtc");
        return data;
      } catch {
        this.recordFailure("webrtc");
      }
    } else {
      this.recordFailure("webrtc");
    }

    try {
      const data = await this.httpTransport.requestSegment(
        peerAddress,
        segmentName,
        signal,
      );
      this.recordSuccess("http");
      return data;
    } catch (error) {
      this.recordFailure("http");
      throw error;
    }
  }

  setPeers(peers: readonly TransportPeer[]): void {
    this.peerIdsByAddress.clear();
    for (const peer of peers) this.peerIdsByAddress.set(peer.address, peer.id);
    if (this.httpTransport instanceof HttpTransport) {
      this.httpTransport.setPeers(peers.map((peer) => peer.address));
    }
  }

  registerPeer(peer: TransportPeer): void {
    this.peerIdsByAddress.delete(peer.address);
    this.peerIdsByAddress.set(peer.address, peer.id);
    while (this.peerIdsByAddress.size > MAX_TRACKED_PEERS) {
      const oldest = this.peerIdsByAddress.keys().next().value;
      if (oldest === undefined) break;
      this.peerIdsByAddress.delete(oldest);
    }
  }

  get peers(): string[] {
    return [
      ...new Set([
        ...this.peerIdsByAddress.keys(),
        ...this.webRtcTransport.peers,
        ...this.httpTransport.peers,
      ]),
    ];
  }

  getStats(): TransportManagerStats {
    return {
      lastTransport: this.usage.lastTransport,
      webrtc: { ...this.usage.webrtc },
      http: { ...this.usage.http },
    };
  }

  getAdapterStats(): Record<ManagedTransportName, TransportStats> {
    return {
      webrtc: this.webRtcTransport.getStats(),
      http: this.httpTransport.getStats(),
    };
  }

  resetStats(): void {
    this.usage.lastTransport = null;
    this.usage.webrtc = { successes: 0, failures: 0 };
    this.usage.http = { successes: 0, failures: 0 };
    this.webRtcTransport.resetStats();
    this.httpTransport.resetStats();
  }

  private recordSuccess(name: ManagedTransportName): void {
    this.usage[name].successes += 1;
    this.usage.lastTransport = name;
  }

  private async startWebRtc(): Promise<void> {
    if (!this.webRtcEnabled) return;
    try {
      await this.webRtcTransport.start(this.transportOptions);
    } catch {
      // Signaling can be retried lazily by requestSegment; HTTP stays usable.
    }
  }

  private recordFailure(name: ManagedTransportName): void {
    this.usage[name].failures += 1;
  }
}
