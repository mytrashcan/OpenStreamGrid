/**
 * @openstreamgrid/sdk — OpenStreamGrid Browser SDK
 *
 * A hybrid P2P-CDN live streaming middleware for Hls.js.
 *
 * ## Exports
 *
 * - `OpenStreamGridHlsPlugin` — main plugin class that attaches to Hls.js
 * - `SegmentCache` — browser-compatible LRU cache (Uint8Array-based)
 * - `WsTrackerClient` — WebSocket client for tracker communication
 * - `OriginHashVerifier`, `sha256Hex`, `verifySegmentHash` — segment integrity tools
 * - TypeScript types for configuration and events
 */

export { OpenStreamGridHlsPlugin } from "./hls-plugin.js";
export { SegmentCache } from "./cache.js";
export { WsTrackerClient } from "./ws-client.js";
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
  SegmentVerificationResult,
  WsClientMessage,
  WsServerMessage,
} from "./types.js";
