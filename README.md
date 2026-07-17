# OpenStreamGrid

Universal hybrid P2P-CDN live streaming middleware.

OpenStreamGrid is an independent **P2P video delivery middleware** that integrates with existing live streaming systems. Clients watching the same live broadcast share received video segments with each other, reducing the network traffic burden on the central Origin server and CDN. If P2P delivery is unavailable or delayed, the client automatically falls back to the Origin server.

> **Core philosophy:** OpenStreamGrid is NOT a complete live streaming platform. It provides APIs and SDKs that streaming services can use to add P2P delivery to their existing HLS-based infrastructure.

---

## Architecture

```
[FFmpeg] ── HLS encode ──► [Origin Server] ── HTTP ──► [HLS Player]
                                 │
                           register broadcast
                                 │
                                 ▼
                          [Tracker Server]
                          /              \
                    WebSocket            REST API
                    signaling            peer discovery
                    ─────┬─────       ─────┬──────
                         │                  │
                         ▼                  ▼
                    [Peer A] ◄── HTTP P2P ──► [Peer B]
                         │                    │
                    Hls.js plugin        Hls.js plugin
                    (browser SDK)        (browser SDK)
                         │                    │
                    origin fallback      origin fallback
                         │                    │
                    [Origin Server]     [Origin Server]
```

---

## Features

### Core
- **HLS-based live streaming** with FFmpeg-encoded test pattern
- **P2P segment sharing** between peers over HTTP
- **Origin fallback** — seamless fallback to origin when P2P is unavailable
- **WebSocket real-time signaling** for peer join/leave and segment availability
- **Quality-based dynamic peer selection** — scores peers by latency (30%), success rate (30%), upload bandwidth (20%), and trust score (20%)

### Performance
- **Parallel segment download** — request different segments from different peers simultaneously (configurable, default: 3)
- **Configurable resource limits** — upload speed (token bucket), concurrent connections, cache size
- **Segment hash verification** — SHA-256 integrity checking on every downloaded segment
- **Trust scoring** — peers with integrity failures are excluded

### Browser SDK
- **Hls.js plugin** — intercepts Hls.js segment loading, routes through P2P grid
- **WebSocket client** — real-time tracker communication from the browser
- **Browser-compatible build** — ESM + CJS via esbuild (no Node builtins)

### Multi-quality ABR
- Origin generates 3 quality levels (low / med / high) from FFmpeg
- Variant playlist with 3 renditions
- Client selects quality based on buffer health and network speed

### Monitoring
- **Real-time dashboard** — served by tracker, shows active broadcasts, peer counts, P2P vs Origin traffic chart
- **Server-Sent Events** — stats push for live updates
- **Per-peer statistics** — uploaded/downloaded bytes, success rate, trust score
- **Persistent tracker state** — SQLite with WAL mode, versioned migrations, and historical stats rollups

### Deployment
- **Docker Compose** — single-command multi-peer test setup
- **Health checks** on all services

---

## Quick Start

```bash
git clone https://github.com/mytrashcan/OpenStreamGrid
cd OpenStreamGrid
docker compose up --build
```

Then open:
- **HLS stream:** http://localhost:8080/hls/stream.m3u8
- **Monitoring dashboard:** http://localhost:7070/dashboard
- **Tracker API:** http://localhost:7070/health

The Docker Compose stack starts a tracker, origin server, and two peer instances (peer-a and peer-b). Peers automatically discover each other through the tracker and share HLS segments.

### Run the MVP test

```bash
./test/docker-test.sh
```

The test builds all images, waits for service health, confirms a peer-to-peer segment transfer, forces a stale peer failure, and confirms the origin fallback in tracker statistics. Set `KEEP_RUNNING=1` to leave the stack running after the test.

### Service endpoints

| Service | URL |
|---------|-----|
| Tracker | `http://localhost:7070` |
| Origin HLS | `http://localhost:8080/hls/stream.m3u8` |
| Peer A | `http://localhost:9091` |
| Peer B | `http://localhost:9092` |

---

## Project Structure

