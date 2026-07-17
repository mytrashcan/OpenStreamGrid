# OpenStreamGrid

Universal hybrid P2P-CDN middleware for standards-based live streaming.

OpenStreamGrid adds peer-assisted segment delivery to an existing HLS, LL-HLS,
or CMAF service. It is not a complete streaming platform: the origin continues
to encode and publish media, while OpenStreamGrid discovers peers, verifies
segments, limits resource use, reports delivery metrics, and immediately falls
back to the origin when P2P cannot meet the playback deadline.

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
- API-key authentication for tracker REST, WebSocket, dashboard, and SSE access.
- Native tracker HTTPS with certificate/key configuration; HTTPS tracker and
  origin URLs are supported by clients.
- Configurable STUN and TURN servers for WebRTC NAT traversal.
- Multi-channel broadcast isolation and multi-rendition HLS generation.
- Token-bucket tracker request limiting, per-broadcast peer caps, peer upload
  bandwidth limiting, and concurrent-upload limits.
- SHA-256 verification, peer trust scoring, and exclusion after integrity failures.
- Real-time monitoring dashboard, Server-Sent Events, global/per-broadcast
  traffic totals, and SQLite history.
- Reusable segment `Buffer` pooling, a 512 MB default TTL-aware LRU cache,
  explicit HTTP keep-alive connection pooling, and SQLite WAL tuning.
- Docker Compose, load-test scenarios, Kubernetes/Helm manifests, and CI.

## Quick start

Requirements: Docker with Compose v2. For local development, use Node.js 22+
and FFmpeg.

```bash
git clone https://github.com/mytrashcan/OpenStreamGrid.git
cd OpenStreamGrid
docker compose up --build
```

| Service | Local URL |
| --- | --- |
| Tracker health | `http://localhost:7070/health` |
| Dashboard | `http://localhost:7070/dashboard` |
| Master HLS playlist | `http://localhost:8080/hls/stream.m3u8` |
| Peer A / Peer B | `http://localhost:9091` / `http://localhost:9092` |

Run the deterministic integration test with `bash test/docker-test.sh`. Run the
load benchmark with `bash scripts/benchmark.sh`; its JSON result is written to
`benchmark-results.json` unless `BENCHMARK_OUTPUT` overrides the destination.

## API summary

All tracker resources are under `/api/v1`. When `TRACKER_API_KEY` is set, send
`X-API-Key: <key>` on protected HTTP requests and during the WebSocket upgrade.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Tracker readiness |
| `GET` | `/dashboard` | Monitoring UI |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/ws` | WebSocket signaling upgrade |
| `GET` | `/api/v1/stats` | Global traffic totals |
| `GET` | `/api/v1/stats/events` | Live monitoring SSE stream |
| `POST` | `/api/v1/broadcasts` | Register or update a broadcast |
| `GET` | `/api/v1/broadcasts` | List broadcasts |
| `GET` | `/api/v1/broadcasts/:id` | Broadcast details and peers |
| `DELETE` | `/api/v1/broadcasts/:id` | Unregister a broadcast |
| `GET` | `/api/v1/broadcasts/:id/stats` | Broadcast traffic totals |
| `POST` | `/api/v1/broadcasts/:id/peers` | Join a broadcast |
| `GET` | `/api/v1/broadcasts/:id/peers` | List peers; filter with `?segment=` |
| `DELETE` | `/api/v1/broadcasts/:id/peers/:peerId` | Leave a broadcast |
| `POST` | `/api/v1/broadcasts/:id/peers/:peerId/segments` | Report cached segments |
| `PUT` | `/api/v1/broadcasts/:id/peers/:peerId/heartbeat` | Refresh peer health |
| `POST` | `/api/v1/broadcasts/:id/peers/:peerId/stats` | Report traffic totals |
| `POST` | `/api/v1/broadcasts/:id/peers/:peerId/reports` | Report peer failure |

See [API_REFERENCE.md](API_REFERENCE.md) for request/response schemas, signaling
messages, status codes, and origin/peer endpoints.

## Environment variables

### Tracker

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `7070` | HTTP/HTTPS listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `STALE_PEER_MS` | `30000` | Peer inactivity timeout |
| `STORE_TYPE` | `sqlite` | `sqlite` or `memory` |
| `DB_PATH` | `./data/tracker.db` | SQLite database path |
| `TRACKER_API_KEY` | unset | Enables API-key authentication when set |
| `TLS_CERT_PATH` | unset | PEM certificate path; requires `TLS_KEY_PATH` |
| `TLS_KEY_PATH` | unset | PEM private-key path; requires `TLS_CERT_PATH` |
| `RATE_LIMIT_RPS` | `100` | Sustained requests per second per client |
| `RATE_LIMIT_BURST` | `200` | Token-bucket burst capacity per client |
| `MAX_PEERS_PER_BROADCAST` | `500` | Maximum active peers in one broadcast |

SQLite starts in WAL mode with `synchronous=NORMAL`, a 64 MiB page cache
(`cache_size=-65536`), and a 5-second busy timeout.

### Origin

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | Origin listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `TRACKER_URL` | `http://tracker:7070` | Tracker base URL |
| `TRACKER_API_KEY` | unset | Tracker API key used during registration |
| `BROADCAST_ID` | `live` | Base broadcast/channel ID |
| `MULTI_STREAM_COUNT` | `1` | Number of generated test channels |
| `PUBLIC_ORIGIN_URL` | `http://origin:<PORT>` | URL advertised to clients |
| `HLS_DIRECTORY` | `/tmp/openstreamgrid-hls` | Generated HLS directory |
| `SEGMENT_DURATION_SECONDS` | `2` | HLS target duration |
| `PLAYLIST_SIZE` | `8` | Segments retained in each media playlist |
| `HASH_INTERVAL_MS` | `250` | Sidecar hash discovery interval |
| `FFMPEG_PATH` | `ffmpeg` on `PATH` | Optional FFmpeg executable override |

