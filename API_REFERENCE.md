# OpenStreamGrid API Reference

This document describes the tracker REST API and signaling protocol, plus the
HTTP surfaces exposed by the origin and Node peers. Examples assume a tracker at
`http://localhost:7070` and broadcast ID `live`.

## Conventions

- JSON request bodies use `Content-Type: application/json`.
- Path identifiers must be percent-encoded.
- When `TRACKER_API_KEY` is configured, protected requests require
  `X-API-Key: <key>`. WebSocket clients send the same header during upgrade.
- Errors use `{ "error": "message" }`.
- Common statuses are `400` invalid input, `401` missing/invalid API key, `404`
  unknown resource, `409` capacity conflict, `413` body too large, `429` rate
  limit exceeded, and `500` internal error.
- Request bodies are limited to 1 MB. Rate-limited responses include
  `Retry-After`.

## Tracker endpoints

### Health and monitoring

#### `GET /health`

Returns `200` with:

```json
{ "status": "ok", "service": "tracker" }
```

#### `GET /dashboard`

Returns the real-time HTML dashboard. It consumes the SSE endpoint below.

#### `GET /metrics`

Returns Prometheus text exposition data for tracker uptime, active broadcasts
and peers, REST request duration, rate-limited requests, delivery requests,
P2P successes, integrity failures, and origin fallbacks.

#### `GET /api/v1/stats`

Returns global totals:

```json
{
  "broadcasts": 1,
  "peers": 2,
  "bytesDownloadedP2P": 104720324,
  "bytesDownloadedOrigin": 116030592,
  "bytesUploadedP2P": 134408132,
  "p2pRequests": 362,
  "p2pSuccesses": 129,
  "p2pFailures": 233,
  "originRequests": 151,
  "integrityFailures": 0,
  "fallbacks": 119,
  "segmentsCached": 239
}
```

#### `GET /api/v1/stats/events`

Opens a `text/event-stream`. Events are named `stats` or `broadcasts`; each
`data` value is a JSON snapshot:

```json
{
  "generatedAt": "2026-07-17T03:38:56.074Z",
  "global": {},
  "broadcasts": [{ "broadcast": {}, "stats": {} }]
}
```

### Broadcasts

#### `POST /api/v1/broadcasts`

Registers a broadcast or updates its playlist URL and supplied metadata.

```json
{
  "id": "live",
  "playlistUrl": "http://origin:8080/hls/stream.m3u8",
  "metadata": { "protocol": "hls", "channel": "primary" }
}
```

Returns `201` when created or `200` when updated with a `Broadcast`:

```json
{
  "id": "live",
  "playlistUrl": "http://origin:8080/hls/stream.m3u8",
  "metadata": { "protocol": "hls", "channel": "primary" },
  "createdAt": "2026-07-17T03:00:00.000Z",
  "updatedAt": "2026-07-17T03:00:00.000Z"
}
```

#### `GET /api/v1/broadcasts`

Returns `200` with `{ "broadcasts": Broadcast[] }`.

#### `GET /api/v1/broadcasts/:id`

Returns `200` with `{ "broadcast": Broadcast, "peers": Peer[] }`, or `404`.

#### `DELETE /api/v1/broadcasts/:id`

Deletes the broadcast and associated peer state. Returns `204`, or `404`.

#### `GET /api/v1/broadcasts/:id/stats`

Returns the traffic fields from global stats for one broadcast, with
`broadcastId` and `peers`.

### Peers

#### `POST /api/v1/broadcasts/:id/peers`

Joins or refreshes a peer.

```json
{
  "id": "peer-a",
  "address": "http://peer-a:9090",
  "uploadBandwidthBps": 4000000,
  "metadata": { "region": "local" }
}
```

Returns `201` for a new peer or `200` for an existing peer. A peer contains:

```json
{
  "id": "peer-a",
  "address": "http://peer-a:9090",
  "segments": [],
  "uploadBandwidthBps": 4000000,
  "joinedAt": "2026-07-17T03:00:00.000Z",
  "lastSeenAt": "2026-07-17T03:00:00.000Z",
  "latencyMs": 0,
  "successRate": 1,
  "trustScore": 1,
  "metadata": { "region": "local" }
}
```

Returns `409` when the configured per-broadcast peer capacity is exhausted.

#### `GET /api/v1/broadcasts/:id/peers`

Returns `{ "peers": Peer[] }`. Add `?segment=low_00042.ts` to return only
peers reporting that segment.

#### `DELETE /api/v1/broadcasts/:id/peers/:peerId`

