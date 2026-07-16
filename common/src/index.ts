export type Quality = "low" | "med" | "high";

export interface BroadcastRegistration {
  id: string;
  playlistUrl: string;
  metadata?: Record<string, string>;
}

export interface Broadcast extends BroadcastRegistration {
  createdAt: string;
  updatedAt: string;
}

export interface PeerJoinRequest {
  id: string;
  address: string;
  uploadBandwidthBps?: number;
  metadata?: Record<string, string>;
}

export interface PeerHeartbeat {
  latencyMs?: number;
  uploadBandwidthBps?: number;
  successRate?: number;
}

export interface Peer extends PeerJoinRequest {
  segments: string[];
  joinedAt: string;
  lastSeenAt: string;
  latencyMs: number;
  successRate: number;
  trustScore: number;
}

export interface SegmentPossessionReport {
  segments: string[];
  replace?: boolean;
}

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

export interface PeerStatsReport {
  stats: PeerTrafficStats;
}

export interface TrafficTotals extends PeerTrafficStats {
  peers: number;
}

export interface BroadcastStats extends TrafficTotals {
  broadcastId: string;
}

export interface GlobalStats extends TrafficTotals {
  broadcasts: number;
}

export interface PeerFailureReport {
  reporterId: string;
  reason: "connection" | "timeout" | "integrity" | "http";
}

export interface HealthStatus {
  status: "ok" | "starting" | "error";
  service: "tracker" | "origin" | "peer";
  details?: Record<string, string | number | boolean>;
}

export interface WebRtcSignalMessage {
  type: "webrtc_offer" | "webrtc_answer";
  broadcastId: string;
  /** Signaling identity of the peer that sent this message. */
  peerId: string;
  targetPeerId: string;
  requestId: string;
  sdp: string;
}

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
      segments: string[];
      replace?: boolean;
    }
  | {
      type: "report_stats";
      broadcastId: string;
      peerId: string;
      stats: PeerTrafficStats;
    }
  | WebRtcSignalMessage;

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
