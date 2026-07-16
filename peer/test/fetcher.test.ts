import assert from "node:assert/strict";
import test from "node:test";
import type { Peer, PeerFailureReport } from "@openstreamgrid/common";
import { SegmentCache } from "../src/cache.js";
import {
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
