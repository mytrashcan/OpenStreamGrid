import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import type { WsServerMessage } from "@openstreamgrid/common";
import WebSocket, { type RawData } from "ws";
import {
  createConfiguredStore,
  createTrackerHandler,
  parseTrackerConfiguration,
  TrackerMetrics,
  TrackerServer,
  TrackerStatsSse,
  type TrackerStatsSnapshot,
} from "../src/server.js";
import { TrackerStore } from "../src/store.js";

interface TestResponse {
  status: number;
  json: unknown;
}

interface SseEvent {
  event: string;
  data: TrackerStatsSnapshot;
}

test("validates tracker environment configuration", () => {
  assert.deepEqual(parseTrackerConfiguration({}), {
    port: 7070,
    host: "0.0.0.0",
    peerSessionTtlMs: 3_600_000,
    stalePeerMs: 30_000,
    rateLimitRps: 100,
    rateLimitBurst: 200,
    maxPeersPerBroadcast: 500,
    wsMaxConnectionsPerIp: 20,
    trustProxyHops: 0,
    neighborViewSize: 64,
  });
  assert.deepEqual(
    parseTrackerConfiguration({
      PORT: "8081",
      HOST: "127.0.0.1",
      STALE_PEER_MS: "5000",
      TRACKER_API_KEY: "test-secret",
    }),
    {
      port: 8081,
      host: "127.0.0.1",
      stalePeerMs: 5_000,
      trackerApiKey: "test-secret",
      peerSessionTtlMs: 3_600_000,
      rateLimitRps: 100,
      rateLimitBurst: 200,
      maxPeersPerBroadcast: 500,
      wsMaxConnectionsPerIp: 20,
      trustProxyHops: 0,
      neighborViewSize: 64,
    },
  );
  assert.equal(
    parseTrackerConfiguration({ TRACKER_NEIGHBOR_VIEW_SIZE: "0" }).neighborViewSize,
    0,
  );
  assert.throws(
    () => parseTrackerConfiguration({ TRACKER_NEIGHBOR_VIEW_SIZE: "1001" }),
    /TRACKER_NEIGHBOR_VIEW_SIZE must be an integer between 0 and 1000/,
  );
  assert.throws(
    () => parseTrackerConfiguration({ PORT: "0" }),
    /PORT must be an integer between 1 and 65535/,
  );
  assert.throws(
    () => parseTrackerConfiguration({ PORT: "7070junk" }),
    /PORT must be an integer/,
  );
  assert.throws(
    () => parseTrackerConfiguration({ STALE_PEER_MS: "NaN" }),
    /STALE_PEER_MS must be an integer/,
  );
  assert.throws(
    () => parseTrackerConfiguration({ HOST: " " }),
    /HOST must not be empty/,
  );
  assert.throws(
    () => parseTrackerConfiguration({ RATE_LIMIT_RPS: "0" }),
    /RATE_LIMIT_RPS must be an integer/,
  );
  assert.throws(
    () => parseTrackerConfiguration({ RATE_LIMIT_BURST: "1.5" }),
    /RATE_LIMIT_BURST must be an integer/,
  );
  assert.throws(
    () => parseTrackerConfiguration({ MAX_PEERS_PER_BROADCAST: "0" }),
    /MAX_PEERS_PER_BROADCAST must be an integer/,
  );
  assert.throws(
    () => parseTrackerConfiguration({ TRACKER_API_KEY: " " }),
    /TRACKER_API_KEY must not be empty/,
  );
  const proxied = parseTrackerConfiguration({
    TRACKER_WS_MAX_CONNECTIONS_PER_IP: "200",
    TRUST_PROXY_HOPS: "1",
  });
  assert.equal(proxied.wsMaxConnectionsPerIp, 200);
  assert.equal(proxied.trustProxyHops, 1);
  assert.throws(
    () => parseTrackerConfiguration({ TRACKER_WS_MAX_CONNECTIONS_PER_IP: "0" }),
    /TRACKER_WS_MAX_CONNECTIONS_PER_IP must be an integer/,
  );
  assert.throws(
    () => parseTrackerConfiguration({ TRUST_PROXY_HOPS: "-1" }),
    /TRUST_PROXY_HOPS must be an integer/,
  );
  assert.deepEqual(
    parseTrackerConfiguration({
      TRACKER_WS_ALLOWED_ORIGINS: " https://Player.Example/ ,, http://localhost:5173, https://cdn.example:443",
    }).wsAllowedOrigins,
    ["https://player.example", "http://localhost:5173", "https://cdn.example"],
  );
  for (const invalid of [
    "player.example",
    "ftp://player.example",
    "https://player.example/app",
    "https://user:pass@player.example",
    "https://player.example?embed=1",
    "https://player.example#player",
    "null",
  ]) {
    assert.throws(
      () => parseTrackerConfiguration({ TRACKER_WS_ALLOWED_ORIGINS: invalid }),
      /TRACKER_WS_ALLOWED_ORIGINS entries must be http\(s\) origins/,
      invalid,
    );
  }
  assert.throws(
    () => createConfiguredStore({ STORE_TYPE: "sqlite", DB_PATH: " " }),
    /DB_PATH must not be empty/,
  );
  assert.deepEqual(
    parseTrackerConfiguration({
      TURN_URLS: "turn:turn.example.com:3478?transport=udp, turns:turn.example.com:5349",
      TURN_SHARED_SECRET: "north-shared-secret-01",
    }).turn,
    {
      urls: ["turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349"],
      sharedSecret: "north-shared-secret-01",
    },
  );
  assert.throws(
    () => parseTrackerConfiguration({ TURN_URLS: "turn:turn.example.com" }),
    /TURN_SHARED_SECRET is required/,
  );
  assert.throws(
    () => parseTrackerConfiguration({ TURN_SHARED_SECRET: "north-shared-secret-01" }),
    /TURN_URLS is required/,
  );
  assert.throws(
    () =>
      parseTrackerConfiguration({
        TURN_URLS: "stun:stun.example.com",
        TURN_SHARED_SECRET: "north-shared-secret-01",
      }),
    /TURN_URLS entries must be turn:\/turns: URIs/,
  );
  for (const invalid of [
    "turn:turn.example.com:3478 transport=udp",
    "turn:turn.example.com:notaport",
    "turn::",
    "turn:turn.example.com:70000",
    "turn:turn.example.com:0",
    "turn:-bad-.example.com",
  ]) {
    assert.throws(
      () =>
        parseTrackerConfiguration({
          TURN_URLS: invalid,
          TURN_SHARED_SECRET: "north-shared-secret-01",
        }),
      /TURN_URLS entries must be turn:\/turns: URIs/,
      invalid,
    );
  }
  assert.deepEqual(
    parseTrackerConfiguration({
      TURN_URLS: "turn:203.0.113.7:3478, turns:[2001:db8::1]:5349?transport=tcp, turn:turn.example.com",
      TURN_SHARED_SECRET: "north-shared-secret-01",
    }).turn?.urls,
    ["turn:203.0.113.7:3478", "turns:[2001:db8::1]:5349?transport=tcp", "turn:turn.example.com"],
  );
  assert.equal(
    parseTrackerConfiguration({ TURN_SHARED_SECRET: "  " }).turn,
    undefined,
    "a blank TURN_SHARED_SECRET placeholder means TURN is disabled",
  );
  assert.throws(
    () =>
      parseTrackerConfiguration({
        TURN_URLS: "turn:turn.example.com",
        TURN_SHARED_SECRET: "short",
      }),
    /TURN_SHARED_SECRET must contain at least 16 bytes/,
  );
});

test("returns TURN credentials bound to the peer session on join", async () => {
  const turn = {
    urls: ["turns:turn.example.com:5349"],
    sharedSecret: "north-shared-secret-01",
  };
  const registerBroadcast = (store: TrackerStore): TrackerStore => {
    store.registerBroadcast({ id: "live", playlistUrl: "http://origin/live.m3u8" });
    return store;
  };
  const withTurn = createTrackerHandler(registerBroadcast(new TrackerStore()), {}, undefined, { turn });
  const joined = await invokeRaw(
    withTurn,
    "POST",
    "/api/v1/broadcasts/live/peers",
    { id: "peer-a", address: "http://peer-a:9090" },
    "192.0.2.40",
  );
  assert.equal(joined.status, 201);
  const body = JSON.parse(joined.body) as {
    expiresAt: string;
    iceServers: Array<{ urls: string[]; username: string; credential: string }>;
  };
  // Credentials outlive the session by a grace period covering refresh retries.
  const expirySeconds = Math.floor((Date.parse(body.expiresAt) + 10 * 60 * 1_000) / 1_000);
  assert.equal(body.iceServers.length, 1);
  const [server] = body.iceServers;
  assert.ok(server);
  assert.deepEqual(server.urls, turn.urls);
  assert.equal(server.username, `${expirySeconds}:peer-a`);
  assert.equal(
    server.credential,
    createHmac("sha1", turn.sharedSecret).update(`${expirySeconds}:peer-a`).digest("base64"),
  );

  const withoutTurn = createTrackerHandler(registerBroadcast(new TrackerStore()));
  const plain = await invokeRaw(
    withoutTurn,
    "POST",
    "/api/v1/broadcasts/live/peers",
    { id: "peer-a", address: "http://peer-a:9090" },
    "192.0.2.41",
  );
  assert.equal(plain.status, 201);
  assert.equal("iceServers" in JSON.parse(plain.body), false);
});

