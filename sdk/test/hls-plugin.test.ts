import assert from "node:assert/strict";
import test from "node:test";
import type {
  SegmentScheduler,
  SegmentSchedulingPlan,
} from "@openstreamgrid/common";
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
  const peerFetched = events.find((event) => event.type === "peer_fetched");
  assert.ok(peerFetched && "peerId" in peerFetched);
  assert.equal(peerFetched.peerId, "peer-a");
  assert.deepEqual(
    events.find((event) => event.type === "scheduler_decision"),
    {
      type: "scheduler_decision",
      policy: "deadline-aware",
      mode: "parallel-peers",
      reason: "deadline_unknown_legacy",
      candidateCount: 1,
      selectedPeerCount: 1,
    },
  );
  assert.equal(plugin.stats.p2pRequests, 1);
  assert.equal(plugin.stats.p2pSuccesses, 1);
});

test("reports failed peer attempts with the reason before falling back", async (context) => {
  const events: SdkEvent[] = [];
  context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("http://peer-a.example")) return new Response(null, { status: 503 });
    if (url.endsWith(".sha256")) return new Response(`${digest}  segment.ts\n`);
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
  assert.deepEqual(events.find((event) => event.type === "peer_failed"), {
    type: "peer_failed",
    segment: "segment.ts",
    peerId: "peer-a",
    message: "Peer returned HTTP 503",
  });
  assert.ok(events.some((event) => event.type === "origin_fallback"));
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

test("uses an injected scheduler while keeping Origin fallback authoritative", async (context) => {
  const events: SdkEvent[] = [];
  const requests: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(segmentData);
  });
  const plugin = new OpenStreamGridHlsPlugin({
    trackerUrl: "ws://tracker.example/ws",
    broadcastId: "live",
    verifySegments: false,
    peerParticipation: false,
    scheduler: {
      policyName: "origin-only",
      planSegment: () => ({
        policy: "origin-only",
        mode: "origin",
        peerIds: [],
        rankedPeers: [],
        reason: "urgent_origin",
      }),
    },
    onEvent: (event) => events.push(event),
  });
  context.mock.method(plugin.wsClient, "getPeersWithSegment", () => [
    peer("http://peer-a.example:9090"),
  ]);

  const result = await plugin.loadSegment(
    "segment.ts",
    "https://origin.example/hls/segment.ts",
    new AbortController().signal,
  );

  assert.deepEqual(result.data, segmentData);
  assert.deepEqual(requests, ["https://origin.example/hls/segment.ts"]);
  assert.deepEqual(
    events.find((event) => event.type === "scheduler_decision"),
    {
      type: "scheduler_decision",
      policy: "origin-only",
      mode: "origin",
      reason: "urgent_origin",
      candidateCount: 1,
      selectedPeerCount: 0,
    },
  );
  assert.equal(plugin.stats.p2pRequests, 0);
});

test("falls back to Origin when an injected scheduler throws", async (context) => {
  const events: SdkEvent[] = [];
  const requests: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(segmentData);
  });
  const plugin = new OpenStreamGridHlsPlugin({
    trackerUrl: "ws://tracker.example/ws",
    broadcastId: "live",
    verifySegments: false,
    peerParticipation: false,
    scheduler: {
      policyName: "throwing",
      planSegment(): SegmentSchedulingPlan {
        throw new Error("scheduler failed");
      },
    },
    onEvent: (event) => events.push(event),
  });
  context.mock.method(plugin.wsClient, "getPeersWithSegment", () => [
    peer("http://peer-a.example:9090"),
  ]);

  const result = await plugin.loadSegment(
    "segment.ts",
    "https://origin.example/hls/segment.ts",
    new AbortController().signal,
  );

  assert.deepEqual(result.data, segmentData);
  assert.deepEqual(requests, ["https://origin.example/hls/segment.ts"]);
  assert.equal(plugin.stats.p2pRequests, 0);
  assert.ok(
    events.some(
      (event) =>
        event.type === "scheduler_warning" &&
        event.code === "invalid_plan" &&
        /scheduler failed/.test(event.message),
    ),
  );
});

test("falls back to Origin when an injected scheduler returns an invalid plan", async (context) => {
  const events: SdkEvent[] = [];
  const requests: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(segmentData);
  });
  const plugin = new OpenStreamGridHlsPlugin({
    trackerUrl: "ws://tracker.example/ws",
    broadcastId: "live",
    verifySegments: false,
    peerParticipation: false,
    scheduler: {
      policyName: "invalid",
      planSegment: () => ({
        policy: "invalid",
        mode: "single-peer",
        peerIds: ["unknown-peer"],
        rankedPeers: [],
        reason: "peer_selected",
      }),
    },
    onEvent: (event) => events.push(event),
  });
  context.mock.method(plugin.wsClient, "getPeersWithSegment", () => [
    peer("http://peer-a.example:9090"),
  ]);

  const result = await plugin.loadSegment(
    "segment.ts",
    "https://origin.example/hls/segment.ts",
    new AbortController().signal,
  );

  assert.deepEqual(result.data, segmentData);
  assert.deepEqual(requests, ["https://origin.example/hls/segment.ts"]);
  assert.equal(plugin.stats.p2pRequests, 0);
  assert.ok(
    events.some(
      (event) =>
        event.type === "scheduler_warning" && event.code === "unknown_peer",
    ),
  );
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

