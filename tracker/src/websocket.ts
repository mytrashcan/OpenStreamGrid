import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type {
  Peer,
  PeerHeartbeat,
  PeerTrafficStats,
  WsServerMessage,
} from "@openstreamgrid/common";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { TrackerStore } from "./store.js";

interface Subscription {
  broadcastId: string;
  peerId: string;
}

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

export class TrackerWebSocketHub implements TrackerEvents {
  private readonly webSocketServer = new WebSocketServer({ noServer: true });
  private readonly subscriptions = new Map<WebSocket, Subscription>();

  constructor(
    private readonly server: Server,
    private readonly store: TrackerStore,
    private readonly downstreamEvents: TrackerEvents = {},
  ) {
    this.server.on("upgrade", this.handleUpgrade);
    this.webSocketServer.on("connection", (socket) => {
      this.subscriptions.set(socket, { broadcastId: "", peerId: "" });
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          socket.close(1003, "Binary messages are not supported");
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
        this.store.listPeers(broadcastId);
        this.subscriptions.set(socket, { broadcastId, peerId });
        this.send(socket, {
          type: "peer_list",
          broadcastId,
          peers: this.store.listPeers(broadcastId),
        });
        return;
      }

      this.requireSubscription(socket, broadcastId, peerId);
      if (type === "heartbeat") {
        const latencyMs = optionalNumber(parsed, "latencyMs");
        const uploadBandwidthBps = optionalNumber(parsed, "uploadBandwidthBps");
        const successRate = optionalNumber(parsed, "successRate");
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
        const replace =
          typeof parsed.replace === "boolean" ? parsed.replace : undefined;
        this.store.reportSegments(broadcastId, peerId, segments, replace);
        this.segmentsAvailable(broadcastId, peerId, segments);
        return;
      }
      if (type === "report_stats") {
        if (!isObject(parsed.stats)) throw new Error("'stats' must be an object");
        this.store.reportStats(
          broadcastId,
          peerId,
          parsed.stats as unknown as PeerTrafficStats,
        );
        this.statsUpdated(broadcastId, peerId);
        return;
      }
      throw new Error(`Unsupported message type '${type}'`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Invalid message";
      socket.close(1008, reason.slice(0, 120));
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

  private broadcast(message: WsServerMessage): void {
    for (const [socket, subscription] of this.subscriptions) {
      if (subscription.broadcastId === message.broadcastId) {
        this.send(socket, message);
      }
    }
  }

  private send(socket: WebSocket, message: WsServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }
}
