import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import {
  createLogger,
  parsePeerTrafficStats,
  type Broadcast,
  type BroadcastRegistration,
  type BroadcastStats,
  type GlobalStats,
  type PeerFailureReport,
  type PeerHeartbeat,
  type PeerJoinRequest,
  type SegmentPossessionReport,
} from "@openstreamgrid/common";
import { SQLiteStore } from "./sqlite-store.js";
import {
  StoreError,
  TrackerStore,
  type TrackerStoreBackend,
} from "./store.js";
import { TrackerWebSocketHub, type TrackerEvents } from "./websocket.js";

const DEFAULT_PORT = 7070;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_STALE_PEER_MS = 30_000;
const DEFAULT_RATE_LIMIT_RPS = 100;
const DEFAULT_RATE_LIMIT_BURST = 200;
const DEFAULT_MAX_PEERS_PER_BROADCAST = 500;
const STATS_EVENT_INTERVAL_MS = 3_000;
const STATS_EVENT_RETRY_MS = 3_000;
const MAX_BODY_BYTES = 1_000_000;
const DASHBOARD_HTML_URL = new URL("./dashboard.html", import.meta.url);
const logger = createLogger("tracker");

let dashboardHtml: Promise<string> | undefined;

type JsonObject = Record<string, unknown>;

export interface TrackerConfiguration {
  port: number;
  host: string;
  stalePeerMs: number;
  rateLimitRps: number;
  rateLimitBurst: number;
  maxPeersPerBroadcast: number;
}

const parseInteger = (
  value: string,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
};

/** Parses and validates tracker process configuration before startup. */
export const parseTrackerConfiguration = (
  environment: NodeJS.ProcessEnv = process.env,
): TrackerConfiguration => {
  const host = environment.HOST ?? DEFAULT_HOST;
  if (host.trim() === "") throw new Error("HOST must not be empty");
  return {
    port: parseInteger(
      environment.PORT ?? String(DEFAULT_PORT),
      "PORT",
      1,
      65_535,
    ),
    host: host.trim(),
    stalePeerMs: parseInteger(
      environment.STALE_PEER_MS ?? String(DEFAULT_STALE_PEER_MS),
      "STALE_PEER_MS",
      1,
    ),
    rateLimitRps: parseInteger(
      environment.RATE_LIMIT_RPS ?? String(DEFAULT_RATE_LIMIT_RPS),
      "RATE_LIMIT_RPS",
      1,
    ),
    rateLimitBurst: parseInteger(
      environment.RATE_LIMIT_BURST ?? String(DEFAULT_RATE_LIMIT_BURST),
      "RATE_LIMIT_BURST",
      1,
    ),
    maxPeersPerBroadcast: parseInteger(
      environment.MAX_PEERS_PER_BROADCAST ??
        String(DEFAULT_MAX_PEERS_PER_BROADCAST),
      "MAX_PEERS_PER_BROADCAST",
      1,
    ),
  };
};

/** Point-in-time dashboard statistics sent over SSE. */
export interface TrackerStatsSnapshot {
  generatedAt: string;
  global: GlobalStats;
  broadcasts: Array<{
    broadcast: Broadcast;
    stats: BroadcastStats;
  }>;
}

type StatsEventName = "broadcasts" | "stats";

/** Publishes tracker statistics to dashboard SSE clients. */
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
    response.write(`retry: ${STATS_EVENT_RETRY_MS}\n\n`);
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
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
}

/** In-memory token-bucket limiter keyed by the direct client address. */
export class IpRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly requestsPerSecond: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {}

  consume(clientIp: string): number | undefined {
    const nowMs = this.now();
    const bucket = this.buckets.get(clientIp) ?? {
      tokens: this.burst,
      lastRefillMs: nowMs,
    };
    const elapsedSeconds = Math.max(0, nowMs - bucket.lastRefillMs) / 1_000;
    bucket.tokens = Math.min(
      this.burst,
      bucket.tokens + elapsedSeconds * this.requestsPerSecond,
    );
    bucket.lastRefillMs = nowMs;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.buckets.set(clientIp, bucket);
      return undefined;
    }

    this.buckets.set(clientIp, bucket);
    return Math.max(
      1,
      Math.ceil((1 - bucket.tokens) / this.requestsPerSecond),
    );
  }
}

