import { clientAddress } from "./client-address.js";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  createLogger,
  parsePeerTrafficStats,
  WS_FEATURE_INVENTORY_BATCH,
  type Peer,
  type PeerHeartbeat,
  type SegmentInventoryUpdate,
  type WebRtcSignalMessage,
  type WsServerMessage,
} from "@openstreamgrid/common";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import {
  PeerSessionTokenService,
  bearerToken,
  type PeerSessionClaims,
} from "./peer-session.js";
import type { TrackerStoreBackend } from "./store.js";

interface Subscription {
  broadcastId: string;
  peerId: string;
  /** The client negotiated `inventory_batch` in its subscribe message. */
  inventoryBatch: boolean;
}

interface BroadcastSubscribers {
  /** Receive every inventory update as its own message. */
  immediate: Set<WebSocket>;
  /** Receive inventory updates merged into periodic batches. */
  batched: Set<WebSocket>;
}

/** Net inventory change for one peer since the last batch flush. */
type PendingInventory =
  | { replace: true; segments: Set<string> }
  | { replace: false; added: Set<string>; removed: Set<string> };

interface PendingInventoryBatch {
  updates: Map<string, PendingInventory>;
  timer: NodeJS.Timeout;
}

type InventoryMessage = Extract<
  WsServerMessage,
  { type: "segment_available" | "segment_inventory_delta" }
>;

interface MessageBudget {
  tokens: number;
  updatedAt: number;
}

const DEFAULT_INVENTORY_BATCH_INTERVAL_MS = 250;
const MAX_UPDATES_PER_BATCH = 256;
const MAX_SUBSCRIBE_FEATURES = 16;
const MAX_BUFFERED_WEB_SOCKET_BYTES = 1024 * 1024;
const MAX_WEB_SOCKET_PAYLOAD_BYTES = 64 * 1024;
const MAX_SEGMENTS_PER_REPORT = 512;
const MAX_SEGMENT_ID_LENGTH = 512;
const MESSAGE_RATE_PER_SECOND = 20;
const MESSAGE_BURST = 40;
const MAX_CONNECTIONS_PER_IP = 20;
const INVALID_MESSAGE_CLOSE_CODE = 1_008;
const BROADCAST_REMOVED_CLOSE_CODE = 4_004;
const UNSUPPORTED_DATA_CLOSE_CODE = 1_003;
const MAX_CLOSE_REASON_LENGTH = 120;
const logger = createLogger("tracker");

