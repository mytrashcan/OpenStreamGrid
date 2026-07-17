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
import type { TrackerStoreBackend } from "./store.js";

interface Subscription {
  broadcastId: string;
  peerId: string;
}

const MAX_BUFFERED_WEB_SOCKET_BYTES = 1024 * 1024;
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
    segments.some((segment) => typeof segment !== "string")
  ) {
    throw new Error("'segments' must be an array of strings");
  }
  return segments;
};

/** Validates tracker WebSocket messages and broadcasts peer updates. */
export class TrackerWebSocketHub implements TrackerEvents {
  private readonly webSocketServer = new WebSocketServer({ noServer: true });
  private readonly subscriptions = new Map<WebSocket, Subscription>();

  constructor(
    private readonly server: Server,
    private readonly store: TrackerStoreBackend,
    private readonly downstreamEvents: TrackerEvents = {},
  ) {
    this.server.on("upgrade", this.handleUpgrade);
    this.webSocketServer.on("connection", (socket) => {
      this.subscriptions.set(socket, { broadcastId: "", peerId: "" });
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          socket.close(
            UNSUPPORTED_DATA_CLOSE_CODE,
            "Binary messages are not supported",
          );
          return;
        }
        this.handleMessage(socket, data);
      });
      socket.once("close", () => this.subscriptions.delete(socket));
    });
  }

  peerJoined(broadcastId: string, peer: Peer): void {
    this.broadcast({ type: "peer_joined", broadcastId, peer });
    this.broadcastPeerList(broadcastId);
    this.downstreamEvents.peerJoined?.(broadcastId, peer);
  }

  peerLeft(broadcastId: string, peerId: string): void {
    this.broadcast({ type: "peer_left", broadcastId, peerId });
    this.broadcastPeerList(broadcastId);
    this.downstreamEvents.peerLeft?.(broadcastId, peerId);
  }

  segmentsAvailable(
    broadcastId: string,
    peerId: string,
    segments: string[],
  ): void {
    this.broadcast({
      type: "segment_available",
      broadcastId,
      peerId,
      segments,
    });
    this.broadcastPeerList(broadcastId);
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
    this.broadcastPeerList(broadcastId);
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
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.webSocketServer.emit("connection", webSocket, request);
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
        const segments = requiredSegments(parsed);
        if (parsed.replace !== undefined && typeof parsed.replace !== "boolean") {
          throw new Error("'replace' must be a boolean");
        }
        const replace = parsed.replace;
        if (replace && this.hasSameSegments(broadcastId, peerId, segments)) return;
        this.store.reportSegments(broadcastId, peerId, segments, replace);
        this.segmentsAvailable(broadcastId, peerId, segments);
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

  private broadcastPeerList(broadcastId: string): void {
    this.broadcast({
      type: "peer_list",
      broadcastId,
      peers: this.store.listPeers(broadcastId),
    });
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
