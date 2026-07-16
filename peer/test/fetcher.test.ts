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
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeRequests -= 1;
      return new Response(url.pathname);
    },
  });

  const result = await fetcher.fetchSegments(
    ["segment_1.ts", "segment_2.ts", "segment_3.ts"],
    peers,
  );

  assert.deepEqual([...result.keys()], [
    "segment_3.ts",
    "segment_2.ts",
    "segment_1.ts",
  ]);
  assert.equal(maximumActiveRequests, 2);
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
