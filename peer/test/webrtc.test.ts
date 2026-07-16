import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import type {
  TransportAdapter,
  TransportOptions,
  TransportStats,
} from "../src/transport.js";
import { TransportManager } from "../src/transport-manager.js";
import { WebRtcTransport } from "../src/webrtc-transport.js";

const emptyStats = (): TransportStats => ({
  segmentsFetched: 0,
  segmentsFailed: 0,
  bytesTransferred: 0,
  latencyMs: { min: Infinity, max: 0, average: 0 },
});

class StubTransport implements TransportAdapter {
  readonly peers: string[] = [];
  requests = 0;
  lastPeerAddress: string | undefined;

  constructor(
    readonly name: string,
    private response: Buffer | Error,
  ) {}

  async start(_options: TransportOptions): Promise<void> {}

  async stop(): Promise<void> {}

  async requestSegment(
    peerAddress: string,
    _segmentName: string,
    _signal?: AbortSignal,
  ): Promise<Buffer> {
    this.requests += 1;
    this.lastPeerAddress = peerAddress;
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }

  getStats(): TransportStats {
    return emptyStats();
  }

  resetStats(): void {}

  respondWith(response: Buffer | Error): void {
    this.response = response;
  }
}

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("transfers and reassembles a segment over a real DataChannel", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const subscriptions = new Map<string, WebSocket>();
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === "subscribe" && typeof message.peerId === "string") {
        subscriptions.set(message.peerId, socket);
        return;
      }
      if (
        (message.type === "webrtc_offer" || message.type === "webrtc_answer") &&
        typeof message.targetPeerId === "string"
      ) {
        subscriptions.get(message.targetPeerId)?.send(JSON.stringify(message));
      }
    });
  });
  const segment = Buffer.alloc(40 * 1024 + 7, 0x5a);
  let uploadedBytes = 0;
  const requester = new WebRtcTransport({ iceServers: [], timeoutMs: 5_000 });
  const responder = new WebRtcTransport({
    iceServers: [],
    timeoutMs: 5_000,
    segmentProvider: (segmentName) =>
      segmentName === "segment.ts" ? segment : undefined,
    onUpload: (bytes) => {
      uploadedBytes += bytes;
    },
  });

  try {
    await Promise.all([
      requester.start({
        signalUrl: `ws://127.0.0.1:${port}`,
        peerId: "peer-a",
        broadcastId: "live",
      }),
      responder.start({
        signalUrl: `ws://127.0.0.1:${port}`,
        peerId: "peer-b",
        broadcastId: "live",
      }),
    ]);
    await waitFor(() => subscriptions.size === 2);

    const received = await requester.requestSegment("peer-b", "segment.ts");

    assert.deepEqual(received, segment);
    assert.equal(uploadedBytes, segment.byteLength);
    assert.equal(requester.getStats().segmentsFetched, 1);
    assert.deepEqual(requester.peers, ["peer-b"]);
  } finally {
    await Promise.all([requester.stop(), responder.stop()]);
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("uses WebRTC when the transport is available", async () => {
  const webRtc = new StubTransport("webrtc", Buffer.from("from-webrtc"));
  const http = new StubTransport("http", new Error("HTTP should not be used"));
  const manager = new TransportManager({
    webRtcTransport: webRtc,
    httpTransport: http,
  });
  manager.setPeers([{ id: "peer-a", address: "http://peer-a:9090" }]);

  const data = await manager.fetchSegment(
    "segment.ts",
    "http://peer-a:9090",
  );

  assert.equal(data.toString(), "from-webrtc");
  assert.equal(webRtc.lastPeerAddress, "peer-a");
  assert.equal(webRtc.requests, 1);
  assert.equal(http.requests, 0);
  assert.deepEqual(manager.getStats(), {
    lastTransport: "webrtc",
    webrtc: { successes: 1, failures: 0 },
    http: { successes: 0, failures: 0 },
  });
});

test("falls back to HTTP when WebRTC fails", async () => {
  const webRtc = new StubTransport("webrtc", new Error("negotiation failed"));
  const http = new StubTransport("http", Buffer.from("from-http"));
  const manager = new TransportManager({
    webRtcTransport: webRtc,
    httpTransport: http,
  });

  const data = await manager.fetchSegment(
    "segment.ts",
    "http://peer-a:9090",
  );

  assert.equal(data.toString(), "from-http");
  assert.equal(webRtc.requests, 1);
  assert.equal(http.requests, 1);
  assert.deepEqual(manager.getStats(), {
    lastTransport: "http",
    webrtc: { successes: 0, failures: 1 },
    http: { successes: 1, failures: 0 },
  });
});

test("tracks failures for both transports and resets usage stats", async () => {
  const webRtc = new StubTransport("webrtc", new Error("negotiation failed"));
  const http = new StubTransport("http", new Error("peer unavailable"));
  const manager = new TransportManager({
    webRtcTransport: webRtc,
    httpTransport: http,
  });

  await assert.rejects(
    manager.fetchSegment("segment.ts", "http://peer-a:9090"),
    /peer unavailable/,
  );
  assert.deepEqual(manager.getStats(), {
    lastTransport: null,
    webrtc: { successes: 0, failures: 1 },
    http: { successes: 0, failures: 1 },
  });

  manager.resetStats();
  assert.deepEqual(manager.getStats(), {
    lastTransport: null,
    webrtc: { successes: 0, failures: 0 },
    http: { successes: 0, failures: 0 },
  });

  webRtc.respondWith(Buffer.from("recovered"));
  assert.equal(
    (await manager.fetchSegment("segment.ts", "peer-a")).toString(),
    "recovered",
  );
});
