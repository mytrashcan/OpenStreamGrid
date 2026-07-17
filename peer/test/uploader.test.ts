import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { SegmentCache } from "../src/cache.js";
import { TrafficStats } from "../src/stats.js";
import { UploadServer } from "../src/uploader.js";

interface RunningServer {
  baseUrl: string;
  cache: SegmentCache;
  stats: TrafficStats;
  server: UploadServer;
}

const startServer = async (
  context: TestContext,
  options: {
    ready?: () => boolean;
    maxConnections?: number;
    maxUploadSpeedBps?: number;
  } = {},
): Promise<RunningServer> => {
  const cache = new SegmentCache(1_000_000);
  const stats = new TrafficStats();
  const server = new UploadServer({
    cache,
    stats,
    maxConnections: options.maxConnections ?? 3,
    maxUploadSpeedBps: options.maxUploadSpeedBps ?? 8_000_000,
    ...(options.ready ? { ready: options.ready } : {}),
  });
  context.after(() => server.stop());
  const port = await server.start(0, "127.0.0.1");
  return { baseUrl: `http://127.0.0.1:${port}`, cache, stats, server };
};

test("validates upload limits before opening a server", () => {
  const cache = new SegmentCache(100);
  const stats = new TrafficStats();
  const create = (maxConnections: number, maxUploadSpeedBps: number): UploadServer =>
    new UploadServer({ cache, stats, maxConnections, maxUploadSpeedBps });

  assert.throws(() => create(0, 1_000), /Maximum connections/);
  assert.throws(() => create(1.5, 1_000), /Maximum connections/);
  assert.throws(() => create(1, 0), /Upload speed must be positive/);
  assert.throws(() => create(1, Number.POSITIVE_INFINITY), /Upload speed must be positive/);
});

test("returns complete health and route error responses", async (context) => {
  let ready = false;
  const { baseUrl, cache } = await startServer(context, { ready: () => ready });

  let response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    status: "starting",
    service: "peer",
    details: { cachedSegments: 0, cacheBytes: 0, activeUploads: 0 },
  });

  cache.set("segment.ts", Buffer.from("data"));
  ready = true;
  response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "peer",
    details: { cachedSegments: 1, cacheBytes: 4, activeUploads: 0 },
  });

  const cases = [
    { path: "/missing", status: 404, error: "Route not found" },
    { path: "/segments/%E0%A4%A", status: 400, error: "Invalid segment name" },
    { path: "/segments/video.mp4", status: 400, error: "Invalid segment name" },
    { path: "/segments/missing.ts", status: 404, error: "Segment not found" },
  ];
  for (const item of cases) {
    response = await fetch(`${baseUrl}${item.path}`);
    assert.equal(response.status, item.status);
    assert.deepEqual(await response.json(), { error: item.error });
  }

  response = await fetch(`${baseUrl}/segments/segment.ts`, { method: "POST" });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Route not found" });
});

test("serves GET and HEAD requests and records only transferred bytes", async (context) => {
  const { baseUrl, cache, stats } = await startServer(context);
  cache.set("segment.ts", Buffer.from("segment-data"));

  const head = await fetch(`${baseUrl}/segments/segment%2Ets`, {
    method: "HEAD",
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "video/mp2t");
  assert.equal(head.headers.get("content-length"), "12");
  assert.equal(await head.text(), "");
  assert.equal(stats.snapshot().bytesUploadedP2P, 0);

  const response = await fetch(`${baseUrl}/segments/segment%2Ets`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, max-age=60");
  assert.equal(await response.text(), "segment-data");
  assert.equal(stats.snapshot().bytesUploadedP2P, 12);
});

test("rejects excess concurrent uploads with retry metadata", async (context) => {
  const { baseUrl, cache, server } = await startServer(context, {
    maxConnections: 1,
    maxUploadSpeedBps: 8,
  });
  cache.set("slow.ts", Buffer.from("slow"));

  const first = await fetch(`${baseUrl}/segments/slow.ts`);
  assert.equal(first.status, 200);
  const rejected = await fetch(`${baseUrl}/segments/slow.ts`);
  assert.equal(rejected.status, 429);
  assert.equal(rejected.headers.get("retry-after"), "1");
  assert.deepEqual(await rejected.json(), {
    error: "Upload connection limit exceeded",
  });

  await server.stop();
  await assert.rejects(first.arrayBuffer());
});

test("coalesces lifecycle calls and cannot restart after shutdown", async () => {
  const server = new UploadServer({
    cache: new SegmentCache(100),
    stats: new TrafficStats(),
    maxConnections: 1,
    maxUploadSpeedBps: 1_000,
  });
  const [firstPort, secondPort] = await Promise.all([
    server.start(0, "127.0.0.1"),
    server.start(0, "127.0.0.1"),
  ]);
  assert.equal(firstPort, secondPort);
  await Promise.all([server.stop(), server.stop()]);
  await assert.rejects(
    server.start(0, "127.0.0.1"),
    /cannot be started after shutdown begins/,
  );
});