const invoke = async (
  handler: ReturnType<typeof createTrackerHandler>,
  method: string,
  url: string,
  body?: unknown,
  requestHeaders: Record<string, string> = {},
): Promise<TestResponse> => {
  const payload = body === undefined ? [] : [JSON.stringify(body)];
  const request = Object.assign(Readable.from(payload), {
    method,
    url,
    headers: requestHeaders,
    socket: { remoteAddress: "192.0.2.100" },
  }) as unknown as IncomingMessage;
  let status = 0;
  let responseBody = "";
  let headersSent = false;
  const response = {
    get headersSent() {
      return headersSent;
    },
    // ServerResponse.writeHead sets statusCode; the handler reads it for metrics.
    get statusCode() {
      return status;
    },
    writeHead(statusCode: number) {
      status = statusCode;
      headersSent = true;
      return response;
    },
    setHeader() {
      return response;
    },
    end(chunk?: string) {
      if (chunk) responseBody += chunk;
      return response;
    },
    destroy() {
      return response;
    },
  } as unknown as ServerResponse;
  await handler(request, response);
  return {
    status,
    json: responseBody ? (JSON.parse(responseBody) as unknown) : undefined,
  };
};

const invokeRaw = async (
  handler: ReturnType<typeof createTrackerHandler>,
  method: string,
  url: string,
  body: unknown,
  remoteAddress: string,
  requestHeaders: Record<string, string> = {},
): Promise<{
  status: number;
  body: string;
  headers: Record<string, string | number>;
}> => {
  const payload = body === undefined ? [] : [JSON.stringify(body)];
  const request = Object.assign(Readable.from(payload), {
    method,
    url,
    headers: requestHeaders,
    socket: { remoteAddress },
  }) as unknown as IncomingMessage;
  let status = 0;
  let responseBody = "";
  let responseHeaders: Record<string, string | number> = {};
  let headersSent = false;
  const response = {
    get headersSent() {
      return headersSent;
    },
    // ServerResponse.writeHead sets statusCode; the handler reads it for metrics.
    get statusCode() {
      return status;
    },
    writeHead(
      statusCode: number,
      headers: Record<string, string | number> = {},
    ) {
      status = statusCode;
      responseHeaders = { ...responseHeaders, ...headers };
      headersSent = true;
      return response;
    },
    setHeader(name: string, value: string | number) {
      responseHeaders[name.toLowerCase()] = value;
      return response;
    },
    end(chunk?: string) {
      if (chunk) responseBody += chunk;
      return response;
    },
    destroy() {
      return response;
    },
  } as unknown as ServerResponse;
  await handler(request, response);
  return { status, body: responseBody, headers: responseHeaders };
};

