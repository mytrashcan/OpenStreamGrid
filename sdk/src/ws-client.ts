/**
 * Browser-native WebSocket client for OpenStreamGrid tracker communication.
 * Uses the native WebSocket API (not the `ws` npm package).
 * Implements exponential-backoff reconnection and periodic status reporting.
 */

import type {
  PeerInfo,
  PeerTrafficStats,
  WsClientMessage,
  WsServerMessage,
} from "./types.js";

const DEFAULT_RECONNECT_INITIAL_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_REPORT_INTERVAL_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

export interface WsClientOptions {
  trackerUrl: string;
  broadcastId: string;
  peerId: string;
  /** Called periodically to get current segments possessed. */
  getSegments?: () => string[];
  /** Called periodically to get current stats. */
  getStats?: () => PeerTrafficStats;
  /** Called when a peer event arrives. */
  onPeerList?: (peers: PeerInfo[]) => void;
  onPeerJoined?: (peer: PeerInfo) => void;
  onPeerLeft?: (peerId: string) => void;
  onSegmentAvailable?: (peerId: string, segments: string[]) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onError?: (error: Event) => void;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  reportIntervalMs?: number;
}

/**
 * WebSocket client that connects to the OpenStreamGrid tracker.
 * Manages reconnection with exponential backoff and periodic status reporting.
 */
export class WsTrackerClient {
  private ws: WebSocket | null = null;
  private reportTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nextReconnectMs: number;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly reportIntervalMs: number;
  private started = false;
  private firstConnectResolve: (() => void) | null = null;
  /** Track known peers. */
  private readonly peers = new Map<string, PeerInfo>();

  constructor(private readonly options: WsClientOptions) {
    this.reconnectInitialMs =
      options.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
    this.reconnectMaxMs =
      options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.reportIntervalMs =
      options.reportIntervalMs ?? DEFAULT_REPORT_INTERVAL_MS;
    this.nextReconnectMs = this.reconnectInitialMs;
  }

  /** Start the WebSocket connection. Resolves on first successful connection. */
  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;
    this.reportTimer = setInterval(() => this.reportStatus(), this.reportIntervalMs);
    return new Promise<void>((resolve) => {
      this.firstConnectResolve = resolve;
      this.openSocket();
    });
  }

  /** Gracefully stop and clean up. */
  stop(): void {
    this.started = false;
    this.peers.clear();
    if (this.reportTimer) clearInterval(this.reportTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reportTimer = null;
    this.reconnectTimer = null;
    this.firstConnectResolve?.();
    this.firstConnectResolve = null;
    if (this.ws) {
      this.ws.onclose = null; // prevent reconnect
      this.ws.onerror = null;
      this.ws.onmessage = null;
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close(1000, "Peer shutting down");
      }
      this.ws = null;
    }
  }

  /** Get the current list of known peers (filtered by a specific segment). */
  getPeersWithSegment(segmentName: string): PeerInfo[] {
    return [...this.peers.values()]
      .filter((p) => p.segments.includes(segmentName))
      .map((p) => ({ ...p, segments: [...p.segments] }));
  }

  /** Get all known peers. */
  getAllPeers(): PeerInfo[] {
    return [...this.peers.values()].map((p) => ({
      ...p,
      segments: [...p.segments],
    }));
  }

  /** Send a report_segments message immediately. */
  reportSegments(): void {
    const segments = this.options.getSegments?.() ?? [];
    this.send({
      type: "report_segments",
      broadcastId: this.options.broadcastId,
      peerId: this.options.peerId,
      segments,
      replace: true,
    });
  }

  private openSocket(): void {
    if (!this.started || this.ws) return;

    const url = this.buildWsUrl();
    let ws: WebSocket;

    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.error("[OpenStreamGrid] Failed to create WebSocket", err);
      this.scheduleReconnect();
      return;
    }

    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws || !this.started) return;
      this.nextReconnectMs = this.reconnectInitialMs;

      // Subscribe to our broadcast
      this.send({
        type: "subscribe",
        broadcastId: this.options.broadcastId,
        peerId: this.options.peerId,
      });

      // Report initial status
      this.reportStatus();

      // Notify
      this.options.onConnected?.();
      this.firstConnectResolve?.();
      this.firstConnectResolve = null;
    };

    ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };

    ws.onerror = (event: Event) => {
      console.error("[OpenStreamGrid] WebSocket error");
      this.options.onError?.(event);
    };

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.peers.clear();
      this.options.onDisconnected?.();
      if (this.started) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    const delayMs = this.nextReconnectMs;
    this.nextReconnectMs = Math.min(
      this.nextReconnectMs * 2,
      this.reconnectMaxMs,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delayMs);
  }

  private reportStatus(): void {
    // Heartbeat
    this.send({
      type: "heartbeat",
      broadcastId: this.options.broadcastId,
      peerId: this.options.peerId,
    });

    // Stats
    const stats = this.options.getStats?.();
    if (stats) {
      this.send({
        type: "report_stats",
        broadcastId: this.options.broadcastId,
        peerId: this.options.peerId,
        stats,
      });
    }

    // Segment possession
    this.reportSegments();
  }

  private handleMessage(raw: unknown): void {
    try {
      const msg = JSON.parse(raw as string) as WsServerMessage;
      if (msg.broadcastId !== this.options.broadcastId) return;

      switch (msg.type) {
        case "peer_list": {
          this.peers.clear();
          for (const peer of msg.peers) {
            this.peers.set(peer.id, { ...peer, segments: [...peer.segments] });
          }
          this.options.onPeerList?.([...this.peers.values()]);
          break;
        }
        case "peer_joined": {
          this.peers.set(msg.peer.id, {
            ...msg.peer,
            segments: [...msg.peer.segments],
          });
          this.options.onPeerJoined?.(msg.peer);
          break;
        }
        case "peer_left": {
          this.peers.delete(msg.peerId);
          this.options.onPeerLeft?.(msg.peerId);
          break;
        }
        case "segment_available": {
          const peer = this.peers.get(msg.peerId);
          if (peer) {
            peer.segments = [
              ...new Set([...peer.segments, ...msg.segments]),
            ];
          }
          this.options.onSegmentAvailable?.(msg.peerId, msg.segments);
          break;
        }
      }
    } catch (err) {
      console.error("[OpenStreamGrid] Invalid WebSocket message", err);
    }
  }

  private send(msg: WsClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private buildWsUrl(): string {
    const url = new URL("/ws", this.options.trackerUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.href;
  }
}
