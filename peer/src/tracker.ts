import {
  createLogger,
  type Peer,
  type PeerFailureReport,
  type PeerHeartbeat,
  type PeerJoinRequest,
  type PeerTrafficStats,
  type WsClientMessage,
  type WsServerMessage,
} from "@openstreamgrid/common";
import WebSocket, { type RawData } from "ws";
import type { PeerDirectory } from "./fetcher.js";
import { keepAliveFetch } from "./http-client.js";
import type { FetchFunction } from "./verifier.js";

const DEFAULT_REPORT_INTERVAL_MS = 5_000;
const DEFAULT_RECONNECT_INITIAL_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const RECONNECT_BACKOFF_MULTIPLIER = 2;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const WEBSOCKET_NORMAL_CLOSURE_CODE = 1_000;
const logger = createLogger("peer");

type JsonObject = Record<string, unknown>;
type PeerUpdateMessage = Extract<
  WsServerMessage,
  {
    type:
      | "peer_list"
      | "peer_joined"
      | "peer_left"
      | "segment_available"
      | "segment_inventory_delta";
  }
>;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const parseMetadata = (value: unknown): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    throw new TypeError("Peer metadata must contain only strings");
  }
  const metadata: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new TypeError("Peer metadata must contain only strings");
    }
    metadata[key] = item;
  }
  return metadata;
};

const parsePeer = (value: unknown): Peer => {
  if (!isObject(value)) throw new TypeError("Peer must be an object");
  const {
    id,
    address,
    segments,
    joinedAt,
    lastSeenAt,
    latencyMs,
    successRate,
    trustScore,
  } = value;
  if (
    typeof id !== "string" ||
    typeof address !== "string" ||
    !isStringArray(segments) ||
    typeof joinedAt !== "string" ||
    typeof lastSeenAt !== "string" ||
    typeof latencyMs !== "number" ||
    !Number.isFinite(latencyMs) ||
    typeof successRate !== "number" ||
    !Number.isFinite(successRate) ||
    typeof trustScore !== "number" ||
    !Number.isFinite(trustScore)
  ) {
    throw new TypeError("Peer contains invalid required fields");
  }
  if (
    value.uploadBandwidthBps !== undefined &&
    (typeof value.uploadBandwidthBps !== "number" ||
      !Number.isFinite(value.uploadBandwidthBps))
  ) {
    throw new TypeError("Peer upload bandwidth must be a finite number");
  }
  const metadata = parseMetadata(value.metadata);
  return {
    id,
    address,
    segments: [...segments],
    joinedAt,
    lastSeenAt,
    latencyMs,
    successRate,
    trustScore,
    ...(typeof value.uploadBandwidthBps === "number"
      ? { uploadBandwidthBps: value.uploadBandwidthBps }
      : {}),
    ...(metadata ? { metadata } : {}),
  };
};

const parsePeerSession = (value: unknown): {
  peer: Peer;
  sessionToken: string;
  expiresAt: number;
} => {
  if (
    !isObject(value) ||
    typeof value.sessionToken !== "string" ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    throw new TypeError("Peer session response is invalid");
  }
  return {
    peer: parsePeer(value.peer),
    sessionToken: value.sessionToken,
    expiresAt: Date.parse(value.expiresAt),
  };
};

const parsePeerUpdate = (data: RawData): PeerUpdateMessage | undefined => {
  const value: unknown = JSON.parse(data.toString());
  if (
    !isObject(value) ||
    typeof value.type !== "string" ||
    typeof value.broadcastId !== "string"
  ) {
    throw new TypeError("Tracker message is missing required fields");
  }
  const broadcastId = value.broadcastId;
  switch (value.type) {
    case "peer_list":
      if (!Array.isArray(value.peers)) {
        throw new TypeError("Tracker peer list must be an array");
      }
      return {
        type: "peer_list",
        broadcastId,
        peers: value.peers.map(parsePeer),
      };
    case "peer_joined":
      return { type: "peer_joined", broadcastId, peer: parsePeer(value.peer) };
    case "peer_left":
      if (typeof value.peerId !== "string") {
        throw new TypeError("Tracker peer ID must be a string");
      }
      return { type: "peer_left", broadcastId, peerId: value.peerId };
    case "segment_available":
      if (typeof value.peerId !== "string" || !isStringArray(value.segments)) {
        throw new TypeError("Tracker segment update is invalid");
      }
      return {
        type: "segment_available",
        broadcastId,
        peerId: value.peerId,
        segments: value.segments,
        ...(value.replace === true ? { replace: true } : {}),
      };
    case "segment_inventory_delta":
      if (
        typeof value.peerId !== "string" ||
        !isStringArray(value.added) ||
        !isStringArray(value.removed)
      ) {
        throw new TypeError("Tracker segment inventory delta is invalid");
      }
      return {
        type: "segment_inventory_delta",
        broadcastId,
        peerId: value.peerId,
        added: value.added,
        removed: value.removed,
      };
    default:
      return undefined;
  }
};

