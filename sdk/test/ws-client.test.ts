import assert from "node:assert/strict";
import test from "node:test";
import { WsTrackerClient } from "../src/ws-client.js";
import type { WebRtcSignalMessage } from "../src/types.js";

class FakeWebSocket {
  readyState: number = WebSocket.CONNECTING;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: (() => void) | null = null;

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }
}

test("appends the peer session token to the WebSocket URL", async () => {
  const socket = new FakeWebSocket();
  let requestedUrl = "";
  const client = new WsTrackerClient({
    trackerUrl: "https://tracker.example/base?ignored=true",
    broadcastId: "live",
    peerId: "browser-viewer",
    reportPeerState: false,
    webSocketFactory: (url) => {
      requestedUrl = url;
      return socket as unknown as WebSocket;
    },
  });
  client.setSessionToken("test session/with symbols");

  const started = client.start();
  socket.open();
  await started;
  client.stop();

  assert.equal(
    requestedUrl,
    "wss://tracker.example/ws?sessionToken=test+session%2Fwith+symbols",
  );
});

test("supports passive subscriptions without reporting unregistered peer state", async () => {
  const socket = new FakeWebSocket();
  const client = new WsTrackerClient({
    trackerUrl: "ws://tracker.example/ws",
    broadcastId: "live",
    peerId: "browser-viewer",
    reportPeerState: false,
    reportIntervalMs: 5,
    webSocketFactory: () => socket as unknown as WebSocket,
  });
  client.setSessionToken("test-session");

  const started = client.start();
  socket.open();
  await started;
  await new Promise((resolve) => setTimeout(resolve, 15));
  client.reportSegments();
  client.stop();

  assert.deepEqual(
    socket.sent.map((message) => JSON.parse(message)),
    [
      {
        type: "subscribe",
        broadcastId: "live",
        peerId: "browser-viewer",
        features: ["inventory_batch", "neighbor_view"],
      },
    ],
  );
});

test("enables peer reports after registration", async () => {
  const socket = new FakeWebSocket();
  const client = new WsTrackerClient({
    trackerUrl: "ws://tracker.example/ws",
    broadcastId: "live",
    peerId: "browser-viewer",
    getSegments: () => ["hls/low/segment.ts"],
    getStats: () => ({
      bytesDownloadedP2P: 1,
      bytesDownloadedOrigin: 2,
      bytesUploadedP2P: 3,
      p2pRequests: 1,
      p2pSuccesses: 1,
      p2pFailures: 0,
      originRequests: 1,
      integrityFailures: 0,
      fallbacks: 0,
      segmentsCached: 1,
    }),
    reportPeerState: false,
    reportIntervalMs: 5,
    webSocketFactory: () => socket as unknown as WebSocket,
  });
  client.setSessionToken("test-session");

  const started = client.start();
  socket.open();
  await started;
  client.enablePeerStateReporting();
  await new Promise((resolve) => setTimeout(resolve, 12));
  client.stop();

  const messages = socket.sent.map((message) => JSON.parse(message) as { type: string });
  assert.ok(messages.some((message) => message.type === "heartbeat"));
  assert.ok(messages.some((message) => message.type === "report_segments"));
  assert.ok(messages.some((message) => message.type === "report_stats"));
});

test("relays validated WebRTC signaling messages", async () => {
  const socket = new FakeWebSocket();
  const received: WebRtcSignalMessage[] = [];
  const client = new WsTrackerClient({
    trackerUrl: "ws://tracker.example/ws",
    broadcastId: "live",
    peerId: "browser-a",
    reportPeerState: false,
    onWebRtcSignal: (message) => received.push(message),
    webSocketFactory: () => socket as unknown as WebSocket,
  });
  client.setSessionToken("test-session");
  const started = client.start();
  socket.open();
  await started;
  const offer: WebRtcSignalMessage = {
    type: "webrtc_offer",
    broadcastId: "live",
    peerId: "browser-b",
    targetPeerId: "browser-a",
    requestId: "request-1",
    sdp: "offer-sdp",
  };
  socket.onmessage?.({ data: JSON.stringify(offer) } as MessageEvent);
  const answer: WebRtcSignalMessage = {
    type: "webrtc_answer",
    broadcastId: "live",
    peerId: "browser-a",
    targetPeerId: "browser-b",
    requestId: "request-1",
    sdp: "answer-sdp",
  };
  client.sendWebRtcSignal(answer);
  client.stop();

  assert.deepEqual(received, [offer]);
  assert.deepEqual(JSON.parse(socket.sent[socket.sent.length - 1] ?? "null"), answer);
});

const remotePeer = {
  address: "webrtc://remote",
  latencyMs: 20,
  successRate: 1,
  trustScore: 1,
};