const REQUEST_DURATION_BUCKETS_MS = [
  1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000,
] as const;

/** Minimal Prometheus collector for tracker process and store metrics. */
export class TrackerMetrics {
  private readonly startedAtMs: number;
  private broadcastsTotal = 0;
  private peersTotal = 0;
  private rateLimitedRequestsTotal = 0;
  private p2pRequestsTotal = 0;
  private originRequestsTotal = 0;
  private p2pSuccessesTotal = 0;
  private integrityFailuresTotal = 0;
  private fallbacksTotal = 0;
  private lastReportedTraffic = {
    p2pRequests: 0,
    originRequests: 0,
    p2pSuccesses: 0,
    integrityFailures: 0,
    fallbacks: 0,
  };
  private requestDurationCount = 0;
  private requestDurationSumMs = 0;
  private readonly requestDurationBuckets = REQUEST_DURATION_BUCKETS_MS.map(
    () => 0,
  );

  constructor(private readonly now: () => number = Date.now) {
    this.startedAtMs = now();
  }

  broadcastCreated(): void {
    this.broadcastsTotal += 1;
  }

  peerJoined(): void {
    this.peersTotal += 1;
  }

  requestRateLimited(): void {
    this.rateLimitedRequestsTotal += 1;
  }

  observeRestRequest(durationMs: number): void {
    const duration = Math.max(0, durationMs);
    this.requestDurationCount += 1;
    this.requestDurationSumMs += duration;
    for (let index = 0; index < REQUEST_DURATION_BUCKETS_MS.length; index += 1) {
      if (duration <= REQUEST_DURATION_BUCKETS_MS[index]!) {
        this.requestDurationBuckets[index] =
          (this.requestDurationBuckets[index] ?? 0) + 1;
      }
    }
  }

  synchronizeTraffic(store: TrackerStoreBackend): void {
    const current = store.getGlobalStats();
    this.p2pRequestsTotal += Math.max(
      0,
      current.p2pRequests - this.lastReportedTraffic.p2pRequests,
    );
    this.originRequestsTotal += Math.max(
      0,
      current.originRequests - this.lastReportedTraffic.originRequests,
    );
    this.p2pSuccessesTotal += Math.max(
      0,
      current.p2pSuccesses - this.lastReportedTraffic.p2pSuccesses,
    );
    this.integrityFailuresTotal += Math.max(
      0,
      current.integrityFailures - this.lastReportedTraffic.integrityFailures,
    );
    this.fallbacksTotal += Math.max(
      0,
      current.fallbacks - this.lastReportedTraffic.fallbacks,
    );
    this.lastReportedTraffic = {
      p2pRequests: current.p2pRequests,
      originRequests: current.originRequests,
      p2pSuccesses: current.p2pSuccesses,
      integrityFailures: current.integrityFailures,
      fallbacks: current.fallbacks,
    };
  }