test("supports browser SDK CORS preflight and REST responses", async () => {
  const handler = createTrackerHandler(new TrackerStore());
  const origin = "http://127.0.0.1:5173";
  const preflight = await invokeRaw(
    handler,
    "OPTIONS",
    "/api/v1/broadcasts/live/peers",
    undefined,
    "192.0.2.10",
    {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  );

  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "*");
  assert.equal(
    preflight.headers["access-control-allow-methods"],
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  assert.equal(
    preflight.headers["access-control-allow-headers"],
    "Authorization, Content-Type, X-API-Key",
  );

  const response = await invokeRaw(
    handler,
    "GET",
    "/api/v1/broadcasts",
    undefined,
    "192.0.2.10",
    { origin },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers["access-control-allow-origin"], "*");
});

test("authenticates protected HTTP routes when an API key is configured", async () => {
  const handler = createTrackerHandler(new TrackerStore(), {}, undefined, {
    apiKey: "test-secret",
  });

  const invalid = await invokeRaw(
    handler,
    "POST",
    "/api/v1/broadcasts",
    { id: "live", playlistUrl: "http://origin/live.m3u8" },
    "192.0.2.21",
    { "x-api-key": "wrong-secret" },
  );
  assert.equal(invalid.status, 401);
  assert.deepEqual(JSON.parse(invalid.body), { error: "Invalid API key" });

  const registered = await invokeRaw(
    handler,
    "POST",
    "/api/v1/broadcasts",
    { id: "live", playlistUrl: "http://origin/live.m3u8" },
    "192.0.2.22",
    { "x-api-key": "test-secret" },
  );
  assert.equal(registered.status, 201);

  for (const path of [
    "/api/v1/stats",
    "/api/v1/stats/events",
    "/dashboard",
  ]) {
    const response = await invokeRaw(
      handler,
      "GET",
      path,
      undefined,
      "192.0.2.23",
    );
    assert.equal(response.status, 401, path);
    assert.deepEqual(JSON.parse(response.body), { error: "Missing API key" });
  }

  const stats = await invokeRaw(
    handler,
    "GET",
    "/api/v1/stats",
    undefined,
    "192.0.2.24",
    { "x-api-key": "test-secret" },
  );
  assert.equal(stats.status, 200);

  // Prometheus-style scrapers send the admin key as a Bearer token.
  const bearerMetrics = await invokeRaw(
    handler,
    "GET",
    "/metrics",
    undefined,
    "192.0.2.25",
    { authorization: "Bearer test-secret" },
  );
  assert.equal(bearerMetrics.status, 200);
  assert.match(bearerMetrics.body, /openstreamgrid_active_peers/);
  const wrongBearer = await invokeRaw(
    handler,
    "GET",
    "/metrics",
    undefined,
    "192.0.2.26",
    { authorization: "Bearer wrong-secret" },
  );
  assert.equal(wrongBearer.status, 401);
  assert.deepEqual(JSON.parse(wrongBearer.body), { error: "Invalid API key" });

  // A peer session token shares the Authorization header but must never grant
  // admin access, while still working on the peer's own routes.
  const joined = await invokeRaw(
    handler,
    "POST",
    "/api/v1/broadcasts/live/peers",
    { id: "peer-a", address: "http://peer-a:9090" },
    "192.0.2.27",
  );
  assert.equal(joined.status, 201);
  const { sessionToken } = JSON.parse(joined.body) as { sessionToken: string };
  const peerMetrics = await invokeRaw(
    handler,
    "GET",
    "/metrics",
    undefined,
    "192.0.2.28",
    { authorization: `Bearer ${sessionToken}` },
  );
  assert.equal(peerMetrics.status, 401);
  assert.deepEqual(JSON.parse(peerMetrics.body), { error: "Invalid API key" });
  const peerHeartbeat = await invokeRaw(
    handler,
    "PUT",
    "/api/v1/broadcasts/live/peers/peer-a/heartbeat",
    {},
    "192.0.2.29",
    { authorization: `Bearer ${sessionToken}` },
  );
  assert.equal(peerHeartbeat.status, 200);

  const publicHealth = await invokeRaw(
    handler,
    "GET",
    "/health",
    undefined,
    "192.0.2.25",
  );
  const publicMetrics = await invokeRaw(
    handler,
    "GET",
    "/metrics",
    undefined,
    "192.0.2.25",
  );
  const publicPreflight = await invokeRaw(
    handler,
    "OPTIONS",
    "/api/v1/broadcasts",
    undefined,
    "192.0.2.25",
  );
  assert.equal(publicHealth.status, 200);
  assert.equal(publicMetrics.status, 401);
  assert.equal(publicPreflight.status, 204);

  // The refused requests above (wrong key, peer token, no key) are counted.
  const counted = await invokeRaw(
    handler,
    "GET",
    "/metrics",
    undefined,
    "192.0.2.30",
    { authorization: "Bearer test-secret" },
  );
  const authFailures = Number(
    /openstreamgrid_auth_failures_total\{interface="http"\} (\d+)/.exec(counted.body)?.[1],
  );
  assert.ok(authFailures >= 3, `auth failures: ${authFailures}`);
  assert.match(counted.body, /openstreamgrid_http_responses_total\{class="2xx"\} [1-9]\d*\n/);
});

test("rate limits mutations per IP and enforces the broadcast peer cap", async () => {
  const handler = createTrackerHandler(new TrackerStore(), {}, undefined, {
    rateLimitRps: 1,
    rateLimitBurst: 1,
    maxPeersPerBroadcast: 1,
  });

  assert.equal(
    (
      await invokeRaw(
        handler,
        "POST",
        "/health",
        undefined,
        "192.0.2.1",
      )
    ).status,
    404,
  );
  const firstMutation = await invokeRaw(
    handler,
    "POST",
    "/not-a-route",
    undefined,
    "192.0.2.1",
  );
  const limitedMutation = await invokeRaw(
    handler,
    "POST",
    "/not-a-route",
    undefined,
    "192.0.2.1",
  );
  assert.equal(firstMutation.status, 404);
  assert.equal(limitedMutation.status, 429);
  assert.equal(limitedMutation.headers["retry-after"], "1");

  assert.equal(
    (
      await invokeRaw(
        handler,
        "POST",
        "/api/v1/broadcasts",
        { id: "live", playlistUrl: "http://origin/live.m3u8" },
        "192.0.2.2",
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await invokeRaw(
        handler,
        "POST",
        "/api/v1/broadcasts/live/peers",
        { id: "peer-a", address: "http://peer-a:9090" },
        "192.0.2.3",
      )
    ).status,
    201,
  );
  const peerLimit = await invokeRaw(
    handler,
    "POST",
    "/api/v1/broadcasts/live/peers",
    { id: "peer-b", address: "http://peer-b:9090" },
    "192.0.2.4",
  );
  assert.equal(peerLimit.status, 429);
  assert.equal(peerLimit.headers["retry-after"], "1");
  assert.deepEqual(JSON.parse(peerLimit.body), {
    error: "Broadcast peer limit reached",
  });
});

test("exports event-loop delay since the previous scrape", async () => {
  const metrics = new TrackerMetrics();
  const store = new TrackerStore();
  // Block the loop long enough for the delay histogram to notice.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const blockedUntil = Date.now() + 60;
  while (Date.now() < blockedUntil) {
    // Busy-wait on purpose.
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  const first = metrics.render(store);
  const max = Number(/^openstreamgrid_event_loop_delay_max_seconds (\S+)$/m.exec(first)?.[1]);
  assert.ok(max >= 0.04, `max delay ${max} s`);
  assert.match(first, /^openstreamgrid_event_loop_delay_p99_seconds \d/m);
  // Each scrape covers only the time since the previous one.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = metrics.render(store);
  const secondMax = Number(/^openstreamgrid_event_loop_delay_max_seconds (\S+)$/m.exec(second)?.[1] ?? 0);
  assert.ok(secondMax < max);
});

test("exports tracker counters, gauges, and REST duration metrics", async () => {
  const handler = createTrackerHandler(new TrackerStore());
  await invoke(handler, "POST", "/api/v1/broadcasts", {
    id: "live",
    playlistUrl: "http://origin/live.m3u8",
  });
  const metricJoin = await invoke(handler, "POST", "/api/v1/broadcasts/live/peers", {
    id: "peer-a",
    address: "http://peer-a:9090",
  });
  await invoke(handler, "POST", "/api/v1/broadcasts/live/peers/peer-a/stats", {
    stats: {
      bytesDownloadedP2P: 100,
      bytesDownloadedOrigin: 50,
      bytesUploadedP2P: 100,
      p2pRequests: 3,
      p2pSuccesses: 2,
      p2pFailures: 1,
      originRequests: 1,
      integrityFailures: 1,
      fallbacks: 1,
      segmentsCached: 2,
    },
  }, {
    authorization: `Bearer ${(metricJoin.json as { sessionToken: string }).sessionToken}`,
  });

  const response = await invokeRaw(
    handler,
    "GET",
    "/metrics",
    undefined,
    "192.0.2.5",
  );
  assert.equal(response.status, 200);
  assert.match(
    String(response.headers["content-type"]),
    /^text\/plain; version=0\.0\.4/,
  );
  assert.match(response.body, /openstreamgrid_broadcasts_total 1\n/);
  assert.match(response.body, /openstreamgrid_peers_total 1\n/);
  assert.match(response.body, /openstreamgrid_p2p_requests_total 3\n/);
  assert.match(response.body, /openstreamgrid_origin_requests_total 1\n/);
  assert.match(response.body, /openstreamgrid_p2p_successes_total 2\n/);
  assert.match(response.body, /openstreamgrid_integrity_failures_total 1\n/);
  assert.match(response.body, /openstreamgrid_fallbacks_total 1\n/);
  assert.match(response.body, /openstreamgrid_active_broadcasts 1\n/);
  assert.match(response.body, /openstreamgrid_active_peers 1\n/);
  assert.match(response.body, /openstreamgrid_request_duration_ms_count 3\n/);
});

test("exposes the broadcast and peer lifecycle over REST", async () => {
  const handler = createTrackerHandler(new TrackerStore());

  const registration = await invoke(handler, "POST", "/api/v1/broadcasts", {
    id: "live",
    playlistUrl: "http://origin/live.m3u8",
  });
  assert.equal(registration.status, 201);
  assert.deepEqual(registration.json, {
    id: "live",
    playlistUrl: "http://origin/live.m3u8",
    createdAt: (registration.json as { createdAt: string }).createdAt,
    updatedAt: (registration.json as { updatedAt: string }).updatedAt,
  });
  assert.match((registration.json as { createdAt: string }).createdAt, /^\d{4}-/);

  const join = await invoke(handler, "POST", "/api/v1/broadcasts/live/peers", {
    id: "peer-a",
    address: "http://peer-a:9090",
  });
  assert.equal(join.status, 201);
  const joined = join.json as { peer: Record<string, unknown>; sessionToken: string };
  assert.deepEqual(joined.peer, {
    id: "peer-a",
    address: "http://peer-a:9090",
    segments: [],
    joinedAt: (joined.peer as { joinedAt: string }).joinedAt,
    lastSeenAt: (joined.peer as { lastSeenAt: string }).lastSeenAt,
    latencyMs: 0,
    successRate: 1,
    trustScore: 1,
  });

  const segmentReport = await invoke(
    handler,
    "POST",
    "/api/v1/broadcasts/live/peers/peer-a/segments",
    { segments: ["segment_1.ts"] },
    { authorization: `Bearer ${joined.sessionToken}` },
  );
  assert.equal(segmentReport.status, 200);
  assert.deepEqual((segmentReport.json as { segments: string[] }).segments, [
    "segment_1.ts",
  ]);
  const peers = await invoke(
    handler,
    "GET",
    "/api/v1/broadcasts/live/peers?segment=segment_1.ts",
    undefined,
    { authorization: `Bearer ${joined.sessionToken}` },
  );
  const peerBody = peers.json as { peers: Array<{ id: string }> };
  assert.deepEqual(peerBody.peers.map((peer) => peer.id), ["peer-a"]);

  const health = await invoke(handler, "GET", "/health");
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { status: "ok", service: "tracker" });
});

test("treats a duplicate peer join as an idempotent update", async () => {
  const store = new TrackerStore();
  const joinedPeers: string[] = [];
  const changedBroadcasts: string[] = [];
  const handler = createTrackerHandler(store, {
    peerJoined: (broadcastId, peer) => joinedPeers.push(`${broadcastId}:${peer.id}`),
    peerListChanged: (broadcastId) => changedBroadcasts.push(broadcastId),
  });
  await invoke(handler, "POST", "/api/v1/broadcasts", {
    id: "live",
    playlistUrl: "http://origin/live.m3u8",
  });

  const first = await invoke(handler, "POST", "/api/v1/broadcasts/live/peers", {
    id: "peer-a",
    address: "http://peer-a:9090",
  });
  const duplicate = await invoke(
    handler,
    "POST",
    "/api/v1/broadcasts/live/peers",
    { id: "peer-a", address: "http://peer-a:9191" },
    { authorization: `Bearer ${(first.json as { sessionToken: string }).sessionToken}` },
  );

  assert.equal(first.status, 201);
  assert.equal(duplicate.status, 200);
  assert.equal((first.json as { peer: { address: string } }).peer.address, "http://peer-a:9090");
  assert.equal((duplicate.json as { peer: { address: string } }).peer.address, "http://peer-a:9191");
  assert.deepEqual(joinedPeers, ["live:peer-a"]);
  assert.deepEqual(changedBroadcasts, ["live"]);
  assert.equal(store.listPeers("live").length, 1);
  assert.equal(store.listPeers("live")[0]?.address, "http://peer-a:9191");
});

test("rejects malformed peer payloads and URL path encoding", async () => {
  const handler = createTrackerHandler(new TrackerStore());
  await invoke(handler, "POST", "/api/v1/broadcasts", {
    id: "live",
    playlistUrl: "http://origin/live.m3u8",
  });
  const malformedJoin = await invoke(handler, "POST", "/api/v1/broadcasts/live/peers", {
    id: "peer-a",
    address: "http://peer-a:9090",
  });
  const auth = {
    authorization: `Bearer ${(malformedJoin.json as { sessionToken: string }).sessionToken}`,
  };

  const stats = await invoke(
    handler,
    "POST",
    "/api/v1/broadcasts/live/peers/peer-a/stats",
    { stats: { bytesDownloadedP2P: "not-a-number" } },
    auth,
  );
  assert.equal(stats.status, 400);
  assert.deepEqual(stats.json, {
    error: "Peer traffic stat 'bytesDownloadedP2P' must be a non-negative number",
  });

  const invalidSegments = await invoke(
    handler,
    "POST",
    "/api/v1/broadcasts/live/peers/peer-a/segments",
    { segments: ["segment.ts"], replace: "yes" },
    auth,
  );
  assert.equal(invalidSegments.status, 400);
  assert.deepEqual(invalidSegments.json, {
    error: "'replace' must be a boolean",
  });

  const invalidHeartbeat = await invoke(
    handler,
    "PUT",
    "/api/v1/broadcasts/live/peers/peer-a/heartbeat",
    { successRate: 1.1 },
    auth,
  );
  assert.equal(invalidHeartbeat.status, 400);
  assert.deepEqual(invalidHeartbeat.json, {
    error: "'successRate' must be between 0 and 1",
  });

  const invalidPath = await invoke(
    handler,
    "GET",
    "/api/v1/broadcasts/%E0%A4%A",
  );
  assert.equal(invalidPath.status, 400);
  assert.deepEqual(invalidPath.json, {
    error: "URL path contains invalid percent encoding",
  });
});

const waitForMessage = async (
  socket: WebSocket,
  predicate: (message: WsServerMessage) => boolean,
): Promise<WsServerMessage> =>
  new Promise<WsServerMessage>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for tracker WebSocket message"));
    }, 1_000);
    const onMessage = (data: RawData): void => {
      const message = JSON.parse(data.toString()) as WsServerMessage;
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });

