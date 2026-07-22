import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  createLogger,
  parsePeerTrafficStats,
  type Peer,
  type PeerHeartbeat,
  type WebRtcSignalMessage,
  type WsServerMessage,
} from "@openstreamgrid/common";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import {
  PeerSessionTokenService,
  type PeerSessionClaims,
} from "./peer-session.js";
import type { TrackerStoreBackend } from "./store.js";

interface Subscription {
  broadcastId: string;
  peerId: string;
}

interface MessageBudget {
  tokens: number;
  updatedAt: number;
}

const MAX_BUFFERED_WEB_SOCKET_BYTES = 1024 * 1024;
const MAX_WEB_SOCKET_PAYLOAD_BYTES = 64 * 1024;
const MAX_SEGMENTS_PER_REPORT = 512;
const MAX_SEGMENT_ID_LENGTH = 512;
const MESSAGE_RATE_PER_SECOND = 20;
const MESSAGE_BURST = 40;
const MAX_CONNECTIONS_PER_IP = 20;
const INVALID_MESSAGE_CLOSE_CODE = 1_008;
const UNSUPPORTED_DATA_CLOSE_CODE = 1_003;
const MAX_CLOSE_REASON_LENGTH = 120;
const logger = createLogger("tracker");

/** Optional tracker lifecycle callbacks for downstream event consumers. */
export interface TrackerEvents {
  broadcastListChanged?(): void;
  peerJoined?(broadcastId: string, peer: Peer): void;
  peerLeft?(broadcastId: string, peerId: string): void;
  segmentsAvailable?(broadcastId: string, peerId: string, segments: string[]): void;
  statsUpdated?(broadcastId: string, peerId: string): void;
  peerListChanged?(broadcastId: string): void;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requiredString = (message: JsonObject, key: string): string => {
  const value = message[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`'${key}' must be a non-empty string`);
  }
  return value;
};

const optionalNumber = (
  message: JsonObject,
  key: string,
): number | undefined => {
  const value = message[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`'${key}' must be a finite number`);
  }
  return value;
};

const optionalNonNegativeNumber = (
  message: JsonObject,
  key: string,
): number | undefined => {
  const value = optionalNumber(message, key);
  if (value !== undefined && value < 0) {
    throw new Error(`'${key}' must be non-negative`);
  }
  return value;
};

const optionalUnitInterval = (
  message: JsonObject,
  key: string,
): number | undefined => {
  const value = optionalNumber(message, key);
  if (value !== undefined && (value < 0 || value > 1)) {
    throw new Error(`'${key}' must be between 0 and 1`);
  }
  return value;
};

const requiredSegments = (message: JsonObject): string[] => {
  const segments = message.segments;
  if (
    !Array.isArray(segments) ||
    segments.length > MAX_SEGMENTS_PER_REPORT ||
    segments.some(
      (segment) =>
        typeof segment !== "string" ||
        segment.length === 0 ||
        segment.length > MAX_SEGMENT_ID_LENGTH,
    )
  ) {
    throw new Error("'segments' must be an array of strings");
  }
  return segments;
};