  render(store: TrackerStoreBackend): string {
    this.synchronizeTraffic(store);
    const stats = store.getGlobalStats();
    const lines: string[] = [];
    const metric = (
      name: string,
      type: "counter" | "gauge",
      help: string,
      value: number,
    ): void => {
      lines.push(
        `# HELP ${name} ${help}`,
        `# TYPE ${name} ${type}`,
        `${name} ${value}`,
      );
    };

    metric(
      "openstreamgrid_broadcasts_total",
      "counter",
      "Broadcasts registered since tracker startup.",
      this.broadcastsTotal,
    );
    metric(
      "openstreamgrid_peers_total",
      "counter",
      "Peer joins since tracker startup.",
      this.peersTotal,
    );
    metric(
      "openstreamgrid_p2p_requests_total",
      "counter",
      "P2P segment requests reported by peers.",
      this.p2pRequestsTotal,
    );
    metric(
      "openstreamgrid_origin_requests_total",
      "counter",
      "Origin segment requests reported by peers.",
      this.originRequestsTotal,
    );
    metric(
      "openstreamgrid_p2p_successes_total",
      "counter",
      "Successful P2P segment requests reported by peers.",
      this.p2pSuccessesTotal,
    );
    metric(
      "openstreamgrid_integrity_failures_total",
      "counter",
      "Segment integrity failures reported by peers.",
      this.integrityFailuresTotal,
    );
    metric(
      "openstreamgrid_fallbacks_total",
      "counter",
      "Origin fallbacks reported by peers.",
      this.fallbacksTotal,
    );
    metric(
      "openstreamgrid_rate_limited_requests_total",
      "counter",
      "REST requests rejected by tracker limits.",
      this.rateLimitedRequestsTotal,
    );
    metric(
      "openstreamgrid_active_broadcasts",
      "gauge",
      "Currently active broadcasts.",
      stats.broadcasts,
    );
    metric(
      "openstreamgrid_active_peers",
      "gauge",
      "Currently active peers.",
      stats.peers,
    );
    metric(
      "openstreamgrid_tracker_uptime_seconds",
      "gauge",
      "Tracker process uptime in seconds.",
      Math.max(0, (this.now() - this.startedAtMs) / 1_000),
    );

    lines.push(
      "# HELP openstreamgrid_request_duration_ms REST request duration in milliseconds.",
      "# TYPE openstreamgrid_request_duration_ms histogram",
    );
    for (let index = 0; index < REQUEST_DURATION_BUCKETS_MS.length; index += 1) {
      lines.push(
        `openstreamgrid_request_duration_ms_bucket{le="${REQUEST_DURATION_BUCKETS_MS[index]}"} ${this.requestDurationBuckets[index]}`,
      );
    }
    lines.push(
      `openstreamgrid_request_duration_ms_bucket{le="+Inf"} ${this.requestDurationCount}`,
      `openstreamgrid_request_duration_ms_sum ${this.requestDurationSumMs}`,
      `openstreamgrid_request_duration_ms_count ${this.requestDurationCount}`,
      "",
    );
    return lines.join("\n");
  }
}

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  value: unknown,
  headers: Record<string, string> = {},
): void => {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(body);
};