```
OpenStreamGrid/
├── package.json                          # Root workspace config (npm workspaces)
├── tsconfig.base.json                    # Shared TypeScript config
├── docker-compose.yml                    # Multi-service Docker setup
├── .gitignore
├── AGENTS.md                             # Implementation guide
├── README.md                             # This file
│
├── common/                               # Shared types & interfaces
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       └── index.ts                      # All shared TypeScript types
│
├── tracker/                              # Tracker & control server
│   ├── package.json
│   ├── Dockerfile
│   ├── tsconfig.json / tsconfig.test.json
│   ├── scripts/
│   │   └── copy-dashboard.mjs
│   ├── src/
│   │   ├── server.ts                     # REST API handler + SSE stats
│   │   ├── store.ts                      # In-memory broadcast/peer state
│   │   ├── websocket.ts                  # WebSocket signaling hub
│   │   └── dashboard.html                # Monitoring dashboard UI
│   └── test/
│       ├── server.test.ts
│       └── store.test.ts
│
├── origin/                               # Origin streaming server
│   ├── package.json
│   ├── Dockerfile
│   ├── tsconfig.json / tsconfig.test.json
│   ├── src/
│   │   ├── server.ts                     # HLS file server + broadcast registration
│   │   └── streamer.ts                   # FFmpeg subprocess manager
│   └── test/
│       └── server.test.ts
│
├── peer/                                 # Node.js peer client (CLI)
│   ├── package.json
│   ├── Dockerfile
│   ├── tsconfig.json / tsconfig.test.json
│   ├── src/
│   │   ├── client.ts                     # CLI entry point + PeerApplication
│   │   ├── tracker.ts                    # Tracker REST/WS client
│   │   ├── fetcher.ts                    # Hybrid segment fetcher (P2P + origin)
│   │   ├── uploader.ts                   # HTTP upload server for peers
│   │   ├── cache.ts                      # LRU segment cache
│   │   ├── verifier.ts                   # SHA-256 hash verification
│   │   └── stats.ts                      # Traffic statistics
│   └── test/
│       ├── client.test.ts
│       ├── cache.test.ts
│       ├── fetcher.test.ts
│       ├── tracker.test.ts
│       └── verifier.test.ts
│
├── sdk/                                  # Browser SDK (Hls.js plugin)
│   ├── package.json                      # @openstreamgrid/sdk
│   ├── tsconfig.json
│   ├── scripts/
│   │   └── build.mjs                     # esbuild-based bundler
│   ├── src/
│   │   ├── index.ts                      # Public API exports
│   │   ├── hls-plugin.ts                 # Hls.js loader plugin
│   │   ├── ws-client.ts                  # Browser WebSocket client
│   │   ├── cache.ts                      # Browser-compatible LRU cache
│   │   ├── verifier.ts                   # Browser SHA-256 (SubtleCrypto)
│   │   └── types.ts                      # SDK-specific types
│   └── dist/                             # Built output (ESM + CJS)
│
└── test/
    └── docker-test.sh                    # Integration test script
```

---

## API Reference

### Tracker REST API

All endpoints are served from the tracker on port `7070`.

#### Health

```
GET /health
```

Response: `{ "status": "ok", "service": "tracker" }`

#### Broadcasts

```
POST /api/v1/broadcasts
```

Register a new broadcast. Body:
```json
{
  "id": "live",
  "playlistUrl": "http://origin:8080/hls/stream.m3u8",
  "metadata": { "protocol": "hls", "source": "test-pattern" }
}
```

---

```
GET /api/v1/broadcasts
```

List all broadcasts.

---

```
GET /api/v1/broadcasts/:id
```

Get broadcast details and peer list.

---

```
DELETE /api/v1/broadcasts/:id
```

Unregister a broadcast.

#### Peers

```
POST /api/v1/broadcasts/:id/peers
```

Join a broadcast. Body:
```json
{
  "id": "peer-a",
  "address": "http://peer-a:9090",
  "uploadBandwidthBps": 4000000
}
```

---

```
DELETE /api/v1/broadcasts/:id/peers/:peerId
```

Leave a broadcast.

---