/** Configuration and callbacks used by the peer tracker client. */
export interface TrackerClientOptions {
  trackerUrl: string;
  apiKey?: string;
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
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Restores a previously issued session, primarily for reconnecting clients. */
  initialSessionToken?: string;
}

/** Maintains tracker membership, WebSocket updates, and periodic reports. */
export class TrackerClient implements PeerDirectory {
  private readonly fetchImpl: FetchFunction;
  private readonly webSocketFactory: (url: URL) => WebSocket;
  private readonly reportIntervalMs: number;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly peers = new Map<string, Peer>();
  private readonly lastReportedSegments = new Set<string>();
  private socket: WebSocket | undefined;
  private reportTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private nextReconnectMs: number;
  private started = false;
  private firstConnectionResolver: (() => void) | undefined;
  private firstConnectionPromise: Promise<void> | undefined;
  private sessionToken: string | undefined;
  private sessionRefreshTimer: NodeJS.Timeout | undefined;
  private joinRequest: PeerJoinRequest | undefined;

  constructor(private readonly options: TrackerClientOptions) {
    this.sessionToken = options.initialSessionToken;
    this.fetchImpl = options.fetchImpl ?? keepAliveFetch;
    this.webSocketFactory =
      options.webSocketFactory ??
      ((url) =>
        new WebSocket(
          url,
          options.apiKey
            ? { headers: { "X-API-Key": options.apiKey } }
            : undefined,
        ));
    this.reportIntervalMs =
      options.reportIntervalMs ?? DEFAULT_REPORT_INTERVAL_MS;
    this.reconnectInitialMs =
      options.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    for (const [label, value] of [
      ["Report interval", this.reportIntervalMs],
      ["Initial reconnect delay", this.reconnectInitialMs],
      ["Maximum reconnect delay", this.reconnectMaxMs],
      ["Startup timeout", this.startupTimeoutMs],
      ["Request timeout", this.requestTimeoutMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive integer`);
      }
    }
    if (this.reconnectMaxMs < this.reconnectInitialMs) {
      throw new Error("Maximum reconnect delay cannot be less than the initial delay");
    }
    this.nextReconnectMs = this.reconnectInitialMs;
  }

  async join(request: PeerJoinRequest): Promise<Peer> {
    const session = parsePeerSession(await this.requestJson(this.peersUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }));
    this.sessionToken = session.sessionToken;
    this.joinRequest = { ...request, ...(request.metadata ? { metadata: { ...request.metadata } } : {}) };
    this.scheduleSessionRefresh(session.expiresAt);
    return session.peer;
  }

  async leave(): Promise<void> {
    const response = await this.fetchImpl(
      new URL(
        `${this.peersUrl().pathname}/${encodeURIComponent(this.options.peerId)}`,
        this.options.trackerUrl,
      ),
      this.withAuthorization({
        method: "DELETE",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      }),
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Tracker leave returned HTTP ${response.status}`);
    }
    this.sessionToken = undefined;
    this.joinRequest = undefined;
  }

  start(signal?: AbortSignal): Promise<void> {
    if (!this.sessionToken) {
      return Promise.reject(new Error("Peer must join before tracker WebSocket startup"));
    }
    if (this.started) return this.firstConnectionPromise ?? Promise.resolve();
    this.started = true;
    this.reportTimer = setInterval(
      () => this.reportStatusSafely(),
      this.reportIntervalMs,
    );
    this.reportTimer.unref();
    this.firstConnectionPromise = new Promise<void>((resolve, reject) => {
      this.firstConnectionResolver = resolve;
      const timeout = setTimeout(() => {
        cleanup();
        this.stop();
        reject(new Error("Tracker WebSocket startup timed out"));
      }, this.startupTimeoutMs);
      timeout.unref();
      const onAbort = (): void => {
        cleanup();
        this.stop();
        reject(signal?.reason ?? new Error("Tracker startup aborted"));
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };
      const connected = this.firstConnectionResolver;
      this.firstConnectionResolver = () => {
        cleanup();
        connected?.();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      this.openSocket();
    });
    return this.firstConnectionPromise;
  }

  stop(): void {
    this.started = false;
    this.peers.clear();
    this.lastReportedSegments.clear();
    if (this.reportTimer) clearInterval(this.reportTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.sessionRefreshTimer) clearTimeout(this.sessionRefreshTimer);
    this.reportTimer = undefined;
    this.reconnectTimer = undefined;
    this.sessionRefreshTimer = undefined;
    this.firstConnectionResolver?.();
    this.firstConnectionResolver = undefined;
    this.firstConnectionPromise = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close(WEBSOCKET_NORMAL_CLOSURE_CODE, "Peer shutting down");
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

  getPeerSessionToken(): string {
    if (!this.sessionToken) throw new Error("Peer has not joined the tracker");
    return this.sessionToken;
  }

  reportSegments(): void {
    const current = new Set(this.options.segments());
    const added = [...current].filter(
      (segment) => !this.lastReportedSegments.has(segment),
    );
    const removed = [...this.lastReportedSegments].filter(
      (segment) => !current.has(segment),
    );
    if (added.length === 0 && removed.length === 0) return;
    if (!this.send({
      type: "report_segments",
      broadcastId: this.options.broadcastId,
      peerId: this.options.peerId,
      added,
      removed,
    })) return;
    this.lastReportedSegments.clear();
    for (const segment of current) this.lastReportedSegments.add(segment);
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
      logger.error("tracker_websocket_creation_failed", error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.once("open", () => {
      if (this.socket !== socket || !this.started) return;
      this.send({
        type: "subscribe",
        broadcastId: this.options.broadcastId,
        peerId: this.options.peerId,
      });
      this.reportStatusSafely();
      this.firstConnectionResolver?.();
      this.firstConnectionResolver = undefined;
    });
    socket.on("message", (data, isBinary) => {
      if (this.socket === socket && !isBinary) this.handleMessage(data);
    });
    socket.on("error", (error) => {
      if (this.socket === socket && this.started) {
        logger.error("tracker_websocket_error", error);
      }
    });
    socket.once("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.peers.clear();
      if (this.started) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    const delayMs = this.nextReconnectMs;
    this.nextReconnectMs = Math.min(
      this.nextReconnectMs * RECONNECT_BACKOFF_MULTIPLIER,
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

  private reportStatusSafely(): void {
    try {
      this.reportStatus();
    } catch (error) {
      if (this.started) logger.error("status_report_failed", error);
    }
  }

  private handleMessage(data: RawData): void {
    try {
      const message = parsePeerUpdate(data);
      if (!message) return;
      if (message.broadcastId !== this.options.broadcastId) return;
      if (message.type === "peer_list") {
        this.nextReconnectMs = this.reconnectInitialMs;
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
          peer.segments = message.replace
            ? [...message.segments]
            : [...new Set([...peer.segments, ...message.segments])];
        }
        return;
      }
      if (message.type === "segment_inventory_delta") {
        const peer = this.peers.get(message.peerId);
        if (!peer) return;
        const segments = new Set(peer.segments);
        for (const segment of message.removed) segments.delete(segment);
        for (const segment of message.added) segments.add(segment);
        peer.segments = [...segments];
      }
    } catch (error) {
      logger.error("invalid_tracker_message", error);
    }
  }

  private send(message: WsClientMessage): boolean {
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify(message));
        return true;
      } catch (error) {
        if (this.started) logger.error("tracker_message_send_failed", error);
      }
    }
    return false;
  }

  private webSocketUrl(): URL {
    const url = new URL("/ws", this.options.trackerUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (this.sessionToken) url.searchParams.set("sessionToken", this.sessionToken);
    return url;
  }

  private peersUrl(): URL {
    return new URL(
      `/api/v1/broadcasts/${encodeURIComponent(this.options.broadcastId)}/peers`,
      this.options.trackerUrl,
    );
  }

  private scheduleSessionRefresh(expiresAt: number): void {
    if (this.sessionRefreshTimer) clearTimeout(this.sessionRefreshTimer);
    const remainingMs = Math.max(1_000, expiresAt - Date.now() - 60_000);
    const delayMs = Math.min(MAX_TIMER_DELAY_MS, remainingMs);
    this.sessionRefreshTimer = setTimeout(() => {
      this.sessionRefreshTimer = undefined;
      if (remainingMs > MAX_TIMER_DELAY_MS) {
        this.scheduleSessionRefresh(expiresAt);
        return;
      }
      const request = this.joinRequest;
      if (!request) return;
      void this.join(request).catch((error: unknown) => {
        logger.error("peer_session_refresh_failed", error);
        this.scheduleSessionRefresh(Date.now() + 30_000);
      });
    }, delayMs);
    this.sessionRefreshTimer.unref();
  }

  private async requestJson(
    endpoint: URL,
    init?: RequestInit,
  ): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const response = await this.fetchImpl(
      endpoint,
      this.withAuthorization({ ...init, signal: init?.signal ?? timeoutSignal }),
    );
    if (!response.ok) {
      throw new Error(`Tracker returned HTTP ${response.status}`);
    }
    return response.json();
  }

  private withAuthorization(init: RequestInit = {}): RequestInit {
    const headers = new Headers(init.headers);
    if (this.options.apiKey) headers.set("X-API-Key", this.options.apiKey);
    if (this.sessionToken) headers.set("Authorization", `Bearer ${this.sessionToken}`);
    return { ...init, headers };
  }

  private copyPeer(peer: Peer): Peer {
    return {
      ...peer,
      segments: [...peer.segments],
      ...(peer.metadata ? { metadata: { ...peer.metadata } } : {}),
    };
  }
}
