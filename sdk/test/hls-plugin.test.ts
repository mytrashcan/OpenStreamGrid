import assert from "node:assert/strict";
import test from "node:test";
import type Hls from "hls.js";
import { OpenStreamGridHlsPlugin } from "../src/hls-plugin.js";
import type { PeerInfo, SdkEvent } from "../src/types.js";

const segmentData = new TextEncoder().encode("segment-data");
const digest = "f554040cf9955040894e4b537fd87fdcf345ca5751905b1e6f7fe067d7798e71";

const peer = (address: string): PeerInfo => ({
  id: "peer-a",
  address,
  segments: ["segment.ts"],
  latencyMs: 10,
  successRate: 1,
  trustScore: 1,
});

test("uses absolute tracker peer addresses and reports the winning peer", async (context) => {
  const events: SdkEvent[] = [];
  const requests: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    requests.push(String(input));
    if (String(input).endsWith(".sha256")) {
      return new Response(`${digest}  segment.ts\n`);
    }
    return new Response(segmentData);
  });
  const plugin = new OpenStreamGridHlsPlugin({
    trackerUrl: "ws://tracker.example/ws",
    broadcastId: "live",
    originBaseUrl: "https://origin.example/hls",
    onEvent: (event) => events.push(event),
  });
  context.mock.method(plugin.wsClient, "getPeersWithSegment", () => [
    peer("http://peer-a.example:9090"),
  ]);

  const result = await plugin.loadSegment(
    "segment.ts",
    "https://origin.example/hls/low/segment.ts",
    new AbortController().signal,
  );

  assert.deepEqual(result.data, segmentData);
  assert.equal(requests[0], "http://peer-a.example:9090/segments/segment.ts");
  assert.equal(requests[1], "https://origin.example/hls/low/segment.ts.sha256");
  assert.equal(
    events.find((event) => event.type === "peer_fetched")?.peerId,
    "peer-a",
  );
  assert.equal(plugin.stats.p2pRequests, 1);
  assert.equal(plugin.stats.p2pSuccesses, 1);
});

test("verifies origin fallback data before caching it", async (context) => {
  context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    if (String(input).endsWith(".sha256")) {
      return new Response(`${"0".repeat(64)}  segment.ts\n`);
    }
    return new Response(segmentData);
  });
  const plugin = new OpenStreamGridHlsPlugin({
    trackerUrl: "ws://tracker.example/ws",
    broadcastId: "live",
    originBaseUrl: "https://origin.example/hls",
  });

  await assert.rejects(
    plugin.loadSegment(
      "segment.ts",
      "https://origin.example/hls/high/segment.ts",
      new AbortController().signal,
    ),
    /integrity check failed/,
  );
  assert.equal(plugin.cache.size, 0);
  assert.equal(plugin.stats.integrityFailures, 1);
});

test("keeps rendition cache entries isolated by segment URL", async (context) => {
  let request = 0;
  context.mock.method(globalThis, "fetch", async () => {
    request += 1;
    return new Response(new Uint8Array([request]));
  });
  const plugin = new OpenStreamGridHlsPlugin({
    trackerUrl: "ws://tracker.example/ws",
    broadcastId: "live",
    verifySegments: false,
    peerParticipation: false,
  });

  const low = await plugin.loadSegment(
    "segment.ts",
    "https://origin.example/hls/low/segment.ts",
    new AbortController().signal,
  );
  const high = await plugin.loadSegment(
    "segment.ts",
    "https://origin.example/hls/high/segment.ts",
    new AbortController().signal,
  );

  assert.deepEqual([...low.data], [1]);
  assert.deepEqual([...high.data], [2]);
  assert.equal(plugin.cache.size, 2);
});

test("restores the Hls.js loader when detached", (context) => {
  const plugin = new OpenStreamGridHlsPlugin({
    trackerUrl: "ws://tracker.example/ws",
    broadcastId: "live",
    verifySegments: false,
    peerParticipation: false,
  });
  context.mock.method(plugin.wsClient, "start", async () => {});
  context.mock.method(plugin.wsClient, "stop", () => {});
  class OriginalLoader {}
  const hls = {
    config: { loader: OriginalLoader },
  } as unknown as Hls;

  plugin.attach(hls);
  assert.notEqual(hls.config.loader, OriginalLoader);
  plugin.detach();

  assert.equal(hls.config.loader, OriginalLoader);
});

test("registers and unregisters a zero-install browser peer", async (context) => {
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    return init?.method === "POST"
      ? Response.json({
          sessionToken: "test-peer-session",
          expiresAt: "2099-01-01T00:00:00.000Z",
        }, { status: 201 })
      : new Response(null, { status: 204 });
  });
  const plugin = new OpenStreamGridHlsPlugin({
    trackerUrl: "wss://tracker.example/ws",
    broadcastId: "live event",
    peerId: "browser-a",
    verifySegments: false,
  });
  context.mock.method(plugin.wsClient, "start", async () => {});
  context.mock.method(plugin.wsClient, "stop", () => {});
  context.mock.method(plugin.wsClient, "enablePeerStateReporting", () => {});
  class OriginalLoader {}
  const hls = { config: { loader: OriginalLoader } } as unknown as Hls;

  plugin.attach(hls);
  await new Promise((resolve) => setTimeout(resolve, 0));
  plugin.detach();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(requests[0]?.method, "POST");
  assert.equal(
    requests[0]?.url,
    "https://tracker.example/api/v1/broadcasts/live%20event/peers",
  );
  assert.deepEqual(JSON.parse(requests[0]?.body ?? "null"), {
    id: "browser-a",
    address: "webrtc://browser-a",
    uploadBandwidthBps: 1_000_000,
    metadata: { runtime: "browser", transport: "webrtc" },
  });
  assert.equal(requests[1]?.method, "DELETE");
  assert.equal(
    requests[1]?.url,
    "https://tracker.example/api/v1/broadcasts/live%20event/peers/browser-a",
  );
});
