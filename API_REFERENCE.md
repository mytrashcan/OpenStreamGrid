# OpenStreamGrid API Reference

This document describes the tracker REST API and signaling protocol, plus the
HTTP surfaces exposed by the origin and Node peers. Examples assume a tracker at
`http://localhost:7070` and broadcast ID `live`.

## Conventions

- JSON request bodies use `Content-Type: application/json`.
- Path identifiers must be percent-encoded.
- Administrative requests use `X-API-Key: <key>`. Clients that can only send
  a bearer credential, such as Prometheus scraping `/metrics`, may send the
  same key as `Authorization: Bearer <key>`. A successful peer join
  returns a scoped session token. Peer REST calls use `Authorization: Bearer
  <token>` and WebSocket clients use `?sessionToken=<token>`.
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
P2P successes, integrity failures, and origin fallbacks. WebSocket signaling
is covered by `openstreamgrid_ws_messages_sent_total`,
`openstreamgrid_ws_bytes_sent_total`, and `openstreamgrid_ws_subscribers` by
`mode` (`immediate`, `batched`, or `neighbor_view`). Many `immediate`
subscribers mean clients that predate inventory batching.
`openstreamgrid_event_loop_delay_{p50,p90,p99,max}_seconds` report how long
callbacks waited for the tracker's event loop since the previous scrape; every
REST and WebSocket message pays that delay.

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
`peers` follows the same visibility rule as the peer listing below.

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

Returns `201` for a new peer or `200` for an authenticated refresh:

```json
{
  "peer": {
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
  },
  "sessionToken": "<opaque-token>",
  "expiresAt": "2026-07-20T04:00:00.000Z"
}
```

When the tracker has `TURN_URLS` and `TURN_SHARED_SECRET`, the response also
includes TURN credentials that expire ten minutes after the session (covering
refresh retries), in the coturn
`use-auth-secret` format: the username is `<expiry unix seconds>:<peer id>`
and the credential is `base64(HMAC-SHA1(secret, username))`.

```json
{
  "iceServers": [
    {
      "urls": ["turns:turn.example.com:5349"],
      "username": "1784520600:peer-a",
      "credential": "<base64-hmac>"
    }
  ]
}
```

Browser SDK and Node peers append these to their configured ICE servers and
replace them on every session refresh.

Returns `429` when the configured per-broadcast peer capacity is exhausted.

Zero-install browser peers use a signaling-only address and identify their
transport in metadata:

```json
{
  "id": "browser-6f98...",
  "address": "webrtc://browser-6f98...",
  "uploadBandwidthBps": 1000000,
  "metadata": { "runtime": "browser", "transport": "webrtc" }
}
```

#### `GET /api/v1/broadcasts/:id/peers`

Returns `{ "peers": Peer[] }`. Add `?segment=low_00042.ts` to return only
peers reporting that segment.

With neighbor views enabled (`TRACKER_NEIGHBOR_VIEW_SIZE` above 0, the
default), a caller authenticated with a peer session sees only itself and its
neighbors, the same peers the WebSocket reports, so a viewer cannot list the
whole audience's addresses. Administrators see every peer, and so does a peer
that has no neighbors yet (for example, one restored after a tracker restart,
until it subscribes).

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

Upgrades require a peer session token (`Authorization: Bearer <token>` or
`?sessionToken=<token>`) and return `401` without a valid one. When
`TRACKER_WS_ALLOWED_ORIGINS` is set, browser upgrades whose `Origin` header is
not in the list (including the literal `null` origin) return `403`. Upgrades
without an `Origin` header, such as Node peers, are not subject to the list.

The first client message subscribes the connection:

```json
{
  "type": "subscribe",
  "broadcastId": "live",
  "peerId": "peer-a",
  "features": ["inventory_batch", "neighbor_view"]
}
```

`features` is optional, and the tracker ignores entries it does not know.
With `inventory_batch`, the tracker merges inventory updates per peer and sends
them every 250 ms as one `segment_inventory_batch` instead of a
`segment_available` or `segment_inventory_delta` message for every report.
Without it, a client receives every report as it arrives. With batching, a
client receives four messages per second for every 256 peers whose inventory
changed in an interval; without it, each report becomes one message to every
peer in the broadcast. The SDK and the Node peer declare it.

