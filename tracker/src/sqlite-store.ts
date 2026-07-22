import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createEmptyPeerTrafficStats,
  type Broadcast,
  type BroadcastRegistration,
  type BroadcastStats,
  type GlobalStats,
  type Peer,
  type PeerFailureReport,
  type PeerHeartbeat,
  type PeerJoinRequest,
  type PeerTrafficStats,
  type TrafficTotals,
} from "@openstreamgrid/common";
import Database from "better-sqlite3";
import { runSQLiteMigrations } from "./sqlite-migration.js";
import {
  StoreError,
  type PeerStatsSnapshot,
  type TrackerStoreBackend,
} from "./store.js";
import {
  clampUnitInterval,
  PeerFailureConsensus,
  penalizePeerQuality,
  sanitizePeerTrafficStats,
} from "./store-utils.js";

const DEFAULT_DB_PATH = "./data/tracker.db";
const DATABASE_BUSY_TIMEOUT_MS = 5_000;
const NOT_FOUND_STATUS_CODE = 404;

interface BroadcastRow {
  id: string;
  playlist_url: string;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

interface PeerRow {
  broadcast_id: string;
  peer_id: string;
  address: string;
  upload_bandwidth_bps: number | null;
  metadata: string | null;
  joined_at: string;
  last_seen_at: string;
  latency_ms: number;
  success_rate: number;
  trust_score: number;
}

interface SegmentRow {
  segment_name: string;
}

interface BroadcastSegmentRow extends SegmentRow {
  peer_id: string;
}

interface PeerIdentityRow {
  broadcast_id: string;
  peer_id: string;
}

interface TrafficRow {
  peers: number;
  bytes_downloaded_p2p: number;
  bytes_downloaded_origin: number;
  bytes_uploaded_p2p: number;
  p2p_requests: number;
  p2p_successes: number;
  p2p_failures: number;
  origin_requests: number;
  integrity_failures: number;
  fallbacks: number;
  segments_cached: number;
}

interface PeerTrafficRow extends Omit<TrafficRow, "peers"> {
  peer_id: string;
}

interface GlobalTrafficRow extends TrafficRow {
  broadcasts: number;
}

interface StatsHistoryRow {
  timestamp: string;
  broadcast_id: string;
  peers: number;
  p2p_bytes: number;
  origin_bytes: number;
  p2p_success_rate: number;
}

/** Persisted traffic-rollup entry returned by the SQLite store. */
export interface StatsHistoryEntry {
  timestamp: string;
  broadcastId: string;
  peers: number;
  p2pBytes: number;
  originBytes: number;
  p2pSuccessRate: number;
}

/** Effective connection-level SQLite performance settings. */
export interface SQLitePragmaSettings {
  journalMode: string;
  synchronous: number;
  cacheSize: number;
}

const prepareStatements = (database: Database.Database) => ({
  getBroadcast: database.prepare(`
    SELECT id, playlist_url, metadata, created_at, updated_at
    FROM broadcasts
    WHERE id = @id
  `),
  listBroadcasts: database.prepare(`
    SELECT id, playlist_url, metadata, created_at, updated_at
    FROM broadcasts
    ORDER BY created_at, id
  `),
  insertBroadcast: database.prepare(`
    INSERT INTO broadcasts(id, playlist_url, metadata, created_at, updated_at)
    VALUES (@id, @playlistUrl, @metadata, @createdAt, @updatedAt)
  `),
  updateBroadcast: database.prepare(`
    UPDATE broadcasts
    SET playlist_url = @playlistUrl,
        metadata = CASE WHEN @hasMetadata = 1 THEN @metadata ELSE metadata END,
        updated_at = @updatedAt
    WHERE id = @id
  `),
  deleteBroadcast: database.prepare("DELETE FROM broadcasts WHERE id = ?"),
  deleteBroadcastPeers: database.prepare(
    "DELETE FROM peers WHERE broadcast_id = ?",
  ),
  deleteBroadcastSegments: database.prepare(
    "DELETE FROM peer_segments WHERE broadcast_id = ?",
  ),
  deleteBroadcastPeerStats: database.prepare(
    "DELETE FROM peer_stats WHERE broadcast_id = ?",
  ),
  deleteBroadcastRetiredStats: database.prepare(
    "DELETE FROM retired_peer_stats WHERE broadcast_id = ?",
  ),
  getPeer: database.prepare(`
    SELECT broadcast_id, peer_id, address, upload_bandwidth_bps, metadata,
           joined_at, last_seen_at, latency_ms, success_rate, trust_score
    FROM peers
    WHERE broadcast_id = @broadcastId AND peer_id = @peerId
  `),
  listPeers: database.prepare(`
    SELECT broadcast_id, peer_id, address, upload_bandwidth_bps, metadata,
           joined_at, last_seen_at, latency_ms, success_rate, trust_score
    FROM peers
    WHERE broadcast_id = @broadcastId
    ORDER BY joined_at, peer_id
  `),
  listPeersWithSegment: database.prepare(`
    SELECT p.broadcast_id, p.peer_id, p.address, p.upload_bandwidth_bps,
           p.metadata, p.joined_at, p.last_seen_at, p.latency_ms,
           p.success_rate, p.trust_score
    FROM peers p
    INNER JOIN peer_segments s
      ON s.broadcast_id = p.broadcast_id AND s.peer_id = p.peer_id
    WHERE p.broadcast_id = @broadcastId AND s.segment_name = @segment
    ORDER BY p.joined_at, p.peer_id
  `),
  listPeerStats: database.prepare(`
    SELECT peer_id, bytes_downloaded_p2p, bytes_downloaded_origin,
           bytes_uploaded_p2p, p2p_requests, p2p_successes, p2p_failures,
           origin_requests, integrity_failures, fallbacks, segments_cached
    FROM peer_stats
    WHERE broadcast_id = @broadcastId
    ORDER BY peer_id
  `),
  upsertPeer: database.prepare(`
    INSERT INTO peers(
      broadcast_id, peer_id, address, upload_bandwidth_bps, metadata,
      joined_at, last_seen_at, latency_ms, success_rate, trust_score
    ) VALUES (
      @broadcastId, @peerId, @address, @uploadBandwidthBps, @metadata,
      @joinedAt, @lastSeenAt, @latencyMs, @successRate, @trustScore
    )
    ON CONFLICT(broadcast_id, peer_id) DO UPDATE SET
      address = excluded.address,
      upload_bandwidth_bps = excluded.upload_bandwidth_bps,
      metadata = excluded.metadata,
      last_seen_at = excluded.last_seen_at
  `),
  insertEmptyPeerStats: database.prepare(`
    INSERT INTO peer_stats(broadcast_id, peer_id)
    VALUES (@broadcastId, @peerId)
    ON CONFLICT(broadcast_id, peer_id) DO NOTHING
  `),
  getSegments: database.prepare(`
    SELECT segment_name
    FROM peer_segments
    WHERE broadcast_id = @broadcastId AND peer_id = @peerId
    ORDER BY rowid
  `),
  listBroadcastSegments: database.prepare(`
    SELECT peer_id, segment_name
    FROM peer_segments
    WHERE broadcast_id = @broadcastId
    ORDER BY peer_id, rowid
  `),
  deletePeerSegments: database.prepare(`
    DELETE FROM peer_segments
    WHERE broadcast_id = @broadcastId AND peer_id = @peerId
  `),
  deletePeerSegment: database.prepare(`
    DELETE FROM peer_segments
    WHERE broadcast_id = @broadcastId
      AND peer_id = @peerId
      AND segment_name = @segment
  `),
  insertPeerSegment: database.prepare(`
    INSERT OR IGNORE INTO peer_segments(broadcast_id, peer_id, segment_name)
    VALUES (@broadcastId, @peerId, @segment)
  `),
  updatePeerLastSeen: database.prepare(`
    UPDATE peers
    SET last_seen_at = @lastSeenAt
    WHERE broadcast_id = @broadcastId AND peer_id = @peerId
  `),
  updatePeerHealth: database.prepare(`
    UPDATE peers
    SET upload_bandwidth_bps = @uploadBandwidthBps,
        latency_ms = @latencyMs,
        success_rate = @successRate,
        last_seen_at = @lastSeenAt
    WHERE broadcast_id = @broadcastId AND peer_id = @peerId
  `),
  replacePeerStats: database.prepare(`
    INSERT INTO peer_stats(
      broadcast_id, peer_id, bytes_downloaded_p2p, bytes_downloaded_origin,
      bytes_uploaded_p2p, p2p_requests, p2p_successes, p2p_failures,
      origin_requests, integrity_failures, fallbacks, segments_cached
    ) VALUES (
      @broadcastId, @peerId, @bytesDownloadedP2P, @bytesDownloadedOrigin,
      @bytesUploadedP2P, @p2pRequests, @p2pSuccesses, @p2pFailures,
      @originRequests, @integrityFailures, @fallbacks, @segmentsCached
    )
    ON CONFLICT(broadcast_id, peer_id) DO UPDATE SET
      bytes_downloaded_p2p = excluded.bytes_downloaded_p2p,
      bytes_downloaded_origin = excluded.bytes_downloaded_origin,
      bytes_uploaded_p2p = excluded.bytes_uploaded_p2p,
      p2p_requests = excluded.p2p_requests,
      p2p_successes = excluded.p2p_successes,
      p2p_failures = excluded.p2p_failures,
      origin_requests = excluded.origin_requests,
      integrity_failures = excluded.integrity_failures,
      fallbacks = excluded.fallbacks,
      segments_cached = excluded.segments_cached
  `),
  updatePeerTrust: database.prepare(`
    UPDATE peers
    SET trust_score = @trustScore, success_rate = @successRate
    WHERE broadcast_id = @broadcastId AND peer_id = @peerId
  `),
  accumulateRetiredStats: database.prepare(`
    INSERT INTO retired_peer_stats(
      broadcast_id, bytes_downloaded_p2p, bytes_downloaded_origin,
      bytes_uploaded_p2p, p2p_requests, p2p_successes, p2p_failures,
      origin_requests, integrity_failures, fallbacks, segments_cached
    )
    SELECT broadcast_id, bytes_downloaded_p2p, bytes_downloaded_origin,
           bytes_uploaded_p2p, p2p_requests, p2p_successes, p2p_failures,
           origin_requests, integrity_failures, fallbacks, segments_cached
    FROM peer_stats
    WHERE broadcast_id = @broadcastId AND peer_id = @peerId
    ON CONFLICT(broadcast_id) DO UPDATE SET
      bytes_downloaded_p2p = retired_peer_stats.bytes_downloaded_p2p + excluded.bytes_downloaded_p2p,
      bytes_downloaded_origin = retired_peer_stats.bytes_downloaded_origin + excluded.bytes_downloaded_origin,
      bytes_uploaded_p2p = retired_peer_stats.bytes_uploaded_p2p + excluded.bytes_uploaded_p2p,
      p2p_requests = retired_peer_stats.p2p_requests + excluded.p2p_requests,
      p2p_successes = retired_peer_stats.p2p_successes + excluded.p2p_successes,
      p2p_failures = retired_peer_stats.p2p_failures + excluded.p2p_failures,
      origin_requests = retired_peer_stats.origin_requests + excluded.origin_requests,
      integrity_failures = retired_peer_stats.integrity_failures + excluded.integrity_failures,
      fallbacks = retired_peer_stats.fallbacks + excluded.fallbacks,
      segments_cached = retired_peer_stats.segments_cached + excluded.segments_cached
  `),
  deletePeerStats: database.prepare(`
    DELETE FROM peer_stats
    WHERE broadcast_id = @broadcastId AND peer_id = @peerId
  `),
  deletePeer: database.prepare(`
    DELETE FROM peers
    WHERE broadcast_id = @broadcastId AND peer_id = @peerId
  `),
  listStalePeers: database.prepare(`
    SELECT broadcast_id, peer_id
    FROM peers
    WHERE last_seen_at < @cutoff
    ORDER BY broadcast_id, peer_id
  `),
  getBroadcastStats: database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM peers WHERE broadcast_id = @broadcastId) AS peers,
      COALESCE(SUM(bytes_downloaded_p2p), 0) AS bytes_downloaded_p2p,
      COALESCE(SUM(bytes_downloaded_origin), 0) AS bytes_downloaded_origin,
      COALESCE(SUM(bytes_uploaded_p2p), 0) AS bytes_uploaded_p2p,
      COALESCE(SUM(p2p_requests), 0) AS p2p_requests,
      COALESCE(SUM(p2p_successes), 0) AS p2p_successes,
      COALESCE(SUM(p2p_failures), 0) AS p2p_failures,
      COALESCE(SUM(origin_requests), 0) AS origin_requests,
      COALESCE(SUM(integrity_failures), 0) AS integrity_failures,
      COALESCE(SUM(fallbacks), 0) AS fallbacks,
      COALESCE(SUM(segments_cached), 0) AS segments_cached
    FROM (
      SELECT bytes_downloaded_p2p, bytes_downloaded_origin,
             bytes_uploaded_p2p, p2p_requests, p2p_successes, p2p_failures,
             origin_requests, integrity_failures, fallbacks, segments_cached
      FROM peer_stats WHERE broadcast_id = @broadcastId
      UNION ALL
      SELECT bytes_downloaded_p2p, bytes_downloaded_origin,
             bytes_uploaded_p2p, p2p_requests, p2p_successes, p2p_failures,
             origin_requests, integrity_failures, fallbacks, segments_cached
      FROM retired_peer_stats WHERE broadcast_id = @broadcastId
    )
  `),
  getGlobalStats: database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM broadcasts) AS broadcasts,
      (SELECT COUNT(*) FROM peers) AS peers,
      COALESCE(SUM(bytes_downloaded_p2p), 0) AS bytes_downloaded_p2p,
      COALESCE(SUM(bytes_downloaded_origin), 0) AS bytes_downloaded_origin,
      COALESCE(SUM(bytes_uploaded_p2p), 0) AS bytes_uploaded_p2p,
      COALESCE(SUM(p2p_requests), 0) AS p2p_requests,
      COALESCE(SUM(p2p_successes), 0) AS p2p_successes,
      COALESCE(SUM(p2p_failures), 0) AS p2p_failures,
      COALESCE(SUM(origin_requests), 0) AS origin_requests,
      COALESCE(SUM(integrity_failures), 0) AS integrity_failures,
      COALESCE(SUM(fallbacks), 0) AS fallbacks,
      COALESCE(SUM(segments_cached), 0) AS segments_cached
    FROM (
      SELECT bytes_downloaded_p2p, bytes_downloaded_origin,
             bytes_uploaded_p2p, p2p_requests, p2p_successes, p2p_failures,
             origin_requests, integrity_failures, fallbacks, segments_cached
      FROM peer_stats
      UNION ALL
      SELECT bytes_downloaded_p2p, bytes_downloaded_origin,
             bytes_uploaded_p2p, p2p_requests, p2p_successes, p2p_failures,
             origin_requests, integrity_failures, fallbacks, segments_cached
      FROM retired_peer_stats
    )
  `),
  insertStatsHistory: database.prepare(`
    INSERT INTO stats_history(
      timestamp, broadcast_id, peers, p2p_bytes, origin_bytes,
      p2p_success_rate
    ) VALUES (
      @timestamp, @broadcastId, @peers, @p2pBytes, @originBytes,
      @p2pSuccessRate
    )
  `),
  listStatsHistory: database.prepare(`
    SELECT timestamp, broadcast_id, peers, p2p_bytes, origin_bytes,
           p2p_success_rate
    FROM stats_history
    ORDER BY timestamp, broadcast_id
  `),
  listBroadcastStatsHistory: database.prepare(`
    SELECT timestamp, broadcast_id, peers, p2p_bytes, origin_bytes,
           p2p_success_rate
    FROM stats_history
    WHERE broadcast_id = @broadcastId
    ORDER BY timestamp
  `),
  deleteStatsHistoryBefore: database.prepare(`
    DELETE FROM stats_history WHERE timestamp < @cutoff
  `),
});

