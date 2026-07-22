# OpenStreamGrid 0.5.0 Release Notes

OpenStreamGrid 0.5.0 hardens the peer-assisted MPEG-TS HLS middleware for
controlled production evaluation. Peer identity now uses signed, short-lived
sessions, peer uploads are authenticated, and untrusted network inputs have
explicit quotas and size limits. Origin and tracker lifecycles recover and
expire state predictably while origin fallback remains available throughout
playback.

## Highlights

- Replaced browser-visible administrator credentials with signed,
  identity-scoped peer sessions that expire automatically.
- Authenticated HTTP and WebRTC peer transfers and added bounded REST,
  WebSocket, signaling, segment, and failure-report inputs.
- Added upload concurrency and bandwidth enforcement, request coalescing,
  deadline-aware fallback, and bounded transport buffers.
- Added origin restart backoff, immutable segment names, streaming SHA-256
  sidecars, broadcast leases, and graceful registration cleanup.
- Added transactional SQLite schema migrations, stronger constraints,
  incremental segment updates, and retained statistics rollups.
- Corrected browser integrity accounting and urgent-segment routing while
  preserving browser-to-browser WebRTC and HTTP Node-peer interoperability.
- Aligned all packages and the Helm chart at 0.5.0, made SQLite single-replica
  defaults explicit, and wired deployment credentials through Kubernetes
  Secrets.

## Upgrade notes

- Configure a stable, random `PEER_SESSION_SECRET` of at least 32 bytes. Do not
  reuse `TRACKER_API_KEY`; changing the session secret invalidates active peer
  sessions.
- Peer join responses now include `sessionToken` and `expiresAt`. Peer REST
  calls use `Authorization: Bearer <token>`, and WebSocket upgrades use
  `?sessionToken=<token>`.
- Create the Kubernetes Secret referenced by
  `tracker.auth.existingSecret` before installing the Helm chart.
- Keep the SQLite tracker at one replica unless a shared external store is
  introduced.
- This release supports MPEG-TS HLS. LL-HLS and CMAF/fMP4 remain roadmap items.
- Browser peer participation remains enabled by default. Set
  `peerParticipation: false` for receive-only playback, and provide HTTPS, WSS,
  and authenticated TURN for internet-facing deployments.

## Validation

- Build, strict TypeScript checks, ESLint, and all 108 automated tests pass on
  Node.js 22, including real HTTP, WebSocket, and WebRTC transfer tests.
- Production and SDK dependency audits report zero vulnerabilities.
- The `@openstreamgrid/sdk` package dry run contains only the compiled ESM,
  CommonJS, declaration, and package metadata files.

---

## OpenStreamGrid 0.2.0 Release Notes

OpenStreamGrid 0.2.0 delivers the complete four-phase prototype for adding
hybrid P2P-CDN delivery to an existing HLS live-streaming service. It is
middleware rather than a full streaming platform: the origin produces standard
HLS, the tracker coordinates peers, and clients retrieve verified segments from
peers with an automatic origin fallback.

## Architecture overview

```text
FFmpeg -> HLS Origin -------------------------------> Player
              |                                        ^
              | register broadcast                     |
              v                                        | origin fallback
        Tracker and Control Server                     |
          | REST / WebSocket / SSE                      |
          |                                             |
          +------> Peer A <--- HTTP or WebRTC ---> Peer B
                     ^                              ^
                     | Hls.js / Node clients        |
                     +---- verified segment cache --+
```

- **Origin server:** generates low, medium, and high HLS renditions, serves
  playlists and segments, and publishes SHA-256 sidecars.
- **Tracker:** manages broadcasts, peers, segment availability, WebSocket
  signaling, live statistics, trust signals, and persistent SQLite state.
- **Node peer:** caches and uploads segments within configured bandwidth and
  concurrency limits, ranks download sources, and falls back to origin.
- **Browser SDK:** integrates with Hls.js and provides browser-compatible
  caching, signaling, integrity verification, and hybrid fetching.
- **Operations:** Docker Compose supports local multi-peer validation; Helm and
  Kustomize support Kubernetes deployment; the dashboard exposes live metrics.

## Features implemented

- Standard HLS delivery with three adaptive-bitrate renditions.
- HTTP and WebRTC DataChannel P2P transports with automatic origin fallback.
- Real-time WebSocket discovery and signaling plus Server-Sent Events metrics.
- Quality-based peer ranking using latency, success rate, bandwidth, and trust.
- Parallel downloads, request coalescing, LRU caching, and SHA-256 verification.
- Upload bandwidth and concurrent connection limits.
- SQLite persistence with WAL mode, migrations, recovery, and statistics history.
- Browser SDK builds for ESM and CommonJS with an Hls.js loader plugin.
- Monitoring dashboard, structured statistics, virtual-peer load tests, and
  reproducible JSON benchmarks.
- Docker Compose, health checks, CI, Helm, Kustomize, ingress, autoscaling,
  persistent volumes, and network policies.
- End-to-end coverage for HLS generation, peer exchange, transport fallback,
  churn, and tracker restart persistence.

## Quick start

Prerequisites are Docker with Compose. For local development, use Node.js 22 or
newer, npm 10 or newer, and FFmpeg.

```bash
git clone https://github.com/mytrashcan/OpenStreamGrid.git
cd OpenStreamGrid
docker compose up --build
```

After the services become healthy:

- HLS master playlist: <http://localhost:8080/hls/stream.m3u8>
- Monitoring dashboard: <http://localhost:7070/dashboard>
- Tracker health endpoint: <http://localhost:7070/health>
- Peer A health endpoint: <http://localhost:9091/health>
- Peer B health endpoint: <http://localhost:9092/health>

Run the automated local validation with:

```bash
npm install
npm install --prefix sdk
npm run build
npm run typecheck
npm test
```

## Docker usage guide

Start the tracker, origin, and two peers in the foreground:

```bash
docker compose up --build
```

Start them in the background and inspect health:

```bash
docker compose up --build --detach tracker origin peer-a peer-b
docker compose ps
```

Run the lightweight health and MVP checks:

```bash
npm run test:docker-health
./test/docker-test.sh
```

Run the comprehensive Phase 4 end-to-end suite, which uses and removes an
isolated Compose project:

```bash
./scripts/e2e-test.sh
```

Run a reproducible ten-peer benchmark and write `benchmark-results.json`:

```bash
PEER_COUNT=10 DURATION_SECONDS=60 ./scripts/benchmark.sh
```

Stop the default stack and remove its containers and network:

```bash
docker compose down
```

Add `--volumes` only when the persisted tracker database should also be removed.

## Documentation

- [Project overview, API, configuration, and development guide](README.md)
- [Kubernetes deployment guide](deploy/k8s/README.md)
- [Helm chart configuration](helm/openstreamgrid/values.yaml)
- [Docker Compose stack](docker-compose.yml)
- [Phase 4 end-to-end test](scripts/e2e-test.sh)
- [Benchmark runner](scripts/benchmark.sh)
- [Browser SDK example](sdk/examples/basic.html)
- [Release history](CHANGELOG.md)