Leaves the broadcast and retires the peer's final stats. Returns `204`, or `404`.

#### `POST /api/v1/broadcasts/:id/peers/:peerId/segments`

Reports segment possession. `replace` defaults to `false`; set it to `true` to
make the list authoritative.

```json
{ "segments": ["low_00041.ts", "low_00042.ts"], "replace": true }
```

Returns the updated `Peer` with `200`.

#### `PUT /api/v1/broadcasts/:id/peers/:peerId/heartbeat`

All fields are optional. `successRate` must be between 0 and 1.

```json
{ "latencyMs": 18, "uploadBandwidthBps": 4000000, "successRate": 0.98 }
```

Returns the updated `Peer` with `200`.

#### `POST /api/v1/broadcasts/:id/peers/:peerId/stats`

Replaces the peer's cumulative traffic counters and returns `204`.

```json
{
  "stats": {
    "bytesDownloadedP2P": 1000,
    "bytesDownloadedOrigin": 2000,
    "bytesUploadedP2P": 800,
    "p2pRequests": 4,
    "p2pSuccesses": 3,
    "p2pFailures": 1,
    "originRequests": 2,
    "integrityFailures": 0,
    "fallbacks": 1,
    "segmentsCached": 6
  }
}
```

Counters must be finite, non-negative numbers. `p2pSuccesses + p2pFailures`
cannot exceed `p2pRequests`.

#### `POST /api/v1/broadcasts/:id/peers/:peerId/reports`

Reports a failed source peer. `reason` is `connection`, `timeout`, `integrity`,
or `http`.

```json
{ "reporterId": "peer-b", "reason": "integrity" }
```

Returns the penalized peer with `200`. Integrity reports can reduce trust to the
selector exclusion threshold.

## WebSocket signaling

Connect to `/ws` using `ws://` or `wss://`. JSON messages are text frames.

The first client message subscribes the connection:

```json
{ "type": "subscribe", "broadcastId": "live", "peerId": "peer-a" }
```

Client-to-server messages:

| Type | Additional fields | Purpose |
| --- | --- | --- |
| `subscribe` | `broadcastId`, `peerId` | Select broadcast and peer identity |
| `heartbeat` | `latencyMs?`, `uploadBandwidthBps?`, `successRate?` | Refresh health |
| `report_segments` | `segments`, `replace?` | Update possession |
| `report_stats` | `stats` | Replace cumulative counters |
| `webrtc_offer` | `targetPeerId`, `requestId`, `sdp` | Forward WebRTC offer |
| `webrtc_answer` | `targetPeerId`, `requestId`, `sdp` | Forward WebRTC answer |

Server-to-client messages:

| Type | Additional fields | Purpose |
| --- | --- | --- |
| `peer_list` | `broadcastId`, `peers` | Initial/current peer snapshot |
| `peer_joined` | `broadcastId`, `peer` | Peer joined |
| `peer_left` | `broadcastId`, `peerId` | Peer left |
| `segment_available` | `broadcastId`, `peerId`, `segments` | Availability changed |
| `stats_update` | `broadcastId`, `peerId`, `stats` | Monitoring data changed |
| `webrtc_offer` / `webrtc_answer` | `peerId`, `targetPeerId`, `requestId`, `sdp` | Relayed signaling |

Malformed frames are rejected. Connections are closed during tracker shutdown;
clients should reconnect with exponential backoff and resubscribe.

## Origin HTTP API

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/health` | `200` ready or `503` starting, with FFmpeg/playlist details |
| `GET`, `HEAD` | `/hls/stream.m3u8` | Master playlist |
| `GET`, `HEAD` | `/hls/:quality/stream.m3u8` | Rendition playlist |
| `GET`, `HEAD` | `/hls/:quality/:segment.ts` | Immutable media segment |
| `GET`, `HEAD` | `/hls/:quality/:segment.ts.sha256` | SHA-256 sidecar |

With multiple generated channels, the channel-specific playlist path is
advertised in that broadcast's `playlistUrl`. Clients should consume the
registered URL rather than constructing a path. Playlists use `no-store`;
segments and hashes are immutable cacheable assets.

## Peer upload HTTP API

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/health` | Readiness, cache bytes/items, and active uploads |
| `GET` | `/segments/:segmentName` | Cached bytes, `404` on miss, `429` at connection limit |
| `HEAD` | `/segments/:segmentName` | Segment headers without transfer accounting |

The upload server accepts simple segment file names only. Transfer speed and
concurrency are bounded by the peer configuration.
