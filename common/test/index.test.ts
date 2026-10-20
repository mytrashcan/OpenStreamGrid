import assert from "node:assert/strict";
import test from "node:test";
import {
  addPeerTrafficStats,
  createEmptyPeerTrafficStats,
  renditionDirectory,
  createLogger,
  parsePeerTrafficStats,
  isMediaSegmentFileName,
  isMediaSegmentPath,
} from "../src/index.js";

test("creates independent traffic snapshots and adds every metric", () => {
  const first = createEmptyPeerTrafficStats();
  const second = createEmptyPeerTrafficStats();
  first.p2pRequests = 2;
  first.bytesDownloadedP2P = 100;
  assert.equal(second.p2pRequests, 0);

  addPeerTrafficStats(second, first);
  assert.deepEqual(second, first);
});

test("parses complete non-negative traffic statistics", () => {
  const stats = {
    bytesDownloadedP2P: 1,
    bytesDownloadedOrigin: 2,
    bytesUploadedP2P: 3,
    p2pRequests: 4,
    p2pSuccesses: 5,
    p2pFailures: 6,
    originRequests: 7,
    integrityFailures: 8,
    fallbacks: 9,
    segmentsCached: 10,
  };
  assert.deepEqual(parsePeerTrafficStats(stats), stats);

  for (const invalid of [null, [], "stats"]) {
    assert.throws(() => parsePeerTrafficStats(invalid), /must be an object/);
  }
  assert.throws(
    () => parsePeerTrafficStats({ ...stats, fallbacks: -1 }),
    /'fallbacks' must be a non-negative number/,
  );
  assert.throws(
    () => parsePeerTrafficStats({ ...stats, segmentsCached: Number.NaN }),
    /'segmentsCached' must be a non-negative number/,
  );
  const { p2pRequests: _missing, ...incomplete } = stats;
  assert.throws(
    () => parsePeerTrafficStats(incomplete),
    /'p2pRequests' must be a non-negative number/,
  );
});

test("writes structured logs for every severity and error shape", (context) => {
  const entries: string[] = [];
  context.mock.method(console, "log", (entry: string) => entries.push(entry));
  context.mock.method(console, "warn", (entry: string) => entries.push(entry));
  context.mock.method(console, "error", (entry: string) => entries.push(entry));
  const logger = createLogger("test-service");

  logger.info("started", { port: 7070 });
  logger.warn("slow");
  logger.error("failed", new TypeError("boom"), { requestId: "one" });
  logger.error("failed_value", null);

  const parsed = entries.map((entry) => JSON.parse(entry) as Record<string, unknown>);
  assert.deepEqual(
    parsed.map(({ timestamp: _timestamp, ...entry }) => entry),
    [
      { level: "info", service: "test-service", event: "started", port: 7070 },
      { level: "warn", service: "test-service", event: "slow" },
      {
        level: "error",
        service: "test-service",
        event: "failed",
        requestId: "one",
        error: {
          name: "TypeError",
          message: "boom",
          stack: (parsed[2]?.error as { stack: string }).stack,
        },
      },
      {
        level: "error",
        service: "test-service",
        event: "failed_value",
        error: { message: "null" },
      },
    ],
  );
  for (const entry of parsed) {
    assert.match(String(entry.timestamp), /^\d{4}-\d{2}-\d{2}T/);
  }
});

test("classifies HLS media segment names", () => {
  for (const name of ["seg_000001.ts", "seg_000001.m4s", "low/seg_000001.m4s"]) {
    assert.equal(isMediaSegmentPath(name), true, name);
  }
  for (const name of ["init_low.mp4", "stream.m3u8", "seg.ts.sha256", "low/seg 1.ts", ""]) {
    assert.equal(isMediaSegmentPath(name), false, name);
  }
  assert.equal(isMediaSegmentFileName("seg_000001.m4s"), true);
  assert.equal(isMediaSegmentFileName("low/seg_000001.m4s"), false);
});

test("names the directory a path points into", () => {
  assert.equal(renditionDirectory("/hls/low/segment.ts"), "low");
  assert.equal(renditionDirectory("hls/low/segment.ts"), "low");
  assert.equal(renditionDirectory("/segment.ts"), undefined);
});
