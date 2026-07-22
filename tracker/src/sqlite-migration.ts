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
  {
    version: 3,
    sql: `
      CREATE TABLE broadcasts_new (
        id TEXT PRIMARY KEY NOT NULL,
        playlist_url TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO broadcasts_new SELECT * FROM broadcasts;

      CREATE TABLE peers_new (
        broadcast_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        address TEXT NOT NULL,
        upload_bandwidth_bps INTEGER CHECK(upload_bandwidth_bps IS NULL OR upload_bandwidth_bps >= 0),
        metadata TEXT,
        joined_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        latency_ms REAL NOT NULL CHECK(latency_ms >= 0),
        success_rate REAL NOT NULL CHECK(success_rate BETWEEN 0 AND 1),
        trust_score REAL NOT NULL CHECK(trust_score BETWEEN 0 AND 1),
        PRIMARY KEY(broadcast_id, peer_id),
        FOREIGN KEY(broadcast_id) REFERENCES broadcasts_new(id) ON DELETE CASCADE
      );
      INSERT INTO peers_new SELECT * FROM peers;

      CREATE TABLE peer_segments_new (
        broadcast_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        segment_name TEXT NOT NULL,
        PRIMARY KEY(broadcast_id, peer_id, segment_name),
        FOREIGN KEY(broadcast_id, peer_id)
          REFERENCES peers_new(broadcast_id, peer_id) ON DELETE CASCADE
      );
      INSERT INTO peer_segments_new SELECT * FROM peer_segments;

      CREATE TABLE peer_stats_new (
        broadcast_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        bytes_downloaded_p2p INTEGER NOT NULL DEFAULT 0 CHECK(bytes_downloaded_p2p >= 0),
        bytes_downloaded_origin INTEGER NOT NULL DEFAULT 0 CHECK(bytes_downloaded_origin >= 0),
        bytes_uploaded_p2p INTEGER NOT NULL DEFAULT 0 CHECK(bytes_uploaded_p2p >= 0),
        p2p_requests INTEGER NOT NULL DEFAULT 0 CHECK(p2p_requests >= 0),
        p2p_successes INTEGER NOT NULL DEFAULT 0 CHECK(p2p_successes >= 0),
        p2p_failures INTEGER NOT NULL DEFAULT 0 CHECK(p2p_failures >= 0),
        origin_requests INTEGER NOT NULL DEFAULT 0 CHECK(origin_requests >= 0),
        integrity_failures INTEGER NOT NULL DEFAULT 0 CHECK(integrity_failures >= 0),
        fallbacks INTEGER NOT NULL DEFAULT 0 CHECK(fallbacks >= 0),
        segments_cached INTEGER NOT NULL DEFAULT 0 CHECK(segments_cached >= 0),
        PRIMARY KEY(broadcast_id, peer_id),
        FOREIGN KEY(broadcast_id, peer_id)
          REFERENCES peers_new(broadcast_id, peer_id) ON DELETE CASCADE
      );
      INSERT INTO peer_stats_new SELECT * FROM peer_stats;

      CREATE TABLE retired_peer_stats_new (
        broadcast_id TEXT PRIMARY KEY NOT NULL,
        bytes_downloaded_p2p INTEGER NOT NULL DEFAULT 0 CHECK(bytes_downloaded_p2p >= 0),
        bytes_downloaded_origin INTEGER NOT NULL DEFAULT 0 CHECK(bytes_downloaded_origin >= 0),
        bytes_uploaded_p2p INTEGER NOT NULL DEFAULT 0 CHECK(bytes_uploaded_p2p >= 0),
        p2p_requests INTEGER NOT NULL DEFAULT 0 CHECK(p2p_requests >= 0),
        p2p_successes INTEGER NOT NULL DEFAULT 0 CHECK(p2p_successes >= 0),
        p2p_failures INTEGER NOT NULL DEFAULT 0 CHECK(p2p_failures >= 0),
        origin_requests INTEGER NOT NULL DEFAULT 0 CHECK(origin_requests >= 0),
        integrity_failures INTEGER NOT NULL DEFAULT 0 CHECK(integrity_failures >= 0),
        fallbacks INTEGER NOT NULL DEFAULT 0 CHECK(fallbacks >= 0),
        segments_cached INTEGER NOT NULL DEFAULT 0 CHECK(segments_cached >= 0),
        FOREIGN KEY(broadcast_id) REFERENCES broadcasts_new(id) ON DELETE CASCADE
      );
      INSERT INTO retired_peer_stats_new SELECT * FROM retired_peer_stats;

      DROP TABLE peer_segments;
      DROP TABLE peer_stats;
      DROP TABLE peers;
      DROP TABLE retired_peer_stats;
      DROP TABLE broadcasts;

      ALTER TABLE broadcasts_new RENAME TO broadcasts;
      ALTER TABLE peers_new RENAME TO peers;
      ALTER TABLE peer_segments_new RENAME TO peer_segments;
      ALTER TABLE peer_stats_new RENAME TO peer_stats;
      ALTER TABLE retired_peer_stats_new RENAME TO retired_peer_stats;

      CREATE INDEX peer_segments_lookup
        ON peer_segments(broadcast_id, segment_name, peer_id);
      CREATE INDEX peers_last_seen ON peers(last_seen_at);
    `,
  },
];

/** Most recent tracker database schema version. */
export const LATEST_SCHEMA_VERSION = migrations.at(-1)?.version ?? 0;

/** Applies pending tracker schema migrations in a transaction. */
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