test("applies batched inventory updates in order", async (context) => {
  context.mock.method(console, "error", () => {});
  const socket = new FakeWebSocket();
  const available: Array<[string, string[]]> = [];
  const client = new WsTrackerClient({
    trackerUrl: "ws://tracker.example/ws",
    broadcastId: "live",
    peerId: "browser-a",
    reportPeerState: false,
    onSegmentAvailable: (peerId, segments) => available.push([peerId, segments]),
    webSocketFactory: () => socket as unknown as WebSocket,
  });
  client.setSessionToken("test-session");
  const started = client.start();
  socket.open();
  await started;
  const deliver = (message: unknown): void =>
    socket.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  deliver({
    type: "peer_list",
    broadcastId: "live",
    peers: [
      { ...remotePeer, id: "browser-b", segments: ["s1.ts", "s2.ts"] },
      { ...remotePeer, id: "browser-c", segments: ["c1.ts"] },
    ],
  });
  deliver({
    type: "segment_inventory_batch",
    broadcastId: "live",
    updates: [
      { peerId: "browser-b", added: ["s3.ts"], removed: ["s1.ts"] },
      { peerId: "browser-c", segments: ["c2.ts"], replace: true },
      { peerId: "browser-unknown", added: ["x.ts"], removed: [] },
    ],
  });
  // A malformed batch is rejected as a whole.
  deliver({
    type: "segment_inventory_batch",
    broadcastId: "live",
    updates: [{ peerId: "browser-b", added: ["bad.ts"] }],
  });
  const inventories = Object.fromEntries(
    client.getAllPeers().map((peer) => [peer.id, peer.segments]),
  );
  client.stop();

  assert.deepEqual(inventories, {
    "browser-b": ["s2.ts", "s3.ts"],
    "browser-c": ["c2.ts"],
  });
  assert.deepEqual(available, [
    ["browser-b", ["s3.ts"]],
    ["browser-c", ["c2.ts"]],
    ["browser-unknown", ["x.ts"]],
  ]);
});

test("reconnects with backoff and resets it after a peer list", async (context) => {
  context.mock.method(console, "error", () => {});
  // Pin the jitter to the top of its range so the delays are the full backoff.
  context.mock.method(Math, "random", () => 0.999);
  const sockets: FakeWebSocket[] = [];
  const openedAt: number[] = [];
  const events: string[] = [];
  const client = new WsTrackerClient({
    trackerUrl: "ws://tracker.example/ws",
    broadcastId: "live",
    peerId: "browser-a",
    reportPeerState: false,
    reconnectInitialMs: 20,
    reconnectMaxMs: 40,
    onConnected: () => events.push("connected"),
    onDisconnected: () => events.push("disconnected"),
    webSocketFactory: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      openedAt.push(Date.now());
      return socket as unknown as WebSocket;
    },
  });
  client.setSessionToken("test-session");
  const waitForSocket = async (count: number): Promise<FakeWebSocket> => {
    const deadline = Date.now() + 1_000;
    while (sockets.length < count) {
      assert.ok(Date.now() < deadline, `socket ${count} was never opened`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return sockets[count - 1] as FakeWebSocket;
  };
  const deliver = (socket: FakeWebSocket, message: unknown): void =>
    socket.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  const peer = { id: "browser-b", address: "webrtc://browser-b", segments: ["s.ts"], latencyMs: 1, successRate: 1, trustScore: 1 };

  const started = client.start();
  const first = await waitForSocket(1);
  first.open();
  await started;
  deliver(first, { type: "peer_list", broadcastId: "live", peers: [peer] });
  assert.equal(client.getAllPeers().length, 1);

  // A drop clears the known peers and reconnects after the initial delay.
  first.onclose?.();
  assert.deepEqual(client.getAllPeers(), []);
  const second = await waitForSocket(2);
  // The next drop before any peer list waits twice as long, up to the cap.
  second.onclose?.();
  const third = await waitForSocket(3);
  third.onclose?.();
  const fourth = await waitForSocket(4);
  const gaps = openedAt.slice(1).map((time, index) => time - (openedAt[index] ?? time));
  assert.ok((gaps[0] ?? 0) >= 15, `first retry after ${gaps[0]} ms`);
  assert.ok((gaps[1] ?? 0) >= 35, `second retry after ${gaps[1]} ms`);
  assert.ok((gaps[2] ?? 0) >= 35 && (gaps[2] ?? 0) < 200, `capped retry after ${gaps[2]} ms`);

  // A peer list proves the session works and resets the backoff.
  fourth.open();
  deliver(fourth, { type: "peer_list", broadcastId: "live", peers: [] });
  fourth.onclose?.();
  await waitForSocket(5);
  const reset = (openedAt[4] ?? 0) - (openedAt[3] ?? 0);
  assert.ok(reset < 35, `retry after a peer list took ${reset} ms`);
  client.stop();

  assert.deepEqual(events.slice(0, 2), ["connected", "disconnected"]);
  // stop() prevents further reconnects.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(sockets.length, 5);
});