/** Optional tracker lifecycle callbacks for downstream event consumers. */
export interface TrackerEvents {
  broadcastListChanged?(): void;
  broadcastRemoved?(broadcastId: string): void;
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

/** Optional WebSocket hardening configuration. */
export interface TrackerWebSocketOptions {
  /**
   * Allowlist of Origin headers permitted on browser WS upgrades. An empty
   * list (default) permits all origins. Upgrades without an Origin header
   * (non-browser clients such as Node peers) are not subject to the list and
   * still require a valid peer session.
   */
  allowedOrigins?: string[];
  /** Concurrent WebSocket connections per client address (default 20). */
  maxConnectionsPerIp?: number;
  /** Reverse proxies in front of the tracker whose X-Forwarded-For is trusted. */
  trustProxyHops?: number;
  /**
   * How long inventory updates are merged before a batch is sent to clients
   * that negotiated `inventory_batch` (default 250 ms).
   */
  inventoryBatchIntervalMs?: number;
}

/** Validates tracker WebSocket messages and broadcasts peer updates. */
export class TrackerWebSocketHub implements TrackerEvents {
  private readonly webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEB_SOCKET_PAYLOAD_BYTES,
  });
  private readonly subscriptions = new Map<WebSocket, Subscription>();
  /** Subscribed sockets per broadcast, so fan-out skips other broadcasts. */
  private readonly subscribersByBroadcast = new Map<string, BroadcastSubscribers>();
  private readonly pendingInventory = new Map<string, PendingInventoryBatch>();
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
    private readonly options: TrackerWebSocketOptions = {},
  ) {
    this.server.on("upgrade", this.handleUpgrade);
    this.webSocketServer.on("connection", (socket) => {
      this.subscriptions.set(socket, {
        broadcastId: "",
        peerId: "",
        inventoryBatch: false,
      });
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
    // A pending update would otherwise reach clients after peer_left and
    // could resurrect the peer's inventory if the same ID rejoins.
    this.pendingInventory.get(broadcastId)?.updates.delete(peerId);
    this.broadcast({ type: "peer_left", broadcastId, peerId });
    this.downstreamEvents.peerLeft?.(broadcastId, peerId);
  }

  segmentsAvailable(
    broadcastId: string,
    peerId: string,
    segments: string[],
    replace = false,
  ): void {
    this.publishInventory({
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
    // Peers do not use broadcast-wide stats, so they are not fanned out over
    // WebSocket: recomputing and sending them to every peer on every report
    // made each report cost O(peers). The dashboard receives them over SSE.
    this.downstreamEvents.statsUpdated?.(broadcastId, peerId);
  }

  peerListChanged(broadcastId: string): void {
    this.downstreamEvents.peerListChanged?.(broadcastId);
  }

  broadcastListChanged(): void {
    this.downstreamEvents.broadcastListChanged?.();
  }

  broadcastRemoved(broadcastId: string): void {
    // The broadcast's peers are gone. Drop its pending batch and close its
    // subscribers so neither can leak into a new broadcast that reuses the ID.
    const batch = this.pendingInventory.get(broadcastId);
    if (batch) clearTimeout(batch.timer);
    this.pendingInventory.delete(broadcastId);
    for (const socket of [...this.subscribersOf(broadcastId)]) {
      this.unindexSubscription(socket);
      this.subscriptions.set(socket, {
        broadcastId: "",
        peerId: "",
        inventoryBatch: false,
      });
      socket.close(BROADCAST_REMOVED_CLOSE_CODE, "Broadcast removed");
    }
    this.downstreamEvents.broadcastRemoved?.(broadcastId);
  }

  async stop(): Promise<void> {
    this.server.off("upgrade", this.handleUpgrade);
    for (const batch of this.pendingInventory.values()) clearTimeout(batch.timer);
    this.pendingInventory.clear();
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
    if (!this.isOriginAllowed(request.headers.origin)) {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    // Prefer the Authorization header so the token stays out of URLs, access
    // logs, and intermediary proxies; the query parameter remains as a
    // fallback for browser clients that cannot set upgrade headers.
    const token =
      bearerToken(request.headers.authorization) ??
      url.searchParams.get("sessionToken") ??
      undefined;
    const claims = this.peerSessions.verify(token);
    if (!claims || !this.peerExists(claims)) {
      socket.end(
        "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    const clientIp = clientAddress(request, this.options.trustProxyHops ?? 0);
    const currentConnections = this.connectionsPerIp.get(clientIp) ?? 0;
    if (currentConnections >= (this.options.maxConnectionsPerIp ?? MAX_CONNECTIONS_PER_IP)) {
      socket.end(
        "HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    // Reserve the per-IP slot before the async upgrade completes so
    // concurrent upgrades cannot exceed the limit; roll it back if the
    // handshake fails before a WebSocket is established.
    this.connectionsPerIp.set(clientIp, currentConnections + 1);
    let reserved = false;
    const releaseReservation = (): void => {
      if (reserved) return;
      reserved = true;
      const remaining = (this.connectionsPerIp.get(clientIp) ?? 1) - 1;
      if (remaining <= 0) this.connectionsPerIp.delete(clientIp);
      else this.connectionsPerIp.set(clientIp, remaining);
    };
    socket.once("error", releaseReservation);
    socket.once("close", releaseReservation);
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      reserved = true;
      socket.off("error", releaseReservation);
      socket.off("close", releaseReservation);
      this.sessions.set(webSocket, claims);
      this.connectionIps.set(webSocket, clientIp);
      this.webSocketServer.emit("connection", webSocket, request);
      const expiryTimer = setTimeout(
        () => webSocket.close(4_001, "Peer session expired"),
        Math.max(1, claims.expiresAt - Date.now()),
      );
      expiryTimer.unref();
      this.sessionExpiryTimers.set(webSocket, expiryTimer);
    });
  };

  private isOriginAllowed(origin: string | undefined): boolean {
    const allowed = this.options.allowedOrigins ?? [];
    // Origin checks stop cross-site browser pages from connecting. Browsers
    // always send Origin on upgrades, while non-browser clients omit it and
    // could forge it anyway, so a missing header falls through to session auth.
    if (allowed.length === 0 || origin === undefined) return true;
    return allowed.includes(origin);
  }

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
        // Unknown features are ignored so clients can declare newer ones
        // against older trackers.
        const features = parsed.features;
        if (
          features !== undefined &&
          (!Array.isArray(features) ||
            features.length > MAX_SUBSCRIBE_FEATURES ||
            features.some((feature) => typeof feature !== "string"))
        ) {
          throw new Error("'features' must be an array of strings");
        }
        this.setSubscription(socket, {
          broadcastId,
          peerId,
          inventoryBatch:
            Array.isArray(features) && features.includes(WS_FEATURE_INVENTORY_BATCH),
        });
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
          this.store.applySegmentDelta(broadcastId, peerId, added, removed);
          this.publishInventory({
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
    for (const socket of this.subscribersOf(message.broadcastId)) {
      if (this.subscriptions.get(socket)?.peerId === message.targetPeerId) {
        this.send(socket, message);
      }
    }
  }

  private setSubscription(socket: WebSocket, subscription: Subscription): void {
    this.unindexSubscription(socket);
    this.subscriptions.set(socket, subscription);
    let subscribers = this.subscribersByBroadcast.get(subscription.broadcastId);
    if (!subscribers) {
      subscribers = { immediate: new Set(), batched: new Set() };
      this.subscribersByBroadcast.set(subscription.broadcastId, subscribers);
    }
    (subscription.inventoryBatch ? subscribers.batched : subscribers.immediate).add(socket);
  }

  private unindexSubscription(socket: WebSocket): void {
    const broadcastId = this.subscriptions.get(socket)?.broadcastId;
    if (!broadcastId) return;
    const subscribers = this.subscribersByBroadcast.get(broadcastId);
    if (!subscribers) return;
    subscribers.immediate.delete(socket);
    subscribers.batched.delete(socket);
    if (subscribers.immediate.size === 0 && subscribers.batched.size === 0) {
      this.subscribersByBroadcast.delete(broadcastId);
    }
  }

  private *subscribersOf(broadcastId: string): Iterable<WebSocket> {
    const subscribers = this.subscribersByBroadcast.get(broadcastId);
    if (!subscribers) return;
    yield* subscribers.immediate;
    yield* subscribers.batched;
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
    this.unindexSubscription(socket);
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
    const subscribers = this.subscribersByBroadcast.get(message.broadcastId);
    if (!subscribers) return;
    // Serialize once: fan-out sends the same payload to every subscriber.
    const payload = JSON.stringify(message);
    for (const socket of subscribers.immediate) this.sendSerialized(socket, payload);
    for (const socket of subscribers.batched) this.sendSerialized(socket, payload);
  }

  /**
   * Sends an inventory update to legacy subscribers right away and merges it
   * into the next batch for subscribers that negotiated `inventory_batch`.
   * Every report otherwise costs one message per peer in the broadcast, so
   * messages grow with the square of the audience; batching sends each
   * subscriber one message per interval for every 256 peers that changed.
   */
  private publishInventory(message: InventoryMessage): void {
    const subscribers = this.subscribersByBroadcast.get(message.broadcastId);
    if (!subscribers) return;
    if (subscribers.immediate.size > 0) {
      const payload = JSON.stringify(message);
      for (const socket of subscribers.immediate) this.sendSerialized(socket, payload);
    }
    if (subscribers.batched.size > 0) this.queueInventory(message);
  }

  private queueInventory(message: InventoryMessage): void {
    let batch = this.pendingInventory.get(message.broadcastId);
    if (!batch) {
      const timer = setTimeout(
        () => this.flushInventory(message.broadcastId),
        this.options.inventoryBatchIntervalMs ?? DEFAULT_INVENTORY_BATCH_INTERVAL_MS,
      );
      timer.unref();
      batch = { updates: new Map(), timer };
      this.pendingInventory.set(message.broadcastId, batch);
    }
    if (message.type === "segment_available" && message.replace) {
      batch.updates.set(message.peerId, {
        replace: true,
        segments: new Set(message.segments),
      });
      return;
    }
    const added = message.type === "segment_available" ? message.segments : message.added;
    const removed = message.type === "segment_available" ? [] : message.removed;
    // Merge in the order clients apply a delta: removals, then additions.
    const pending = batch.updates.get(message.peerId);
    if (pending?.replace) {
      for (const segment of removed) pending.segments.delete(segment);
      for (const segment of added) pending.segments.add(segment);
      return;
    }
    const delta = pending ?? { replace: false, added: new Set(), removed: new Set() };
    for (const segment of removed) {
      delta.added.delete(segment);
      delta.removed.add(segment);
    }
    for (const segment of added) {
      delta.removed.delete(segment);
      delta.added.add(segment);
    }
    batch.updates.set(message.peerId, delta);
  }

  private flushInventory(broadcastId: string): void {
    const batch = this.pendingInventory.get(broadcastId);
    this.pendingInventory.delete(broadcastId);
    const subscribers = this.subscribersByBroadcast.get(broadcastId)?.batched;
    if (!batch || !subscribers || subscribers.size === 0) return;
    const updates = [...batch.updates].map(
      ([peerId, pending]): SegmentInventoryUpdate =>
        pending.replace
          ? { peerId, segments: [...pending.segments], replace: true }
          : { peerId, added: [...pending.added], removed: [...pending.removed] },
    );
    for (let start = 0; start < updates.length; start += MAX_UPDATES_PER_BATCH) {
      const payload = JSON.stringify({
        type: "segment_inventory_batch",
        broadcastId,
        updates: updates.slice(start, start + MAX_UPDATES_PER_BATCH),
      } satisfies WsServerMessage);
      for (const socket of subscribers) this.sendSerialized(socket, payload);
    }
  }

  private send(socket: WebSocket, message: WsServerMessage): void {
    this.sendSerialized(socket, JSON.stringify(message));
  }

  private sendSerialized(socket: WebSocket, payload: string): void {
    if (socket.readyState === WebSocket.OPEN) {
      if (socket.bufferedAmount > MAX_BUFFERED_WEB_SOCKET_BYTES) {
        socket.terminate();
        return;
      }
      try {
        socket.send(payload);
      } catch (error) {
        logger.error("websocket_send_failed", error);
        socket.terminate();
      }
    }
  }
}
