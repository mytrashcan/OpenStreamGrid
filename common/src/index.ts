/** Supported adaptive-bitrate quality identifiers. */
export type Quality = "low" | "med" | "high";

const UNSAFE_PEER_HOSTNAMES = new Set([
  "0.0.0.0",
  "::",
  "::1",
  "localhost",
  "metadata.google.internal",
]);

/** Rejects peer HTTP addresses that can trivially target local metadata services. */
export const validatePeerHttpBaseUrl = (address: string): URL => {
  const url = new URL(address);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Peer address must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Peer address must not contain credentials");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    UNSAFE_PEER_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.startsWith("127.") ||
    hostname.startsWith("169.254.") ||
    hostname.startsWith("fe80:")
  ) {
    throw new Error("Peer address targets a reserved local endpoint");
  }
  if (url.search || url.hash) {
    throw new Error("Peer address must not contain a query or fragment");
  }
  return url;
};

/** Payload used to register or update a broadcast. */
export interface BroadcastRegistration {
  id: string;
  playlistUrl: string;
  metadata?: Record<string, string>;
}

/** Registered broadcast metadata returned by the tracker. */
export interface Broadcast extends BroadcastRegistration {
  createdAt: string;
  updatedAt: string;
}

/** Payload used when a peer joins a broadcast. */
export interface PeerJoinRequest {
  id: string;
  address: string;
  uploadBandwidthBps?: number;
  metadata?: Record<string, string>;
}

/** Optional peer quality measurements sent with a heartbeat. */
export interface PeerHeartbeat {
  latencyMs?: number;
  uploadBandwidthBps?: number;
  successRate?: number;
}

/** Tracker representation of a connected peer. */
export interface Peer extends PeerJoinRequest {
  segments: string[];
  joinedAt: string;
  lastSeenAt: string;
  latencyMs: number;
  successRate: number;
  trustScore: number;
}

/** Segment inventory update sent by a peer. */
export interface SegmentPossessionReport {
  segments: string[];
  replace?: boolean;
}

/** Cumulative traffic and integrity counters reported by a peer. */
export interface PeerTrafficStats {
  bytesDownloadedP2P: number;
  bytesDownloadedOrigin: number;
  bytesUploadedP2P: number;
  p2pRequests: number;
  p2pSuccesses: number;
  p2pFailures: number;
  originRequests: number;
  integrityFailures: number;
  fallbacks: number;
  segmentsCached: number;
}

/** Ordered keys for iterating over every peer traffic metric. */
export const peerTrafficStatKeys = [
  "bytesDownloadedP2P",
  "bytesDownloadedOrigin",
  "bytesUploadedP2P",
  "p2pRequests",
  "p2pSuccesses",
  "p2pFailures",
  "originRequests",
  "integrityFailures",
  "fallbacks",
  "segmentsCached",
] as const satisfies ReadonlyArray<keyof PeerTrafficStats>;

/** Creates a fresh, zero-filled peer traffic snapshot. */
export const createEmptyPeerTrafficStats = (): PeerTrafficStats => ({
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

/** Adds every metric from `source` to the mutable `target` snapshot. */
export const addPeerTrafficStats = (
  target: PeerTrafficStats,
  source: PeerTrafficStats,
): void => {
  for (const key of peerTrafficStatKeys) {
    target[key] += source[key];
  }
};

/** Validates an unknown value as a complete peer traffic snapshot. */
export const parsePeerTrafficStats = (value: unknown): PeerTrafficStats => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Peer traffic stats must be an object");
  }

  const record = value as Record<string, unknown>;
  const stats = createEmptyPeerTrafficStats();
  for (const key of peerTrafficStatKeys) {
    const metric = record[key];
    if (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0) {
      throw new TypeError(`Peer traffic stat '${key}' must be a non-negative number`);
    }
    stats[key] = metric;
  }
  return stats;
};

/** Context fields appended to a structured log entry. */
export type LogContext = Readonly<Record<string, unknown>>;

