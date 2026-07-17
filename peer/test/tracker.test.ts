import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type {
  Peer,
  PeerTrafficStats,
  WsClientMessage,
} from "@openstreamgrid/common";
import { WebSocketServer } from "ws";
import { TrackerClient } from "../src/tracker.js";

const stats = (): PeerTrafficStats => ({
  bytesDownloadedP2P: 0,
  bytesDownloadedOrigin: 0,
  bytesUploadedP2P: 0,
  p2pRequests: 0,
  p2pSuccesses: 0,
  p2pFailures: 0,
  originRequests: 0,
  integrityFailures: 0,
  fallbacks: 0,
  segmentsCached: 1,
});

const remotePeer: Peer = {
  id: "peer-b",
  address: "http://peer-b:9090",
  segments: ["segment.ts"],
  joinedAt: "2026-07-17T00:00:00.000Z",
  lastSeenAt: "2026-07-17T00:00:00.000Z",
  latencyMs: 25,
  successRate: 1,
  trustScore: 1,
  uploadBandwidthBps: 1_000_000,
};

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("uses validated WebSocket peer updates and reconnects after disconnect", async (context) => {
  context.mock.method(console, "error", () => {});
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const messages: WsClientMessage[] = [];
  let connections = 0;
  server.on("connection", (socket) => {
    connections += 1;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as WsClientMessage;
      messages.push(message);
      if (message.type === "subscribe") {
        socket.send(
          JSON.stringify({
            type: "peer_list",
            broadcastId: "live",
            peers: [{ id: "malformed-peer" }],
          }),
        );
        socket.send(
          JSON.stringify({
            type: "peer_list",
            broadcastId: "live",
            peers: [remotePeer],
          }),
        );
      }
    });
  });
  const client = new TrackerClient({
    trackerUrl: `http://127.0.0.1:${port}`,
    broadcastId: "live",
    peerId: "peer-a",
    heartbeat: () => ({ uploadBandwidthBps: 500_000, successRate: 1 }),
    stats,
    segments: () => ["local.ts"],
    reportIntervalMs: 10,
    reconnectInitialMs: 5,
    reconnectMaxMs: 20,
  });

  try {
    await client.start();
    await waitFor(
      () =>
        messages.some((message) => message.type === "heartbeat") &&
        messages.some((message) => message.type === "report_stats") &&
        messages.some((message) => message.type === "report_segments"),
    );
    await waitFor(async () => (await client.listPeers("segment.ts")).length === 1);
    assert.deepEqual(
      (await client.listPeers("segment.ts")).map((peer) => peer.id),
      ["peer-b"],
    );

    for (const socket of server.clients) socket.terminate();
    await waitFor(() => connections === 2);
    await waitFor(
      () =>
        messages.filter((message) => message.type === "subscribe").length === 2,
    );
  } finally {
    client.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