const createSseReader = (
  response: Response,
): (() => Promise<SseEvent>) => {
  const reader = response.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let buffer = "";

  return async (): Promise<SseEvent> => {
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = frame.split("\n");
        const event = lines
          .find((line) => line.startsWith("event:"))
          ?.slice("event:".length)
          .trim();
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n");
        if (event && data) {
          return {
            event,
            data: JSON.parse(data) as TrackerStatsSnapshot,
          };
        }
        continue;
      }

      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE stream closed unexpectedly");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
};

const waitForSseEvent = async (
  nextEvent: () => Promise<SseEvent>,
  predicate: (event: SseEvent) => boolean,
): Promise<SseEvent> => {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("Timed out waiting for tracker SSE event")),
      // Event-driven updates are coalesced to one per second.
      3_000,
    );
  });
  const matchingEvent = (async (): Promise<SseEvent> => {
    while (true) {
      const event = await nextEvent();
      if (predicate(event)) return event;
    }
  })();
  try {
    return await Promise.race([matchingEvent, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

test("pushes peer and segment updates to WebSocket subscribers", async () => {
  const server = new TrackerServer(() => new TrackerStore());
  const port = await server.start(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${port}`;
  let socket: WebSocket | undefined;
  try {
    await fetch(`${baseUrl}/api/v1/broadcasts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "live",
        playlistUrl: "http://origin/live.m3u8",
      }),
    });
    const joinResponse = await fetch(`${baseUrl}/api/v1/broadcasts/live/peers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "peer-a",
        address: "http://peer-a:9090",
      }),
    });
    const { sessionToken } = await joinResponse.json() as { sessionToken: string };
    const activeSocket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?sessionToken=${encodeURIComponent(sessionToken)}`,
    );
    socket = activeSocket;
    await new Promise<void>((resolve) => activeSocket.once("open", resolve));
    const initialPeers = waitForMessage(
      activeSocket,
      (message) => message.type === "peer_list",
    );
    activeSocket.send(
      JSON.stringify({
        type: "subscribe",
        broadcastId: "live",
        peerId: "peer-a",
      }),
    );
    const peerList = await initialPeers;
    assert.equal(peerList.type, "peer_list");
    assert.deepEqual(peerList.peers.map((peer) => peer.id), ["peer-a"]);

    const segmentUpdate = waitForMessage(
      activeSocket,
      (message) => message.type === "segment_available",
    );
    const response = await fetch(
      `${baseUrl}/api/v1/broadcasts/live/peers/peer-a/segments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ segments: ["segment_1.ts"] }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await segmentUpdate, {
      type: "segment_available",
      broadcastId: "live",
      peerId: "peer-a",
      segments: ["segment_1.ts"],
      replace: true,
    });
  } finally {
    socket?.close();
    await server.stop();
  }
});

test("batches inventory updates for subscribers that negotiate inventory_batch", async () => {
  const server = new TrackerServer(() => new TrackerStore(), 30_000, {
    rateLimitRps: 100,
    rateLimitBurst: 200,
    maxPeersPerBroadcast: 500,
    wsInventoryBatchMs: 400,
  });
  const port = await server.start(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${port}`;
  const sockets = new Map<string, WebSocket>();
  const received = new Map<string, WsServerMessage[]>();
  const tokens = new Map<string, string>();
  try {
    await fetch(`${baseUrl}/api/v1/broadcasts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "live", playlistUrl: "http://origin/live.m3u8" }),
    });
    for (const id of ["peer-a", "peer-b", "peer-c"]) {
      const join = await fetch(`${baseUrl}/api/v1/broadcasts/live/peers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, address: `http://${id}:9090` }),
      });
      tokens.set(id, (await join.json() as { sessionToken: string }).sessionToken);
    }
    // peer-a negotiates batching; peer-b and peer-c are legacy clients.
    for (const [id, features] of [
      ["peer-a", ["inventory_batch", "future_feature"]],
      ["peer-b", undefined],
      ["peer-c", undefined],
    ] as const) {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/ws?sessionToken=${encodeURIComponent(tokens.get(id) ?? "")}`,
      );
      sockets.set(id, socket);
      const messages: WsServerMessage[] = [];
      received.set(id, messages);
      socket.on("message", (data: RawData) => {
        messages.push(JSON.parse(data.toString()) as WsServerMessage);
      });
      await new Promise<void>((resolve) => socket.once("open", resolve));
      const subscribed = waitForMessage(socket, (message) => message.type === "peer_list");
      socket.send(
        JSON.stringify({
          type: "subscribe",
          broadcastId: "live",
          peerId: id,
          ...(features ? { features } : {}),
        }),
      );
      await subscribed;
    }
    const peerB = sockets.get("peer-b");
    const peerC = sockets.get("peer-c");
    assert.ok(peerB && peerC);
    const report = (socket: WebSocket, peerId: string, added: string[], removed: string[]) =>
      socket.send(
        JSON.stringify({ type: "report_segments", broadcastId: "live", peerId, added, removed }),
      );
    const legacyDeltas = (): WsServerMessage[] =>
      (received.get("peer-b") ?? []).filter(
        (message) => message.type === "segment_inventory_delta",
      );

    report(peerB, "peer-b", ["s1.ts"], []);
    report(peerB, "peer-b", ["s2.ts"], ["s1.ts"]);
    report(peerC, "peer-c", ["c1.ts"], []);
    const deadline = Date.now() + 1_000;
    while (legacyDeltas().length < 3) {
      assert.ok(Date.now() < deadline, "legacy subscriber did not receive every delta");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Legacy subscribers get each report as it arrives.
    assert.deepEqual(
      legacyDeltas().map((message) =>
        message.type === "segment_inventory_delta"
          ? [message.peerId, message.added, message.removed]
          : [],
      ),
      [
        ["peer-b", ["s1.ts"], []],
        ["peer-b", ["s2.ts"], ["s1.ts"]],
        ["peer-c", ["c1.ts"], []],
      ],
    );

    const leave = await fetch(`${baseUrl}/api/v1/broadcasts/live/peers/peer-c`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${tokens.get("peer-c") ?? ""}` },
    });
    assert.equal(leave.status, 204);
    const peerA = sockets.get("peer-a");
    assert.ok(peerA);
    const batch = await waitForMessage(
      peerA,
      (message) => message.type === "segment_inventory_batch",
    );

    // The batch carries peer-b's net change and drops peer-c, which left
    // before the flush.
    assert.deepEqual(batch, {
      type: "segment_inventory_batch",
      broadcastId: "live",
      updates: [{ peerId: "peer-b", added: ["s2.ts"], removed: ["s1.ts"] }],
    });
    const batchedTypes = (received.get("peer-a") ?? []).map((message) => message.type);
    assert.ok(!batchedTypes.includes("segment_inventory_delta"));
    assert.ok(
      batchedTypes.indexOf("peer_left") < batchedTypes.indexOf("segment_inventory_batch"),
    );

    // A full replacement absorbs later deltas into one replace update.
    const replaced = await fetch(`${baseUrl}/api/v1/broadcasts/live/peers/peer-b/segments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.get("peer-b") ?? ""}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ segments: ["r1.ts", "r2.ts"] }),
    });
    assert.equal(replaced.status, 200);
    const nextBatch = waitForMessage(
      peerA,
      (message) => message.type === "segment_inventory_batch",
    );
    report(peerB, "peer-b", ["r3.ts"], ["r1.ts"]);
    assert.deepEqual(await nextBatch, {
      type: "segment_inventory_batch",
      broadcastId: "live",
      updates: [{ peerId: "peer-b", segments: ["r2.ts", "r3.ts"], replace: true }],
    });
  } finally {
    for (const socket of sockets.values()) socket.close();
    await server.stop();
  }
});

test("drops pending inventory and closes subscribers when a broadcast is deleted", async () => {
  const server = new TrackerServer(() => new TrackerStore(), 30_000, {
    rateLimitRps: 100,
    rateLimitBurst: 200,
    maxPeersPerBroadcast: 500,
    wsInventoryBatchMs: 500,
  });
  const port = await server.start(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${port}`;
  const register = () =>
    fetch(`${baseUrl}/api/v1/broadcasts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "live", playlistUrl: "http://origin/live.m3u8" }),
    });
  const join = async (id: string): Promise<string> => {
    const response = await fetch(`${baseUrl}/api/v1/broadcasts/live/peers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, address: `http://${id}:9090` }),
    });
    return (await response.json() as { sessionToken: string }).sessionToken;
  };
  const listSegments = async (): Promise<string[][]> => {
    const response = await fetch(`${baseUrl}/api/v1/broadcasts/live/peers`);
    const body = await response.json() as { peers: Array<{ segments: string[] }> };
    return body.peers.map((peer) => peer.segments);
  };
  const sockets: WebSocket[] = [];
  const batches: WsServerMessage[] = [];
  const subscribe = async (token: string): Promise<WebSocket> => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?sessionToken=${encodeURIComponent(token)}`,
    );
    sockets.push(socket);
    socket.on("message", (data: RawData) => {
      const message = JSON.parse(data.toString()) as WsServerMessage;
      if (message.type === "segment_inventory_batch") batches.push(message);
    });
    await new Promise<void>((resolve) => socket.once("open", resolve));
    const subscribed = waitForMessage(socket, (message) => message.type === "peer_list");
    socket.send(
      JSON.stringify({
        type: "subscribe",
        broadcastId: "live",
        peerId: "peer-a",
        features: ["inventory_batch"],
      }),
    );
    await subscribed;
    return socket;
  };
  try {
    await register();
    const oldSocket = await subscribe(await join("peer-a"));
    const closed = new Promise<number>((resolve) => oldSocket.once("close", resolve));
    // Queue an update, then delete the broadcast before the batch is sent.
    oldSocket.send(
      JSON.stringify({
        type: "report_segments",
        broadcastId: "live",
        peerId: "peer-a",
        added: ["old.ts"],
        removed: [],
      }),
    );
    const deadline = Date.now() + 1_000;
    while (!(await listSegments()).flat().includes("old.ts")) {
      assert.ok(Date.now() < deadline, "the report was not applied");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const deleted = await fetch(`${baseUrl}/api/v1/broadcasts/live`, { method: "DELETE" });
    assert.equal(deleted.status, 204);
    assert.equal(await closed, 4_004);

    // A new broadcast that reuses the ID, and a subscriber that joins it
    // before the old batch would have been sent, see no old inventory.
    await register();
    await subscribe(await join("peer-a"));
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(batches, []);
    assert.deepEqual(await listSegments(), [[]]);
  } finally {
    for (const socket of sockets) socket.close();
    await server.stop();
  }
});

test("limits neighbor-view subscribers to their neighbors and refills on leave", async () => {
  const server = new TrackerServer(() => new TrackerStore(), 30_000, {
    rateLimitRps: 100,
    rateLimitBurst: 200,
    maxPeersPerBroadcast: 500,
    wsInventoryBatchMs: 100,
    neighborViewSize: 2,
  });
  const port = await server.start(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${port}`;
  const sockets: WebSocket[] = [];
  try {
    await fetch(`${baseUrl}/api/v1/broadcasts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "live", playlistUrl: "http://origin/live.m3u8" }),
    });
    const tokens = new Map<string, string>();
    for (const id of ["peer-a", "peer-b", "peer-c", "peer-d"]) {
      const join = await fetch(`${baseUrl}/api/v1/broadcasts/live/peers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, address: `http://${id}:9090` }),
      });
      tokens.set(id, (await join.json() as { sessionToken: string }).sessionToken);
    }
    const connect = async (id: string, features: string[]) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/ws?sessionToken=${encodeURIComponent(tokens.get(id) ?? "")}`,
      );
      sockets.push(socket);
      const messages: WsServerMessage[] = [];
      socket.on("message", (data: RawData) => {
        messages.push(JSON.parse(data.toString()) as WsServerMessage);
      });
      await new Promise<void>((resolve) => socket.once("open", resolve));
      const list = waitForMessage(socket, (message) => message.type === "peer_list");
      socket.send(JSON.stringify({ type: "subscribe", broadcastId: "live", peerId: id, features }));
      const peerList = await list;
      assert.equal(peerList.type, "peer_list");
      return { socket, messages, peerList: peerList.peers.map((peer) => peer.id).sort() };
    };

    const viewer = await connect("peer-d", ["inventory_batch", "neighbor_view"]);
    const full = await connect("peer-a", ["inventory_batch"]);
    // The viewer sees itself and two neighbors; a full subscriber sees everyone.
    assert.equal(viewer.peerList.length, 3);
    assert.ok(viewer.peerList.includes("peer-d"));
    assert.deepEqual(full.peerList, ["peer-a", "peer-b", "peer-c", "peer-d"]);
    const neighbors = viewer.peerList.filter((id) => id !== "peer-d");
    const outsider = ["peer-a", "peer-b", "peer-c"].find((id) => !neighbors.includes(id));
    assert.ok(outsider);

    for (const id of ["peer-a", "peer-b", "peer-c"]) {
      const join = await fetch(`${baseUrl}/api/v1/broadcasts/live/peers/${id}/segments`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.get(id) ?? ""}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ segments: [`${id}.ts`] }),
      });
      assert.equal(join.status, 200);
    }
    const batch = await waitForMessage(
      viewer.socket,
      (message) => message.type === "segment_inventory_batch",
    );
    assert.equal(batch.type, "segment_inventory_batch");
    assert.deepEqual(batch.updates.map((update) => update.peerId).sort(), neighbors.sort());

    // When a neighbor leaves, the viewer is told and its view is refilled
    // from the remaining audience. Other peers refill too and may link to or
    // evict the viewer, so check the resulting peer set, not message order.
    const [leaving] = neighbors;
    assert.ok(leaving);
    const seenBefore = viewer.messages.length;
    const left = await fetch(`${baseUrl}/api/v1/broadcasts/live/peers/${leaving}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${tokens.get(leaving) ?? ""}` },
    });
    assert.equal(left.status, 204);
    const remaining = ["peer-a", "peer-b", "peer-c"].filter((id) => id !== leaving).sort();
    const known = new Map<string, string[]>(
      neighbors.map((id) => [id, [`${id}.ts`]]),
    );
    const deadline = Date.now() + 1_000;
    let applied = seenBefore;
    while (true) {
      for (const message of viewer.messages.slice(applied)) {
        if (message.type === "peer_joined") known.set(message.peer.id, message.peer.segments);
        if (message.type === "peer_left") known.delete(message.peerId);
      }
      applied = viewer.messages.length;
      if ([...known.keys()].sort().join() === remaining.join()) break;
      assert.ok(Date.now() < deadline, `viewer knows ${[...known.keys()].join()}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(
      viewer.messages
        .slice(seenBefore)
        .some((message) => message.type === "peer_left" && message.peerId === leaving),
    );
    // A neighbor learned through peer_joined arrives with its inventory.
    assert.deepEqual(known.get(outsider), [`${outsider}.ts`]);

    const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
    assert.match(metrics, /openstreamgrid_ws_subscribers\{mode="neighbor_view"\} 1\n/);
    assert.match(metrics, /openstreamgrid_ws_subscribers\{mode="batched"\} 1\n/);
    assert.match(metrics, /openstreamgrid_ws_subscribers\{mode="immediate"\} 0\n/);
    const sent = Number(/openstreamgrid_ws_messages_sent_total (\d+)/.exec(metrics)?.[1]);
    const bytes = Number(/openstreamgrid_ws_bytes_sent_total (\d+)/.exec(metrics)?.[1]);
    assert.ok(sent >= viewer.messages.length + full.messages.length);
    assert.ok(bytes > sent);
  } finally {
    for (const socket of sockets) socket.close();
    await server.stop();
  }
});

