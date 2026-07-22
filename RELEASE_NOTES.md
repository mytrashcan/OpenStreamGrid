# OpenStreamGrid 0.5.0 Release Notes

OpenStreamGrid 0.5.0 hardens the peer-assisted HLS prototype for public review.
Peer identity now uses scoped sessions, peer uploads are authenticated, and
untrusted network inputs have explicit quotas and size limits. Origin and
tracker lifecycles recover and expire state predictably.

A page using the Hls.js SDK now registers the viewer with the tracker, advertises
verified cached segments, exchanges those segments over WebRTC DataChannels,
reports traffic, and leaves cleanly when playback ends. Origin fallback remains
active throughout the lifecycle.

## Highlights

- No viewer executable or Chrome extension is required.
- Browser-to-browser uploads use WebRTC DataChannels and tracker-relayed SDP.
- Browser peers use path-qualified segment IDs so adaptive renditions remain
  isolated.
- Uploads default to 1 Mbps and three concurrent connections, both configurable.
- REST registration is retried after transient tracker failures.
- Tracker REST endpoints support browser CORS preflight requests.
- Active DataChannel transfers receive a size- and bandwidth-aware deadline.
- Browser peers continue to consume existing HTTP Node peers.
- The SDK suite includes a real two-peer DataChannel transfer test.

## Upgrade

The browser peer path is enabled by default. Existing applications can opt out
with `peerParticipation: false`. Production deployments should provide HTTPS,
WSS, and a TURN service for restrictive NAT and firewall environments.

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
