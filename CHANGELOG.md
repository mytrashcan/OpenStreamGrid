# Changelog

All notable changes to OpenStreamGrid are documented in this file.

## [Unreleased]

### Added

- The dashboard's peer table shows each peer's client, `Browser` or `Node`,
  with the rendition a Node peer follows (`Node · low`).
- The Node peer follows a multivariant playlist to one rendition, chosen with
  `RENDITION` (`--rendition`) or the lowest bandwidth by default, instead of
  finding no segments in it. It waits for the origin to serve the playlist
  before joining the tracker.
- Test-only LL-HLS on the origin: `HLS_PARTS_PER_SEGMENT` lists recent MPEG-TS
  segments as packet-aligned parts (`EXT-X-PART`). A new browser E2E variant
  plays it with low-latency hls.js and checks that the viewer assembles and
  shares segments (`assembleLowLatencySegments`).
- `assembleLowLatencySegments` (Hls.js plugin, off by default): LL-HLS
  viewers join a segment's parts once the playlist lists it with all its
  parts, verify the result against the segment's sidecar, and share it, so
  peers that load complete segments can get them from viewers at the live
  edge (ADR 0002, option B).
- Prometheus gauges for the tracker's event-loop delay
  (`openstreamgrid_event_loop_delay_{p50,p90,p99,max}_seconds`) since the
  previous scrape. The capacity benchmark reports them and gains `--churn`.
- `OpenStreamGridHlsPlugin.hlsJsConfig()` hands out the grid's loader as
  hls.js configuration for players that create hls.js themselves, such as
  Video.js 10's `<hlsjs-video>` (`source.engine.hlsJs`); `attach()` then only
  tracks the created instance for playback deadlines. The browser E2E covers
  Video.js 10.
- `origin/dist/sidecars.js` writes the `.sha256` sidecars peers verify
  against for HLS output from any packager, so OpenStreamGrid works with an
  existing origin. It hashes segments once a playlist lists them and prunes
  sidecars of deleted segments.
- Prometheus metrics for WebSocket signaling: messages and bytes sent, and
  subscribers by inventory delivery mode, with matching Grafana panels.
- WebSocket `neighbor_view` subscribe feature (with `inventory_batch`): each
  client sees a bounded, mostly mutual set of neighbors
  (`TRACKER_NEIGHBOR_VIEW_SIZE`, default 64) and receives peer and inventory
  updates only for them, so inventory traffic grows linearly with the audience
  instead of with its square. Neighbors that leave are replaced, and newcomers
  are linked into full views. The SDK and the Node peer declare it. One
  tracker serves 4000 peers in one broadcast at under half a core.
- The Hls.js plugin sends LL-HLS partial segments (`EXT-X-PART`) straight to
  the origin and shares only complete segments, instead of attempting P2P and
  an integrity sidecar that parts do not have.
- WebSocket `inventory_batch` subscribe feature: the tracker merges segment
  inventory updates per peer and sends them every 250 ms as one
  `segment_inventory_batch`, instead of sending each report to every peer. The
  SDK and the Node peer declare it; clients that do not keep receiving every
  report as before. In the capacity benchmark one tracker serves 2000 peers in
  one broadcast at a third of a core, where legacy clients saturate it at 1000.
- `npm run benchmark:tracker-capacity` measures one tracker's control-plane
  capacity; results are in `docs/tracker-capacity.md`.
- `TRACKER_WS_MAX_CONNECTIONS_PER_IP` (default 20) for viewers sharing one NAT
  address, and `TRUST_PROXY_HOPS` to take the client address from
  `X-Forwarded-For` behind trusted proxies. Helm `tracker.trustProxyHops`
  defaults to 1 when the chart's ingress is enabled, and
  `networkPolicy.trackerIngressFrom` can restrict the tracker to the ingress
  controller and the origin.
- `OpenStreamGridShakaPlugin` brings the same delivery core to Shaka Player
  through an HTTP(S) scheme plugin, with deadlines derived from Shaka's request
  timeouts. The browser E2E covers it.
