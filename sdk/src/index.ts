/**
 * @openstreamgrid/sdk — OpenStreamGrid Browser SDK
 *
 * A hybrid P2P-CDN live streaming middleware for Hls.js.
 *
 * ## Exports
 *
 * - `OpenStreamGridHlsPlugin` — main plugin class that attaches to Hls.js
 * - `OpenStreamGridShakaPlugin` — the same delivery core for Shaka Player
 * - `SegmentCache` — browser-compatible LRU cache (Uint8Array-based)
 * - `WsTrackerClient` — WebSocket client for tracker communication
 * - `OriginHashVerifier`, `sha256Hex`, `verifySegmentHash` — segment integrity tools
 * - TypeScript types for configuration and events
 */

export { OpenStreamGridHlsPlugin } from "./hls-plugin.js";
export { OpenStreamGridShakaPlugin } from "./shaka-plugin.js";
export { DeadlineAwareScheduler } from "./deadline-aware-scheduler.js";
export { TrustLatencyProbeScheduler } from "./trust-latency-probe-scheduler.js";
export { SegmentCache } from "./cache.js";
export { WsTrackerClient } from "./ws-client.js";
export { BrowserWebRtcPeer } from "./webrtc-peer.js";
export {
  OriginHashVerifier,
  sha256Hex,
  verifySegmentHash,
  parseSha256,
  constantTimeEqual,
} from "./verifier.js";

export type {
  CachedSegment,
  HlsjsPluginConfig,
  PeerInfo,
  PeerTrafficStats,
  SdkEvent,
  SegmentInventoryUpdate,
  SegmentVerificationResult,
  WsClientMessage,
  WsServerMessage,
} from "./types.js";
export type { BrowserWebRtcPeerOptions } from "./webrtc-peer.js";
export type {
  ShakaNamespace,
  ShakaPluginConfig,
  ShakaSchemePlugin,
} from "./shaka-plugin.js";
export type {
  DeadlineAwareSchedulerOptions,
  OriginLatencyEstimate,
} from "./deadline-aware-scheduler.js";