test("neighbor views include peers restored from the store after a restart", async () => {
  const store = new TrackerStore();
  const configuration = {
    rateLimitRps: 100,
    rateLimitBurst: 200,
    maxPeersPerBroadcast: 500,
    peerSessionSecret: "test-peer-session-secret-0123456789",
    neighborViewSize: 4,
  };
  const before = new TrackerServer(() => store, 30_000, configuration);
  const beforePort = await before.start(0, "127.0.0.1");
  await fetch(`http://127.0.0.1:${beforePort}/api/v1/broadcasts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "live", playlistUrl: "http://origin/live.m3u8" }),
  });
  await fetch(`http://127.0.0.1:${beforePort}/api/v1/broadcasts/live/peers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "peer-old", address: "http://peer-old:9090" }),
  });
  await before.stop().catch(() => undefined);

  // The restarted tracker knows peer-old only from the store. A new peer that
  // opts into neighbor views must still be able to find it.
  const after = new TrackerServer(() => store, 30_000, configuration);
  const port = await after.start(0, "127.0.0.1");
  let socket: WebSocket | undefined;
  try {
    const join = await fetch(`http://127.0.0.1:${port}/api/v1/broadcasts/live/peers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "peer-new", address: "http://peer-new:9090" }),
    });
    const { sessionToken } = await join.json() as { sessionToken: string };
    const activeSocket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?sessionToken=${encodeURIComponent(sessionToken)}`,
    );
    socket = activeSocket;
    await new Promise<void>((resolve) => activeSocket.once("open", resolve));
    const list = waitForMessage(activeSocket, (message) => message.type === "peer_list");
    activeSocket.send(
      JSON.stringify({
        type: "subscribe",
        broadcastId: "live",
        peerId: "peer-new",
        features: ["inventory_batch", "neighbor_view"],
      }),
    );
    const peerList = await list;
    assert.equal(peerList.type, "peer_list");
    assert.deepEqual(peerList.peers.map((peer) => peer.id).sort(), ["peer-new", "peer-old"]);
  } finally {
    socket?.close();
    await after.stop();
  }
});

