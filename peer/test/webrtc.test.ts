import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import wrtc from "@roamhq/wrtc";
import WebSocket, { WebSocketServer } from "ws";
import type {
  TransportAdapter,
  TransportOptions,
  TransportStats,
} from "../src/transport.js";
import { HttpTransport } from "../src/http-transport.js";
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
  starts = 0;
  stops = 0;
  lastPeerAddress: string | undefined;

  constructor(
    readonly name: string,
    private response: Buffer | Error,
    private readonly startGate: Promise<void> = Promise.resolve(),
  ) {}

  async start(_options: TransportOptions): Promise<void> {
    this.starts += 1;
    await this.startGate;
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }

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
    let subscribedPeerId: string | undefined;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === "subscribe" && typeof message.peerId === "string") {
        subscribedPeerId = message.peerId;
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
    socket.once("close", () => {
      if (
        subscribedPeerId &&
        subscriptions.get(subscribedPeerId) === socket
      ) {
        subscriptions.delete(subscribedPeerId);
      }
    });
  });
  const segment = Buffer.alloc(40 * 1024 + 7, 0x5a);
  let uploadedBytes = 0;
  const configuredIceServers: RTCIceServer[] = [
    {
      urls: "turns:turn.example.com:5349?transport=tcp",
      username: "peer-user",
      credential: "peer-secret",
    },
  ];
  let requesterConfiguration: RTCConfiguration | undefined;
  const requester = new WebRtcTransport({
    iceServers: configuredIceServers,
    timeoutMs: 5_000,
    peerConnectionFactory: (configuration) => {
      requesterConfiguration = configuration;
      return new wrtc.RTCPeerConnection({ iceServers: [] });
    },
  });
  const responder = new WebRtcTransport({
    iceServers: [],
    timeoutMs: 5_000,
    segmentProvider: (segmentName) =>
      segmentName === "segment.ts" ? segment : undefined,
    onUpload: (bytes) => {
      uploadedBytes += bytes;
    },
    signalReconnectMs: 10,
  });

  try {
    await Promise.all([
      requester.start({
        signalUrl: `ws://127.0.0.1:${port}`,
        peerId: "peer-a",
        broadcastId: "live",
        sessionToken: "test-peer-a-session",
      }),
      responder.start({
        signalUrl: `ws://127.0.0.1:${port}`,
        peerId: "peer-b",
        broadcastId: "live",
        sessionToken: "test-peer-b-session",
      }),
    ]);
    await waitFor(() => subscriptions.size === 2);

    const received = await requester.requestSegment("peer-b", "segment.ts");

    assert.deepEqual(received, segment);
    assert.deepEqual(requesterConfiguration?.iceServers, configuredIceServers);
    assert.equal(uploadedBytes, segment.byteLength);
    assert.equal(requester.getStats().segmentsFetched, 1);
    assert.deepEqual(requester.peers, ["peer-b"]);

    const disconnectedSocket = subscriptions.get("peer-b");
    disconnectedSocket?.terminate();
    await waitFor(
      () =>
        subscriptions.has("peer-b") &&
        subscriptions.get("peer-b") !== disconnectedSocket,
    );
    const receivedAfterReconnect = await requester.requestSegment(
      "peer-b",
      "segment.ts",
    );
    assert.deepEqual(receivedAfterReconnect, segment);
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

test("coalesces concurrent transport starts and stops", async () => {
  let releaseStart: (() => void) | undefined;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const webRtc = new StubTransport("webrtc", Buffer.alloc(0), startGate);
  const http = new StubTransport("http", Buffer.alloc(0), startGate);
  const manager = new TransportManager({
    webRtcTransport: webRtc,
    httpTransport: http,
  });

  const firstStart = manager.start();
  const secondStart = manager.start();
  assert.equal(webRtc.starts, 1);
  assert.equal(http.starts, 1);
  releaseStart?.();
  await Promise.all([firstStart, secondStart]);
  await Promise.all([manager.stop(), manager.stop()]);

  assert.equal(webRtc.starts, 1);
  assert.equal(http.starts, 1);
  assert.equal(webRtc.stops, 1);
  assert.equal(http.stops, 1);
});

test("forwards an already-aborted signal to HTTP requests", async () => {
  const controller = new AbortController();
  controller.abort(new Error("shutting down"));
  const transport = new HttpTransport({
    fetchImpl: async (_input, init) => {
      assert.equal(init?.signal?.aborted, true);
      throw init?.signal?.reason;
    },
  });

  await assert.rejects(
    transport.requestSegment("http://peer-a:9090", "segment.ts", controller.signal),
    /shutting down/,
  );
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

test("uses HTTP without starting WebRTC when WebRTC is disabled", async () => {
  const webRtc = new StubTransport("webrtc", Buffer.from("unexpected"));
  const http = new StubTransport("http", Buffer.from("from-http"));
  const manager = new TransportManager({
    webRtcEnabled: false,
    webRtcTransport: webRtc,
    httpTransport: http,
  });

  await manager.start();
  const data = await manager.fetchSegment(
    "segment.ts",
    "http://peer-a:9090",
  );

  assert.equal(data.toString(), "from-http");
  assert.equal(webRtc.requests, 0);
  assert.equal(http.requests, 1);
  assert.deepEqual(manager.getStats(), {
    lastTransport: "http",
    webrtc: { successes: 0, failures: 1 },
    http: { successes: 1, failures: 0 },
  });
  await manager.stop();
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