test("resets the injected scheduler when detached", () => {
  let resets = 0;
  const scheduler: SegmentScheduler = {
    policyName: "resettable",
    planSegment: () => ({
      policy: "resettable",
      mode: "origin",
      peerIds: [],
      rankedPeers: [],
      reason: "urgent_origin",
    }),
    reset(): void {
      resets += 1;
    },
  };
  const plugin = new OpenStreamGridHlsPlugin({
    trackerUrl: "ws://tracker.example/ws",
    broadcastId: "live",
    verifySegments: false,
    peerParticipation: false,
    scheduler,
  });

  plugin.detach();

  assert.equal(resets, 1);
});

test("contains scheduler reset failures when detached", (context) => {
  context.mock.method(console, "warn", () => {});
  const plugin = new OpenStreamGridHlsPlugin({
    trackerUrl: "ws://tracker.example/ws",
    broadcastId: "live",
    verifySegments: false,
    peerParticipation: false,
    scheduler: {
      policyName: "throwing-reset",
      planSegment: () => ({
        policy: "throwing-reset",
        mode: "origin",
        peerIds: [],
        rankedPeers: [],
        reason: "urgent_origin",
      }),
      reset(): void {
        throw new Error("reset failed");
      },
    },
  });

  assert.doesNotThrow(() => plugin.detach());
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

test("passes tracker-issued TURN credentials to the browser WebRTC peer", async (context) => {
  context.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST"
      ? Response.json({
          sessionToken: "test-peer-session",
          expiresAt: "2099-01-01T00:00:00.000Z",
          iceServers: [
            {
              urls: ["turns:turn.example.com:5349"],
              username: "4070908800:browser-a",
              credential: "issued-credential",
            },
            { urls: 42 },
            "not-an-object",
          ],
        }, { status: 201 })
      : new Response(null, { status: 204 }));
  const issued: RTCIceServer[][] = [];
  const plugin = new OpenStreamGridHlsPlugin({
    trackerUrl: "https://tracker.example",
    broadcastId: "live",
    peerId: "browser-a",
    verifySegments: false,
    peerConnectionFactory: () => {
      throw new Error("no connection expected");
    },
  });
  context.mock.method(plugin.wsClient, "start", async () => {});
  context.mock.method(plugin.wsClient, "stop", () => {});
  context.mock.method(plugin.wsClient, "enablePeerStateReporting", () => {});
  class OriginalLoader {}
  const hls = { config: { loader: OriginalLoader } } as unknown as Hls;

  plugin.attach(hls);
  const webRtcPeer = (plugin as unknown as {
    webRtcPeer: { setIssuedIceServers(servers: RTCIceServer[]): void };
  }).webRtcPeer;
  context.mock.method(webRtcPeer, "setIssuedIceServers", (servers: RTCIceServer[]) => {
    issued.push(servers);
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  plugin.detach();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(issued, [[
    {
      urls: ["turns:turn.example.com:5349"],
      username: "4070908800:browser-a",
      credential: "issued-credential",
    },
  ]]);
});

test("replaces TURN credentials when the peer session is refreshed", async (context) => {
  let registrations = 0;
  context.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "POST") return new Response(null, { status: 204 });
    registrations += 1;
    return Response.json({
      sessionToken: `session-${registrations}`,
      // Expires just over the 60 s refresh margin, so the refresh fires in ~1.5 s.
      expiresAt: new Date(Date.now() + 61_500).toISOString(),
      iceServers: [{
        urls: ["turns:turn.example.com:5349"],
        username: `expiry-${registrations}:browser-a`,
        credential: `credential-${registrations}`,
      }],
    }, { status: registrations === 1 ? 201 : 200 });
  });
  const issued: string[] = [];
  const plugin = new OpenStreamGridHlsPlugin({
    trackerUrl: "https://tracker.example",
    broadcastId: "live",
    peerId: "browser-a",
    verifySegments: false,
    peerConnectionFactory: () => {
      throw new Error("no connection expected");
    },
  });
  context.mock.method(plugin.wsClient, "start", async () => {});
  context.mock.method(plugin.wsClient, "stop", () => {});
  context.mock.method(plugin.wsClient, "enablePeerStateReporting", () => {});
  class OriginalLoader {}
  const hls = { config: { loader: OriginalLoader } } as unknown as Hls;

  plugin.attach(hls);
  const webRtcPeer = (plugin as unknown as {
    webRtcPeer: { setIssuedIceServers(servers: RTCIceServer[]): void };
  }).webRtcPeer;
  context.mock.method(webRtcPeer, "setIssuedIceServers", (servers: RTCIceServer[]) => {
    issued.push(servers.map((server) => server.credential ?? "").join(","));
  });
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  plugin.detach();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(registrations, 2);
  assert.deepEqual(issued, ["credential-1", "credential-2"]);
});
