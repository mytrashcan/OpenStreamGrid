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

  const started = client.start();
  socket.open();
  await started;
  await new Promise((resolve) => setTimeout(resolve, 15));
  client.reportSegments();
  client.stop();

  assert.deepEqual(
    socket.sent.map((message) => JSON.parse(message)),
    [{ type: "subscribe", broadcastId: "live", peerId: "browser-viewer" }],
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