test("limits REST peer listings for peer sessions to their neighbor view", async () => {
  const server = new TrackerServer(() => new TrackerStore(), 30_000, {
    rateLimitRps: 100,
    rateLimitBurst: 200,
    maxPeersPerBroadcast: 500,
    trackerApiKey: "test-admin-key",
    neighborViewSize: 2,
  });
  const port = await server.start(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${port}`;
  const admin = { "x-api-key": "test-admin-key" };
  try {
    await fetch(`${baseUrl}/api/v1/broadcasts`, {
      method: "POST",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ id: "live", playlistUrl: "http://origin/live.m3u8" }),
    });
    const tokens = new Map<string, string>();
    for (const id of ["peer-a", "peer-b", "peer-c", "peer-d"]) {
      const join = await fetch(`${baseUrl}/api/v1/broadcasts/live/peers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, address: `http://${id}:9090` }),
      });
      tokens.set(id, (await join.json() as { sessionToken: string }).sessionToken);
      await fetch(`${baseUrl}/api/v1/broadcasts/live/peers/${id}/segments`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.get(id) ?? ""}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ segments: ["shared.ts"] }),
      });
    }
    const listed = async (path: string, headers: Record<string, string>): Promise<string[]> => {
      const response = await fetch(`${baseUrl}${path}`, { headers });
      assert.equal(response.status, 200);
      const body = await response.json() as { peers: Array<{ id: string }> };
      return body.peers.map((peer) => peer.id).sort();
    };
    const asPeer = { authorization: `Bearer ${tokens.get("peer-d") ?? ""}` };

    // A peer sees itself and its two neighbors, in both listings and with a
    // segment filter; an administrator sees everyone.
    const visible = await listed("/api/v1/broadcasts/live/peers", asPeer);
    assert.equal(visible.length, 3);
    assert.ok(visible.includes("peer-d"));
    assert.deepEqual(await listed("/api/v1/broadcasts/live", asPeer), visible);
    assert.deepEqual(
      await listed("/api/v1/broadcasts/live/peers?segment=shared.ts", asPeer),
      visible,
    );
    assert.deepEqual(await listed("/api/v1/broadcasts/live/peers?segment=none.ts", asPeer), []);
    assert.deepEqual(await listed("/api/v1/broadcasts/live/peers", admin), [
      "peer-a",
      "peer-b",
      "peer-c",
      "peer-d",
    ]);
  } finally {
    await server.stop();
  }
});

test("spreads a flush over several turns and still reaches every viewer", async () => {
  const server = new TrackerServer(() => new TrackerStore(), 30_000, {
    rateLimitRps: 100,
    rateLimitBurst: 200,
    maxPeersPerBroadcast: 500,
    wsInventoryBatchMs: 100,
    neighborViewSize: 8,
    wsViewersPerFlushTurn: 1,
  });
  const port = await server.start(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${port}`;
  const sockets: WebSocket[] = [];
  try {
    await fetch(`${baseUrl}/api/v1/broadcasts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "live", playlistUrl: "http://origin/live.m3u8" }),
    });
    const ids = ["peer-a", "peer-b", "peer-c", "peer-d"];
    const tokens = new Map<string, string>();
    for (const id of ids) {
      const join = await fetch(`${baseUrl}/api/v1/broadcasts/live/peers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, address: `http://${id}:9090` }),
      });
      tokens.set(id, (await join.json() as { sessionToken: string }).sessionToken);
    }
    const seen = new Map<string, Set<string>>();
    for (const id of ids) {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/ws?sessionToken=${encodeURIComponent(tokens.get(id) ?? "")}`,
      );
      sockets.push(socket);
      await new Promise<void>((resolve) => socket.once("open", resolve));
      const list = waitForMessage(socket, (message) => message.type === "peer_list");
      socket.send(
        JSON.stringify({
          type: "subscribe",
          broadcastId: "live",
          peerId: id,
          features: ["inventory_batch", "neighbor_view"],
        }),
      );
      await list;
      const updatedPeers = new Set<string>();
      seen.set(id, updatedPeers);
      socket.on("message", (data: RawData) => {
        const message = JSON.parse(data.toString()) as WsServerMessage;
        if (message.type !== "segment_inventory_batch") return;
        for (const update of message.updates) updatedPeers.add(update.peerId);
      });
    }
    // Every peer reports; each viewer must get its neighbors' updates even
    // though the flush serves one viewer per event-loop turn.
    ids.forEach((id, index) =>
      sockets[index]?.send(
        JSON.stringify({ type: "report_segments", broadcastId: "live", peerId: id, added: [`${id}.ts`], removed: [] }),
      ),
    );
    // Reports may straddle two flushes, so collect until every viewer has
    // seen each of its neighbors' updates.
    const complete = (): boolean =>
      ids.every((id) => (seen.get(id)?.size ?? 0) === ids.length - 1);
    const deadline = Date.now() + 2_000;
    while (!complete()) {
      assert.ok(Date.now() < deadline, "a viewer missed its neighbors' updates");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const id of ids) {
      assert.deepEqual([...(seen.get(id) ?? [])].sort(), ids.filter((other) => other !== id));
    }
  } finally {
    for (const socket of sockets) socket.close();
    await server.stop();
  }
});

test("announces peers removed by the stale sweep", async () => {
  const server = new TrackerServer(() => new TrackerStore(), 1_000, {
    rateLimitRps: 100,
    rateLimitBurst: 200,
    maxPeersPerBroadcast: 500,
  });
  const port = await server.start(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${port}`;
  let socket: WebSocket | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    await fetch(`${baseUrl}/api/v1/broadcasts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "live", playlistUrl: "http://origin/live.m3u8" }),
    });
    const tokens = new Map<string, string>();
    for (const id of ["peer-silent", "peer-active"]) {
      const join = await fetch(`${baseUrl}/api/v1/broadcasts/live/peers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, address: `http://${id}:9090` }),
      });
      tokens.set(id, (await join.json() as { sessionToken: string }).sessionToken);
    }
    const activeSocket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?sessionToken=${encodeURIComponent(tokens.get("peer-active") ?? "")}`,
    );
    socket = activeSocket;
    await new Promise<void>((resolve) => activeSocket.once("open", resolve));
    const list = waitForMessage(activeSocket, (message) => message.type === "peer_list");
    activeSocket.send(JSON.stringify({ type: "subscribe", broadcastId: "live", peerId: "peer-active" }));
    await list;
    // peer-active keeps heartbeating; peer-silent goes stale after 1 s.
    heartbeat = setInterval(() => {
      activeSocket.send(JSON.stringify({ type: "heartbeat", broadcastId: "live", peerId: "peer-active" }));
    }, 200);
    const left = await new Promise<WsServerMessage>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("No peer_left from the sweep")), 4_000);
      activeSocket.on("message", (data: RawData) => {
        const message = JSON.parse(data.toString()) as WsServerMessage;
        if (message.type !== "peer_left") return;
        clearTimeout(timeout);
        resolve(message);
      });
    });
    assert.deepEqual(left, { type: "peer_left", broadcastId: "live", peerId: "peer-silent" });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    socket?.close();
    await server.stop();
  }
});

test("authenticates WebSocket upgrades with a peer session", async () => {
  const server = new TrackerServer(
    () => new TrackerStore(),
    30_000,
    {
      trackerApiKey: "test secret/with symbols",
      rateLimitRps: 100,
      rateLimitBurst: 200,
      maxPeersPerBroadcast: 500,
    },
  );
  const port = await server.start(0, "127.0.0.1");
  const websocketUrl = `ws://127.0.0.1:${port}/ws`;
  const rejectedStatus = (url: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      socket.once("open", () => {
        socket.close();
        reject(new Error("Expected WebSocket upgrade to be rejected"));
      });
      socket.once("error", reject);
    });

  let authenticatedSocket: WebSocket | undefined;
  try {
    assert.equal(await rejectedStatus(websocketUrl), 401);
    assert.equal(await rejectedStatus(`${websocketUrl}?sessionToken=wrong`), 401);
    const broadcast = await fetch(`http://127.0.0.1:${port}/api/v1/broadcasts`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test secret/with symbols" },
      body: JSON.stringify({ id: "live", playlistUrl: "http://origin/live.m3u8" }),
    });
    assert.equal(broadcast.status, 201);
    const join = await fetch(`http://127.0.0.1:${port}/api/v1/broadcasts/live/peers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "peer-a", address: "http://peer-a:9090" }),
    });
    const { sessionToken } = await join.json() as { sessionToken: string };
    authenticatedSocket = new WebSocket(`${websocketUrl}?sessionToken=${encodeURIComponent(sessionToken)}`);
    await new Promise<void>((resolve, reject) => {
      authenticatedSocket?.once("open", resolve);
      authenticatedSocket?.once("error", reject);
    });
    assert.equal(authenticatedSocket.readyState, WebSocket.OPEN);

    // Both refused upgrades count as WebSocket auth failures.
    const metrics = await (
      await fetch(`http://127.0.0.1:${port}/metrics`, {
        headers: { "x-api-key": "test secret/with symbols" },
      })
    ).text();
    assert.match(metrics, /openstreamgrid_auth_failures_total\{interface="websocket"\} 2\n/);
    assert.match(metrics, /openstreamgrid_ws_upgrades_rejected_total\{reason="auth"\} 2\n/);
    assert.match(metrics, /openstreamgrid_ws_upgrades_rejected_total\{reason="origin"\} 0\n/);
  } finally {
    authenticatedSocket?.close();
    await server.stop();
  }
});

