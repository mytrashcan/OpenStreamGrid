/**
 * Browser-native WebSocket client for OpenStreamGrid tracker communication.
 * Uses the native WebSocket API (not the `ws` npm package).
 * Implements exponential-backoff reconnection and periodic status reporting.
 */

import { createLogger } from "@openstreamgrid/common";
import type {
  PeerInfo,
  PeerTrafficStats,
  WsClientMessage,
  WsServerMessage,
} from "./types.js";

const DEFAULT_RECONNECT_INITIAL_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_REPORT_INTERVAL_MS = 5_000;
const RECONNECT_BACKOFF_MULTIPLIER = 2;
const WEBSOCKET_NORMAL_CLOSURE_CODE = 1_000;
const logger = createLogger("sdk");

type JsonObject = Record<string, unknown>;

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

const parsePeer = (value: unknown): PeerInfo => {
  if (!isObject(value)) throw new TypeError("Peer must be an object");
  const { id, address, segments, latencyMs, successRate, trustScore } = value;
  if (
    typeof id !== "string" ||
    typeof address !== "string" ||
    !isStringArray(segments) ||
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
  if (
    (value.joinedAt !== undefined && typeof value.joinedAt !== "string") ||
    (value.lastSeenAt !== undefined && typeof value.lastSeenAt !== "string")
  ) {
    throw new TypeError("Peer timestamps must be strings");
  }
  return {
    id,
    address,
    segments: [...segments],
    latencyMs,
    successRate,
    trustScore,
    ...(typeof value.uploadBandwidthBps === "number"
      ? { uploadBandwidthBps: value.uploadBandwidthBps }
      : {}),
    ...(metadata ? { metadata } : {}),
    ...(typeof value.joinedAt === "string" ? { joinedAt: value.joinedAt } : {}),
    ...(typeof value.lastSeenAt === "string"
      ? { lastSeenAt: value.lastSeenAt }
      : {}),
  };
};

const parseServerMessage = (raw: unknown): WsServerMessage => {
  if (typeof raw !== "string") {
    throw new TypeError("WebSocket message must be text");
  }
  const value: unknown = JSON.parse(raw);
  if (!isObject(value) || typeof value.type !== "string") {
    throw new TypeError("WebSocket message must be an object with a type");
  }
  if (typeof value.broadcastId !== "string") {
    throw new TypeError("WebSocket message broadcastId must be a string");
  }
  const broadcastId = value.broadcastId;
  switch (value.type) {
    case "peer_list":
      if (!Array.isArray(value.peers)) {
        throw new TypeError("Peer list must be an array");
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
        throw new TypeError("Peer ID must be a string");
      }
      return { type: "peer_left", broadcastId, peerId: value.peerId };
    case "segment_available":
      if (typeof value.peerId !== "string" || !isStringArray(value.segments)) {
        throw new TypeError("Segment availability message is invalid");
      }
      return {
        type: "segment_available",
        broadcastId,
        peerId: value.peerId,
        segments: value.segments,
      };
    case "stats_update":
      if (typeof value.peerId !== "string") {
        throw new TypeError("Peer ID must be a string");
      }
      return {
        type: "stats_update",
        broadcastId,
        peerId: value.peerId,
        stats: value.stats,
      };
    default:
      throw new TypeError(`Unsupported WebSocket message type '${value.type}'`);
  }
};

const callSafely = (label: string, callback: () => void): void => {
  try {
    callback();
  } catch (error) {
    logger.error("callback_failed", error, { callback: label });
  }
};

/** Browser tracker client callbacks and reconnection settings. */
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
  private firstConnectPromise: Promise<void> | null = null;
  /** Track known peers. */
  private readonly peers = new Map<string, PeerInfo>();

  constructor(private readonly options: WsClientOptions) {
    if (
      typeof options.broadcastId !== "string" ||
      options.broadcastId.trim() === ""
    ) {
      throw new Error("broadcastId must not be empty");
    }
    if (typeof options.peerId !== "string" || options.peerId.trim() === "") {
      throw new Error("peerId must not be empty");
    }
    let trackerUrl: URL;
    try {
      trackerUrl = new URL(options.trackerUrl);
    } catch {
      throw new Error("trackerUrl must be a valid absolute URL");
    }
    if (!["http:", "https:", "ws:", "wss:"].includes(trackerUrl.protocol)) {
      throw new Error("trackerUrl must use HTTP, HTTPS, WS, or WSS");
    }
    this.reconnectInitialMs =
      options.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
    this.reconnectMaxMs =
      options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.reportIntervalMs =
      options.reportIntervalMs ?? DEFAULT_REPORT_INTERVAL_MS;
    for (const [label, value] of [
      ["Report interval", this.reportIntervalMs],
      ["Initial reconnect delay", this.reconnectInitialMs],
      ["Maximum reconnect delay", this.reconnectMaxMs],
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

  /** Start the WebSocket connection. Resolves on first successful connection. */
  start(): Promise<void> {
    if (this.started) return this.firstConnectPromise ?? Promise.resolve();
    this.started = true;
    this.reportTimer = setInterval(
      () => this.reportStatusSafely(),
      this.reportIntervalMs,
    );
    this.firstConnectPromise = new Promise<void>((resolve) => {
      this.firstConnectResolve = resolve;
      this.openSocket();
    });
    return this.firstConnectPromise;
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
    this.firstConnectPromise = null;
    if (this.ws) {
      this.ws.onclose = null; // prevent reconnect
      this.ws.onerror = null;
      this.ws.onmessage = null;
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close(WEBSOCKET_NORMAL_CLOSURE_CODE, "Peer shutting down");
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
    } catch (error) {
      logger.error("websocket_creation_failed", error);
      this.scheduleReconnect();
      return;
    }

    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws || !this.started) return;

      // Subscribe to our broadcast
      this.send({
        type: "subscribe",
        broadcastId: this.options.broadcastId,
        peerId: this.options.peerId,
      });

      // Report initial status
      this.reportStatusSafely();

      this.firstConnectResolve?.();
      this.firstConnectResolve = null;
      callSafely("onConnected", () => this.options.onConnected?.());
    };

    ws.onmessage = (event: MessageEvent) => {
      if (this.ws === ws) this.handleMessage(event.data);
    };

    ws.onerror = (event: Event) => {
      if (this.ws === ws && this.started) {
        logger.error("websocket_error", new Error("Browser WebSocket error"));
        callSafely("onError", () => this.options.onError?.(event));
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.peers.clear();
      callSafely("onDisconnected", () => this.options.onDisconnected?.());
      if (this.started) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    const delayMs = this.nextReconnectMs;
    this.nextReconnectMs = Math.min(
      this.nextReconnectMs * RECONNECT_BACKOFF_MULTIPLIER,
      this.reconnectMaxMs,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delayMs);
  }

  private reportStatus(): void {
    this.send({
      type: "heartbeat",
      broadcastId: this.options.broadcastId,
      peerId: this.options.peerId,
    });

    const stats = this.options.getStats?.();
    if (stats) {
      this.send({
        type: "report_stats",
        broadcastId: this.options.broadcastId,
        peerId: this.options.peerId,
        stats,
      });
    }

    this.reportSegments();
  }

  private reportStatusSafely(): void {
    try {
      this.reportStatus();
    } catch (error) {
      if (this.started) {
        logger.error("status_report_failed", error);
      }
    }
  }

  private handleMessage(raw: unknown): void {
    try {
      const msg = parseServerMessage(raw);
      if (msg.broadcastId !== this.options.broadcastId) return;

      switch (msg.type) {
        case "peer_list": {
          this.nextReconnectMs = this.reconnectInitialMs;
          this.peers.clear();
          for (const peer of msg.peers) {
            this.peers.set(peer.id, { ...peer, segments: [...peer.segments] });
          }
          callSafely("onPeerList", () =>
            this.options.onPeerList?.([...this.peers.values()]),
          );
          break;
        }
        case "peer_joined": {
          this.peers.set(msg.peer.id, {
            ...msg.peer,
            segments: [...msg.peer.segments],
          });
          callSafely("onPeerJoined", () => this.options.onPeerJoined?.(msg.peer));
          break;
        }
        case "peer_left": {
          this.peers.delete(msg.peerId);
          callSafely("onPeerLeft", () => this.options.onPeerLeft?.(msg.peerId));
          break;
        }
        case "segment_available": {
          const peer = this.peers.get(msg.peerId);
          if (peer) {
            peer.segments = [
              ...new Set([...peer.segments, ...msg.segments]),
            ];
          }
          callSafely("onSegmentAvailable", () =>
            this.options.onSegmentAvailable?.(msg.peerId, msg.segments),
          );
          break;
        }
      }
    } catch (error) {
      logger.error("invalid_tracker_message", error);
    }
  }

  private send(msg: WsClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (error) {
        logger.error("tracker_message_send_failed", error);
      }
    }
  }

  private buildWsUrl(): string {
    const url = new URL("/ws", this.options.trackerUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.href;
  }
}
