import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import type {
  Broadcast,
  BroadcastRegistration,
  BroadcastStats,
  GlobalStats,
  PeerFailureReport,
  PeerHeartbeat,
  PeerJoinRequest,
  SegmentPossessionReport,
} from "@openstreamgrid/common";
import { parsePeerTrafficStats } from "@openstreamgrid/common";
import { SQLiteStore } from "./sqlite-store.js";
import {
  StoreError,
  TrackerStore,
  type TrackerStoreBackend,
} from "./store.js";
import { TrackerWebSocketHub, type TrackerEvents } from "./websocket.js";

const DEFAULT_PORT = 7070;
const DEFAULT_STALE_PEER_MS = 30_000;
const STATS_EVENT_INTERVAL_MS = 3_000;
const MAX_BODY_BYTES = 1_000_000;
const DASHBOARD_HTML_URL = new URL("./dashboard.html", import.meta.url);

let dashboardHtml: Promise<string> | undefined;

type JsonObject = Record<string, unknown>;

export interface TrackerStatsSnapshot {
  generatedAt: string;
  global: GlobalStats;
  broadcasts: Array<{
    broadcast: Broadcast;
    stats: BroadcastStats;
  }>;
}

type StatsEventName = "broadcasts" | "stats";

export class TrackerStatsSse implements TrackerEvents {
  private readonly clients = new Set<ServerResponse>();
  private eventSequence = 0;
  private publishTimer: NodeJS.Timeout | undefined;

  constructor(private readonly store: TrackerStoreBackend) {}

  connect(response: ServerResponse): void {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.flushHeaders();
    response.write("retry: 3000\n\n");
    this.clients.add(response);
    response.once("close", () => {
      this.clients.delete(response);
      this.stopTimerWhenIdle();
    });
    this.publishTo(response, "stats");
    this.startTimer();
  }

  broadcastListChanged(): void {
    this.publish("broadcasts");
  }

  peerJoined(): void {
    this.publish("broadcasts");
  }

  peerLeft(): void {
    this.publish("broadcasts");
  }

  statsUpdated(): void {
    this.publish("stats");
  }

  stop(): void {
    if (this.publishTimer) clearInterval(this.publishTimer);
    this.publishTimer = undefined;
    for (const client of this.clients) client.end();
    this.clients.clear();
  }

  private snapshot(): TrackerStatsSnapshot {
    return {
      generatedAt: new Date().toISOString(),
      global: this.store.getGlobalStats(),
      broadcasts: this.store.listBroadcasts().map((broadcast) => ({
        broadcast,
        stats: this.store.getBroadcastStats(broadcast.id),
      })),
    };
  }

  private publish(eventName: StatsEventName): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify(this.snapshot());
    const eventId = ++this.eventSequence;
    for (const client of this.clients) {
      this.writeEvent(client, eventName, eventId, payload);
    }
  }

  private publishTo(
    client: ServerResponse,
    eventName: StatsEventName,
  ): void {
    this.writeEvent(
      client,
      eventName,
      ++this.eventSequence,
      JSON.stringify(this.snapshot()),
    );
  }

  private writeEvent(
    client: ServerResponse,
    eventName: StatsEventName,
    eventId: number,
    payload: string,
  ): void {
    if (client.destroyed || client.writableEnded) {
      this.clients.delete(client);
      return;
    }
    if (client.writableNeedDrain) return;
    client.write(`event: ${eventName}\nid: ${eventId}\ndata: ${payload}\n\n`);
  }

  private startTimer(): void {
    if (this.publishTimer) return;
    this.publishTimer = setInterval(
      () => this.publish("stats"),
      STATS_EVENT_INTERVAL_MS,
    );
    this.publishTimer.unref();
  }

  private stopTimerWhenIdle(): void {
    if (this.clients.size > 0 || !this.publishTimer) return;
    clearInterval(this.publishTimer);
    this.publishTimer = undefined;
  }
}

class RequestError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void => {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
};

const sendHtml = (
  response: ServerResponse,
  statusCode: number,
  body: string,
): void => {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-cache",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
};

const loadDashboardHtml = (): Promise<string> => {
  dashboardHtml ??= readFile(DASHBOARD_HTML_URL, "utf8");
  return dashboardHtml;
};