test("applies the WebSocket Origin allowlist to browser upgrades only", async () => {
  const server = new TrackerServer(
    () => new TrackerStore(),
    30_000,
    {
      trackerApiKey: "test-secret",
      rateLimitRps: 100,
      rateLimitBurst: 200,
      maxPeersPerBroadcast: 500,
      wsAllowedOrigins: ["https://player.example"],
    },
  );
  const port = await server.start(0, "127.0.0.1");
  const sockets: WebSocket[] = [];
  const upgradeStatus = (url: string, origin?: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(url, origin ? { origin } : undefined);
      sockets.push(socket);
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      socket.once("open", () => resolve(101));
      socket.once("error", reject);
    });

  try {
    const broadcast = await fetch(`http://127.0.0.1:${port}/api/v1/broadcasts`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-secret" },
      body: JSON.stringify({ id: "live", playlistUrl: "http://origin/live.m3u8" }),
    });
    assert.equal(broadcast.status, 201);
    const join = await fetch(`http://127.0.0.1:${port}/api/v1/broadcasts/live/peers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "peer-a", address: "http://peer-a:9090" }),
    });
    const { sessionToken } = await join.json() as { sessionToken: string };
    const url = `ws://127.0.0.1:${port}/ws?sessionToken=${encodeURIComponent(sessionToken)}`;

    assert.equal(await upgradeStatus(url, "https://attacker.example"), 403);
    // Sandboxed iframes and file:// pages send the literal "null" origin.
    assert.equal(await upgradeStatus(url, "null"), 403);
    assert.equal(await upgradeStatus(url, "https://player.example"), 101);
    // Node peers send no Origin header; they are still bound by session auth.
    assert.equal(await upgradeStatus(url), 101);
    assert.equal(await upgradeStatus(`ws://127.0.0.1:${port}/ws?sessionToken=wrong`), 401);
  } finally {
    for (const socket of sockets) socket.close();
    await server.stop();
  }
});

test("relays WebRTC offers and answers only to the target peer", async () => {
  const server = new TrackerServer(() => new TrackerStore());
  const port = await server.start(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${port}`;
  const sockets: WebSocket[] = [];
  try {
    await fetch(`${baseUrl}/api/v1/broadcasts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "live",
        playlistUrl: "http://origin/live.m3u8",
      }),
    });
    for (const peerId of ["peer-a", "peer-b"]) {
      const joinResponse = await fetch(`${baseUrl}/api/v1/broadcasts/live/peers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: peerId,
          address: `http://${peerId}:9090`,
        }),
      });
      const { sessionToken } = await joinResponse.json() as { sessionToken: string };
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?sessionToken=${encodeURIComponent(sessionToken)}`);
      sockets.push(socket);
      await new Promise<void>((resolve) => socket.once("open", resolve));
      const subscribed = waitForMessage(
        socket,
        (message) => message.type === "peer_list",
      );
      socket.send(
        JSON.stringify({ type: "subscribe", broadcastId: "live", peerId }),
      );
      await subscribed;
    }

    const peerASocket = sockets[0];
    const peerBSocket = sockets[1];
    assert.ok(peerASocket);
    assert.ok(peerBSocket);
    const offer = {
      type: "webrtc_offer",
      broadcastId: "live",
      peerId: "peer-a",
      targetPeerId: "peer-b",
      requestId: "request-1",
      sdp: "offer-sdp",
    } as const;
    const relayedOffer = waitForMessage(
      peerBSocket,
      (message) =>
        message.type === "webrtc_offer" && message.requestId === "request-1",
    );
    peerASocket.send(JSON.stringify(offer));
    assert.deepEqual(await relayedOffer, offer);

    const answer = {
      type: "webrtc_answer",
      broadcastId: "live",
      peerId: "peer-b",
      targetPeerId: "peer-a",
      requestId: "request-1",
      sdp: "answer-sdp",
    } as const;
    const relayedAnswer = waitForMessage(
      peerASocket,
      (message) =>
        message.type === "webrtc_answer" && message.requestId === "request-1",
    );
    peerBSocket.send(JSON.stringify(answer));
    assert.deepEqual(await relayedAnswer, answer);
  } finally {
    for (const socket of sockets) socket.close();
    await server.stop();
  }
});

test("coalesces bursts of dashboard updates into one leading and one trailing event", async () => {
  const store = new TrackerStore();
  store.registerBroadcast({ id: "live", playlistUrl: "http://origin/live.m3u8" });
  const sse = new TrackerStatsSse(store, 50);
  const writes: string[] = [];
  const response = {
    destroyed: false,
    writableEnded: false,
    writableNeedDrain: false,
    writeHead: () => response,
    flushHeaders: () => undefined,
    write: (chunk: string) => writes.push(chunk),
    once: () => response,
    end: () => undefined,
  };
  sse.connect(response as unknown as ServerResponse);
  const events = () => writes.filter((chunk) => chunk.startsWith("event:"));
  assert.equal(events().length, 1);

  for (let index = 0; index < 100; index += 1) sse.statsUpdated();
  sse.peerJoined();
  // The first event goes out at once; the rest wait for one trailing event.
  assert.equal(events().length, 2);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(events().length, 3);
  // The trailing event keeps the strongest event name of the burst.
  assert.match(events()[2] ?? "", /^event: broadcasts\n/);
  sse.stop();
});

test("sends dashboard segments only for the peers the mesh view draws", () => {
  const store = new TrackerStore();
  store.registerBroadcast({ id: "live", playlistUrl: "http://origin/live.m3u8" });
  for (let index = 0; index < 30; index += 1) {
    store.joinPeer("live", { id: `peer-${String(index).padStart(2, "0")}`, address: `http://peer-${index}:9090` });
    store.reportSegments("live", `peer-${String(index).padStart(2, "0")}`, ["a.ts"]);
  }
  const sse = new TrackerStatsSse(store);
  const writes: string[] = [];
  const response = {
    destroyed: false,
    writableEnded: false,
    writableNeedDrain: false,
    writeHead: () => response,
    flushHeaders: () => undefined,
    write: (chunk: string) => writes.push(chunk),
    once: () => response,
    end: () => undefined,
  };
  sse.connect(response as unknown as ServerResponse);
  sse.stop();
  const event = writes.find((chunk) => chunk.startsWith("event:")) ?? "";
  const snapshot = JSON.parse(/^data: (.*)$/m.exec(event)?.[1] ?? "{}") as TrackerStatsSnapshot;
  const peers = snapshot.broadcasts[0]?.peers ?? [];
  assert.equal(peers.length, 30);
  assert.ok(peers.slice(0, 24).every((entry) => entry.peer.segments.length === 1));
  assert.ok(peers.slice(24).every((entry) => entry.peer.segments.length === 0));
});

