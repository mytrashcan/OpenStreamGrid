# OpenStreamGrid

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/mytrashcan/OpenStreamGrid)](https://github.com/mytrashcan/OpenStreamGrid/releases/latest)
[![CI](https://github.com/mytrashcan/OpenStreamGrid/actions/workflows/ci.yml/badge.svg)](https://github.com/mytrashcan/OpenStreamGrid/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-green.svg)](package.json)
[![Docker images](https://github.com/mytrashcan/OpenStreamGrid/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/mytrashcan/OpenStreamGrid/actions/workflows/docker-publish.yml)

Universal hybrid P2P-CDN middleware for standards-based live streaming.

[English](README.md) | [한국어](README.ko.md)

OpenStreamGrid adds peer-assisted segment delivery to an existing HLS, LL-HLS,
or CMAF service. Your origin continues to encode and publish media while
OpenStreamGrid discovers peers, verifies segments, limits resource use, reports
delivery metrics, and immediately falls back to the origin when P2P cannot meet
the playback deadline.

> OpenStreamGrid is delivery middleware, not a complete streaming platform. It
> integrates with your existing origin, CDN, and player stack.

## Quick Start

With [Docker Compose v2](https://docs.docker.com/compose/) installed, start the
tracker, test origin, and two peers with one command:

```bash
git clone --branch v0.4.1 --depth 1 https://github.com/mytrashcan/OpenStreamGrid.git
cd OpenStreamGrid
docker compose up --build --detach
docker compose ps
```

| Service | Local URL |
| --- | --- |
| Monitoring dashboard | <http://localhost:7070/dashboard> |
| Tracker health | <http://localhost:7070/health> |
| Master HLS playlist | <http://localhost:8080/hls/stream.m3u8> |
| Peer A / Peer B | <http://localhost:9091> / <http://localhost:9092> |

The Compose stack generates a live test pattern with FFmpeg. Once healthy, the
peers begin exchanging verified segments and fall back to the origin whenever a
peer is unavailable or too slow. Stop the stack with `docker compose down`.

## Current Release

[OpenStreamGrid v0.4.1](https://github.com/mytrashcan/OpenStreamGrid/releases/tag/v0.4.1)
is the current stable release. It enforces `TRACKER_API_KEY` across protected
tracker REST operations, statistics, dashboard access, and WebSocket upgrades.
It also includes the v0.4.0 zero-install browser peer path and its CORS and
bandwidth-aware WebRTC transfer fixes. See the [changelog](CHANGELOG.md) for the
complete history.

Tagged container images are published to GHCR for production deployment:

| Component | Image |
| --- | --- |
| Tracker | `ghcr.io/mytrashcan/openstreamgrid-tracker:v0.4.1` |
| Origin | `ghcr.io/mytrashcan/openstreamgrid-origin:v0.4.1` |
| Node peer | `ghcr.io/mytrashcan/openstreamgrid-peer:v0.4.1` |

Use immutable version tags in deployments; `latest` is provided for evaluation.
The browser SDK package is build- and publish-dry-run verified in CI but is not
yet published to npm. Until the first registry release, consume it from a tagged
source checkout and build it locally:

```bash
npm ci --prefix sdk
npm run build --prefix sdk
```

## Use Cases

- **Live streaming platforms** — reduce origin and CDN segment traffic while
  preserving reliable playback during peer churn.
- **Enterprise webinars and town halls** — distribute simultaneous internal
  viewing load across participating clients.
- **E-learning and virtual classrooms** — share live lecture segments among
  learners without replacing the existing HLS workflow.

The current prototype is best suited to evaluation and controlled deployments.
Review [Security](SECURITY.md) and the [release notes](RELEASE_NOTES.md) before
planning a production rollout.

## Architecture

```text
                         HTTPS / API key
  encoder ──► origin ─────────────────────────► tracker + SQLite WAL
     │          │                                  │  │
     │          ├── HLS renditions                 │  ├── REST + WebSocket
     │          └── SHA-256 sidecars               │  └── dashboard + SSE
     │                                             │
     │                   peer discovery / stats ───┘
     │
     └──────────────────────── CDN / origin fallback
                                      │
                           ┌───────────┴───────────┐
                           ▼                       ▼
                      Node peer A ◄──────────► Node peer B
                           │       HTTP/WebRTC     │
                           │       STUN/TURN       │
                           ▼                       ▼
                      segment cache          segment cache
                           │                       │
                           └──── Hls.js browser SDK┘
```

The tracker isolates state by broadcast ID, so multiple channels can share one
deployment. The origin can generate multiple test channels and three HLS
renditions per channel. Production media origins can register their own
playlist URLs through the same API.

## Features

- Hybrid HTTP/WebRTC segment delivery with immediate origin fallback.
- API-key authentication for tracker REST, WebSocket, dashboard, and SSE access (constant-time comparison with `timingSafeEqual`).
- Native tracker HTTPS and HTTPS-compatible tracker/origin clients.
- Configurable STUN and TURN servers for WebRTC NAT traversal.
- Multi-channel isolation and multi-rendition HLS generation.
- Quality-based peer ranking, parallel downloads, and request coalescing.
- SHA-256 verification, peer trust scoring, and integrity-failure exclusion.
- TTL-aware LRU caching, upload bandwidth limiting, and connection limits.
- Real-time dashboard, Prometheus metrics, SSE updates, and SQLite history.
- Docker Compose, load-test scenarios, Kubernetes/Helm manifests, and CI.

## Zero-install browser peers

The Hls.js SDK turns each viewer into a WebRTC peer automatically. It registers
the viewer, caches verified segments, advertises availability, serves cached
bytes through a rate-limited DataChannel, reports traffic, and unregisters on
detach. Viewers do not install an executable or browser extension.

The following example assumes your bundler resolves the locally built
`@openstreamgrid/sdk` package:

```ts
import Hls from "hls.js";
import { OpenStreamGridHlsPlugin } from "@openstreamgrid/sdk";

const hls = new Hls();
const plugin = new OpenStreamGridHlsPlugin({
  trackerUrl: "https://stream.example.com",
  broadcastId: "live",
  originBaseUrl: "https://stream.example.com/hls/low",
  maxUploadBitrate: 1_000_000,
  maxUploadConnections: 3,
  iceServers: [
    { urls: "stun:stun.example.com:3478" },
    {
      urls: "turns:turn.example.com:5349",
      username: "viewer",
      credential: "short-lived-credential",
    },
  ],
});
plugin.attach(hls);
hls.loadSource("https://stream.example.com/hls/stream.m3u8");
hls.attachMedia(document.querySelector("video")!);
```

Set `peerParticipation: false` for receive-only playback. A native agent or
browser extension can still be useful as an optional dedicated seed in managed
environments, but it is not part of the normal viewer path.

`trackerApiKey` is a deployment-wide credential, not per-viewer authorization.
Supply it when tracker authentication is enabled, but do not hard-code a
long-lived key in a public JavaScript bundle. For public deployments, protect
the tracker behind an authenticated gateway or use another trusted mechanism
that does not expose the shared secret to viewers.

## Tracker API

Tracker resources are under `/api/v1`. When `TRACKER_API_KEY` is set, send
`X-API-Key: <key>` on protected HTTP requests. WebSocket clients can send the
header or pass `?apiKey=<key>`; browsers use the query parameter because the
WebSocket API cannot set arbitrary upgrade headers.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Check tracker readiness |
| `GET` | `/dashboard` | Open the monitoring UI |
| `GET` | `/metrics` | Read Prometheus metrics |
| `GET` | `/ws` | Upgrade to WebSocket signaling |
| `GET` | `/api/v1/stats` | Read global traffic totals |
| `GET` | `/api/v1/stats/events` | Subscribe to monitoring SSE |
| `POST` | `/api/v1/broadcasts` | Register or update a broadcast |
| `GET` | `/api/v1/broadcasts` | List broadcasts |
| `GET` | `/api/v1/broadcasts/:id` | Read broadcast details and peers |
| `DELETE` | `/api/v1/broadcasts/:id` | Unregister a broadcast |
| `GET` | `/api/v1/broadcasts/:id/stats` | Read broadcast traffic totals |
| `POST` | `/api/v1/broadcasts/:id/peers` | Join a broadcast |
| `GET` | `/api/v1/broadcasts/:id/peers` | List peers; filter with `?segment=` |
| `DELETE` | `/api/v1/broadcasts/:id/peers/:peerId` | Leave a broadcast |
| `POST` | `/api/v1/broadcasts/:id/peers/:peerId/segments` | Report cached segments |
| `PUT` | `/api/v1/broadcasts/:id/peers/:peerId/heartbeat` | Refresh peer health |
| `POST` | `/api/v1/broadcasts/:id/peers/:peerId/stats` | Report traffic totals |
| `POST` | `/api/v1/broadcasts/:id/peers/:peerId/reports` | Report a peer failure |

See [API_REFERENCE.md](API_REFERENCE.md) for schemas, signaling messages, status
codes, and origin/peer endpoints.

## Configuration

### Tracker

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `7070` | HTTP/HTTPS listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `STALE_PEER_MS` | `30000` | Peer inactivity timeout |
| `STORE_TYPE` | `sqlite` | Persistence backend: `sqlite` or `memory` |
| `DB_PATH` | `./data/tracker.db` | SQLite database path |
| `TRACKER_API_KEY` | unset | Enable API-key authentication (v0.4.1+: enforced on REST POST/PUT/DELETE, stats, dashboard, and WebSocket upgrade) |
| `TLS_CERT_PATH` | unset | PEM certificate path; requires `TLS_KEY_PATH` |
| `TLS_KEY_PATH` | unset | PEM private-key path; requires `TLS_CERT_PATH` |
| `RATE_LIMIT_RPS` | `100` | Sustained requests per second per client |
| `RATE_LIMIT_BURST` | `200` | Token-bucket burst capacity per client |
| `MAX_PEERS_PER_BROADCAST` | `500` | Active-peer limit per broadcast |

### Origin

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | Origin listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `TRACKER_URL` | `http://tracker:7070` | Tracker base URL |
| `TRACKER_API_KEY` | unset | API key used for tracker registration |
| `BROADCAST_ID` | `live` | Base broadcast/channel ID |
| `MULTI_STREAM_COUNT` | `1` | Generated test-channel count |
| `PUBLIC_ORIGIN_URL` | `http://origin:<PORT>` | URL advertised to clients |
| `HLS_DIRECTORY` | `/tmp/openstreamgrid-hls` | Generated HLS directory |
| `SEGMENT_DURATION_SECONDS` | `2` | HLS target duration |
| `PLAYLIST_SIZE` | `8` | Segments retained per media playlist |
| `HASH_INTERVAL_MS` | `250` | Sidecar hash discovery interval |
| `FFMPEG_PATH` | `ffmpeg` on `PATH` | FFmpeg executable override |

### Node Peer

| Variable | Default | Description |
| --- | --- | --- |
| `TRACKER_URL` | `http://tracker:7070` | Tracker base URL |
| `TRACKER_API_KEY` | unset | Tracker REST/WebSocket API key |
| `BROADCAST_ID` | `live` | Broadcast to join |
| `ORIGIN_URL` | required | Rendition directory or `.m3u8` URL |
| `PEER_ADDRESS` | required | Advertised `http://host:port` address |
| `PEER_ID` | hostname | Stable peer identifier |
| `UPLOAD_HOST` | `0.0.0.0` | Upload server bind address |
| `CACHE_SIZE` | `512MB` | Maximum segment-cache size |
| `CACHE_TTL_MS` | `300000` | Absolute cache-entry lifetime in milliseconds |
| `MAX_UPLOAD_SPEED` | `1Mbps` | Token-bucket upload bit rate |
| `MAX_CONNECTIONS` | `3` | Concurrent peer uploads |
| `MAX_PARALLEL_DOWNLOADS` | `3` | Concurrent segment downloads |
| `PLAYLIST_POLL_MS` | `500` | HLS playlist poll interval |
| `P2P_TIMEOUT_MS` | `2000` | Peer request deadline |
| `WEBRTC_ENABLED` | `true` | Try WebRTC before HTTP |
| `STUN_SERVER` | public Google STUN | `stun:` or `stuns:` ICE server URL |
| `TURN_SERVER` | unset | `turn:` or `turns:` relay URL |
| `TURN_USERNAME` | unset | TURN username |
| `TURN_CREDENTIAL` | unset | TURN credential |

Equivalent CLI flags are available for the primary peer options. Benchmark
configuration is available through the following environment variables.

### Browser SDK

| Option | Default | Description |
| --- | --- | --- |
| `peerParticipation` | `true` | Register and upload as a zero-install browser peer |
| `iceServers` | public Google STUN | STUN/TURN servers for WebRTC NAT traversal |
| `maxUploadBitrate` | `1000000` | Browser upload limit in bits per second |
| `maxUploadConnections` | `3` | Concurrent browser DataChannel uploads |
| `peerTimeoutMs` | `3000` | Peer request and negotiation deadline |
| `maxCacheBytes` | `100 MB` | Browser segment-cache limit |
| `trackerApiKey` | unset | API key for REST peer registration |

### Benchmark

| Variable | Default | Description |
| --- | --- | --- |
| `PEER_COUNT` | `10` | Number of virtual peers |
| `DURATION_SECONDS` | `60` | Measurement duration |
| `RAMP_UP_SECONDS` | `5` | Peer startup ramp |
| `CHURN_RATE` | `0.15` | Per-cycle churn probability |
| `REPORT_INTERVAL_SECONDS` | `10` | Console report interval |
| `BENCHMARK_OUTPUT` | `benchmark-results.json` | JSON output path |
| `BENCHMARK_PROJECT_NAME` | `openstreamgrid-benchmark` | Isolated Compose project name |
| `TRACKER_URL` | `http://127.0.0.1:7070` | Host health-check URL |
| `ORIGIN_URL` | `http://127.0.0.1:8080` | Host health-check URL |

## Performance Baseline

The reproducible local Docker baseline for the default 10-peer, 60-second
scenario achieved 46.07% P2P efficiency and 47.44% CDN traffic reduction. These
figures are regression data, not a production capacity claim. See the raw
[benchmark result](benchmark-results.json) and [release notes](RELEASE_NOTES.md)
for the full scenario and latency measurements. Run it locally with
`bash scripts/benchmark.sh`.

## Development

For local development, install Node.js 22+, npm, Docker Compose v2, and FFmpeg.

```bash
npm ci
npm ci --prefix sdk
npm run build
npm run typecheck
npm test
npm run lint
```

Repository layout: `tracker/` owns discovery, persistence, signaling, and
monitoring; `origin/` owns test HLS generation and serving; `peer/` is the Node
peer; `sdk/` is the browser/Hls.js package; `common/` contains shared contracts;
`test/` and `scripts/` contain integration and load tooling.

> [!TIP]
> **Want to contribute?** Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
> testing expectations, coding guidelines, and pull request requirements.

## Community

[![Discord: coming soon](https://img.shields.io/badge/Discord-coming%20soon-5865F2?logo=discord&logoColor=white)](#community)
[![GitHub stars](https://img.shields.io/github/stars/mytrashcan/OpenStreamGrid?style=social)](https://github.com/mytrashcan/OpenStreamGrid/stargazers)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)

- Ask usage questions and propose ideas in [GitHub Discussions](https://github.com/mytrashcan/OpenStreamGrid/discussions).
- Report reproducible defects through [GitHub Issues](https://github.com/mytrashcan/OpenStreamGrid/issues).
- Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

The Discord community is not open yet. This badge will be linked to the official
server once one is available.

## Star History

> Star history chart coming soon. If OpenStreamGrid is useful to you, consider
> [starring the repository](https://github.com/mytrashcan/OpenStreamGrid).

## Documentation

- [Korean README](README.ko.md)
- [API reference](API_REFERENCE.md)
- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Release notes](RELEASE_NOTES.md)
- [Changelog](CHANGELOG.md)
- [Kubernetes deployment guide](deploy/k8s/README.md)
- [Browser SDK example](sdk/examples/basic.html)

## License

OpenStreamGrid is licensed under the [GNU General Public License v3.0](LICENSE).