```
GET /api/v1/broadcasts/:id/peers[?segment=<name>]
```

Get peer list for a broadcast. Optional `segment` query parameter filters peers that possess a specific segment.

---

```
POST /api/v1/broadcasts/:id/peers/:peerId/segments
```

Report segments possessed by a peer. Body:
```json
{
  "segments": ["segment1.ts", "segment2.ts"],
  "replace": false
}
```

---

```
PUT /api/v1/broadcasts/:id/peers/:peerId/heartbeat
```

Send peer heartbeat. Body:
```json
{
  "latencyMs": 50,
  "uploadBandwidthBps": 4000000,
  "successRate": 0.95
}
```

---

```
POST /api/v1/broadcasts/:id/peers/:peerId/stats
```

Report traffic statistics. Body:
```json
{
  "stats": {
    "bytesDownloadedP2P": 1000000,
    "bytesDownloadedOrigin": 500000,
    "bytesUploadedP2P": 800000,
    "p2pRequests": 42,
    "p2pSuccesses": 40,
    "p2pFailures": 2,
    "originRequests": 10,
    "integrityFailures": 0,
    "fallbacks": 2,
    "segmentsCached": 30
  }
}
```

---

```
POST /api/v1/broadcasts/:id/peers/:peerId/reports
```

Report a peer failure. Body:
```json
{
  "reporterId": "peer-b",
  "reason": "timeout"
}
```

Reasons: `connection`, `timeout`, `integrity`, `http`

#### Stats

```
GET /api/v1/stats
```

Global statistics across all broadcasts.

---

```
GET /api/v1/broadcasts/:id/stats
```

Per-broadcast statistics.

---

```
GET /api/v1/stats/events
```

Server-Sent Events stream for real-time stats updates.

### Tracker WebSocket API

Connect to `ws://<tracker>:7070/ws`.

#### Client → Server Messages

```json
{ "type": "subscribe",           "broadcastId": "live", "peerId": "peer-a" }
{ "type": "heartbeat",           "broadcastId": "live", "peerId": "peer-a", "latencyMs": 50 }
{ "type": "report_segments",     "broadcastId": "live", "peerId": "peer-a", "segments": ["seg1.ts"] }
{ "type": "report_stats",        "broadcastId": "live", "peerId": "peer-a", "stats": { ... } }
```

#### Server → Client Messages

```json
{ "type": "peer_joined",       "broadcastId": "live", "peer": { ... } }
{ "type": "peer_left",         "broadcastId": "live", "peerId": "peer-b" }
{ "type": "segment_available", "broadcastId": "live", "peerId": "peer-a", "segments": ["seg1.ts"] }
{ "type": "stats_update",      "broadcastId": "live", "peerId": "peer-a", "stats": { ... } }
{ "type": "peer_list",         "broadcastId": "live", "peers": [...] }
```

### Browser SDK

```typescript
import { OpenStreamGridHlsPlugin } from "@openstreamgrid/sdk";
import Hls from "hls.js";

const plugin = new OpenStreamGridHlsPlugin({
  trackerUrl: "ws://localhost:7070/ws",
  broadcastId: "live",
  peerId: "browser-client-1",
  originBaseUrl: "http://localhost:8080/hls",
});

const hls = new Hls();
plugin.attach(hls);
hls.loadSource("http://localhost:8080/hls/stream.m3u8");
hls.attachMedia(videoElement);
```

---

## Configuration

### Tracker

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `7070` | HTTP server port |
| `HOST` | `0.0.0.0` | HTTP server bind host |
| `STALE_PEER_MS` | `30000` | Milliseconds before a peer is considered stale |
| `STORE_TYPE` | `sqlite` | Tracker store backend (`sqlite` or `memory`) |
| `DB_PATH` | `./data/tracker.db` | SQLite database path when `STORE_TYPE=sqlite` |