test("streams global, broadcast, REST, and WebSocket stats over SSE", async () => {
  const server = new TrackerServer(() => new TrackerStore());
  const port = await server.start(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${port}`;
  const abortController = new AbortController();
  let socket: WebSocket | undefined;
  try {
    await fetch(`${baseUrl}/api/v1/broadcasts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "live",
        playlistUrl: "http://origin/live.m3u8",
      }),
    });

    const response = await fetch(`${baseUrl}/api/v1/stats/events`, {
      signal: abortController.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    const nextEvent = createSseReader(response);
    const initial = await waitForSseEvent(
      nextEvent,
      (event) => event.event === "stats",
    );
    assert.equal(initial.data.global.broadcasts, 1);
    assert.equal(initial.data.global.peers, 0);
    assert.equal(initial.data.broadcasts[0]?.broadcast.id, "live");
    assert.deepEqual(initial.data.broadcasts[0]?.peers, []);

    const dashboard = await fetch(`${baseUrl}/dashboard`);
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.headers.get("content-type") ?? "", /^text\/html/);
    const dashboardHtml = await dashboard.text();
    assert.match(dashboardHtml, /new EventSource\("\/api\/v1\/stats\/events"\)/);
    assert.match(dashboardHtml, /id="broadcast-selector"/);
    assert.match(dashboardHtml, /All broadcasts/);
    assert.match(
      dashboardHtml,
      /broadcastSelector\.addEventListener\("change"/,
    );

    const sseJoinResponse = await fetch(`${baseUrl}/api/v1/broadcasts/live/peers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "peer-a", address: "http://peer-a:9090" }),
    });
    const { sessionToken } = await sseJoinResponse.json() as { sessionToken: string };
    const peerUpdate = await waitForSseEvent(
      nextEvent,
      (event) => event.event === "broadcasts" && event.data.global.peers === 1,
    );
    assert.equal(peerUpdate.data.broadcasts[0]?.stats.peers, 1);
    assert.equal(peerUpdate.data.broadcasts[0]?.peers[0]?.peer.id, "peer-a");

    const restStats = {
      bytesDownloadedP2P: 100,
      bytesDownloadedOrigin: 50,
      bytesUploadedP2P: 100,
      p2pRequests: 2,
      p2pSuccesses: 2,
      p2pFailures: 0,
      originRequests: 1,
      integrityFailures: 0,
      fallbacks: 0,
      segmentsCached: 2,
    };
    await fetch(`${baseUrl}/api/v1/broadcasts/live/peers/peer-a/stats`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ stats: restStats }),
    });
    const restUpdate = await waitForSseEvent(
      nextEvent,
      (event) => event.data.global.bytesDownloadedP2P === 100,
    );
    assert.equal(restUpdate.event, "stats");
    assert.equal(
      restUpdate.data.broadcasts[0]?.peers[0]?.stats.bytesDownloadedP2P,
      100,
    );

    const activeSocket = new WebSocket(`ws://127.0.0.1:${port}/ws?sessionToken=${encodeURIComponent(sessionToken)}`);
    socket = activeSocket;
    await new Promise<void>((resolve) => activeSocket.once("open", resolve));
    const subscribed = waitForMessage(
      activeSocket,
      (message) => message.type === "peer_list",
    );
    activeSocket.send(
      JSON.stringify({ type: "subscribe", broadcastId: "live", peerId: "peer-a" }),
    );
    await subscribed;
    activeSocket.send(
      JSON.stringify({
        type: "report_stats",
        broadcastId: "live",
        peerId: "peer-a",
        stats: { ...restStats, bytesDownloadedP2P: 250 },
      }),
    );
    const webSocketUpdate = await waitForSseEvent(
      nextEvent,
      (event) => event.data.global.bytesDownloadedP2P === 250,
    );
    assert.equal(webSocketUpdate.event, "stats");

    await fetch(`${baseUrl}/api/v1/broadcasts/live/peers/peer-a`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    const peerLeftUpdate = await waitForSseEvent(
      nextEvent,
      (event) => event.event === "broadcasts" && event.data.global.peers === 0,
    );
    assert.equal(peerLeftUpdate.data.broadcasts[0]?.stats.peers, 0);
  } finally {
    socket?.close();
    abortController.abort();
    await server.stop();
  }
});

test("rate limits REST mutations per forwarded client behind trusted proxies", async () => {
  const handler = createTrackerHandler(new TrackerStore(), {}, undefined, {
    rateLimitRps: 1,
    rateLimitBurst: 1,
    trustProxyHops: 1,
  });
  const register = (forwardedFor: string) =>
    invokeRaw(
      handler,
      "POST",
      "/api/v1/broadcasts",
      { id: `live-${forwardedFor}`, playlistUrl: "http://origin/live.m3u8" },
      "10.0.0.5",
      { "x-forwarded-for": forwardedFor },
    );
  // Every request arrives from the ingress at 10.0.0.5; viewers are told apart
  // by the address the ingress recorded.
  assert.equal((await register("203.0.113.1")).status, 201);
  assert.equal((await register("203.0.113.2")).status, 201);
  assert.equal((await register("203.0.113.1")).status, 429);
});

test("applies a configurable WebSocket limit per forwarded client", async () => {
  const server = new TrackerServer(() => new TrackerStore(), 30_000, {
    rateLimitRps: 100,
    rateLimitBurst: 200,
    maxPeersPerBroadcast: 500,
    wsMaxConnectionsPerIp: 1,
    trustProxyHops: 1,
  });
  const port = await server.start(0, "127.0.0.1");
  const sockets: WebSocket[] = [];
  const upgradeStatus = (url: string, forwardedFor: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { "x-forwarded-for": forwardedFor } });
      sockets.push(socket);
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      socket.once("open", () => resolve(101));
      socket.once("error", reject);
    });
  try {
    await fetch(`http://127.0.0.1:${port}/api/v1/broadcasts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "live", playlistUrl: "http://origin/live.m3u8" }),
    });
    const tokens: string[] = [];
    for (const id of ["peer-a", "peer-b", "peer-c"]) {
      const join = await fetch(`http://127.0.0.1:${port}/api/v1/broadcasts/live/peers`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${tokens.length + 10}` },
        body: JSON.stringify({ id, address: `http://${id}:9090` }),
      });
      tokens.push((await join.json() as { sessionToken: string }).sessionToken);
    }
    const url = (token: string) => `ws://127.0.0.1:${port}/ws?sessionToken=${encodeURIComponent(token)}`;
    assert.equal(await upgradeStatus(url(tokens[0] ?? ""), "203.0.113.1"), 101);
    // A different viewer behind the same proxy gets its own slot.
    assert.equal(await upgradeStatus(url(tokens[1] ?? ""), "203.0.113.2"), 101);
    // A second connection from the same viewer exceeds the limit of 1.
    assert.equal(await upgradeStatus(url(tokens[2] ?? ""), "203.0.113.1"), 429);
  } finally {
    for (const socket of sockets) socket.close();
    await server.stop();
  }
});

test("keeps peer and broadcast metadata small", async () => {
  const handler = createTrackerHandler(new TrackerStore());
  const register = (metadata: unknown) =>
    invoke(handler, "POST", "/api/v1/broadcasts", {
      id: "live",
      playlistUrl: "http://origin/live.m3u8",
      metadata,
    });
  const join = (id: string, metadata: unknown) =>
    invoke(handler, "POST", "/api/v1/broadcasts/live/peers", {
      id,
      address: `http://${id}:9090`,
      metadata,
    });

  assert.equal((await register({ owner: "origin", leaseExpiresAt: "2026-10-20T00:00:00Z" })).status, 201);
  const accepted = await join("peer-a", {
    uploadToken: "x".repeat(43),
    rendition: "low",
    "app.region": "eu-west:1",
  });
  assert.equal(accepted.status, 201);

  const rejected: Array<[unknown, string]> = [
    [
      Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, "v"])),
      "'metadata' must have at most 32 entries",
    ],
    [{ "bad key": "v" }, "'metadata' keys must be 1 to 64 letters, digits, '_', '.', ':' or '-'"],
    [{ ["k".repeat(65)]: "v" }, "'metadata' keys must be 1 to 64 letters, digits, '_', '.', ':' or '-'"],
    [{ big: "v".repeat(1_025) }, "'metadata' values must be at most 1024 characters"],
    [
      Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`k${index}`, "v".repeat(1_000)])),
      "'metadata' must total at most 4096 characters",
    ],
  ];
  for (const [metadata, error] of rejected) {
    const response = await join("peer-b", metadata);
    assert.equal(response.status, 400);
    assert.deepEqual(response.json, { error });
  }
  const broadcast = await register({ big: "v".repeat(1_025) });
  assert.equal(broadcast.status, 400);
});

test("bounds peer IDs and addresses on join", async () => {
  const handler = createTrackerHandler(new TrackerStore());
  await invoke(handler, "POST", "/api/v1/broadcasts", {
    id: "live",
    playlistUrl: "http://origin/live.m3u8",
  });
  const join = (id: string, address = `http://peer:9090`) =>
    invoke(handler, "POST", "/api/v1/broadcasts/live/peers", { id, address });

  assert.equal((await join("peer-a.example_01:x")).status, 201);
  assert.equal((await join("p".repeat(128), "http://peer-b:9090")).status, 201);
  const cases: Array<[string, string, string]> = [
    ["p".repeat(129), "http://peer-c:9090", "'id' must be at most 128 characters"],
    ["peer c", "http://peer-c:9090", "'id' must not contain whitespace or control characters"],
    ["peer\u0000c", "http://peer-c:9090", "'id' must not contain whitespace or control characters"],
    ["peer-c", `http://peer-c:9090/${"a".repeat(2_048)}`, "'address' must be at most 2048 characters"],
  ];
  for (const [id, address, error] of cases) {
    const response = await join(id, address);
    assert.equal(response.status, 400, error);
    assert.deepEqual(response.json, { error });
  }
});
