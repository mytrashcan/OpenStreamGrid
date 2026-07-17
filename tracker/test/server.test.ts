import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type { WsServerMessage } from "@openstreamgrid/common";
import WebSocket, { type RawData } from "ws";
import {
  createConfiguredStore,
  createTrackerHandler,
  parseTrackerConfiguration,
  TrackerServer,
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
    stalePeerMs: 30_000,
  });
  assert.deepEqual(
    parseTrackerConfiguration({
      PORT: "8081",
      HOST: "127.0.0.1",
      STALE_PEER_MS: "5000",
    }),
    { port: 8081, host: "127.0.0.1", stalePeerMs: 5_000 },
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
    () => parseTrackerConfiguration({ TRACKER_API_KEY: " " }),
    /TRACKER_API_KEY must not be empty/,
  );
  assert.throws(
    () => parseTrackerConfiguration({ TLS_CERT_PATH: "/tmp/cert.pem" }),
    /TLS_CERT_PATH and TLS_KEY_PATH must be configured together/,
  );
  assert.throws(
    () =>
      parseTrackerConfiguration({
        TLS_CERT_PATH: "/missing/cert.pem",
        TLS_KEY_PATH: "/missing/key.pem",
      }),
    /TLS_CERT_PATH must point to an existing file/,
  );
  assert.throws(
    () => createConfiguredStore({ STORE_TYPE: "sqlite", DB_PATH: " " }),
    /DB_PATH must not be empty/,
  );
});

test("accepts complete TLS and API key configuration", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "openstreamgrid-tls-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const certPath = path.join(directory, "cert.pem");
  const keyPath = path.join(directory, "key.pem");
  await Promise.all([writeFile(certPath, "certificate"), writeFile(keyPath, "key")]);

  assert.deepEqual(
    parseTrackerConfiguration({
      TRACKER_API_KEY: "test-secret",
      TLS_CERT_PATH: certPath,
      TLS_KEY_PATH: keyPath,
    }),
    {
      port: 7070,
      host: "0.0.0.0",
      stalePeerMs: 30_000,
      apiKey: "test-secret",
      tlsCertPath: certPath,
      tlsKeyPath: keyPath,
    },
  );
});

const invoke = async (
  handler: ReturnType<typeof createTrackerHandler>,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<TestResponse> => {
  const payload = body === undefined ? [] : [JSON.stringify(body)];
  const request = Object.assign(Readable.from(payload), {
    method,
    url,
    headers,
  }) as unknown as IncomingMessage;
  let status = 0;
  let responseBody = "";
  let headersSent = false;
  const response = {
    get headersSent() {
      return headersSent;
    },
    writeHead(statusCode: number) {
      status = statusCode;
      headersSent = true;
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

test("requires the configured API key for mutating REST requests", async () => {
  const handler = createTrackerHandler(
    new TrackerStore(),
    {},
    undefined,
    "test-secret",
  );

  assert.equal((await invoke(handler, "GET", "/health")).status, 200);
  assert.equal((await invoke(handler, "GET", "/api/v1/broadcasts")).status, 200);
  for (const method of ["POST", "PUT", "DELETE"]) {
    assert.deepEqual(await invoke(handler, method, "/not-a-route"), {
      status: 401,
      json: { error: "Unauthorized" },
    });
    assert.equal(
      (
        await invoke(handler, method, "/not-a-route", undefined, {
          "x-api-key": "wrong-secret",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await invoke(handler, method, "/not-a-route", undefined, {
          "x-api-key": "test-secret",
        })
      ).status,
      404,
    );
  }
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
  assert.deepEqual(join.json, {
    id: "peer-a",
    address: "http://peer-a:9090",
    segments: [],
    joinedAt: (join.json as { joinedAt: string }).joinedAt,
    lastSeenAt: (join.json as { lastSeenAt: string }).lastSeenAt,
    latencyMs: 0,
    successRate: 1,
    trustScore: 1,
  });

  const segmentReport = await invoke(
    handler,
    "POST",
    "/api/v1/broadcasts/live/peers/peer-a/segments",
    { segments: ["segment_1.ts"] },
  );
  assert.equal(segmentReport.status, 200);
  assert.deepEqual((segmentReport.json as { segments: string[] }).segments, [
    "segment_1.ts",
  ]);
  const peers = await invoke(
    handler,
    "GET",
    "/api/v1/broadcasts/live/peers?segment=segment_1.ts",
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
  );

  assert.equal(first.status, 201);
  assert.equal(duplicate.status, 200);
  assert.equal((first.json as { address: string }).address, "http://peer-a:9090");
  assert.equal((duplicate.json as { address: string }).address, "http://peer-a:9191");
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
  await invoke(handler, "POST", "/api/v1/broadcasts/live/peers", {
    id: "peer-a",
    address: "http://peer-a:9090",
  });

  const stats = await invoke(
    handler,
    "POST",
    "/api/v1/broadcasts/live/peers/peer-a/stats",
    { stats: { bytesDownloadedP2P: "not-a-number" } },
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
      1_000,
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
    await fetch(`${baseUrl}/api/v1/broadcasts/live/peers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "peer-a",
        address: "http://peer-a:9090",
      }),
    });
    const activeSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ segments: ["segment_1.ts"] }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await segmentUpdate, {
      type: "segment_available",
      broadcastId: "live",
      peerId: "peer-a",
      segments: ["segment_1.ts"],
    });
  } finally {
    socket?.close();
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
      await fetch(`${baseUrl}/api/v1/broadcasts/live/peers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: peerId,
          address: `http://${peerId}:9090`,
        }),
      });
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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

    const dashboard = await fetch(`${baseUrl}/dashboard`);
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await dashboard.text(), /new EventSource\("\/api\/v1\/stats\/events"\)/);

    await fetch(`${baseUrl}/api/v1/broadcasts/live/peers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "peer-a", address: "http://peer-a:9090" }),
    });
    const peerUpdate = await waitForSseEvent(
      nextEvent,
      (event) => event.event === "broadcasts" && event.data.global.peers === 1,
    );
    assert.equal(peerUpdate.data.broadcasts[0]?.stats.peers, 1);

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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stats: restStats }),
    });
    const restUpdate = await waitForSseEvent(
      nextEvent,
      (event) => event.data.global.bytesDownloadedP2P === 100,
    );
    assert.equal(restUpdate.event, "stats");

    const activeSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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