const sendPrometheus = (response: ServerResponse, body: string): void => {
  response.writeHead(200, {
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
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

const optionalNonNegativeNumber = (
  body: JsonObject,
  key: string,
): number | undefined => {
  const value = optionalNumber(body, key);
  if (value !== undefined && value < 0) {
    throw new RequestError(`'${key}' must be non-negative`);
  }
  return value;
};

const optionalUnitInterval = (
  body: JsonObject,
  key: string,
): number | undefined => {
  const value = optionalNumber(body, key);
  if (value !== undefined && (value < 0 || value > 1)) {
    throw new RequestError(`'${key}' must be between 0 and 1`);
  }
  return value;
};

const optionalBoolean = (body: JsonObject, key: string): boolean | undefined => {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new RequestError(`'${key}' must be a boolean`);
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

export interface TrackerHttpOptions {
  rateLimitRps?: number;
  rateLimitBurst?: number;
  maxPeersPerBroadcast?: number;
  metrics?: TrackerMetrics;
  rateLimiter?: IpRateLimiter;
}

/** Creates the REST and dashboard request handler for a tracker store. */
export const createTrackerHandler = (
  store: TrackerStoreBackend,
  events: TrackerEvents = {},
  statsEvents?: TrackerStatsSse,
  options: TrackerHttpOptions = {},
) => {
  const metrics = options.metrics ?? new TrackerMetrics();
  const rateLimiter =
    options.rateLimiter ??
    new IpRateLimiter(
      options.rateLimitRps ?? DEFAULT_RATE_LIMIT_RPS,
      options.rateLimitBurst ?? DEFAULT_RATE_LIMIT_BURST,
    );
  const maxPeersPerBroadcast =
    options.maxPeersPerBroadcast ?? DEFAULT_MAX_PEERS_PER_BROADCAST;

  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const requestStartedAt = performance.now();
    let isRestRequest = false;
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://tracker.local");
      const path = url.pathname;
      isRestRequest = path.startsWith("/api/");

      if (method === "GET" && path === "/health") {
        sendJson(response, 200, { status: "ok", service: "tracker" });
        return;
      }
      if (method === "GET" && path === "/metrics") {
        sendPrometheus(response, metrics.render(store));
        return;
      }
      if (
        path !== "/health" &&
        (method === "POST" || method === "PUT" || method === "DELETE")
      ) {
        const retryAfter = rateLimiter.consume(
          request.socket?.remoteAddress ?? "unknown",
        );
        if (retryAfter !== undefined) {
          metrics.requestRateLimited();
          throw new RequestError("Rate limit exceeded", 429, {
            "retry-after": String(retryAfter),
          });
        }
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
        if (result.created) metrics.broadcastCreated();
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
          const replace = optionalBoolean(body, "replace");
          const report: SegmentPossessionReport = {
            segments: stringArray(body, "segments"),
            ...(replace !== undefined ? { replace } : {}),
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
          const latencyMs = optionalNonNegativeNumber(body, "latencyMs");
          const uploadBandwidthBps = optionalNonNegativeNumber(
            body,
            "uploadBandwidthBps",
          );
          const successRate = optionalUnitInterval(body, "successRate");
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
          metrics.synchronizeTraffic(store);
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
          const uploadBandwidthBps = optionalNonNegativeNumber(
            body,
            "uploadBandwidthBps",
          );
          const metadata = optionalMetadata(body);
          const join: PeerJoinRequest = {
            id: requiredString(body, "id"),
            address: requiredString(body, "address"),
            ...(uploadBandwidthBps !== undefined ? { uploadBandwidthBps } : {}),
            ...(metadata ? { metadata } : {}),
          };
          const alreadyJoined = store
            .listPeers(broadcastId)
            .some((peer) => peer.id === join.id);
          if (
            !alreadyJoined &&
            store.listPeers(broadcastId).length >= maxPeersPerBroadcast
          ) {
            metrics.requestRateLimited();
            throw new RequestError("Broadcast peer limit reached", 429, {
              "retry-after": "1",
            });
          }
          const peer = store.joinPeer(broadcastId, join);
          if (!alreadyJoined) metrics.peerJoined();
          sendJson(response, alreadyJoined ? 200 : 201, peer);
          if (alreadyJoined) events.peerListChanged?.(broadcastId);
          else events.peerJoined?.(broadcastId, peer);
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
          metrics.synchronizeTraffic(store);
          store.unregisterBroadcast(broadcastId);
          metrics.synchronizeTraffic(store);
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
      const message =
        statusCode === 500
          ? "Internal server error"
          : error instanceof Error
            ? error.message
            : "Request failed";
      if (statusCode === 500) {
        logger.error("request_failed", error, {
          method: request.method ?? "GET",
          path: request.url ?? "/",
        });
      }
      if (!response.headersSent) {
        sendJson(
          response,
          statusCode,
          { error: message },
          error instanceof RequestError ? error.headers : {},
        );
      } else {
        response.destroy();
      }
    } finally {
      if (isRestRequest) {
        metrics.observeRestRequest(performance.now() - requestStartedAt);
      }
    }
  };
};

/** Factory used to create a tracker persistence backend. */
export type TrackerStoreFactory = () => TrackerStoreBackend;

/** Selects the configured in-memory or SQLite tracker store. */
export const createConfiguredStore = (
  environment: NodeJS.ProcessEnv = process.env,
): TrackerStoreBackend => {
  const storeType = (environment.STORE_TYPE ?? "sqlite").trim().toLowerCase();
  if (storeType === "memory") return new TrackerStore();
  if (storeType === "sqlite") {
    if (environment.DB_PATH !== undefined && environment.DB_PATH.trim() === "") {
      throw new Error("DB_PATH must not be empty when STORE_TYPE is 'sqlite'");
    }
    return new SQLiteStore(environment.DB_PATH);
  }
  throw new Error(
    `Unsupported STORE_TYPE '${environment.STORE_TYPE}'. Expected 'sqlite' or 'memory'`,
  );
};

/** Owns tracker HTTP, WebSocket, SSE, cleanup, and store lifecycles. */
export class TrackerServer {
  readonly store: TrackerStoreBackend;
  private readonly server;
  private readonly webSockets: TrackerWebSocketHub;
  private readonly statsEvents: TrackerStatsSse;
  private cleanupTimer: NodeJS.Timeout | undefined;
  private startPromise: Promise<number> | undefined;
  private stopPromise: Promise<void> | undefined;

  constructor(
    storeFactory: TrackerStoreFactory = createConfiguredStore,
    private readonly stalePeerMs = DEFAULT_STALE_PEER_MS,
    configuration: Pick<
      TrackerConfiguration,
      "rateLimitRps" | "rateLimitBurst" | "maxPeersPerBroadcast"
    > = {
      rateLimitRps: DEFAULT_RATE_LIMIT_RPS,
      rateLimitBurst: DEFAULT_RATE_LIMIT_BURST,
      maxPeersPerBroadcast: DEFAULT_MAX_PEERS_PER_BROADCAST,
    },
  ) {
    const store = storeFactory();
    this.store = store;
    this.statsEvents = new TrackerStatsSse(store);
    const metrics = new TrackerMetrics();
    let webSockets: TrackerWebSocketHub | undefined;
    const events: TrackerEvents = {
      peerJoined: (broadcastId, peer) =>
        webSockets?.peerJoined(broadcastId, peer),
      peerLeft: (broadcastId, peerId) =>
        webSockets?.peerLeft(broadcastId, peerId),
      segmentsAvailable: (broadcastId, peerId, segments) =>
        webSockets?.segmentsAvailable(broadcastId, peerId, segments),
      statsUpdated: (broadcastId, peerId) => {
        metrics.synchronizeTraffic(store);
        webSockets?.statsUpdated(broadcastId, peerId);
      },
      peerListChanged: (broadcastId) =>
        webSockets?.peerListChanged(broadcastId),
      broadcastListChanged: () => webSockets?.broadcastListChanged(),
    };
    this.server = createServer(
      createTrackerHandler(store, events, this.statsEvents, {
        rateLimitRps: configuration.rateLimitRps,
        rateLimitBurst: configuration.rateLimitBurst,
        maxPeersPerBroadcast: configuration.maxPeersPerBroadcast,
        metrics,
      }),
    );
    webSockets = new TrackerWebSocketHub(this.server, store, this.statsEvents);
    this.webSockets = webSockets;
  }

  async start(port = DEFAULT_PORT, host = "0.0.0.0"): Promise<number> {
    if (this.stopPromise) {
      throw new Error("Tracker server cannot be started after shutdown begins");
    }
    if (this.startPromise) return this.startPromise;
    const startPromise = this.startOnce(port, host).catch((error: unknown) => {
      if (this.startPromise === startPromise) this.startPromise = undefined;
      throw error;
    });
    this.startPromise = startPromise;
    return startPromise;
  }

  private async startOnce(port: number, host: string): Promise<number> {
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
          logger.error("stale_peer_cleanup_failed", error);
        }
      },
      Math.max(1_000, Math.floor(this.stalePeerMs / 2)),
    );
    this.cleanupTimer.unref();
    const address = this.server.address();
    return typeof address === "object" && address ? address.port : port;
  }

  async stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    await this.startPromise?.catch(() => undefined);
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
  const configuration = parseTrackerConfiguration();
  const server = new TrackerServer(
    createConfiguredStore,
    configuration.stalePeerMs,
    configuration,
  );
  const actualPort = await server.start(configuration.port, configuration.host);
  logger.info("started", { port: actualPort, host: configuration.host });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("stopping", { signal });
    await server.stop();
    process.exit(0);
  };
  const requestShutdown = (signal: string): void => {
    void shutdown(signal).catch((error: unknown) => {
      logger.error("shutdown_failed", error);
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", () => requestShutdown("SIGTERM"));
  process.once("SIGINT", () => requestShutdown("SIGINT"));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error: unknown) => {
    logger.error("start_failed", error);
    process.exit(1);
  });
}
