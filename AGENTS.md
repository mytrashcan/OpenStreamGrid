# OpenStreamGrid — 범용 라이브 스트리밍 P2P 전송 시스템

You are a senior software engineer implementing a universal hybrid P2P-CDN streaming middleware prototype. All code and documentation should be in English unless otherwise specified.

## Project Goal

Design and implement a universal hybrid P2P-CDN delivery system that can be applied to various live streaming services, not tied to any specific internet broadcasting platform or proprietary protocol.

Clients watching the same live broadcast share received video segments with each other, reducing the network traffic burden on the central Origin server and CDN.

The system adopts a **hybrid delivery structure**: if P2P delivery is unavailable or delayed, the client automatically falls back to the Origin server or CDN.

## Core Direction

OpenStreamGrid is NOT a complete live streaming platform. It focuses on implementing an independent **P2P video delivery middleware** that integrates with existing live streaming systems.

Streaming services use OpenStreamGrid's API or SDK to register broadcasts, and viewing clients receive video data from both CDN and other peers via the SDK.

Standard-based streaming: HLS, Low-Latency HLS, or CMAF.

## System Architecture

### Components

1. **Origin Streaming Server** — receives raw live video, encodes it, generates streaming segments and playlists (HLS/.m3u8 + .ts segments via FFmpeg)
2. **Tracker and Control Server** — manages broadcast sessions and peer states, provides peer list for clients to connect to
3. **Peer Client SDK** — connects to streaming players, fetches segments from CDN or peers, caches received segments, serves to other peers within limits
4. **Peer Transport Layer** — segment transfer between peers (MVP: HTTP, future: WebRTC DataChannel, QUIC)
5. **Monitoring Server** — collects performance data from Tracker and clients, displays dashboard

## MVP Scope

First version implements:

- Test live stream generation (FFmpeg to HLS)
- HLS-based video segment generation
- Single broadcast channel support
- Central Tracker-based peer discovery
- HTTP-based peer-to-peer segment sharing
- Peer segment caching
- P2P request timeout
- Origin fallback on P2P failure
- Client upload speed limiting
- Segment hash verification
- P2P and Origin traffic statistics collection
- Docker-based multi-peer testing

MVP validation is on the same local or Docker network (no complex NAT traversal).

## MVP Success Criteria

- Live video plays normally via Origin server without P2P
- With 2+ peers connected, video segments are transferred between peers
- Peer disconnection doesn't break playback (Origin fallback works)
- Segment integrity verification works
- P2P vs Origin data ratio is measurable
- Upload speed and concurrent connection limits apply correctly
- Origin server transfer volume decreases with multiple peers
- Playback delay and buffering stay within acceptable range with P2P enabled

## Implementation Phases

### Phase 1: Foundation (implement now)
1. **Tracker Server** (Go or Node.js):
   - REST API: register broadcast, join/leave stream, get peer list, report segment possession, report stats
   - In-memory state management per broadcast: active peers, segment ranges, peer metadata (latency, upload bandwidth, success rate)
   - `/api/v1/broadcast/register`, `/api/v1/peer/join`, `/api/v1/peer/leave`, `/api/v1/peer/list`, `/api/v1/peer/segments`, `/api/v1/stats`

2. **Origin Streaming Server** (Node.js or Python):
   - FFmpeg subprocess: generates test HLS stream (sample video or test pattern)
   - HTTP server serving .m3u8 and .ts segments
   - Register with Tracker on startup
   - Health endpoint

3. **Peer Client SDK** (Node.js/TypeScript):
   - HTTP client for fetching segments (from Origin/CDN or other peers)
   - Local segment cache (LRU with size limit)
   - P2P upload server (lightweight HTTP)
   - Segment hash verification (SHA-256)
   - Upload speed limiter (token bucket)
   - Hybrid selector: for each segment, decide P2P vs Origin based on urgency, buffer, peer stats
   - Upload bandwidth / concurrent connection limits
   - Stats reporting to Tracker

4. **Docker Setup**:
   - docker-compose.yml with origin, tracker, and N peer instances
   - Health checks and network isolation

### Phase 1 Non-goals
- No WebRTC/WebSocket yet (plain HTTP)
- No adaptive bitrate
- No NAT traversal
- No browser SDK (CLI/Node-based peer clients first)
- No persistent storage (in-memory)

## Tracker API Design

```
POST   /api/v1/broadcasts              — Register a broadcast
GET    /api/v1/broadcasts              — List broadcasts
GET    /api/v1/broadcasts/:id          — Get broadcast details
DELETE /api/v1/broadcasts/:id          — Unregister broadcast

POST   /api/v1/broadcasts/:id/peers    — Peer joins a broadcast
DELETE /api/v1/broadcasts/:id/peers/:peerId — Peer leaves
GET    /api/v1/broadcasts/:id/peers    — Get peer list for a broadcast

POST   /api/v1/broadcasts/:id/peers/:peerId/segments — Report segments possessed
PUT    /api/v1/broadcasts/:id/peers/:peerId/heartbeat — Peer heartbeat

GET    /api/v1/stats                    — Global stats
GET    /api/v1/broadcasts/:id/stats     — Per-broadcast stats
```

## Peer Segment Selector Logic

For each segment needed:
1. Calculate urgency = segment deadline - current time
2. If urgency < THRESHOLD_URGENT (e.g. 2 segments ahead): use Origin (reliable, fast)
3. Else: query Tracker for peers with this segment
4. Rank peers by: latency, success rate, available bandwidth
5. Try best peer with TIMEOUT (e.g. 2 seconds)
6. On timeout or failure: fall back to Origin immediately
7. Track success/failure per peer for future decisions

## Resource Protection

- Max upload speed: configurable (default: 1 Mbps)
- Max concurrent P2P upload connections: configurable (default: 3)
- Cache size limit: configurable (default: 200 MB)
- Clean shutdown: stop upload server immediately on SIGTERM/SIGINT
- Stats exposed: bytes uploaded, bytes downloaded via P2P, bytes downloaded via Origin

## Segment Integrity

- Each .ts segment published by Origin includes a .sha256 file
- Peers verify SHA-256 hash after download from any source
- Failed verification → discard segment, report peer (reduce trust score)
- Trust score below threshold → exclude peer from selector

## Directory Structure

```
OpenStreamGrid/
├── docker-compose.yml
├── README.md
├── tracker/
│   ├── package.json
│   ├── Dockerfile
│   └── src/
│       └── server.ts (or index.js)
├── origin/
│   ├── package.json
│   ├── Dockerfile
│   └── src/
│       ├── server.ts
│       └── streamer.ts (FFmpeg wrapper)
├── peer/
│   ├── package.json
│   └── src/
│       ├── index.ts (CLI entry point)
│       ├── client.ts (segment fetcher + selector)
│       ├── uploader.ts (HTTP upload server)
│       ├── cache.ts (LRU segment cache)
│       ├── verifier.ts (SHA-256 verification)
│       └── stats.ts
├── common/
│   └── types.ts (shared types/interfaces)
└── test/
    └── docker-test.sh (multi-peer test script)
```

Get started by creating the project structure, implementing each component, and providing a working Docker-based test setup that demonstrates a peer sharing segments and falling back to origin.