- Helm `tracker.priorityClassName` and a documented tracker recovery profile.
  In local Docker Compose measurements with SQLite, the tracker was healthy again
  within 0.5 s of a restart and a browser viewer reconnected in about 1 s without
  interrupting playback; Kubernetes rescheduling takes longer (see the
  Kubernetes guide's *Recovery* section).
- CMAF/fMP4 HLS: `HLS_SEGMENT_TYPE=fmp4` makes the origin emit `.m4s` media
  segments with an immutable per-rendition init segment and SHA-256
  sidecars; Node peers and the browser SDK share `.m4s` segments, while init
  segments load from the origin. The browser E2E runs for both formats.
- `sdk-publish.yml` publishes `@openstreamgrid/sdk` to npm with provenance
  when a GitHub release is published (opt-in via the `SDK_NPM_PUBLISH`
  repository variable). The SDK package now has repository metadata and a
  README for its npm page.
- The tracker can issue short-lived TURN credentials (`TURN_URLS`,
  `TURN_SHARED_SECRET`, coturn `use-auth-secret` format) with each peer
  session; the browser SDK adds them to its ICE servers and renews them with
  the session, so viewer code no longer needs static TURN passwords. Node peers
  use the issued credentials too, alongside any `TURN_SERVER` they configure.
- Browser E2E test (Playwright): two real Chromium viewers play the Compose
  stream through the Hls.js plugin and must exchange a verified segment over
  WebRTC. It runs in CI for SDK, tracker, and origin changes.
- Browser SDK `peer_failed` events report why a peer attempt failed (HTTP
  status, WebRTC error, timeout, or integrity); WebRTC errors keep their
  underlying message. API_REFERENCE documents all SDK events.
- Helm `tracker.extraEnv` and `origin.extraEnv` pass additional environment
  variables (including `valueFrom`) to the containers, so settings such as
  `TRACKER_WS_ALLOWED_ORIGINS` and rate limits are configurable in Kubernetes.
- Grafana dashboard (`helm/openstreamgrid/dashboards/openstreamgrid.json`) for
  delivery, reliability, and tracker API metrics, shipped optionally as a
  sidecar ConfigMap (`grafanaDashboard.enabled`).
- Optional Prometheus Operator `ServiceMonitor` for the tracker
  (`tracker.metrics.serviceMonitor.enabled`).
- Admin endpoints, including `/metrics`, also accept the tracker API key as
  `Authorization: Bearer <key>` so Prometheus can scrape them.

### Changed

- The browser SDK and the Node peer jitter their tracker reconnect backoff
  (each delay is uniform between half and all of the backoff step), so an
  audience that loses the tracker at once, as in a tracker restart, does not
  reconnect in lockstep.
- Dashboard SSE snapshots include peer segment lists only for the 24 peers
  per broadcast that the mesh view draws, which removes most of the stream's
  size in large audiences.
- SQLite heartbeats, stats reports, and segment reports share one commit per
  event-loop turn (each still in its own savepoint), cutting tracker CPU at
  4000 peers by about 10%. A crash can lose the current turn's writes.
- SQLite heartbeats, stats reports, and segment deltas look up the peer row
  once instead of loading the peer and its segments up to three times, which
  saves a few points of tracker CPU at 4000 peers.
- Inventory flushes for neighbor-view clients are spread over event-loop turns
  (256 viewers per turn), so they no longer block REST requests for tens of
  milliseconds. At 4000 peers, REST p95 latency dropped from 60–200 ms to
  about 40 ms.
- With neighbor views enabled, REST peer listings
  (`GET /api/v1/broadcasts/:id/peers` and `GET /api/v1/broadcasts/:id`) show a
  peer-session caller only itself and its neighbors, so a viewer can no longer
  list the whole audience's addresses. Administrators still see everyone.
- The tracker no longer sends `stats_update` to every peer on each stats
  report (the SDK and Node peer ignored it; the dashboard uses SSE). At 500
  peers in one broadcast, REST p95 latency dropped from about 1 s to 7 ms.
- WebSocket fan-out serializes each message once and only visits the
  broadcast's own subscribers.
- WebSocket upgrades, `subscribe`, and peer rejoins look up one peer instead
  of listing the whole audience, so connecting thousands of peers no longer
  slows down quadratically.
- Deleting a broadcast, or letting an origin lease expire, closes its
  WebSocket subscribers with code `4004` and drops pending inventory updates,
  so a new broadcast that reuses the ID starts clean.

### Fixed

- Node peers advertise their rendition directory on join (`rendition`
  metadata) and skip peers on another rendition. Renditions often share segment
  file names, so Node peers following different renditions fetched each
  other's segments, failed verification, and reported each other to the
  tracker.
- The Node peer gives up on a segment after three failed attempts instead of
  downloading it from the origin again on every playlist poll, which a
  missing sidecar caused indefinitely. It logs `segment_skipped`.
- When an origin segment's SHA-256 sidecar cannot be fetched, the SDK plays the
  origin bytes and emits `integrity_skipped` instead of failing the load, and
  never caches or shares them. Shaka Player in `lowLatencyMode` requests LL-HLS
  parts as segments, which have no sidecar, and such loads failed repeatedly.
  A sidecar that does not match still fails the load.
- The stale-peer sweep no longer lists every peer (with segments) twice every
  sweep to find the removed ones, and SQLite segment lookups (`?segment=`) load
  the matching peers' segments in one query instead of one per peer.
- The dashboard's peer table shows the top 200 peers by P2P upload, with a
  note when there are more, instead of rebuilding a row for every peer on each
  update.
- The load-test image (used by `scripts/benchmark.sh`) now contains the
  benchmark helper it imports; it failed at startup since 0.6.0. CI starts the
  image to catch this. The load test also negotiates inventory batching and
  neighbor views like the SDK, and applies full-list, delta, and batched
  inventory updates correctly instead of merging everything.
- An open monitoring dashboard no longer overloads the tracker: event-driven
  SSE snapshots, which list every peer, are coalesced to at most one per
  second. At 1000 peers, REST p95 latency with a dashboard open dropped from
  3.9 s to 29 ms.
- Behind a TLS proxy or Kubernetes ingress, all viewers shared the proxy's
  address, so the per-client REST rate limit and the 20-connection WebSocket
  limit applied to the whole audience. With `TRUST_PROXY_HOPS` set, limits
  apply per viewer.
- The browser SDK stops waiting for peers when a known playback deadline
  would otherwise be missed and fetches the segment from the origin in time;
  previously a slow peer transfer could run past the deadline.
- README SDK examples set `originBaseUrl` to `/hls` instead of `/hls/low`;
  with the master playlist, segment verification rejected the medium and
  high renditions.
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
