import assert from "node:assert/strict";
import test from "node:test";
import type { Peer, PeerFailureReport } from "@openstreamgrid/common";
import { SegmentCache } from "../src/cache.js";
import {
  calculatePeerScore,
  exponentialMovingAverage,
  HybridSegmentFetcher,
  type PeerDirectory,
} from "../src/fetcher.js";
import { TrafficStats } from "../src/stats.js";
import type { FetchFunction, SegmentIntegrityVerifier } from "../src/verifier.js";

const peer: Peer = {
  id: "peer-a",
  address: "http://peer-a:9090",
  segments: ["segment.ts"],
  joinedAt: "2026-07-17T00:00:00.000Z",
  lastSeenAt: "2026-07-17T00:00:00.000Z",
  latencyMs: 10,
  successRate: 1,
  trustScore: 1,
  uploadBandwidthBps: 1_000_000,
};

class FakeDirectory implements PeerDirectory {
  readonly failures: Array<{ peerId: string; reason: PeerFailureReport["reason"] }> = [];

  async listPeers(): Promise<Peer[]> {
    return [peer];
  }

  async reportFailure(
    peerId: string,
    reason: PeerFailureReport["reason"],
  ): Promise<void> {
    this.failures.push({ peerId, reason });
  }
}

const verifier: SegmentIntegrityVerifier = {
  async verify(): Promise<boolean> {
    return true;
  },
};

