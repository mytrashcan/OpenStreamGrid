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

/** Transport names managed by the peer fallback coordinator. */
export type ManagedTransportName = "webrtc" | "http";

const MAX_TRACKED_PEERS = 2_000;

/** Attempt and failure counters for one transport. */
export interface TransportAttemptStats {
  successes: number;
  failures: number;
}

/** Aggregate transport usage snapshot. */
export interface TransportManagerStats {
  lastTransport: ManagedTransportName | null;
  webrtc: TransportAttemptStats;
  http: TransportAttemptStats;
}

/** Peer identifiers and addresses available to each transport. */
export interface TransportPeer {
  id: string;
  address: string;
  metadata?: Record<string, string>;
}

/** Transport dependencies and WebRTC fallback configuration. */
export interface TransportManagerOptions
  extends Pick<
    TransportOptions,
    "signalUrl" | "peerId" | "broadcastId" | "signal"
  > {
  fetchImpl?: FetchFunction;
  verifier?: SegmentIntegrityVerifier;
  p2pTimeoutMs?: number;
  webRtcEnabled?: boolean;
  iceServers?: RTCIceServer[];
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
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;

  constructor(options: TransportManagerOptions = {}) {
    this.webRtcEnabled = options.webRtcEnabled ?? true;
    this.webRtcTransport =
      options.webRtcTransport ??
      new WebRtcTransport({
        ...options.webRtc,
        ...(options.iceServers ? { iceServers: options.iceServers } : {}),
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
    if (this.stopPromise) await this.stopPromise;
    if (this.started) return this.startPromise;
    this.started = true;
    const startPromise = this.startOnce().finally(() => {
      if (this.startPromise === startPromise) this.startPromise = undefined;
    });
    this.startPromise = startPromise;
    return startPromise;
  }

  setSessionToken(sessionToken: string): void {
    if (this.started) throw new Error("Cannot change the peer session after transport startup");
    this.transportOptions.sessionToken = sessionToken;
  }

  private async startOnce(): Promise<void> {
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
    if (this.stopPromise) return this.stopPromise;
    const pendingStart = this.startPromise;
    const stopPromise = (async (): Promise<void> => {
      await pendingStart?.catch(() => undefined);
      await Promise.allSettled([
        this.webRtcTransport.stop(),
        this.httpTransport.stop(),
      ]);
      this.peerIdsByAddress.clear();
    })().finally(() => {
      if (this.stopPromise === stopPromise) this.stopPromise = undefined;
    });
    this.stopPromise = stopPromise;
    return stopPromise;
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
      this.httpTransport.setPeers(peers.map((peer) => ({
        address: peer.address,
        ...(peer.metadata?.uploadToken
          ? { authorizationToken: peer.metadata.uploadToken }
          : {}),
      })));
    }
  }

  registerPeer(peer: TransportPeer): void {
    this.peerIdsByAddress.delete(peer.address);
    this.peerIdsByAddress.set(peer.address, peer.id);
    if (this.httpTransport instanceof HttpTransport) {
      this.httpTransport.setPeerAuthorization(
        peer.address,
        peer.metadata?.uploadToken,
      );
    }
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