With `neighbor_view` (honored only together with `inventory_batch`), the
client sees a bounded set of neighbors, `TRACKER_NEIGHBOR_VIEW_SIZE` peers (64
by default), instead of the whole audience. `peer_list` contains the client and
its neighbors, inventory batches carry only neighbors' updates, and
`peer_joined` / `peer_left` mean that a peer entered or left the client's view:
the tracker replaces neighbors that leave and links newcomers to random
existing peers, which may drop one of their neighbors to make room. Links are
made in both directions, so most peers a client sees also see it and can
request segments from it. Audiences no larger than the
view size are unaffected. The SDK and the Node peer declare it.

Deleting a broadcast closes its subscribers' connections with code `4004`.

Client-to-server messages:

| Type | Additional fields | Purpose |
| --- | --- | --- |
| `subscribe` | `broadcastId`, `peerId`, `features?` | Select broadcast and peer identity, and negotiate optional features |
| `heartbeat` | `latencyMs?`, `uploadBandwidthBps?`, `successRate?` | Refresh health |
| `report_segments` | `segments` and `replace?`, or `added` and `removed` | Update possession with a full list or a delta |
| `report_stats` | `stats` | Replace cumulative counters |
| `webrtc_offer` | `targetPeerId`, `requestId`, `sdp` | Forward WebRTC offer |
| `webrtc_answer` | `targetPeerId`, `requestId`, `sdp` | Forward WebRTC answer |

Server-to-client messages:

| Type | Additional fields | Purpose |
| --- | --- | --- |
| `peer_list` | `broadcastId`, `peers` | Initial/current peer snapshot |
| `peer_joined` | `broadcastId`, `peer` | Peer joined |
| `peer_left` | `broadcastId`, `peerId` | Peer left |
| `segment_available` | `broadcastId`, `peerId`, `segments`, `replace?` | A peer reported a segment list; `replace` means it is the full inventory |
| `segment_inventory_delta` | `broadcastId`, `peerId`, `added`, `removed` | A peer reported a delta |
| `segment_inventory_batch` | `broadcastId`, `updates` | Net inventory changes since the last batch, for `inventory_batch` clients |
| `webrtc_offer` / `webrtc_answer` | `peerId`, `targetPeerId`, `requestId`, `sdp` | Relayed signaling |

Each entry in `updates` is either `{ "peerId", "added", "removed" }` or
`{ "peerId", "segments", "replace": true }`. Apply entries in order, removals
before additions, as for `segment_inventory_delta`. Updates from a peer that
left before the batch was sent are dropped, so `peer_left` is never followed by
a stale update. A batch carries at most 256 entries; larger batches are split.

Malformed frames are rejected. Connections are closed during tracker shutdown;
clients should reconnect with exponential backoff and resubscribe.

## Browser SDK events

`OpenStreamGridHlsPlugin` reports diagnostics through the `onEvent` option.
Delivery events carry optional `segment`, `peerId`, `durationMs`, and
`message` fields.

| Type | Meaning |
| --- | --- |
| `cache_hit` / `cache_miss` | The segment was or was not in the local cache |
| `peer_fetched` | A peer delivered the segment and it passed verification |
| `peer_failed` | A peer attempt failed; `message` gives the reason (HTTP status, WebRTC error, timeout, integrity). Attempts cancelled because another peer won are not reported |
| `origin_fallback` | The segment was served by the origin/CDN |
| `integrity_ok` / `integrity_fail` | SHA-256 verification passed or failed |
| `integrity_skipped` | The origin's sidecar could not be fetched (for example, LL-HLS parts that a player requests as segments). The origin bytes were played but not cached or shared; `message` gives the reason |
| `segment_assembled` | With `assembleLowLatencySegments`, an LL-HLS segment was joined from its parts, verified, and cached for sharing |
| `ws_connected` / `ws_disconnected` / `ws_error` | Tracker signaling connection state |
| `scheduler_decision` | Delivery plan: `policy`, `mode`, `reason`, `candidateCount`, `selectedPeerCount` |
| `scheduler_warning` | A scheduler error or invalid plan was contained: `policy`, `code`, `message` |

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