/** Structured logger shared by Node services and the browser SDK. */
export interface Logger {
  info(event: string, context?: LogContext): void;
  warn(event: string, context?: LogContext): void;
  error(event: string, error: unknown, context?: LogContext): void;
}

type LogLevel = "info" | "warn" | "error";

const writeLog = (
  service: string,
  level: LogLevel,
  event: string,
  context: LogContext = {},
  error?: unknown,
): void => {
  const entry = {
    ...context,
    timestamp: new Date().toISOString(),
    level,
    service,
    event,
    ...(error === undefined
      ? {}
      : {
          error:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : { message: String(error) },
        }),
  };
  const serialized = JSON.stringify(entry);
  if (level === "error") console.error(serialized);
  else if (level === "warn") console.warn(serialized);
  else console.log(serialized);
};

/** Creates a structured logger whose entries always identify their service. */
export const createLogger = (service: string): Logger => ({
  info: (event, context) => writeLog(service, "info", event, context),
  warn: (event, context) => writeLog(service, "warn", event, context),
  error: (event, error, context) =>
    writeLog(service, "error", event, context, error),
});

/** Request wrapper for submitting a peer traffic snapshot. */
export interface PeerStatsReport {
  stats: PeerTrafficStats;
}

/** Aggregated peer count and traffic counters. */
export interface TrafficTotals extends PeerTrafficStats {
  peers: number;
}

/** Traffic totals for one broadcast. */
export interface BroadcastStats extends TrafficTotals {
  broadcastId: string;
}

/** Traffic totals across every registered broadcast. */
export interface GlobalStats extends TrafficTotals {
  broadcasts: number;
}

/** Report that lowers a peer's quality scores after a failed request. */
export interface PeerFailureReport {
  reporterId: string;
  reason: "connection" | "timeout" | "integrity" | "http";
}

/** Health-check response shared by all services. */
export interface HealthStatus {
  status: "ok" | "starting" | "error";
  service: "tracker" | "origin" | "peer";
  details?: Record<string, string | number | boolean>;
}

/** WebRTC offer or answer relayed through tracker signaling. */
export interface WebRtcSignalMessage {
  type: "webrtc_offer" | "webrtc_answer";
  broadcastId: string;
  /** Signaling identity of the peer that sent this message. */
  peerId: string;
  targetPeerId: string;
  requestId: string;
  sdp: string;
}

/** Messages accepted from tracker WebSocket clients. */
export type WsClientMessage =
  | {
      type: "subscribe";
      broadcastId: string;
      peerId: string;
    }
  | {
      type: "heartbeat";
      broadcastId: string;
      peerId: string;
      latencyMs?: number;
      uploadBandwidthBps?: number;
      successRate?: number;
    }
  | {
      type: "report_segments";
      broadcastId: string;
      peerId: string;
      segments?: string[];
      replace?: boolean;
      added?: string[];
      removed?: string[];
    }
  | {
      type: "report_stats";
      broadcastId: string;
      peerId: string;
      stats: PeerTrafficStats;
    }
  | WebRtcSignalMessage;

/** Messages emitted to tracker WebSocket clients. */
export type WsServerMessage =
  | {
      type: "peer_joined";
      broadcastId: string;
      peer: Peer;
    }
  | {
      type: "peer_left";
      broadcastId: string;
      peerId: string;
    }
  | {
      type: "segment_available";
      broadcastId: string;
      peerId: string;
      segments: string[];
      /** When true, the list replaces the peer's previous inventory. */
      replace?: boolean;
    }
  | {
      type: "segment_inventory_delta";
      broadcastId: string;
      peerId: string;
      added: string[];
      removed: string[];
    }
  | {
      type: "stats_update";
      broadcastId: string;
      peerId: string;
      stats: BroadcastStats;
    }
  | {
      type: "peer_list";
      broadcastId: string;
      peers: Peer[];
    }
  | WebRtcSignalMessage;
