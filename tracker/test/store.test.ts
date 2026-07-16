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
