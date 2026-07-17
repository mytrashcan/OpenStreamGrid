import assert from "node:assert/strict";
import test from "node:test";
import { WsTrackerClient } from "../src/ws-client.js";

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
