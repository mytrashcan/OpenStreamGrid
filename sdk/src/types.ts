/**
 * Browser-compatible types for the OpenStreamGrid Browser SDK.
 * Mirrors @openstreamgrid/common but avoids the Node dependency.
 */

/** A segment stored in the browser cache — uses Uint8Array instead of Node Buffer. */
export interface CachedSegment {
  data: Uint8Array;
  storedAt: number;
  hash?: string;
}

/** Tracker peer metadata consumed by the browser SDK. */
export interface PeerInfo {
  id: string;
  address: string;
  /** Segments this peer claims to possess (segment names / URLs). */
  segments: string[];
  latencyMs: number;
  successRate: number;
  trustScore: number;
  uploadBandwidthBps?: number;
  metadata?: Record<string, string>;
  joinedAt?: string;
  lastSeenAt?: string;
}

/** Result of verifying browser segment bytes against an expected digest. */
export interface SegmentVerificationResult {
  valid: boolean;
  actualHash: string;
  expectedHash?: string;
}

/** Configuration for attaching P2P delivery to an Hls.js player. */
export interface HlsjsPluginConfig {
  /** WebSocket URL of the tracker (e.g., ws://tracker:7070/ws). */
  trackerUrl: string;
  /** Broadcast / stream ID to join. */
  broadcastId: string;
  /** Unique peer ID for this client. Generated if omitted. */
  peerId?: string;
  /** Base URL used to fetch segment hashes. Required unless verification is disabled. */
  originBaseUrl?: string;
  /** Max cache size in bytes (default: 100 MB). */
  maxCacheBytes?: number;
  /** P2P request timeout in ms (default: 3000). */
  peerTimeoutMs?: number;
  /** Enable zero-install browser peer participation (default: true). */
  peerParticipation?: boolean;
  /** ICE servers used for browser WebRTC connections. */
  iceServers?: RTCIceServer[];
  /** Maximum simultaneous browser uploads (default: 3). */
  maxUploadConnections?: number;
  /** Browser upload bitrate limit in bits per second (default: 1 Mbps). */
  maxUploadBitrate?: number;
  /** Optional tracker API key used for peer registration requests. */
  trackerApiKey?: string;
  /** Test and embedded-runtime hook for constructing peer connections. */
  peerConnectionFactory?: (configuration: RTCConfiguration) => RTCPeerConnection;
  /** Whether to enable SHA-256 segment verification (default: true). */
  verifySegments?: boolean;
  /** Callback for stats / debug events. */
  onEvent?: (event: SdkEvent) => void;
  /** Callback when the plugin is ready (first WS connection established). */
  onReady?: () => void;
}

/** Diagnostic event emitted by the browser SDK. */
export interface SdkEvent {
  type:
    | "peer_fetched"
    | "origin_fallback"
    | "cache_hit"
    | "cache_miss"
    | "integrity_ok"
    | "integrity_fail"
    | "ws_connected"
    | "ws_disconnected"
    | "ws_error";
  /** Segment name involved, if any. */
  segment?: string;
  /** Peer ID involved, if any. */
  peerId?: string;
  /** Duration in ms, if applicable. */
  durationMs?: number;
  /** Additional info. */
  message?: string;
}

/** Message types for tracker WebSocket communication. */
/** Messages emitted by the browser SDK to the tracker. */
export type WsClientMessage =
  | { type: "subscribe"; broadcastId: string; peerId: string }
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

/** WebRTC offer or answer relayed by the tracker. */
export interface WebRtcSignalMessage {
  type: "webrtc_offer" | "webrtc_answer";
  broadcastId: string;
  peerId: string;
  targetPeerId: string;
  requestId: string;
  sdp: string;
}

/** Messages accepted by the browser SDK from the tracker. */
export type WsServerMessage =
  | { type: "peer_joined"; broadcastId: string; peer: PeerInfo }
  | { type: "peer_left"; broadcastId: string; peerId: string }
  | {
      type: "segment_available";
      broadcastId: string;
      peerId: string;
      segments: string[];
    }
  | { type: "stats_update"; broadcastId: string; peerId: string; stats: unknown }
  | { type: "peer_list"; broadcastId: string; peers: PeerInfo[] }
  | WebRtcSignalMessage;

/** Cumulative browser peer traffic and integrity counters. */
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