type Statements = ReturnType<typeof prepareStatements>;

/** SQLite-backed implementation of tracker state and statistics. */
export class SQLiteStore implements TrackerStoreBackend {
  private readonly database: Database.Database;
  private readonly statements: Statements;
  private readonly failureConsensus: PeerFailureConsensus;

  constructor(
    databasePath = process.env.DB_PATH ?? DEFAULT_DB_PATH,
    private readonly now: () => Date = () => new Date(),
    private readonly maxSegmentsPerPeer = 2_000,
  ) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(resolve(databasePath)), { recursive: true });
    }
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = NORMAL");
    this.database.pragma("cache_size = -65536");
    this.database.pragma(`busy_timeout = ${DATABASE_BUSY_TIMEOUT_MS}`);
    this.database.pragma("foreign_keys = ON");
    runSQLiteMigrations(this.database);
    this.statements = prepareStatements(this.database);
    this.failureConsensus = new PeerFailureConsensus(() => this.now().getTime());
  }

  registerBroadcast(registration: BroadcastRegistration): {
    broadcast: Broadcast;
    created: boolean;
  } {
    return this.database.transaction(() => {
      const existing = this.findBroadcast(registration.id);
      const timestamp = this.timestamp();
      if (existing) {
        this.statements.updateBroadcast.run({
          id: registration.id,
          playlistUrl: registration.playlistUrl,
          metadata: registration.metadata
            ? JSON.stringify(registration.metadata)
            : null,
          hasMetadata: registration.metadata !== undefined ? 1 : 0,
          updatedAt: timestamp,
        });
      } else {
        this.statements.insertBroadcast.run({
          id: registration.id,
          playlistUrl: registration.playlistUrl,
          metadata: registration.metadata
            ? JSON.stringify(registration.metadata)
            : null,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
      return {
        broadcast: this.requireBroadcast(registration.id),
        created: existing === undefined,
      };
    })();
  }

  listBroadcasts(): Broadcast[] {
    return (this.statements.listBroadcasts.all() as BroadcastRow[]).map((row) =>
      this.mapBroadcast(row),
    );
  }

  getBroadcast(id: string): Broadcast {
    return this.requireBroadcast(id);
  }

  unregisterBroadcast(id: string): void {
    this.requireBroadcast(id);
    this.database.transaction(() => {
      this.statements.deleteBroadcastSegments.run(id);
      this.statements.deleteBroadcastPeerStats.run(id);
      this.statements.deleteBroadcastRetiredStats.run(id);
      this.statements.deleteBroadcastPeers.run(id);
      this.statements.deleteBroadcast.run(id);
    })();
  }

  joinPeer(broadcastId: string, request: PeerJoinRequest): Peer {
    this.requireBroadcast(broadcastId);
    const timestamp = this.timestamp();
    const existing = this.findPeer(broadcastId, request.id);
    this.database.transaction(() => {
      this.statements.upsertPeer.run({
        broadcastId,
        peerId: request.id,
        address: request.address,
        uploadBandwidthBps: request.uploadBandwidthBps ?? null,
        metadata: request.metadata ? JSON.stringify(request.metadata) : null,
        joinedAt: existing?.joined_at ?? timestamp,
        lastSeenAt: timestamp,
        latencyMs: existing?.latency_ms ?? 0,
        successRate: existing?.success_rate ?? 1,
        trustScore: existing?.trust_score ?? 1,
      });
      this.statements.insertEmptyPeerStats.run({
        broadcastId,
        peerId: request.id,
      });
    })();
    return this.requirePeer(broadcastId, request.id);
  }

  leavePeer(broadcastId: string, peerId: string): void {
    this.requireBroadcast(broadcastId);
    this.requirePeer(broadcastId, peerId);
    this.database.transaction(() => this.retirePeer(broadcastId, peerId))();
  }

  listPeers(broadcastId: string, segment?: string): Peer[] {
    this.requireBroadcast(broadcastId);
    const rows = segment === undefined
      ? (this.statements.listPeers.all({ broadcastId }) as PeerRow[])
      : (this.statements.listPeersWithSegment.all({
          broadcastId,
          segment,
        }) as PeerRow[]);
    if (segment !== undefined) return rows.map((row) => this.mapPeer(row));

    const segmentsByPeer = new Map<string, string[]>();
    const segmentRows = this.statements.listBroadcastSegments.all({
      broadcastId,
    }) as BroadcastSegmentRow[];
    for (const row of segmentRows) {
      const segments = segmentsByPeer.get(row.peer_id);
      if (segments) segments.push(row.segment_name);
      else segmentsByPeer.set(row.peer_id, [row.segment_name]);
    }
    return rows.map((row) => this.mapPeer(row, segmentsByPeer.get(row.peer_id) ?? []));
  }

  listPeerStats(broadcastId: string): PeerStatsSnapshot[] {
    const rows = this.statements.listPeerStats.all({ broadcastId }) as PeerTrafficRow[];
    const statsByPeer = new Map(
      rows.map((row) => [row.peer_id, this.mapPeerTrafficStats(row)]),
    );
    return this.listPeers(broadcastId).map((peer) => ({
      peer,
      stats: statsByPeer.get(peer.id) ?? createEmptyPeerTrafficStats(),
    }));
  }

  reportSegments(
    broadcastId: string,
    peerId: string,
    segments: string[],
    replace = false,
  ): Peer {
    this.requirePeer(broadcastId, peerId);
    const existing = this.getSegments(broadcastId, peerId);
    const nextSegments = [...new Set(replace ? segments : [...existing, ...segments])].slice(
      -this.maxSegmentsPerPeer,
    );
    const existingSet = new Set(existing);
    const nextSet = new Set(nextSegments);
    this.database.transaction(() => {
      for (const segment of existing) {
        if (!nextSet.has(segment)) {
          this.statements.deletePeerSegment.run({ broadcastId, peerId, segment });
        }
      }
      for (const segment of nextSegments) {
        if (existingSet.has(segment)) continue;
        this.statements.insertPeerSegment.run({ broadcastId, peerId, segment });
      }
      this.statements.updatePeerLastSeen.run({
        broadcastId,
        peerId,
        lastSeenAt: this.timestamp(),
      });
    })();
    return this.requirePeer(broadcastId, peerId);
  }

  heartbeat(
    broadcastId: string,
    peerId: string,
    heartbeat: PeerHeartbeat,
  ): Peer {
    const peer = this.requirePeer(broadcastId, peerId);
    this.statements.updatePeerHealth.run({
      broadcastId,
      peerId,
      uploadBandwidthBps:
        heartbeat.uploadBandwidthBps === undefined
          ? (peer.uploadBandwidthBps ?? null)
          : Math.max(0, heartbeat.uploadBandwidthBps),
      latencyMs:
        heartbeat.latencyMs === undefined
          ? peer.latencyMs
          : Math.max(0, heartbeat.latencyMs),
      successRate:
        heartbeat.successRate === undefined
          ? peer.successRate
          : clampUnitInterval(heartbeat.successRate),
      lastSeenAt: this.timestamp(),
    });
    return this.requirePeer(broadcastId, peerId);
  }

  reportStats(
    broadcastId: string,
    peerId: string,
    stats: PeerTrafficStats,
  ): void {
    this.requirePeer(broadcastId, peerId);
    this.database.transaction(() => {
      this.statements.replacePeerStats.run({
        broadcastId,
        peerId,
        ...sanitizePeerTrafficStats(stats),
      });
      this.statements.updatePeerLastSeen.run({
        broadcastId,
        peerId,
        lastSeenAt: this.timestamp(),
      });
    })();
  }

  reportPeerFailure(
    broadcastId: string,
    peerId: string,
    report: PeerFailureReport,
  ): Peer {
    const reported = this.requirePeer(broadcastId, peerId);
    this.requirePeer(broadcastId, report.reporterId);
    if (!this.failureConsensus.observe(broadcastId, peerId, report)) {
      return reported;
    }
    const quality = penalizePeerQuality(reported, report.reason);
    this.statements.updatePeerTrust.run({
      broadcastId,
      peerId,
      ...quality,
    });
    return this.requirePeer(broadcastId, peerId);
  }

  removeStalePeers(maxAgeMs: number): number {
    const cutoff = new Date(this.now().getTime() - maxAgeMs).toISOString();
    const stalePeers = this.statements.listStalePeers.all({
      cutoff,
    }) as PeerIdentityRow[];
    this.database.transaction(() => {
      for (const peer of stalePeers) {
        this.retirePeer(peer.broadcast_id, peer.peer_id);
      }
    })();
    return stalePeers.length;
  }

  getBroadcastStats(broadcastId: string): BroadcastStats {
    this.requireBroadcast(broadcastId);
    const row = this.statements.getBroadcastStats.get({
      broadcastId,
    }) as TrafficRow;
    return { broadcastId, ...this.mapTrafficTotals(row) };
  }

  getGlobalStats(): GlobalStats {
    const row = this.statements.getGlobalStats.get() as GlobalTrafficRow;
    return { broadcasts: row.broadcasts, ...this.mapTrafficTotals(row) };
  }

  rollupStats(timestamp = this.timestamp()): StatsHistoryEntry[] {
    return this.database.transaction(() => {
      return this.listBroadcasts().map((broadcast) => {
        const totals = this.getBroadcastStats(broadcast.id);
        const entry: StatsHistoryEntry = {
          timestamp,
          broadcastId: broadcast.id,
          peers: totals.peers,
          p2pBytes: totals.bytesDownloadedP2P,
          originBytes: totals.bytesDownloadedOrigin,
          p2pSuccessRate:
            totals.p2pRequests === 0
              ? 0
              : clampUnitInterval(totals.p2pSuccesses / totals.p2pRequests),
        };
        this.statements.insertStatsHistory.run(entry);
        return entry;
      });
    })();
  }

  getStatsHistory(broadcastId?: string): StatsHistoryEntry[] {
    const rows = broadcastId === undefined
      ? (this.statements.listStatsHistory.all() as StatsHistoryRow[])
      : (this.statements.listBroadcastStatsHistory.all({
          broadcastId,
        }) as StatsHistoryRow[]);
    return rows.map((row) => ({
      timestamp: row.timestamp,
      broadcastId: row.broadcast_id,
      peers: row.peers,
      p2pBytes: row.p2p_bytes,
      originBytes: row.origin_bytes,
      p2pSuccessRate: row.p2p_success_rate,
    }));
  }

  pruneStatsHistory(cutoff: string): number {
    return this.statements.deleteStatsHistoryBefore.run({ cutoff }).changes;
  }

  close(): void {
    if (this.database.open) this.database.close();
  }

  getPragmaSettings(): SQLitePragmaSettings {
    return {
      journalMode: String(
        this.database.pragma("journal_mode", { simple: true }),
      ),
      synchronous: Number(
        this.database.pragma("synchronous", { simple: true }),
      ),
      cacheSize: Number(this.database.pragma("cache_size", { simple: true })),
    };
  }

  private findBroadcast(id: string): Broadcast | undefined {
    const row = this.statements.getBroadcast.get({ id }) as
      | BroadcastRow
      | undefined;
    return row ? this.mapBroadcast(row) : undefined;
  }

  private requireBroadcast(id: string): Broadcast {
    const broadcast = this.findBroadcast(id);
    if (!broadcast) {
      throw new StoreError(`Broadcast '${id}' was not found`, NOT_FOUND_STATUS_CODE);
    }
    return broadcast;
  }

  private findPeer(broadcastId: string, peerId: string): PeerRow | undefined {
    return this.statements.getPeer.get({ broadcastId, peerId }) as
      | PeerRow
      | undefined;
  }

  private requirePeer(broadcastId: string, peerId: string): Peer {
    this.requireBroadcast(broadcastId);
    const row = this.findPeer(broadcastId, peerId);
    if (!row) {
      throw new StoreError(`Peer '${peerId}' was not found`, NOT_FOUND_STATUS_CODE);
    }
    return this.mapPeer(row);
  }

  private retirePeer(broadcastId: string, peerId: string): void {
    const parameters = { broadcastId, peerId };
    this.statements.accumulateRetiredStats.run(parameters);
    this.statements.deletePeerStats.run(parameters);
    this.statements.deletePeerSegments.run(parameters);
    this.statements.deletePeer.run(parameters);
  }

  private getSegments(broadcastId: string, peerId: string): string[] {
    return (this.statements.getSegments.all({
      broadcastId,
      peerId,
    }) as SegmentRow[]).map((row) => row.segment_name);
  }

  private mapBroadcast(row: BroadcastRow): Broadcast {
    const metadata = this.parseMetadata(row.metadata);
    return {
      id: row.id,
      playlistUrl: row.playlist_url,
      ...(metadata ? { metadata } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapPeer(
    row: PeerRow,
    segments = this.getSegments(row.broadcast_id, row.peer_id),
  ): Peer {
    const metadata = this.parseMetadata(row.metadata);
    return {
      id: row.peer_id,
      address: row.address,
      ...(row.upload_bandwidth_bps === null
        ? {}
        : { uploadBandwidthBps: row.upload_bandwidth_bps }),
      ...(metadata ? { metadata } : {}),
      segments,
      joinedAt: row.joined_at,
      lastSeenAt: row.last_seen_at,
      latencyMs: row.latency_ms,
      successRate: row.success_rate,
      trustScore: row.trust_score,
    };
  }

  private mapTrafficTotals(row: TrafficRow): TrafficTotals {
    return {
      peers: row.peers,
      ...this.mapPeerTrafficStats(row),
    };
  }

  private mapPeerTrafficStats(
    row: Omit<TrafficRow, "peers">,
  ): PeerTrafficStats {
    return {
      bytesDownloadedP2P: row.bytes_downloaded_p2p,
      bytesDownloadedOrigin: row.bytes_downloaded_origin,
      bytesUploadedP2P: row.bytes_uploaded_p2p,
      p2pRequests: row.p2p_requests,
      p2pSuccesses: row.p2p_successes,
      p2pFailures: row.p2p_failures,
      originRequests: row.origin_requests,
      integrityFailures: row.integrity_failures,
      fallbacks: row.fallbacks,
      segmentsCached: row.segments_cached,
    };
  }

  private parseMetadata(value: string | null): Record<string, string> | undefined {
    if (value === null) return undefined;
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Tracker database contains invalid metadata");
    }
    const metadata: Record<string, string> = {};
    for (const [key, item] of Object.entries(parsed)) {
      if (typeof item !== "string") {
        throw new Error("Tracker database contains invalid metadata");
      }
      metadata[key] = item;
    }
    return metadata;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}