const sendEmpty = (response: ServerResponse, statusCode: number): void => {
  response.writeHead(statusCode);
  response.end();
};

const readJson = async (request: IncomingMessage): Promise<JsonObject> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new RequestError("Request body is too large", 413);
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as JsonObject;
  } catch {
    throw new RequestError("Request body must be a JSON object");
  }
};

const requiredString = (body: JsonObject, key: string): string => {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new RequestError(`'${key}' must be a non-empty string`);
  }
  return value;
};

const optionalNumber = (body: JsonObject, key: string): number | undefined => {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RequestError(`'${key}' must be a finite number`);
  }
  return value;
};

const optionalMetadata = (
  body: JsonObject,
): Record<string, string> | undefined => {
  const value = body.metadata;
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError("'metadata' must be an object of strings");
  }
  const metadata: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new RequestError("'metadata' must be an object of strings");
    }
    metadata[key] = item;
  }
  return metadata;
};

const stringArray = (body: JsonObject, key: string): string[] => {
  const value = body[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new RequestError(`'${key}' must be an array of strings`);
  }
  return value;
};

const decodedPathComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new RequestError("URL path contains invalid percent encoding");
  }
};

export const createTrackerHandler = (
  store: TrackerStoreBackend,
  events: TrackerEvents = {},
  statsEvents?: TrackerStatsSse,
) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://tracker.local");
      const path = url.pathname;

      if (method === "GET" && path === "/health") {
        sendJson(response, 200, { status: "ok", service: "tracker" });
        return;
      }
      if (method === "GET" && path === "/dashboard") {
        sendHtml(response, 200, await loadDashboardHtml());
        return;
      }
      if (method === "GET" && path === "/api/v1/stats") {
        sendJson(response, 200, store.getGlobalStats());
        return;
      }
      if (method === "GET" && path === "/api/v1/stats/events") {
        if (!statsEvents) {
          throw new RequestError("Stats event stream is unavailable", 503);
        }
        statsEvents.connect(response);
        return;
      }
      if (path === "/api/v1/broadcasts" && method === "POST") {
        const body = await readJson(request);
        const metadata = optionalMetadata(body);
        const registration: BroadcastRegistration = {
          id: requiredString(body, "id"),
          playlistUrl: requiredString(body, "playlistUrl"),
          ...(metadata ? { metadata } : {}),
        };
        const result = store.registerBroadcast(registration);
        sendJson(response, result.created ? 201 : 200, result.broadcast);
        events.broadcastListChanged?.();
        return;
      }
      if (path === "/api/v1/broadcasts" && method === "GET") {
        sendJson(response, 200, { broadcasts: store.listBroadcasts() });
        return;
      }

      const statsMatch = path.match(/^\/api\/v1\/broadcasts\/([^/]+)\/stats$/);
      if (statsMatch?.[1] && method === "GET") {
        sendJson(response, 200, store.getBroadcastStats(decodedPathComponent(statsMatch[1])));
        return;
      }

      const peerActionMatch = path.match(
        /^\/api\/v1\/broadcasts\/([^/]+)\/peers\/([^/]+)\/(segments|heartbeat|stats|reports)$/,
      );
      if (peerActionMatch?.[1] && peerActionMatch[2] && peerActionMatch[3]) {
        const broadcastId = decodedPathComponent(peerActionMatch[1]);
        const peerId = decodedPathComponent(peerActionMatch[2]);
        const action = peerActionMatch[3];
        const body = await readJson(request);
        if (action === "segments" && method === "POST") {
          const report: SegmentPossessionReport = {
            segments: stringArray(body, "segments"),
            ...(typeof body.replace === "boolean" ? { replace: body.replace } : {}),
          };
          const peer = store.reportSegments(
            broadcastId,
            peerId,
            report.segments,
            report.replace,
          );
          sendJson(response, 200, peer);
          events.segmentsAvailable?.(broadcastId, peerId, report.segments);
          return;
        }
        if (action === "heartbeat" && method === "PUT") {
          const latencyMs = optionalNumber(body, "latencyMs");
          const uploadBandwidthBps = optionalNumber(
            body,
            "uploadBandwidthBps",
          );
          const successRate = optionalNumber(body, "successRate");
          const heartbeat: PeerHeartbeat = {
            ...(latencyMs !== undefined ? { latencyMs } : {}),
            ...(uploadBandwidthBps !== undefined ? { uploadBandwidthBps } : {}),
            ...(successRate !== undefined ? { successRate } : {}),
          };
          sendJson(response, 200, store.heartbeat(broadcastId, peerId, heartbeat));
          events.peerListChanged?.(broadcastId);
          return;
        }
        if (action === "stats" && method === "POST") {
          let stats;
          try {
            stats = parsePeerTrafficStats(body.stats);
          } catch (error) {
            throw new RequestError(
              error instanceof Error ? error.message : "'stats' is invalid",
            );
          }
          store.reportStats(broadcastId, peerId, stats);
          sendEmpty(response, 204);
          events.statsUpdated?.(broadcastId, peerId);
          return;
        }
        if (action === "reports" && method === "POST") {
          const reason = body.reason;
          if (
            reason !== "connection" &&
            reason !== "timeout" &&
            reason !== "integrity" &&
            reason !== "http"
          ) {
            throw new RequestError("'reason' is invalid");
          }
          const report: PeerFailureReport = {
            reporterId: requiredString(body, "reporterId"),
            reason,
          };
          sendJson(response, 200, store.reportPeerFailure(broadcastId, peerId, report));
          events.peerListChanged?.(broadcastId);
          return;
        }
      }

      const peerMatch = path.match(
        /^\/api\/v1\/broadcasts\/([^/]+)\/peers(?:\/([^/]+))?$/,
      );
      if (peerMatch?.[1]) {
        const broadcastId = decodedPathComponent(peerMatch[1]);
        const encodedPeerId = peerMatch[2];
        if (!encodedPeerId && method === "POST") {
          const body = await readJson(request);
          const uploadBandwidthBps = optionalNumber(body, "uploadBandwidthBps");
          const metadata = optionalMetadata(body);
          const join: PeerJoinRequest = {
            id: requiredString(body, "id"),
            address: requiredString(body, "address"),
            ...(uploadBandwidthBps !== undefined ? { uploadBandwidthBps } : {}),
            ...(metadata ? { metadata } : {}),
          };
          const peer = store.joinPeer(broadcastId, join);
          sendJson(response, 201, peer);
          events.peerJoined?.(broadcastId, peer);
          return;
        }
        if (!encodedPeerId && method === "GET") {
          const segment = url.searchParams.get("segment") ?? undefined;
          sendJson(response, 200, {
            peers: store.listPeers(broadcastId, segment),
          });
          return;
        }
        if (encodedPeerId && method === "DELETE") {
          const peerId = decodedPathComponent(encodedPeerId);
          store.leavePeer(broadcastId, peerId);
          sendEmpty(response, 204);
          events.peerLeft?.(broadcastId, peerId);
          return;
        }
      }

      const broadcastMatch = path.match(/^\/api\/v1\/broadcasts\/([^/]+)$/);
      if (broadcastMatch?.[1]) {
        const broadcastId = decodedPathComponent(broadcastMatch[1]);
        if (method === "GET") {
          sendJson(response, 200, {
            broadcast: store.getBroadcast(broadcastId),
            peers: store.listPeers(broadcastId),
          });
          return;
        }
        if (method === "DELETE") {
          store.unregisterBroadcast(broadcastId);
          sendEmpty(response, 204);
          events.broadcastListChanged?.();
          return;
        }
      }

      sendJson(response, 404, { error: "Route not found" });
    } catch (error) {
      const statusCode =
        error instanceof StoreError || error instanceof RequestError
          ? error.statusCode
          : 500;
      const message = error instanceof Error ? error.message : "Internal server error";
      if (statusCode === 500) {
        console.error("tracker request failed", error);
      }
      if (!response.headersSent) {
        sendJson(response, statusCode, { error: message });
      } else {
        response.destroy();
      }
    }
  };

