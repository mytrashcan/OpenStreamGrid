import type {
  Peer,
  PeerFailureReport,
  PeerHeartbeat,
  PeerJoinRequest,
  PeerTrafficStats,
  WsClientMessage,
  WsServerMessage,
} from "@openstreamgrid/common";
import WebSocket, { type RawData } from "ws";
import type { PeerDirectory } from "./fetcher.js";
import type { FetchFunction } from "./verifier.js";

const DEFAULT_REPORT_INTERVAL_MS = 5_000;
const DEFAULT_RECONNECT_INITIAL_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

export interface TrackerClientOptions {
  trackerUrl: string;
  broadcastId: string;
  peerId: string;
  heartbeat: () => PeerHeartbeat;
  stats: () => PeerTrafficStats;
  segments: () => string[];
  fetchImpl?: FetchFunction;
  webSocketFactory?: (url: URL) => WebSocket;
  reportIntervalMs?: number;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
}

export class TrackerClient implements PeerDirectory {
  private readonly fetchImpl: FetchFunction;
  private readonly webSocketFactory: (url: URL) => WebSocket;
  private readonly reportIntervalMs: number;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly peers = new Map<string, Peer>();
  private socket: WebSocket | undefined;
  private reportTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private nextReconnectMs: number;
  private started = false;
  private firstConnectionResolver: (() => void) | undefined;

  constructor(private readonly options: TrackerClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocketFactory =
      options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.reportIntervalMs =
      options.reportIntervalMs ?? DEFAULT_REPORT_INTERVAL_MS;
    this.reconnectInitialMs =
      options.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.nextReconnectMs = this.reconnectInitialMs;
  }

  async join(request: PeerJoinRequest): Promise<Peer> {
    return this.requestJson<Peer>(this.peersUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  async leave(): Promise<void> {
    const response = await this.fetchImpl(
      new URL(
        `${this.peersUrl().pathname}/${encodeURIComponent(this.options.peerId)}`,
        this.options.trackerUrl,
      ),
      { method: "DELETE" },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Tracker leave returned HTTP ${response.status}`);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.reportTimer = setInterval(
      () => this.reportStatus(),
      this.reportIntervalMs,
    );
    this.reportTimer.unref();
    await new Promise<void>((resolve) => {
      this.firstConnectionResolver = resolve;
      this.openSocket();
    });
  }

  stop(): void {
    this.started = false;
    this.peers.clear();
    if (this.reportTimer) clearInterval(this.reportTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reportTimer = undefined;
    this.reconnectTimer = undefined;
    this.firstConnectionResolver?.();
    this.firstConnectionResolver = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close(1000, "Peer shutting down");
    }
  }

  async listPeers(segmentName: string): Promise<Peer[]> {
    return [...this.peers.values()]
      .filter((peer) => peer.segments.includes(segmentName))
      .map((peer) => this.copyPeer(peer));
  }

  allPeers(): Peer[] {
    return [...this.peers.values()].map((peer) => this.copyPeer(peer));
  }

  reportSegments(): void {
    this.send({
      type: "report_segments",
      broadcastId: this.options.broadcastId,
      peerId: this.options.peerId,
      segments: this.options.segments(),
      replace: true,
    });
  }

  async reportFailure(
    peerId: string,
    reason: PeerFailureReport["reason"],
  ): Promise<void> {
    const endpoint = new URL(
      `${this.peersUrl().pathname}/${encodeURIComponent(peerId)}/reports`,
      this.options.trackerUrl,
    );
    await this.requestJson(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reporterId: this.options.peerId, reason }),
    });
  }

  private openSocket(): void {
    if (!this.started || this.socket) return;
    let socket: WebSocket;
    try {
      socket = this.webSocketFactory(this.webSocketUrl());
    } catch (error) {
      console.error("failed to create tracker WebSocket", error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.once("open", () => {
      if (this.socket !== socket || !this.started) return;
      this.nextReconnectMs = this.reconnectInitialMs;
      this.send({
        type: "subscribe",
        broadcastId: this.options.broadcastId,
        peerId: this.options.peerId,
      });
      this.reportStatus();
      this.firstConnectionResolver?.();
      this.firstConnectionResolver = undefined;
    });
    socket.on("message", (data, isBinary) => {
      if (!isBinary) this.handleMessage(data);
    });
    socket.on("error", (error) => {
      if (this.started) console.error("tracker WebSocket error", error);
    });
    socket.once("close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.peers.clear();
      if (this.started) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    const delayMs = this.nextReconnectMs;
    this.nextReconnectMs = Math.min(
      this.nextReconnectMs * 2,
      this.reconnectMaxMs,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket();
    }, delayMs);
    this.reconnectTimer.unref();
  }

  private reportStatus(): void {
    const heartbeat = this.options.heartbeat();
    this.send({
      type: "heartbeat",
      broadcastId: this.options.broadcastId,
      peerId: this.options.peerId,
      ...heartbeat,
    });
    this.send({
      type: "report_stats",
      broadcastId: this.options.broadcastId,
      peerId: this.options.peerId,
      stats: this.options.stats(),
    });
    this.reportSegments();
  }

  private handleMessage(data: RawData): void {
    try {
      const message = JSON.parse(data.toString()) as WsServerMessage;
      if (message.broadcastId !== this.options.broadcastId) return;
      if (message.type === "peer_list") {
        this.peers.clear();
        for (const peer of message.peers) this.peers.set(peer.id, this.copyPeer(peer));
        return;
      }
      if (message.type === "peer_joined") {
        this.peers.set(message.peer.id, this.copyPeer(message.peer));
        return;
      }
      if (message.type === "peer_left") {
        this.peers.delete(message.peerId);
        return;
      }
      if (message.type === "segment_available") {
        const peer = this.peers.get(message.peerId);
        if (peer) {
          peer.segments = [...new Set([...peer.segments, ...message.segments])];
        }
      }
    } catch (error) {
      console.error("tracker sent an invalid WebSocket message", error);
    }
  }

  private send(message: WsClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private webSocketUrl(): URL {
    const url = new URL("/ws", this.options.trackerUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url;
  }

  private peersUrl(): URL {
    return new URL(
      `/api/v1/broadcasts/${encodeURIComponent(this.options.broadcastId)}/peers`,
      this.options.trackerUrl,
    );
  }

  private async requestJson<T = unknown>(
    endpoint: URL,
    init?: RequestInit,
  ): Promise<T> {
    const response = await this.fetchImpl(endpoint, init);
    if (!response.ok) {
      throw new Error(`Tracker returned HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }

  private copyPeer(peer: Peer): Peer {
    return {
      ...peer,
      segments: [...peer.segments],
      ...(peer.metadata ? { metadata: { ...peer.metadata } } : {}),
    };
  }
}