test("uses a ranked peer for non-urgent segments", async () => {
  const stats = new TrafficStats();
  const fetchImpl: FetchFunction = async (input) => {
    assert.match(String(input), /^http:\/\/peer-a:9090\/segments\//);
    return new Response("from-peer");
  };
  const fetcher = new HybridSegmentFetcher({
    selfPeerId: "peer-b",
    originBaseUrl: new URL("http://origin:8080/hls/"),
    cache: new SegmentCache(1_000),
    directory: new FakeDirectory(),
    verifier,
    stats,
    fetchImpl,
  });

  const result = await fetcher.fetchSegment("segment.ts", 3);
  assert.equal(result.source, "p2p");
  assert.equal(result.data.toString(), "from-peer");
  assert.equal(stats.snapshot().p2pSuccesses, 1);
});

test("falls back to origin when the selected peer is unreachable", async () => {
  const stats = new TrafficStats();
  const directory = new FakeDirectory();
  const fetchImpl: FetchFunction = async (input) => {
    if (String(input).startsWith("http://peer-a")) throw new TypeError("unreachable");
    return new Response("from-origin");
  };
  const fetcher = new HybridSegmentFetcher({
    selfPeerId: "peer-b",
    originBaseUrl: new URL("http://origin:8080/hls/"),
    cache: new SegmentCache(1_000),
    directory,
    verifier,
    stats,
    fetchImpl,
  });

  const result = await fetcher.fetchSegment("segment.ts", 3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.source, "origin");
  assert.equal(stats.snapshot().fallbacks, 1);
  assert.equal(stats.snapshot().originRequests, 1);
  assert.deepEqual(directory.failures, [
    { peerId: "peer-a", reason: "connection" },
  ]);
});

test("uses origin immediately when peer discovery is unavailable", async (context) => {
  context.mock.method(console, "error", () => {});
  const stats = new TrafficStats();
  const directory: PeerDirectory = {
    async listPeers(): Promise<Peer[]> {
      throw new Error("tracker unavailable");
    },
    async reportFailure(): Promise<void> {},
  };
  const fetchImpl: FetchFunction = async (input) => {
    assert.match(String(input), /^http:\/\/origin:8080\/hls\//);
    return new Response("from-origin");
  };
  const fetcher = new HybridSegmentFetcher({
    selfPeerId: "peer-b",
    originBaseUrl: new URL("http://origin:8080/hls/"),
    cache: new SegmentCache(1_000),
    directory,
    verifier,
    stats,
    fetchImpl,
  });

  const result = await fetcher.fetchSegment("segment.ts", 3);
  assert.equal(result.source, "origin");
  assert.equal(stats.snapshot().fallbacks, 1);
  assert.equal(stats.snapshot().originRequests, 1);
});

test("calculates normalized weighted peer scores and metric EMA", () => {
  assert.equal(exponentialMovingAverage(100, 200), 130);
  assert.ok(
    Math.abs(
      calculatePeerScore(
        {
          latencyMs: 100,
          successRate: 0.8,
          uploadBandwidthBps: 500,
          trustScore: 0.5,
        },
        1_000,
      ) - 0.71,
    ) < Number.EPSILON,
  );
});

test("selects the highest scored trusted peer", async () => {
  const candidates: Peer[] = [
    {
      ...peer,
      id: "peer-untrusted",
      address: "http://peer-untrusted:9090",
      latencyMs: 1,
      trustScore: 0.2,
      uploadBandwidthBps: 10_000_000,
    },
    {
      ...peer,
      id: "peer-slow",
      address: "http://peer-slow:9090",
      latencyMs: 900,
      successRate: 0.5,
      trustScore: 0.8,
      uploadBandwidthBps: 100_000,
    },
    {
      ...peer,
      id: "peer-best",
      address: "http://peer-best:9090",
      latencyMs: 50,
      successRate: 0.95,
      trustScore: 0.9,
      uploadBandwidthBps: 2_000_000,
    },
  ];
  const directory: PeerDirectory = {
    async listPeers(): Promise<Peer[]> {
      return candidates;
    },
    async reportFailure(): Promise<void> {},
  };
  const fetcher = new HybridSegmentFetcher({
    selfPeerId: "self",
    originBaseUrl: new URL("http://origin:8080/hls/"),
    cache: new SegmentCache(1_000),
    directory,
    verifier,
    stats: new TrafficStats(),
    fetchImpl: async (input) => {
      assert.match(String(input), /^http:\/\/peer-best:9090\/segments\//);
      return new Response("best-peer");
    },
  });

  const result = await fetcher.fetchSegment("segment.ts", 3);
  assert.equal(result.source, "p2p");
  assert.equal(result.data.toString(), "best-peer");
});

test("downloads urgent segments first from distinct peers up to the parallel limit", async () => {
  const peers: Peer[] = [
    {
      ...peer,
      id: "peer-a",
      address: "http://peer-a:9090",
      segments: ["segment_1.ts", "segment_2.ts", "segment_3.ts"],
    },
    {
      ...peer,
      id: "peer-b",
      address: "http://peer-b:9090",
      segments: ["segment_1.ts", "segment_2.ts", "segment_3.ts"],
      latencyMs: 20,
    },
  ];
  const requests: string[] = [];
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  let releaseFirstWave: (() => void) | undefined;
  const firstWaveReleased = new Promise<void>((resolve) => {
    releaseFirstWave = resolve;
  });
  let firstWaveStarted: (() => void) | undefined;
  const firstWaveReady = new Promise<void>((resolve) => {
    firstWaveStarted = resolve;
  });
  const fetcher = new HybridSegmentFetcher({
    selfPeerId: "self",
    originBaseUrl: new URL("http://origin:8080/hls/"),
    cache: new SegmentCache(10_000),
    directory: new FakeDirectory(),
    verifier,
    stats: new TrafficStats(),
    maxParallel: 2,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      requests.push(`${url.hostname}${url.pathname}`);
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      if (requests.length <= 2) {
        if (requests.length === 2) firstWaveStarted?.();
        await firstWaveReleased;
      }
      activeRequests -= 1;
      return new Response(url.pathname);
    },
  });

  const pending = fetcher.fetchSegments(
    ["segment_1.ts", "segment_2.ts", "segment_3.ts"],
    peers,
  );
  await firstWaveReady;
  assert.equal(maximumActiveRequests, 2);
  releaseFirstWave?.();
  const result = await pending;

  assert.deepEqual([...result.keys()], [
    "segment_3.ts",
    "segment_2.ts",
    "segment_1.ts",
  ]);
  assert.deepEqual(
    new Set(requests.slice(0, 2).map((request) => request.split("/")[0])),
    new Set(["peer-a", "peer-b"]),
  );
});

test("falls back only failed parallel peer downloads to origin", async () => {
  const directory = new FakeDirectory();
  const stats = new TrafficStats();
  const peers: Peer[] = [
    {
      ...peer,
      id: "peer-a",
      address: "http://peer-a:9090",
      segments: ["segment_1.ts", "segment_2.ts"],
    },
    {
      ...peer,
      id: "peer-b",
      address: "http://peer-b:9090",
      segments: ["segment_1.ts", "segment_2.ts"],
      latencyMs: 20,
    },
  ];
  const fetcher = new HybridSegmentFetcher({
    selfPeerId: "self",
    originBaseUrl: new URL("http://origin:8080/hls/"),
    cache: new SegmentCache(10_000),
    directory,
    verifier,
    stats,
    maxParallel: 2,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "peer-a") {
        return new Response("unavailable", { status: 503 });
      }
      if (url.hostname === "peer-b") return new Response("from-peer-b");
      return new Response(`from-origin-${url.pathname.split("/").at(-1)}`);
    },
  });

  const result = await fetcher.fetchSegments(
    ["segment_1.ts", "segment_2.ts"],
    peers,
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.get("segment_2.ts")?.toString(), "from-origin-segment_2.ts");
  assert.equal(result.get("segment_1.ts")?.toString(), "from-peer-b");
  assert.equal(stats.snapshot().fallbacks, 1);
  assert.equal(stats.snapshot().originRequests, 1);
  assert.deepEqual(directory.failures, [
    { peerId: "peer-a", reason: "http" },
  ]);
});

test("coalesces concurrent requests for the same segment", async () => {
  let requests = 0;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetcher = new HybridSegmentFetcher({
    selfPeerId: "self",
    originBaseUrl: new URL("http://origin:8080/hls/"),
    cache: new SegmentCache(1_000),
    directory: { async listPeers() { return []; }, async reportFailure() {} },
    verifier,
    stats: new TrafficStats(),
    fetchImpl: async () => {
      requests += 1;
      await blocked;
      return new Response("shared-segment");
    },
  });

  const first = fetcher.fetchSegment("segment.ts", 0);
  const second = fetcher.fetchSegment("segment.ts", 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  release?.();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.data.toString(), "shared-segment");
  assert.equal(secondResult.data.toString(), "shared-segment");
  assert.equal(requests, 1);
});