export type TrackerStoreFactory = () => TrackerStoreBackend;

export const createConfiguredStore = (
  environment: NodeJS.ProcessEnv = process.env,
): TrackerStoreBackend => {
  const storeType = (environment.STORE_TYPE ?? "sqlite").toLowerCase();
  if (storeType === "memory") return new TrackerStore();
  if (storeType === "sqlite") return new SQLiteStore(environment.DB_PATH);
  throw new Error(
    `Unsupported STORE_TYPE '${environment.STORE_TYPE}'. Expected 'sqlite' or 'memory'`,
  );
};

export class TrackerServer {
  readonly store: TrackerStoreBackend;
  private readonly server;
  private readonly webSockets: TrackerWebSocketHub;
  private readonly statsEvents: TrackerStatsSse;
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(
    storeFactory: TrackerStoreFactory = createConfiguredStore,
    private readonly stalePeerMs = DEFAULT_STALE_PEER_MS,
  ) {
    const store = storeFactory();
    this.store = store;
    this.statsEvents = new TrackerStatsSse(store);
    let webSockets: TrackerWebSocketHub | undefined;
    const events: TrackerEvents = {
      peerJoined: (broadcastId, peer) =>
        webSockets?.peerJoined(broadcastId, peer),
      peerLeft: (broadcastId, peerId) =>
        webSockets?.peerLeft(broadcastId, peerId),
      segmentsAvailable: (broadcastId, peerId, segments) =>
        webSockets?.segmentsAvailable(broadcastId, peerId, segments),
      statsUpdated: (broadcastId, peerId) =>
        webSockets?.statsUpdated(broadcastId, peerId),
      peerListChanged: (broadcastId) =>
        webSockets?.peerListChanged(broadcastId),
      broadcastListChanged: () => webSockets?.broadcastListChanged(),
    };
    this.server = createServer(
      createTrackerHandler(store, events, this.statsEvents),
    );
    webSockets = new TrackerWebSocketHub(this.server, store, this.statsEvents);
    this.webSockets = webSockets;
  }

