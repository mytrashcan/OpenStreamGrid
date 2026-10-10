# Changelog

All notable changes to OpenStreamGrid are documented in this file.

## [Unreleased]

### Added

- Helm `tracker.extraEnv` and `origin.extraEnv` pass additional environment
  variables (including `valueFrom`) to the containers, so settings such as
  `TRACKER_WS_ALLOWED_ORIGINS` and rate limits are configurable in Kubernetes.

### Fixed

- The React integration example compiles again: it narrows `SdkEvent` before
  reading `segment`, which `scheduler_decision` events do not carry. CI now
  builds the example so SDK type changes cannot break it silently.

## [0.6.1] - 2026-10-11

### Security

- Made peer joins atomic so concurrent joins cannot bypass the per-broadcast
  peer cap or both mint session tokens, and applied WebSocket segment deltas
  atomically in the store.
- Reserved per-IP WebSocket slots before the upgrade handshake, preferred the
  `Authorization` header over the `sessionToken` query parameter, and added an
  optional `TRACKER_WS_ALLOWED_ORIGINS` allowlist.
- Fixed a polynomial-ReDoS in the SDK `parseSha256` helper and restricted
  workflow token permissions (CodeQL findings).

### Fixed

- `TRACKER_WS_ALLOWED_ORIGINS` no longer rejects Node peers, which send no
  `Origin` header; the allowlist now applies only to browser upgrades, and
  entries are validated and normalized to their origin form at startup.
  **Upgrade note:** entries that are not http(s) origins (for example a bare
  `player.example`) now stop the tracker at startup instead of silently never
  matching.

### Changed

- Relicensed the project from GPL-3.0 to MIT.
- The Helm chart now derives image tags from `appVersion` (`v<appVersion>`),
  matching the published GHCR release tags; the previous default (`0.5.0`)
  did not exist and failed with `ImagePullBackOff`.
- Package, lockfile, and chart versions are set together by
  `scripts/bump-version.mjs`, and a test fails when they drift apart.

### Community

- Added a Code of Conduct, Dependabot configuration for npm, GitHub Actions,
  and Docker base images, and a star history chart in the README.
- Replaced the placeholder Discord contact link in the issue chooser with
  GitHub Discussions and private security advisory links.

### CI

- Added automated pull request and issue labeling.
- Run the test suite once with c8 coverage instead of twice, publish a
  coverage summary and lcov artifact, and test on Node 22 and 24.
- Removed the unused `.eslintignore`; ignores live in `eslint.config.js`.
- Pinned every workflow action to a commit SHA.
- Container images are now built for `linux/amd64` and `linux/arm64`, carry an
  SBOM, and are tagged with both `vX.Y.Z` and `X.Y.Z`. Tag pushes fail fast
  when the tag does not match the `package.json` version.

## [0.6.0] - 2026-07-26

### Scheduling

- Added the shared `SegmentScheduler` contract and extracted the Node
  weighted-score and browser trust/latency-probe policies into injectable
  schedulers without changing their default selection behavior.
- Added deadline-aware scheduler decorators for Node peers and the browser SDK,
  with first-success-wins hedged P2P/Origin requests, cancellation, and a
  bounded Origin-latency estimator.

### Benchmarking

- Added versioned, seeded benchmark scenarios with schema validation, QoE
  metrics (deadline misses, stall proxies, latency percentiles, fairness),
  repeated-run aggregation, result comparison, and SVG reports.
- Added a deterministic scheduler lab with critical, tight, relaxed,
  slow-Origin, unreliable-peer, and mixed-workload scenarios.

See [RELEASE_NOTES.md](RELEASE_NOTES.md) for details.

## [0.5.0] - 2026-07-22

### Security

- Replaced browser-visible administrator credentials with signed, short-lived
  peer sessions bound to a broadcast and peer identity.
- Added authenticated peer uploads, address validation, bounded payloads,
  WebSocket quotas, failure-report consensus, and transport size limits.

### Reliability

- Added origin restart/backoff, immutable segment names, streaming hashes,
  broadcast leases, network timeouts, bounded buffer retention, and stronger
  SQLite constraints with incremental segment updates and retained rollups.
- Corrected urgent-segment routing and browser integrity accounting.

### Operations

- Made Helm defaults safe for SQLite, added secret references, aligned packages
  at 0.5.0, and corrected protocol and TLS documentation.

## [0.4.1] - 2026-07-18

### Security audit remediation

#### Fixed
- **Tracker authentication was documented but not implemented.** The `TRACKER_API_KEY` env var was listed in CORS headers and SECURITY.md, but the tracker never validated it. Added `apiKeysMatch()` (constant-time comparison) and middleware enforcing `X-API-Key` on REST POST/PUT/DELETE, stats, and dashboard SSE endpoints. WebSocket upgrades now validate `?apiKey=` query parameter.
- **CI `npx eslint` without version pin.** Replaced with `npm run lint` using the locally installed eslint version.
- **SDK WebSocket client** now appends `?apiKey=` to the tracker URL when `apiKey` is configured.

#### Changed
- Package versions advanced to 0.4.1.

## [0.4.0] - 2026-07-17

### Zero-install browser peers

#### Added
- Browser-native WebRTC DataChannel requesting and segment uploads.
- Automatic browser peer registration, heartbeat, segment advertisement, traffic reporting, and unload cleanup.
- Browser upload bitrate and concurrent-connection limits.
- Path-qualified browser segment identifiers to keep ABR rendition caches isolated.
- Real DataChannel integration tests between two browser peer implementations.
- Tracker REST CORS and preflight support for cross-origin browser registration.

#### Changed
- The Hls.js plugin now turns each participating viewer into a peer by default; no executable or browser extension is required.
- Browser peers prefer WebRTC-only peers and retain HTTP fallback for existing Node peers.
- WebRTC transfers extend their deadline from segment size and advertised upload bandwidth after negotiation succeeds.
- Package versions advanced to 0.4.0.

## [0.3.0] - 2026-07-17

### Phase 5 — Production Hardening

#### Added
- STUN/TURN NAT traversal for WebRTC DataChannel (config via STUN_SERVER, TURN_SERVER, TURN_USERNAME, TURN_CREDENTIAL env vars)
- API key authentication for tracker REST endpoints (TRACKER_API_KEY env, X-API-Key header)
- HTTPS/WSS support (TLS_CERT_PATH + TLS_KEY_PATH env vars)
- Token-bucket rate limiting (RATE_LIMIT_RPS, RATE_LIMIT_BURST) with 429 responses
- Peer connection limit per broadcast (MAX_PEERS_PER_BROADCAST)
- Prometheus /metrics endpoint with counters, gauges, and histograms
- Multi-broadcast channel support (MULTI_STREAM_COUNT, MultiHlsStreamer)
- Dashboard broadcast selector for multi-channel viewing
- Buffer pool for segment data (reduced GC pressure)
- HTTP client with connection keep-alive and pooling
- SQLite WAL optimization (synchronous=NORMAL, cache_size=-65536)
- Docker publish GitHub Actions workflow
- SDK npm publish dry-run workflow
- API_REFERENCE.md, CONTRIBUTING.md, SECURITY.md documentation

#### Changed
- Updated README.md with full API reference, env vars table, architecture diagram
- Increased default cache size, added TTL-based eviction
- Enhanced test suite from 26 to 95 tests

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