test("returns cached data and handles empty parallel input", async () => {
  const cache = new SegmentCache(1_000);
  cache.set("cached.ts", Buffer.from("cached-data"));
  let requests = 0;
  const fetcher = new HybridSegmentFetcher({
    selfPeerId: "self",
    originBaseUrl: new URL("http://origin:8080/hls/"),
    cache,
    directory: new FakeDirectory(),
    verifier,
    stats: new TrafficStats(),
    fetchImpl: async () => {
      requests += 1;
      return new Response("unexpected");
    },
  });

  const result = await fetcher.fetchSegment("cached.ts", 10);
  assert.equal(result.source, "cache");
  assert.equal(result.data.toString(), "cached-data");
  assert.equal(fetcher.getLastSource("cached.ts"), "cache");
  assert.deepEqual(await fetcher.fetchSegments([], []), new Map());
  assert.equal(requests, 0);
});

test("validates the parallel download limit", () => {
  const create = (maxParallel: number): HybridSegmentFetcher =>
    new HybridSegmentFetcher({
      selfPeerId: "self",
      originBaseUrl: new URL("http://origin:8080/hls/"),
      cache: new SegmentCache(100),
      directory: new FakeDirectory(),
      verifier,
      stats: new TrafficStats(),
      maxParallel,
    });

  assert.throws(() => create(0), /Maximum parallel downloads/);
  assert.throws(() => create(1.5), /Maximum parallel downloads/);
});

test("reports peer timeouts and falls back to a verified origin segment", async () => {
  const directory = new FakeDirectory();
  const stats = new TrafficStats();
  const fetcher = new HybridSegmentFetcher({
    selfPeerId: "self",
    originBaseUrl: new URL("http://origin:8080/hls/"),
    cache: new SegmentCache(1_000),
    directory,
    verifier,
    stats,
    p2pTimeoutMs: 1,
    fetchImpl: async (input, init) => {
      if (String(input).startsWith("http://origin")) {
        return new Response("origin-after-timeout");
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    },
  });

  const result = await fetcher.fetchSegment("segment.ts", 3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.source, "origin");
  assert.equal(result.data.toString(), "origin-after-timeout");
  assert.equal(fetcher.getLastSource("segment.ts"), "origin");
  assert.deepEqual(directory.failures, [{ peerId: "peer-a", reason: "timeout" }]);
  assert.deepEqual(stats.snapshot(), {
    bytesDownloadedP2P: 0,
    bytesDownloadedOrigin: 20,
    bytesUploadedP2P: 0,
    p2pRequests: 1,
    p2pSuccesses: 0,
    p2pFailures: 1,
    originRequests: 1,
    integrityFailures: 0,
    fallbacks: 1,
    segmentsCached: 1,
  });
});

test("aborts an in-flight Origin request when the fetcher stops", async () => {
  const fetcher = new HybridSegmentFetcher({
    selfPeerId: "self",
    originBaseUrl: new URL("http://origin:8080/hls/"),
    cache: new SegmentCache(1_000),
    directory: new FakeDirectory(),
    verifier,
    stats: new TrafficStats(),
    fetchImpl: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      }),
  });

  const pending = fetcher.fetchSegment("segment.ts", 0);
  await new Promise((resolve) => setImmediate(resolve));
  fetcher.stop();

  await assert.rejects(pending, /Segment fetcher stopped/);
});

test("rejects origin HTTP and integrity failures with useful errors", async () => {
  const create = (
    fetchImpl: FetchFunction,
    segmentVerifier: SegmentIntegrityVerifier = verifier,
  ): HybridSegmentFetcher =>
    new HybridSegmentFetcher({
      selfPeerId: "self",
      originBaseUrl: new URL("http://origin:8080/hls/"),
      cache: new SegmentCache(1_000),
      directory: { async listPeers() { return []; }, async reportFailure() {} },
      verifier: segmentVerifier,
      stats: new TrafficStats(),
      fetchImpl,
    });

  await assert.rejects(
    create(async () => new Response("missing", { status: 404 })).fetchSegment(
      "missing.ts",
      0,
    ),
    /Origin returned HTTP 404 for 'missing.ts'/,
  );
  await assert.rejects(
    create(
      async () => new Response("corrupt"),
      { async verify() { return false; } },
    ).fetchSegment("corrupt.ts", 0),
    /failed integrity verification/,
  );

  let aggregate: unknown;
  try {
    await create(async () => new Response("failed", { status: 503 })).fetchSegments(
      ["one.ts", "two.ts"],
      [],
    );
    assert.fail("Expected parallel fetch failures");
  } catch (error) {
    aggregate = error;
  }
  assert.ok(aggregate instanceof AggregateError);
  assert.equal(aggregate.errors.length, 2);
  assert.match(aggregate.message, /segments could not be fetched/);
});
