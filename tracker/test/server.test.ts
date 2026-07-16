import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import type { WsServerMessage } from "@openstreamgrid/common";
import WebSocket, { type RawData } from "ws";
import {
  createTrackerHandler,
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

const invoke = async (
  handler: ReturnType<typeof createTrackerHandler>,
  method: string,
  url: string,
  body?: unknown,
): Promise<TestResponse> => {
  const payload = body === undefined ? [] : [JSON.stringify(body)];
  const request = Object.assign(Readable.from(payload), {
    method,
    url,
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

test("exposes the broadcast and peer lifecycle over REST", async () => {
  const handler = createTrackerHandler(new TrackerStore());

  const registration = await invoke(handler, "POST", "/api/v1/broadcasts", {
    id: "live",
    playlistUrl: "http://origin/live.m3u8",
  });
  assert.equal(registration.status, 201);

  const join = await invoke(handler, "POST", "/api/v1/broadcasts/live/peers", {
    id: "peer-a",
    address: "http://peer-a:9090",
  });
  assert.equal(join.status, 201);

  await invoke(
    handler,
    "POST",
    "/api/v1/broadcasts/live/peers/peer-a/segments",
    { segments: ["segment_1.ts"] },
  );
  const peers = await invoke(
    handler,
    "GET",
    "/api/v1/broadcasts/live/peers?segment=segment_1.ts",
  );
  const peerBody = peers.json as { peers: Array<{ id: string }> };
  assert.deepEqual(peerBody.peers.map((peer) => peer.id), ["peer-a"]);

  const health = await invoke(handler, "GET", "/health");
  assert.equal(health.status, 200);
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
  const server = new TrackerServer();
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

test("streams global, broadcast, REST, and WebSocket stats over SSE", async () => {
  const server = new TrackerServer();
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