  async start(port = DEFAULT_PORT, host = "0.0.0.0"): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.cleanupTimer = setInterval(
      () => {
        try {
          this.removeStalePeers();
        } catch (error) {
          console.error("failed to remove stale peers", error);
        }
      },
      Math.max(1_000, Math.floor(this.stalePeerMs / 2)),
    );
    this.cleanupTimer.unref();
    const address = this.server.address();
    return typeof address === "object" && address ? address.port : port;
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    if (!this.server.listening) {
      this.store.close();
      return;
    }
    this.statsEvents.stop();
    try {
      await this.webSockets.stop();
      await new Promise<void>((resolve, reject) => {
        this.server.close((error) => (error ? reject(error) : resolve()));
      });
    } finally {
      this.store.close();
    }
  }

  private removeStalePeers(): void {
    const peersBefore = new Map(
      this.store.listBroadcasts().map((broadcast) => [
        broadcast.id,
        new Set(this.store.listPeers(broadcast.id).map((peer) => peer.id)),
      ]),
    );
    if (this.store.removeStalePeers(this.stalePeerMs) === 0) return;
    for (const [broadcastId, peerIds] of peersBefore) {
      const activePeerIds = new Set(
        this.store.listPeers(broadcastId).map((peer) => peer.id),
      );
      for (const peerId of peerIds) {
        if (!activePeerIds.has(peerId)) {
          this.webSockets.peerLeft(broadcastId, peerId);
        }
      }
    }
  }
}

const run = async (): Promise<void> => {
  const port = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  const stalePeerMs = Number.parseInt(
    process.env.STALE_PEER_MS ?? String(DEFAULT_STALE_PEER_MS),
    10,
  );
  const server = new TrackerServer(createConfiguredStore, stalePeerMs);
  await server.start(port);
  console.log(JSON.stringify({ event: "tracker_started", port }));

  const shutdown = async (signal: string): Promise<void> => {
    console.log(JSON.stringify({ event: "tracker_stopping", signal }));
    await server.stop();
    process.exit(0);
  };
  const requestShutdown = (signal: string): void => {
    void shutdown(signal).catch((error: unknown) => {
      console.error("tracker shutdown failed", error);
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", () => requestShutdown("SIGTERM"));
  process.once("SIGINT", () => requestShutdown("SIGINT"));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error: unknown) => {
    console.error("tracker failed to start", error);
    process.exit(1);
  });
}
