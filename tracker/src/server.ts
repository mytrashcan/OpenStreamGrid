import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import type {
  BroadcastRegistration,
  PeerFailureReport,
  PeerHeartbeat,
  PeerJoinRequest,
  PeerStatsReport,
  SegmentPossessionReport,
} from "@openstreamgrid/common";
import { StoreError, TrackerStore } from "./store.js";

const DEFAULT_PORT = 7070;
const DEFAULT_STALE_PEER_MS = 30_000;
const MAX_BODY_BYTES = 1_000_000;

type JsonObject = Record<string, unknown>;

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
  for (const item of Object.values(value)) {
    if (typeof item !== "string") {
      throw new RequestError("'metadata' must be an object of strings");
    }
  }
  return value as Record<string, string>;
};

const stringArray = (body: JsonObject, key: string): string[] => {
  const value = body[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new RequestError(`'${key}' must be an array of strings`);
  }
  return value;
};

export const createTrackerHandler = (store: TrackerStore) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://tracker.local");
      const path = url.pathname;

      if (method === "GET" && path === "/health") {
        sendJson(response, 200, { status: "ok", service: "tracker" });
        return;
      }
      if (method === "GET" && path === "/api/v1/stats") {
        sendJson(response, 200, store.getGlobalStats());
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
        return;
      }
      if (path === "/api/v1/broadcasts" && method === "GET") {
        sendJson(response, 200, { broadcasts: store.listBroadcasts() });
        return;
      }

      const statsMatch = path.match(/^\/api\/v1\/broadcasts\/([^/]+)\/stats$/);
      if (statsMatch?.[1] && method === "GET") {
        sendJson(response, 200, store.getBroadcastStats(decodeURIComponent(statsMatch[1])));
        return;
      }

      const peerActionMatch = path.match(
        /^\/api\/v1\/broadcasts\/([^/]+)\/peers\/([^/]+)\/(segments|heartbeat|stats|reports)$/,
      );
      if (peerActionMatch?.[1] && peerActionMatch[2] && peerActionMatch[3]) {
        const broadcastId = decodeURIComponent(peerActionMatch[1]);
        const peerId = decodeURIComponent(peerActionMatch[2]);
        const action = peerActionMatch[3];
        const body = await readJson(request);
        if (action === "segments" && method === "POST") {
          const report: SegmentPossessionReport = {
            segments: stringArray(body, "segments"),
            ...(typeof body.replace === "boolean" ? { replace: body.replace } : {}),
          };
          sendJson(
            response,
            200,
            store.reportSegments(
              broadcastId,
              peerId,
              report.segments,
              report.replace,
            ),
          );
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
          return;
        }
        if (action === "stats" && method === "POST") {
          const report = body as unknown as PeerStatsReport;
          if (!report.stats || typeof report.stats !== "object") {
            throw new RequestError("'stats' must be an object");
          }
          store.reportStats(broadcastId, peerId, report.stats);
          sendEmpty(response, 204);
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
          return;
        }
      }

      const peerMatch = path.match(
        /^\/api\/v1\/broadcasts\/([^/]+)\/peers(?:\/([^/]+))?$/,
      );
      if (peerMatch?.[1]) {
        const broadcastId = decodeURIComponent(peerMatch[1]);
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
          sendJson(response, 201, store.joinPeer(broadcastId, join));
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
          store.leavePeer(broadcastId, decodeURIComponent(encodedPeerId));
          sendEmpty(response, 204);
          return;
        }
      }

      const broadcastMatch = path.match(/^\/api\/v1\/broadcasts\/([^/]+)$/);
      if (broadcastMatch?.[1]) {
        const broadcastId = decodeURIComponent(broadcastMatch[1]);
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

export class TrackerServer {
  readonly store: TrackerStore;
  private readonly server;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    store = new TrackerStore(),
    private readonly stalePeerMs = DEFAULT_STALE_PEER_MS,
  ) {
    this.store = store;
    this.server = createServer(createTrackerHandler(store));
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
      () => this.store.removeStalePeers(this.stalePeerMs),
      Math.max(1_000, Math.floor(this.stalePeerMs / 2)),
    );
    this.cleanupTimer.unref();
    const address = this.server.address();
    return typeof address === "object" && address ? address.port : port;
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

const run = async (): Promise<void> => {
  const port = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  const stalePeerMs = Number.parseInt(
    process.env.STALE_PEER_MS ?? String(DEFAULT_STALE_PEER_MS),
    10,
  );
  const server = new TrackerServer(new TrackerStore(), stalePeerMs);
  await server.start(port);
  console.log(JSON.stringify({ event: "tracker_started", port }));

  const shutdown = async (signal: string): Promise<void> => {
    console.log(JSON.stringify({ event: "tracker_stopping", signal }));
    await server.stop();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error: unknown) => {
    console.error("tracker failed to start", error);
    process.exit(1);
  });
}
