import type Database from "better-sqlite3";

interface Migration {
  version: number;
  sql: string;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE broadcasts (
        id TEXT PRIMARY KEY,
        playlist_url TEXT,
        metadata TEXT,
        created_at TEXT,
        updated_at TEXT
      );

      CREATE TABLE peers (
        broadcast_id TEXT,
        peer_id TEXT,
        address TEXT,
        upload_bandwidth_bps INT,
        metadata TEXT,
        joined_at TEXT,
        last_seen_at TEXT,
        latency_ms REAL,
        success_rate REAL,
        trust_score REAL,
        PRIMARY KEY(broadcast_id, peer_id)
      );

      CREATE TABLE peer_segments (
        broadcast_id TEXT,
        peer_id TEXT,
        segment_name TEXT,
        PRIMARY KEY(broadcast_id, peer_id, segment_name)
      );

      CREATE TABLE peer_stats (
        broadcast_id TEXT,
        peer_id TEXT,
        bytes_downloaded_p2p INT DEFAULT 0,
        bytes_downloaded_origin INT DEFAULT 0,
        bytes_uploaded_p2p INT DEFAULT 0,
        p2p_requests INT DEFAULT 0,
        p2p_successes INT DEFAULT 0,
        p2p_failures INT DEFAULT 0,
        origin_requests INT DEFAULT 0,
        integrity_failures INT DEFAULT 0,
        fallbacks INT DEFAULT 0,
        segments_cached INT DEFAULT 0,
        PRIMARY KEY(broadcast_id, peer_id)
      );

      CREATE TABLE stats_history (
        timestamp TEXT,
        broadcast_id TEXT,
        peers INT,
        p2p_bytes INT,
        origin_bytes INT,
        p2p_success_rate REAL
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE retired_peer_stats (
        broadcast_id TEXT PRIMARY KEY,
        bytes_downloaded_p2p INT DEFAULT 0,
        bytes_downloaded_origin INT DEFAULT 0,
        bytes_uploaded_p2p INT DEFAULT 0,
        p2p_requests INT DEFAULT 0,
        p2p_successes INT DEFAULT 0,
        p2p_failures INT DEFAULT 0,
        origin_requests INT DEFAULT 0,
        integrity_failures INT DEFAULT 0,
        fallbacks INT DEFAULT 0,
        segments_cached INT DEFAULT 0
      );

      CREATE INDEX peer_segments_lookup
        ON peer_segments(broadcast_id, segment_name, peer_id);
      CREATE INDEX peers_last_seen
        ON peers(last_seen_at);
      CREATE INDEX stats_history_lookup
        ON stats_history(broadcast_id, timestamp);
    `,
  },
];

export const LATEST_SCHEMA_VERSION = migrations.at(-1)?.version ?? 0;

export const runSQLiteMigrations = (database: Database.Database): void => {
  const migrate = database.transaction(() => {
    const rawVersion: unknown = database.pragma("user_version", {
      simple: true,
    });
    if (
      typeof rawVersion !== "number" ||
      !Number.isSafeInteger(rawVersion) ||
      rawVersion < 0
    ) {
      throw new Error("Tracker database returned an invalid schema version");
    }
    const currentVersion = rawVersion;
    if (currentVersion > LATEST_SCHEMA_VERSION) {
      throw new Error(
        `Tracker database schema version ${currentVersion} is newer than supported version ${LATEST_SCHEMA_VERSION}`,
      );
    }

    for (const migration of migrations) {
      if (migration.version <= currentVersion) continue;
      database.exec(migration.sql);
      database.pragma(`user_version = ${migration.version}`);
    }
  });
  migrate.immediate();
};
