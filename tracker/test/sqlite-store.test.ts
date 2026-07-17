import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { PeerTrafficStats } from "@openstreamgrid/common";
import Database from "better-sqlite3";
import { createConfiguredStore } from "../src/server.js";
import { LATEST_SCHEMA_VERSION } from "../src/sqlite-migration.js";
import { SQLiteStore } from "../src/sqlite-store.js";
import { StoreError, TrackerStore } from "../src/store.js";

const trafficStats = (
  overrides: Partial<PeerTrafficStats> = {},
): PeerTrafficStats => ({
  bytesDownloadedP2P: 200,
  bytesDownloadedOrigin: 100,
  bytesUploadedP2P: 150,
  p2pRequests: 4,
  p2pSuccesses: 3,
  p2pFailures: 1,
  originRequests: 2,
  integrityFailures: 1,
  fallbacks: 1,
  segmentsCached: 5,
  ...overrides,
});

const temporaryDatabasePath = (context: TestContext): string => {
  const directory = mkdtempSync(join(tmpdir(), "openstreamgrid-tracker-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "tracker.db");
};

test("implements broadcast, peer, segment, health, stats, and deletion CRUD", (context) => {
  let now = new Date("2026-07-17T00:00:00.000Z");
  const store = new SQLiteStore(
    temporaryDatabasePath(context),
    () => now,
    3,
  );
  context.after(() => store.close());

  const created = store.registerBroadcast({
    id: "live",
    playlistUrl: "http://origin/hls/stream.m3u8",
    metadata: { title: "Launch stream" },
  });
  assert.equal(created.created, true);
  assert.deepEqual(store.listBroadcasts(), [created.broadcast]);

  now = new Date("2026-07-17T00:00:01.000Z");
  const updated = store.registerBroadcast({
    id: "live",
    playlistUrl: "http://cdn/hls/stream.m3u8",
  });
  assert.equal(updated.created, false);
  assert.equal(updated.broadcast.createdAt, "2026-07-17T00:00:00.000Z");
  assert.equal(updated.broadcast.updatedAt, "2026-07-17T00:00:01.000Z");
  assert.deepEqual(updated.broadcast.metadata, { title: "Launch stream" });

  store.joinPeer("live", {
    id: "peer-a",
    address: "http://peer-a:9090",
    uploadBandwidthBps: 1_000_000,
    metadata: { region: "local" },
  });
  store.joinPeer("live", {
    id: "reporter",
    address: "http://reporter:9090",
  });
  const segmented = store.reportSegments("live", "peer-a", [
    "segment_1.ts",
    "segment_2.ts",
    "segment_2.ts",
    "segment_3.ts",
    "segment_4.ts",
  ]);
  assert.deepEqual(segmented.segments, [
    "segment_2.ts",
    "segment_3.ts",
    "segment_4.ts",
  ]);
  assert.deepEqual(
    store.listPeers("live", "segment_3.ts").map((peer) => peer.id),
    ["peer-a"],
  );
  assert.deepEqual(
    store.reportSegments("live", "peer-a", ["segment_5.ts"], true).segments,
    ["segment_5.ts"],
  );

  const heartbeat = store.heartbeat("live", "peer-a", {
    latencyMs: -10,
    uploadBandwidthBps: -1,
    successRate: 2,
  });
  assert.equal(heartbeat.latencyMs, 0);
  assert.equal(heartbeat.uploadBandwidthBps, 0);
  assert.equal(heartbeat.successRate, 1);

  const penalized = store.reportPeerFailure("live", "peer-a", {
    reporterId: "reporter",
    reason: "integrity",
  });
  assert.equal(penalized.trustScore, 0.65);
  assert.equal(penalized.successRate, 0.825);

  store.reportStats(
    "live",
    "peer-a",
    trafficStats({
      bytesDownloadedP2P: 200.9,
      integrityFailures: -1,
    }),
  );
  assert.deepEqual(
    store.listPeerStats("live").find(({ peer }) => peer.id === "peer-a")?.stats,
    trafficStats({ bytesDownloadedP2P: 200, integrityFailures: 0 }),
  );
  assert.deepEqual(store.getBroadcastStats("live"), {
    broadcastId: "live",
    peers: 2,
    ...trafficStats({ bytesDownloadedP2P: 200, integrityFailures: 0 }),
  });

  store.leavePeer("live", "peer-a");
  assert.deepEqual(
    store.listPeers("live").map((peer) => peer.id),
    ["reporter"],
  );
  assert.equal(store.getGlobalStats().bytesDownloadedP2P, 200);
  assert.equal(store.getGlobalStats().peers, 1);

  now = new Date("2026-07-17T00:01:00.000Z");
  assert.equal(store.removeStalePeers(30_000), 1);
  assert.equal(store.getBroadcastStats("live").peers, 0);
  assert.throws(
    () => store.leavePeer("live", "missing"),
    (error: unknown) => error instanceof StoreError && error.statusCode === 404,
  );

  store.unregisterBroadcast("live");
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
  assert.throws(
    () => store.getBroadcast("live"),
    (error: unknown) => error instanceof StoreError && error.statusCode === 404,
  );
});

test("persists tracker state across close and reopen with WAL enabled", (context) => {
  const databasePath = temporaryDatabasePath(context);
  const first = new SQLiteStore(
    databasePath,
    () => new Date("2026-07-17T01:00:00.000Z"),
  );
  first.registerBroadcast({
    id: "live",
    playlistUrl: "http://origin/live.m3u8",
    metadata: { quality: "high" },
  });
  first.joinPeer("live", {
    id: "peer-a",
    address: "http://peer-a:9090",
    uploadBandwidthBps: 500_000,
  });
  first.reportSegments("live", "peer-a", ["segment_1.ts", "segment_2.ts"]);
  first.heartbeat("live", "peer-a", { latencyMs: 12, successRate: 0.9 });
  first.reportStats("live", "peer-a", trafficStats());
  first.close();

  const second = new SQLiteStore(databasePath);
  assert.deepEqual(second.getBroadcast("live").metadata, { quality: "high" });
  assert.deepEqual(second.listPeers("live"), [
    {
      id: "peer-a",
      address: "http://peer-a:9090",
      uploadBandwidthBps: 500_000,
      segments: ["segment_1.ts", "segment_2.ts"],
      joinedAt: "2026-07-17T01:00:00.000Z",
      lastSeenAt: "2026-07-17T01:00:00.000Z",
      latencyMs: 12,
      successRate: 0.9,
      trustScore: 1,
    },
  ]);
  assert.deepEqual(second.getBroadcastStats("live"), {
    broadcastId: "live",
    peers: 1,
    ...trafficStats(),
  });
  assert.deepEqual(second.getPragmaSettings(), {
    journalMode: "wal",
    synchronous: 1,
    cacheSize: -65_536,
  });
  second.close();

  const database = new Database(databasePath, { readonly: true });
  assert.equal(
    database.pragma("user_version", { simple: true }),
    LATEST_SCHEMA_VERSION,
  );
  assert.equal(database.pragma("journal_mode", { simple: true }), "wal");
  database.close();
});

test("upgrades an existing schema using PRAGMA user_version", (context) => {
  const databasePath = temporaryDatabasePath(context);
  const initial = new SQLiteStore(databasePath);
  initial.close();

  const oldDatabase = new Database(databasePath);
  oldDatabase.exec(`
    DROP INDEX peer_segments_lookup;
    DROP INDEX peers_last_seen;
    DROP INDEX stats_history_lookup;
    DROP TABLE retired_peer_stats;
  `);
  oldDatabase.pragma("user_version = 1");
  oldDatabase.close();

  const upgraded = new SQLiteStore(databasePath);
  upgraded.close();
  const database = new Database(databasePath, { readonly: true });
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  assert.ok(tables.some(({ name }) => name === "retired_peer_stats"));
  assert.equal(
    database.pragma("user_version", { simple: true }),
    LATEST_SCHEMA_VERSION,
  );
  database.close();
});

test("selects SQLite by default and memory when configured", (context) => {
  const sqlite = createConfiguredStore({
    DB_PATH: temporaryDatabasePath(context),
  });
  assert.ok(sqlite instanceof SQLiteStore);
  sqlite.close();

  const memory = createConfiguredStore({ STORE_TYPE: "memory" });
  assert.ok(memory instanceof TrackerStore);
  memory.close();
  assert.throws(
    () => createConfiguredStore({ STORE_TYPE: "unsupported" }),
    /Unsupported STORE_TYPE/,
  );
});

test("rolls current and retired peer totals into stats history", (context) => {
  const store = new SQLiteStore(temporaryDatabasePath(context));
  context.after(() => store.close());
  store.registerBroadcast({
    id: "live-a",
    playlistUrl: "http://origin/a.m3u8",
  });
  store.registerBroadcast({
    id: "live-b",
    playlistUrl: "http://origin/b.m3u8",
  });
  store.joinPeer("live-a", { id: "peer-a", address: "http://peer-a" });
  store.reportStats("live-a", "peer-a", trafficStats());
  store.leavePeer("live-a", "peer-a");

  const timestamp = "2026-07-17T02:00:00.000Z";
  assert.deepEqual(store.rollupStats(timestamp), [
    {
      timestamp,
      broadcastId: "live-a",
      peers: 0,
      p2pBytes: 200,
      originBytes: 100,
      p2pSuccessRate: 0.75,
    },
    {
      timestamp,
      broadcastId: "live-b",
      peers: 0,
      p2pBytes: 0,
      originBytes: 0,
      p2pSuccessRate: 0,
    },
  ]);
  assert.deepEqual(store.getStatsHistory("live-a"), [
    {
      timestamp,
      broadcastId: "live-a",
      peers: 0,
      p2pBytes: 200,
      originBytes: 100,
      p2pSuccessRate: 0.75,
    },
  ]);
  assert.equal(store.getStatsHistory().length, 2);
});

test("handles empty history, duplicate joins, and idempotent close", (context) => {
  const store = new SQLiteStore(temporaryDatabasePath(context));
  assert.deepEqual(store.getStatsHistory(), []);
  store.registerBroadcast({ id: "live", playlistUrl: "http://origin/live.m3u8" });
  store.joinPeer("live", {
    id: "peer-a",
    address: "http://peer-a:9090",
    metadata: { region: "local" },
  });
  store.reportSegments("live", "peer-a", ["one.ts", "two.ts"]);
  store.reportStats("live", "peer-a", trafficStats());

  const rejoined = store.joinPeer("live", {
    id: "peer-a",
    address: "http://peer-a:9191",
  });
  assert.equal(rejoined.address, "http://peer-a:9191");
  assert.deepEqual(rejoined.segments, ["one.ts", "two.ts"]);
  assert.deepEqual(store.getBroadcastStats("live"), {
    broadcastId: "live",
    peers: 1,
    ...trafficStats(),
  });
  assert.deepEqual(store.reportSegments("live", "peer-a", [], true).segments, []);
  store.close();
  store.close();
});

test("rejects corrupted broadcast and peer metadata", (context) => {
  const databasePath = temporaryDatabasePath(context);
  const store = new SQLiteStore(databasePath);
  store.registerBroadcast({ id: "live", playlistUrl: "http://origin/live.m3u8" });
  store.joinPeer("live", { id: "peer-a", address: "http://peer-a" });
  store.close();

  const database = new Database(databasePath);
  database.prepare("UPDATE peers SET metadata = ? WHERE peer_id = ?").run(
    JSON.stringify({ region: null }),
    "peer-a",
  );
  database.close();

  const corrupted = new SQLiteStore(databasePath);
  assert.throws(
    () => corrupted.listPeers("live"),
    /Tracker database contains invalid metadata/,
  );
  corrupted.close();

  const broadcastDatabase = new Database(databasePath);
  broadcastDatabase
    .prepare("UPDATE broadcasts SET metadata = ? WHERE id = ?")
    .run("[]", "live");
  broadcastDatabase.close();
  const corruptedBroadcast = new SQLiteStore(databasePath);
  assert.throws(
    () => corruptedBroadcast.getBroadcast("live"),
    /Tracker database contains invalid metadata/,
  );
  corruptedBroadcast.close();
});