/** Validates tracker WebSocket messages and broadcasts peer updates. */
export class TrackerWebSocketHub implements TrackerEvents {
  private readonly webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEB_SOCKET_PAYLOAD_BYTES,
  });
  private readonly subscriptions = new Map<WebSocket, Subscription>();
  private readonly sessions = new Map<WebSocket, PeerSessionClaims>();
  private readonly messageBudgets = new Map<WebSocket, MessageBudget>();
  private readonly connectionIps = new Map<WebSocket, string>();
  private readonly connectionsPerIp = new Map<string, number>();
  private readonly sessionExpiryTimers = new Map<WebSocket, NodeJS.Timeout>();

  constructor(
    private readonly server: Server,
    private readonly store: TrackerStoreBackend,
    private readonly downstreamEvents: TrackerEvents = {},
    private readonly peerSessions = new PeerSessionTokenService(),
  ) {
    this.server.on("upgrade", this.handleUpgrade);
    this.webSocketServer.on("connection", (socket) => {
      this.subscriptions.set(socket, { broadcastId: "", peerId: "" });
      this.messageBudgets.set(socket, {
        tokens: MESSAGE_BURST,
        updatedAt: Date.now(),
      });
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          socket.close(
            UNSUPPORTED_DATA_CLOSE_CODE,
            "Binary messages are not supported",
          );
          return;
        }
        if (!this.consumeMessageBudget(socket)) {
          socket.close(INVALID_MESSAGE_CLOSE_CODE, "Message rate limit exceeded");
          return;
        }
        this.handleMessage(socket, data);
      });
      socket.once("close", () => this.removeSocket(socket));
    });
  }

  peerJoined(broadcastId: string, peer: Peer): void {
    this.broadcast({ type: "peer_joined", broadcastId, peer });
    this.downstreamEvents.peerJoined?.(broadcastId, peer);
  }

  peerLeft(broadcastId: string, peerId: string): void {
    this.broadcast({ type: "peer_left", broadcastId, peerId });
    this.downstreamEvents.peerLeft?.(broadcastId, peerId);
  }

  segmentsAvailable(
    broadcastId: string,
    peerId: string,
    segments: string[],
    replace = false,
  ): void {
    this.broadcast({
      type: "segment_available",
      broadcastId,
      peerId,
      segments,
      ...(replace ? { replace: true } : {}),
    });
    this.downstreamEvents.segmentsAvailable?.(
      broadcastId,
      peerId,
      segments,
    );
  }

  statsUpdated(broadcastId: string, peerId: string): void {
    this.broadcast({
      type: "stats_update",
      broadcastId,
      peerId,
      stats: this.store.getBroadcastStats(broadcastId),
    });
    this.downstreamEvents.statsUpdated?.(broadcastId, peerId);
  }

  peerListChanged(broadcastId: string): void {
    this.downstreamEvents.peerListChanged?.(broadcastId);
  }

  broadcastListChanged(): void {
    this.downstreamEvents.broadcastListChanged?.();
  }

  async stop(): Promise<void> {
    this.server.off("upgrade", this.handleUpgrade);
    for (const socket of this.webSocketServer.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => {
      this.webSocketServer.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private readonly handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const url = new URL(request.url ?? "/", "http://tracker.local");
    if (url.pathname !== "/ws") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const claims = this.peerSessions.verify(url.searchParams.get("sessionToken") ?? undefined);
    if (!claims || !this.peerExists(claims)) {
      socket.end(
        "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    const clientIp = request.socket.remoteAddress ?? "unknown";
    if ((this.connectionsPerIp.get(clientIp) ?? 0) >= MAX_CONNECTIONS_PER_IP) {
      socket.end(
        "HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.sessions.set(webSocket, claims);
      this.connectionIps.set(webSocket, clientIp);
      this.connectionsPerIp.set(
        clientIp,
        (this.connectionsPerIp.get(clientIp) ?? 0) + 1,
      );
      this.webSocketServer.emit("connection", webSocket, request);
      const expiryTimer = setTimeout(
        () => webSocket.close(4_001, "Peer session expired"),
        Math.max(1, claims.expiresAt - Date.now()),
      );
      expiryTimer.unref();
      this.sessionExpiryTimers.set(webSocket, expiryTimer);
    });
  };

  private handleMessage(socket: WebSocket, data: RawData): void {
    try {
      const parsed: unknown = JSON.parse(data.toString());
      if (!isObject(parsed)) throw new Error("Message must be a JSON object");
      const type = requiredString(parsed, "type");
      const broadcastId = requiredString(parsed, "broadcastId");
      const peerId = requiredString(parsed, "peerId");

      if (type === "subscribe") {
        const claims = this.sessions.get(socket);
        if (
          !claims ||
          claims.broadcastId !== broadcastId ||
          claims.peerId !== peerId ||
          !this.peerExists(claims)
        ) {
          throw new Error("Subscription does not match the authenticated peer session");
        }
        this.subscriptions.set(socket, { broadcastId, peerId });
        this.send(socket, {
          type: "peer_list",
          broadcastId,
          peers: this.store.listPeers(broadcastId),
        });
        return;
      }

      this.requireSubscription(socket, broadcastId, peerId);
      if (type === "webrtc_offer" || type === "webrtc_answer") {
        this.relayWebRtcSignal({
          type,
          broadcastId,
          peerId,
          targetPeerId: requiredString(parsed, "targetPeerId"),
          requestId: requiredString(parsed, "requestId"),
          sdp: requiredString(parsed, "sdp"),
        });
        return;
      }
      if (type === "heartbeat") {
        const latencyMs = optionalNonNegativeNumber(parsed, "latencyMs");
        const uploadBandwidthBps = optionalNonNegativeNumber(
          parsed,
          "uploadBandwidthBps",
        );
        const successRate = optionalUnitInterval(parsed, "successRate");
        const heartbeat: PeerHeartbeat = {
          ...(latencyMs !== undefined ? { latencyMs } : {}),
          ...(uploadBandwidthBps !== undefined ? { uploadBandwidthBps } : {}),
          ...(successRate !== undefined ? { successRate } : {}),
        };
        this.store.heartbeat(broadcastId, peerId, heartbeat);
        this.peerListChanged(broadcastId);
        return;
      }
      if (type === "report_segments") {
        if (parsed.added !== undefined || parsed.removed !== undefined) {
          const added = requiredSegments({ segments: parsed.added ?? [] });
          const removed = requiredSegments({ segments: parsed.removed ?? [] });
          const peer = this.store
            .listPeers(broadcastId)
            .find((candidate) => candidate.id === peerId);
          if (!peer) throw new Error("Peer was not found");
          const next = new Set(peer.segments);
          for (const segment of removed) next.delete(segment);
          for (const segment of added) next.add(segment);
          this.store.reportSegments(broadcastId, peerId, [...next], true);
          this.broadcast({
            type: "segment_inventory_delta",
            broadcastId,
            peerId,
            added,
            removed,
          });
          return;
        }
        const segments = requiredSegments(parsed);
        if (parsed.replace !== undefined && typeof parsed.replace !== "boolean") {
          throw new Error("'replace' must be a boolean");
        }
        const replace = parsed.replace;
        if (replace && this.hasSameSegments(broadcastId, peerId, segments)) return;
        this.store.reportSegments(broadcastId, peerId, segments, replace);
        this.segmentsAvailable(broadcastId, peerId, segments, replace === true);
        return;
      }
      if (type === "report_stats") {
        this.store.reportStats(
          broadcastId,
          peerId,
          parsePeerTrafficStats(parsed.stats),
        );
        this.statsUpdated(broadcastId, peerId);
        return;
      }
      throw new Error(`Unsupported message type '${type}'`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Invalid message";
      socket.close(
        INVALID_MESSAGE_CLOSE_CODE,
        reason.slice(0, MAX_CLOSE_REASON_LENGTH),
      );
    }
  }

  private requireSubscription(
    socket: WebSocket,
    broadcastId: string,
    peerId: string,
  ): void {
    const subscription = this.subscriptions.get(socket);
    if (
      !subscription ||
      subscription.broadcastId !== broadcastId ||
      subscription.peerId !== peerId
    ) {
      throw new Error("Message does not match the WebSocket subscription");
    }
  }

  private hasSameSegments(
    broadcastId: string,
    peerId: string,
    segments: string[],
  ): boolean {
    const peer = this.store
      .listPeers(broadcastId)
      .find((candidate) => candidate.id === peerId);
    if (!peer) return false;
    const expected = new Set(segments);
    return (
      peer.segments.length === expected.size &&
      peer.segments.every((segment) => expected.has(segment))
    );
  }

  private relayWebRtcSignal(message: WebRtcSignalMessage): void {
    for (const [socket, subscription] of this.subscriptions) {
      if (
        subscription.broadcastId === message.broadcastId &&
        subscription.peerId === message.targetPeerId
      ) {
        this.send(socket, message);
      }
    }
  }

  private peerExists(claims: PeerSessionClaims): boolean {
    try {
      return this.store
        .listPeers(claims.broadcastId)
        .some((peer) => peer.id === claims.peerId);
    } catch {
      return false;
    }
  }

  private consumeMessageBudget(socket: WebSocket): boolean {
    const budget = this.messageBudgets.get(socket);
    if (!budget) return false;
    const now = Date.now();
    budget.tokens = Math.min(
      MESSAGE_BURST,
      budget.tokens + ((now - budget.updatedAt) / 1_000) * MESSAGE_RATE_PER_SECOND,
    );
    budget.updatedAt = now;
    if (budget.tokens < 1) return false;
    budget.tokens -= 1;
    return true;
  }

  private removeSocket(socket: WebSocket): void {
    const expiryTimer = this.sessionExpiryTimers.get(socket);
    if (expiryTimer) clearTimeout(expiryTimer);
    this.sessionExpiryTimers.delete(socket);
    this.subscriptions.delete(socket);
    this.sessions.delete(socket);
    this.messageBudgets.delete(socket);
    const clientIp = this.connectionIps.get(socket);
    this.connectionIps.delete(socket);
    if (!clientIp) return;
    const remaining = (this.connectionsPerIp.get(clientIp) ?? 1) - 1;
    if (remaining <= 0) this.connectionsPerIp.delete(clientIp);
    else this.connectionsPerIp.set(clientIp, remaining);
  }

  private broadcast(message: WsServerMessage): void {
    for (const [socket, subscription] of this.subscriptions) {
      if (subscription.broadcastId === message.broadcastId) {
        this.send(socket, message);
      }
    }
  }

  private send(socket: WebSocket, message: WsServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      if (socket.bufferedAmount > MAX_BUFFERED_WEB_SOCKET_BYTES) {
        socket.terminate();
        return;
      }
      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        logger.error("websocket_send_failed", error);
        socket.terminate();
      }
    }
  }
}