### Origin

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `8080` | HTTP server port |
| `HOST` | `0.0.0.0` | HTTP server bind host |
| `TRACKER_URL` | `http://tracker:7070` | Tracker endpoint |
| `BROADCAST_ID` | `live` | Broadcast identifier |
| `PUBLIC_ORIGIN_URL` | `http://origin:8080` | Public origin URL for playlist |
| `HLS_DIRECTORY` | `/tmp/openstreamgrid-hls` | HLS output directory |
| `FFMPEG_PATH` | `ffmpeg` | Path to FFmpeg binary |
| `SEGMENT_DURATION_SECONDS` | `2` | HLS segment duration in seconds |
| `PLAYLIST_SIZE` | `8` | Segments retained in each media playlist |
| `HASH_INTERVAL_MS` | `250` | Interval for generating segment hashes |

### Peer

| Environment Variable / CLI Flag | Default | Description |
|-------------------------------|---------|-------------|
| `TRACKER_URL` / `--tracker-url` | `http://tracker:7070` | Tracker endpoint |
| `BROADCAST_ID` / `--broadcast-id` | `live` | Broadcast to join |
| `ORIGIN_URL` / `--origin-url` | — | Origin HLS URL (required) |
| `PEER_ADDRESS` / `--peer-address` | — | Peer's own HTTP address (required) |
| `PEER_ID` / `--peer-id` | Hostname | Unique peer identifier |
| `CACHE_SIZE` / `--cache-size` | `200MB` | LRU cache size limit |
| `MAX_UPLOAD_SPEED` / `--max-upload-speed` | `1Mbps` | Token bucket upload cap |
| `MAX_CONNECTIONS` / `--max-connections` | `3` | Max concurrent P2P uploads |
| `MAX_PARALLEL_DOWNLOADS` / `--parallel-downloads` | `3` | Max parallel segment downloads |
| `PLAYLIST_POLL_MS` | `500` | Poll interval for HLS playlist |
| `P2P_TIMEOUT_MS` | `2000` | Timeout for peer segment requests |
| `UPLOAD_HOST` | `0.0.0.0` | Peer upload server bind host |
| `WEBRTC_ENABLED` / `--webrtc-enabled` | `true` | Enable WebRTC with HTTP fallback |
| `STUN_SERVER` | `stun:stun.l.google.com:19302` | STUN or STUNS URL used to discover public peer addresses |
| `TURN_SERVER` | — | Optional TURN or TURNS relay URL for restrictive NATs and firewalls |
| `TURN_USERNAME` | — | Optional username for the configured TURN server |
| `TURN_CREDENTIAL` | — | Optional credential for the configured TURN server |

`STUN_SERVER` and `TURN_SERVER` are validated when the peer starts. TURN
credentials require `TURN_SERVER`; supplying credentials without a TURN URL is
rejected. When ICE negotiation or WebRTC segment delivery fails, the transport
manager automatically retries the same peer over HTTP using the existing
fallback path.

For example, configure an authenticated TLS TURN relay before starting the
Compose stack:

```bash
export TURN_SERVER='turns:turn.example.com:5349?transport=tcp'
export TURN_USERNAME='openstreamgrid'
export TURN_CREDENTIAL='replace-with-a-secret'
docker compose up --build
```

---

## Development

### Prerequisites

- **Node.js** 22 or newer
- **npm** 10+
- **FFmpeg** (for origin server)
- **Docker** with Compose (for integration tests)

### Setup

```bash
npm install
npm install --prefix sdk
npm run build
```

### Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Build all workspaces |
| `npm run test` | Run all workspace tests |
| `npm run typecheck` | TypeScript type checking (no emit) |

### Adding a new workspace

1. Create the directory with `package.json`, `tsconfig.json` (extending `../tsconfig.base.json`), and `src/`
2. Add the workspace name to the root `package.json` `"workspaces"` array
3. Run `npm install` from the project root

### Peer CLI usage

```bash
node peer/dist/client.js \
  --tracker-url http://localhost:7070 \
  --broadcast-id live \
  --origin-url http://localhost:8080/hls \
  --peer-address http://localhost:9090 \
  --cache-size 200MB \
  --max-upload-speed 1Mbps \
  --max-connections 3
```

### Linting

```bash
npx eslint .
```

---

## License

GPL-3.0 © [mytrashcan](https://github.com/mytrashcan)