### Node peer

| Variable | Default | Description |
| --- | --- | --- |
| `TRACKER_URL` | `http://tracker:7070` | Tracker base URL |
| `TRACKER_API_KEY` | unset | Tracker REST/WebSocket API key |
| `BROADCAST_ID` | `live` | Broadcast to join |
| `ORIGIN_URL` | required | Rendition directory or `.m3u8` URL |
| `PEER_ADDRESS` | required | Advertised `http://host:port` address |
| `PEER_ID` | hostname | Stable peer identifier |
| `UPLOAD_HOST` | `0.0.0.0` | Upload server bind address |
| `CACHE_SIZE` | `512MB` | Maximum segment-cache bytes |
| `CACHE_TTL_MS` | `300000` | Absolute entry lifetime in milliseconds |
| `MAX_UPLOAD_SPEED` | `1Mbps` | Token-bucket upload bit rate |
| `MAX_CONNECTIONS` | `3` | Concurrent peer uploads |
| `MAX_PARALLEL_DOWNLOADS` | `3` | Concurrent segment downloads |
| `PLAYLIST_POLL_MS` | `500` | HLS playlist poll interval |
| `P2P_TIMEOUT_MS` | `2000` | Peer request deadline |
| `WEBRTC_ENABLED` | `true` | Try WebRTC before HTTP transport |
| `STUN_SERVER` | public Google STUN | `stun:` or `stuns:` ICE server URL |
| `TURN_SERVER` | unset | `turn:` or `turns:` relay URL |
| `TURN_USERNAME` | unset | TURN username |
| `TURN_CREDENTIAL` | unset | TURN credential |

Equivalent CLI flags exist for tracker URL/API key, broadcast, origin, peer
address/ID, cache size/TTL, upload limits, parallelism, and WebRTC enablement.

### Benchmark

| Variable | Default | Description |
| --- | --- | --- |
| `PEER_COUNT` | `10` | Virtual peers |
| `DURATION_SECONDS` | `60` | Measurement duration |
| `RAMP_UP_SECONDS` | `5` | Peer startup ramp |
| `CHURN_RATE` | `0.15` | Per-cycle churn probability |
| `REPORT_INTERVAL_SECONDS` | `10` | Console report interval |
| `BENCHMARK_OUTPUT` | `benchmark-results.json` | JSON output path |
| `BENCHMARK_PROJECT_NAME` | `openstreamgrid-benchmark` | Isolated Compose project name |
| `TRACKER_URL` | `http://127.0.0.1:7070` | Host health-check URL |
| `ORIGIN_URL` | `http://127.0.0.1:8080` | Host health-check URL |

## Performance baseline

Baseline captured on 2026-07-17 with the default benchmark scenario: 10 virtual
peers, 60 seconds, 5-second ramp-up, low rendition, P2P enabled, and 15% churn.

| Metric | Result |
| --- | ---: |
| P2P efficiency ratio | 46.07% |
| CDN traffic reduction | 47.44% |
| Segment latency p50 / p95 / p99 | 10.02 / 1682.71 / 1776.94 ms |
| P2P / origin download | 104.72 / 116.03 MB |
| Average upload per peer | 13.44 MB |
| Churn events / peer sessions | 7 / 16 |
| Integrity, churn, and segment errors | 0 |

These local Docker results are a reproducible regression baseline, not a
production capacity claim. Network topology, media bitrate, CPU allocation,
TURN use, and churn materially affect the result. The raw measurement is stored
in [benchmark-results.json](benchmark-results.json).

## Development

```bash
npm ci
npm ci --prefix sdk
npm run build
npm run typecheck
npm test
npx eslint .
```

Repository layout: `tracker/` owns discovery, persistence, signaling, and
monitoring; `origin/` owns test HLS generation and serving; `peer/` is the Node
peer; `sdk/` is the browser/Hls.js package; `common/` contains shared contracts;
`test/` and `scripts/` contain integration and load tooling.

See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes and
[SECURITY.md](SECURITY.md) for vulnerability reporting and deployment guidance.

## License

OpenStreamGrid is licensed under the GNU General Public License v3.0. See
[LICENSE](LICENSE).
