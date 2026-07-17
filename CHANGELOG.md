# Changelog

All notable changes to OpenStreamGrid are documented in this file.

## [0.2.0] - 2026-07-17

OpenStreamGrid 0.2.0 completes the four prototype phases for a universal hybrid
P2P-CDN live-streaming middleware.

### Phase 1 - Hybrid streaming foundation

- Added an FFmpeg-backed HLS origin with test-pattern generation, health checks,
  broadcast registration, multi-rendition playlists, and SHA-256 sidecars.
- Added the tracker REST API for broadcasts, peer discovery, segment ownership,
  heartbeats, failure reports, and traffic statistics.
- Added Node.js peers with an LRU segment cache, HTTP segment uploads, token-bucket
  bandwidth limiting, concurrent upload limits, integrity verification, and
  automatic origin fallback.
- Added a Docker Compose multi-peer environment and an integration test that
  proves P2P sharing and origin fallback.

### Phase 2 - Real-time selection and browser playback

- Added WebSocket signaling for peer lifecycle, segment availability, statistics,
  and transport negotiation.
- Added weighted peer scoring, trust-based exclusion, metric smoothing, and
  configurable parallel segment downloads.
- Added the `@openstreamgrid/sdk` browser package with ESM and CommonJS builds,
  an Hls.js loader plugin, browser caching, and Web Crypto integrity checks.
- Added three-rendition adaptive HLS output and a real-time monitoring dashboard
  backed by Server-Sent Events.

### Phase 3 - Advanced transport and deployment

- Added a transport adapter layer with WebRTC DataChannel segment transfer and
  transparent HTTP fallback.
- Added a virtual-peer load generator with ramp-up, burst, churn, latency, P2P
  efficiency, and CDN reduction metrics.
- Added a persistent SQLite tracker backend with WAL mode, schema migrations,
  restart recovery, and historical statistics rollups.
- Added Docker health checks, GitHub Actions CI, strict TypeScript checks, ESLint,
  a Helm chart, Kustomize manifests, autoscaling, ingress, persistent storage,
  and network policies.

### Phase 4 - End-to-end validation and benchmarks

- Added an isolated Docker end-to-end suite covering HLS generation, peer
  discovery, P2P delivery, HTTP fallback, peer churn, and SQLite persistence.
- Added a reproducible benchmark runner that emits human-readable and JSON
  results for efficiency, CDN reduction, latency percentiles, upload volume,
  and churn behavior.
- Expanded automated unit and integration coverage across all workspaces and
  hardened transport lifecycle behavior for deterministic shutdown and fallback.

### Seven code review iterations

The release includes seven focused review-and-hardening passes:

1. Type safety and error handling.
2. Performance and asynchronous control flow.
3. Edge cases and race-condition guards.
4. Code quality and maintainability.
5. Configuration validation and fail-fast startup behavior.
6. Test coverage improvements.
7. A final deep-dive review across service, transport, persistence, and test code.

CI command ordering was also corrected so generated build artifacts are available
before the no-emit typecheck gate runs.

[0.2.0]: https://github.com/mytrashcan/OpenStreamGrid/releases/tag/v0.2.0
