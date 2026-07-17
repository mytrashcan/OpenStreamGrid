import assert from "node:assert/strict";
import test from "node:test";
import type { PeerTrafficStats } from "@openstreamgrid/common";
import { StoreError, TrackerStore } from "../src/store.js";

const stats = (origin: number, p2p: number): PeerTrafficStats => ({
  bytesDownloadedP2P: p2p,
  bytesDownloadedOrigin: origin,
  bytesUploadedP2P: p2p,
  p2pRequests: 1,
  p2pSuccesses: 1,
  p2pFailures: 0,
  originRequests: 1,
  integrityFailures: 0,
  fallbacks: 0,
  segmentsCached: 2,
});

test("registers broadcasts and manages segment-aware peer discovery", () => {
  const store = new TrackerStore(() => new Date("2026-07-17T00:00:00.000Z"));
  const result = store.registerBroadcast({
    id: "live",
    playlistUrl: "http://origin/hls/stream.m3u8",
  });
  assert.equal(result.created, true);
  store.joinPeer("live", { id: "peer-a", address: "http://peer-a:9090" });
  store.joinPeer("live", { id: "peer-b", address: "http://peer-b:9090" });
  store.reportSegments("live", "peer-a", ["segment_1.ts", "segment_2.ts"]);

  assert.deepEqual(
    store.listPeers("live", "segment_2.ts").map((peer) => peer.id),
    ["peer-a"],
  );
  assert.equal(store.getBroadcastStats("live").peers, 2);
});

test("aggregates current and departed peer traffic", () => {
  const store = new TrackerStore();
  store.registerBroadcast({ id: "live", playlistUrl: "http://origin/stream.m3u8" });
  store.joinPeer("live", { id: "peer-a", address: "http://peer-a" });
  store.reportStats("live", "peer-a", stats(100, 50));
  store.leavePeer("live", "peer-a");

  const totals = store.getGlobalStats();
  assert.equal(totals.peers, 0);
  assert.equal(totals.bytesDownloadedOrigin, 100);
  assert.equal(totals.bytesDownloadedP2P, 50);
});

test("returns isolated per-peer traffic snapshots", () => {
  const store = new TrackerStore();
  store.registerBroadcast({ id: "live", playlistUrl: "http://origin/live.m3u8" });
  store.joinPeer("live", { id: "peer-a", address: "http://peer-a:9090" });
  store.reportStats("live", "peer-a", stats(100, 50));

  const snapshot = store.listPeerStats("live");
  assert.deepEqual(snapshot[0]?.stats, stats(100, 50));
  snapshot[0]!.stats.bytesDownloadedP2P = 999;
  assert.deepEqual(store.listPeerStats("live")[0]?.stats, stats(100, 50));
});

test("penalizes integrity failures more heavily and expires stale peers", () => {
  let now = new Date("2026-07-17T00:00:00.000Z");
  const store = new TrackerStore(() => now);
  store.registerBroadcast({ id: "live", playlistUrl: "http://origin/stream.m3u8" });
  store.joinPeer("live", { id: "bad", address: "http://bad" });
  store.joinPeer("live", { id: "reporter", address: "http://reporter" });
  const peer = store.reportPeerFailure("live", "bad", {
    reporterId: "reporter",
    reason: "integrity",
  });
  assert.equal(peer.trustScore, 0.65);

  now = new Date("2026-07-17T00:01:00.000Z");
  assert.equal(store.removeStalePeers(30_000), 2);
  assert.equal(store.listPeers("live").length, 0);
});

test("returns a typed not-found error", () => {
  const store = new TrackerStore();
  assert.throws(
    () => store.getBroadcast("missing"),
    (error: unknown) => error instanceof StoreError && error.statusCode === 404,
  );
});

test("updates broadcasts and peers without leaking mutable state", () => {
  let now = new Date("2026-07-17T00:00:00.000Z");
  const store = new TrackerStore(() => now, 2);
  const metadata = { title: "Original" };
  const created = store.registerBroadcast({
    id: "live",
    playlistUrl: "http://origin/first.m3u8",
    metadata,
  });
  metadata.title = "Mutated input";
  created.broadcast.metadata!.title = "Mutated output";

  now = new Date("2026-07-17T00:00:01.000Z");
  const updated = store.registerBroadcast({
    id: "live",
    playlistUrl: "http://origin/second.m3u8",
  });
  assert.equal(updated.created, false);
  assert.deepEqual(updated.broadcast, {
    id: "live",
    playlistUrl: "http://origin/second.m3u8",
    metadata: { title: "Original" },
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:01.000Z",
  });

  const peerMetadata = { region: "local" };
  store.joinPeer("live", {
    id: "peer-a",
    address: "http://peer-a:9090",
    metadata: peerMetadata,
  });
  peerMetadata.region = "remote";
  store.reportSegments("live", "peer-a", ["one.ts", "two.ts", "three.ts"]);
  store.reportStats("live", "peer-a", stats(10, 20));
  const rejoined = store.joinPeer("live", {
    id: "peer-a",
    address: "http://peer-a:9191",
  });
  assert.deepEqual(rejoined.segments, ["two.ts", "three.ts"]);
  assert.equal(rejoined.joinedAt, "2026-07-17T00:00:01.000Z");
  assert.equal(rejoined.address, "http://peer-a:9191");
  assert.deepEqual(store.getBroadcastStats("live"), {
    broadcastId: "live",
    peers: 1,
    ...stats(10, 20),
  });

  const listed = store.listPeers("live")[0]!;
  listed.segments.push("external.ts");
  assert.deepEqual(store.listPeers("live")[0]?.segments, ["two.ts", "three.ts"]);
});

test("handles empty updates, cutoff boundaries, and missing store entities", () => {
  let now = new Date("2026-07-17T00:00:00.000Z");
  const store = new TrackerStore(() => now);
  assert.deepEqual(store.listBroadcasts(), []);
  assert.deepEqual(store.getGlobalStats(), {
    broadcasts: 0,
    peers: 0,
    bytesDownloadedP2P: 0,
    bytesDownloadedOrigin: 0,
    bytesUploadedP2P: 0,
    p2pRequests: 0,
    p2pSuccesses: 0,
    p2pFailures: 0,
    originRequests: 0,
    integrityFailures: 0,
    fallbacks: 0,
    segmentsCached: 0,
  });

  store.registerBroadcast({ id: "live", playlistUrl: "http://origin/live.m3u8" });
  const original = store.joinPeer("live", {
    id: "peer-a",
    address: "http://peer-a",
    uploadBandwidthBps: 100,
  });
  store.reportSegments("live", "peer-a", ["segment.ts"]);
  assert.deepEqual(store.reportSegments("live", "peer-a", [], true).segments, []);
  now = new Date("2026-07-17T00:00:30.000Z");
  const heartbeat = store.heartbeat("live", "peer-a", {});
  assert.equal(heartbeat.latencyMs, original.latencyMs);
  assert.equal(heartbeat.uploadBandwidthBps, 100);
  assert.equal(heartbeat.successRate, original.successRate);
  assert.equal(store.removeStalePeers(0), 0);

  assert.throws(() => store.unregisterBroadcast("missing"), /was not found/);
  assert.throws(() => store.leavePeer("live", "missing"), /Peer 'missing'/);
  assert.throws(
    () => store.reportSegments("live", "missing", []),
    /Peer 'missing'/,
  );
  assert.throws(
    () =>
      store.reportPeerFailure("live", "peer-a", {
        reporterId: "missing",
        reason: "connection",
      }),
    /Peer 'missing'/,
  );
  store.close();
});
