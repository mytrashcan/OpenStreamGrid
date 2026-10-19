# OpenStreamGrid

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/mytrashcan/OpenStreamGrid)](https://github.com/mytrashcan/OpenStreamGrid/releases/latest)
[![CI](https://github.com/mytrashcan/OpenStreamGrid/actions/workflows/ci.yml/badge.svg)](https://github.com/mytrashcan/OpenStreamGrid/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-green.svg)](package.json)
[![Docker images](https://github.com/mytrashcan/OpenStreamGrid/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/mytrashcan/OpenStreamGrid/actions/workflows/docker-publish.yml)

Universal hybrid P2P-CDN middleware for standards-based live streaming.

[English](README.md) | [한국어](README.ko.md)

OpenStreamGrid adds peer-assisted delivery to HLS streams with MPEG-TS (`.ts`)
or CMAF/fMP4 (`.m4s`) media segments. With LL-HLS, partial segments load
from the origin while complete segments are shared. With
`assembleLowLatencySegments`, viewers at the live edge also share the segments
they assemble from parts; sharing the parts themselves is a roadmap item (see
[ADR 0002](docs/adr/0002-llhls-part-sharing.md)). Peers share and SHA-256-verify media segments, while fMP4 init segments
and playlists always load from your origin or CDN. Your
origin continues to encode and publish media while OpenStreamGrid discovers
peers, verifies segments, limits resource use, reports delivery metrics, and
immediately falls back to the origin when P2P cannot meet the playback deadline.

> OpenStreamGrid is delivery middleware, not a complete streaming platform. It
> integrates with your existing origin, CDN, and player stack.

## Quick Start

With [Docker Compose v2](https://docs.docker.com/compose/) installed, start the
tracker, test origin, and two peers with one command:

```bash
git clone --branch v0.6.1 --depth 1 https://github.com/mytrashcan/OpenStreamGrid.git
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

## Release Status

[OpenStreamGrid v0.6.1](https://github.com/mytrashcan/OpenStreamGrid/releases/tag/v0.6.1)
is the current stable release. It is a patch release on top of v0.6.0's
reproducible QoE benchmarks, pluggable scheduling policies, and deadline-aware
P2P/Origin hedging: it hardens peer joins and WebSocket upgrades, fixes the
WebSocket Origin allowlist for Node peers, corrects Helm image tags, and ships
multi-architecture container images.
Use the release tag for reproducible deployments and review the
[release notes](RELEASE_NOTES.md) before upgrading. See the
[changelog](CHANGELOG.md) for the complete history.

Tagged container images are published to GHCR for production deployment:

| Component | Image |
| --- | --- |
| Tracker | `ghcr.io/mytrashcan/openstreamgrid-tracker:v0.6.1` |
| Origin | `ghcr.io/mytrashcan/openstreamgrid-origin:v0.6.1` |
| Node peer | `ghcr.io/mytrashcan/openstreamgrid-peer:v0.6.1` |

Images are built for `linux/amd64` and `linux/arm64` and tagged both `vX.Y.Z`
and `X.Y.Z` (from v0.6.1; earlier releases are `linux/amd64` with `vX.Y.Z` only).
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
                    HTTP behind TLS proxy / API key
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

## Scheduling

OpenStreamGrid uses the shared `SegmentScheduler` contract with runtime-specific
default policies. Node peers use `WeightedScoreScheduler`, which combines
latency, success rate, upload bandwidth, and trust from longer-lived peer
observations. The browser SDK uses `TrustLatencyProbeScheduler`, which ranks the
tracker snapshot by trust and then latency before probing up to three peers in
parallel. The policies differ because browser playback sessions have less
persistent peer-quality history than Node peers.

Applications can inject a custom scheduler through the Node fetcher or the
browser SDK's `scheduler` option. Browser decisions are observable through the
`scheduler_decision` SDK event. Regardless of policy, the delivery layer treats
Origin/CDN fallback as authoritative whenever P2P is unavailable or a plan
chooses Origin.

## Features

- Hybrid HTTP/WebRTC segment delivery with immediate origin fallback.
- Player integrations for Hls.js, Shaka Player, and Video.js 10 (or any player
  that creates hls.js itself); LL-HLS streams play, with partial segments
  loading from the origin.
- Works with an existing origin: a sidecar writer adds the SHA-256 files
  peers verify against to any packager's HLS output.
- Scales to thousands of viewers per broadcast and tracker: batched inventory
  updates and bounded neighbor views keep signaling linear in the audience.
- Admin API-key authentication plus short-lived, peer-scoped session tokens.
- HTTPS-compatible clients; terminate TLS at a trusted reverse proxy.
- Configurable STUN and TURN servers for WebRTC NAT traversal.
- Multi-channel isolation and multi-rendition HLS generation.
- Quality-based peer ranking, parallel downloads, and request coalescing.
- SHA-256 verification, peer trust scoring, and integrity-failure exclusion.
- TTL-aware LRU caching, upload bandwidth limiting, and connection limits.
- Real-time dashboard, Prometheus metrics (including signaling volume and
  event-loop delay), SSE updates, and SQLite history.
- Grafana dashboard and Prometheus Operator `ServiceMonitor` in the Helm chart.
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
  originBaseUrl: "https://stream.example.com/hls",
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

Rather than embedding TURN credentials in viewer code, set `TURN_URLS` and
`TURN_SHARED_SECRET` on the tracker. Each peer then receives short-lived TURN
credentials with its session, the SDK adds them to `iceServers`, and they are
renewed with the session.

Set `peerParticipation: false` for receive-only playback. A native agent or
browser extension can still be useful as an optional dedicated seed in managed
environments, but it is not part of the normal viewer path.

Browser peers automatically receive a short-lived, identity-scoped session when
they register. Do not pass or embed `TRACKER_API_KEY` in viewer code; reserve the
administrator credential for trusted origin and operations components.

### Shaka Player

`OpenStreamGridShakaPlugin` provides the same delivery core for Shaka Player. It
registers an HTTP(S) scheme plugin, so media segment requests go through the
grid and every other request uses Shaka's fetch plugin:

```ts
import shaka from "shaka-player";
import { OpenStreamGridShakaPlugin } from "@openstreamgrid/sdk";

const plugin = new OpenStreamGridShakaPlugin({
  trackerUrl: "https://stream.example.com",
  broadcastId: "live",
  originBaseUrl: "https://stream.example.com/hls",
});
plugin.attach(shaka);
const player = new shaka.Player();
await player.attach(document.querySelector("video")!);
await player.load("https://stream.example.com/hls/stream.m3u8");
```

It takes the same options as the Hls.js plugin. Shaka scheme plugins are global,
so attach one instance per page; `detach()` restores Shaka's fetch plugin.
Shaka does not expose the playback position to network plugins, so the adapter
derives a deadline from each request's retry and stall timeouts: peers get the
first part of that budget, and the origin is used before Shaka would abort.

### Video.js 10 and other hls.js wrappers

Players that create hls.js themselves, such as Video.js 10's `<hlsjs-video>`,
take the grid's loader as hls.js configuration. Call `hlsJsConfig()` with
hls.js's default loader and pass the result where the player accepts hls.js
options:

```ts
import "@videojs/html/media/hlsjs-video";
import { Hls } from "@videojs/hlsjs-video";
import { OpenStreamGridHlsPlugin } from "@openstreamgrid/sdk";

const grid = new OpenStreamGridHlsPlugin({
  trackerUrl: "https://stream.example.com",
  broadcastId: "live",
  originBaseUrl: "https://stream.example.com/hls",
});
const video = document.querySelector("hlsjs-video")!;
video.source = {
  src: "https://stream.example.com/hls/stream.m3u8",
  // Native HLS playback would bypass hls.js and the grid.
  preferPlayback: "mse",
  engine: { hlsJs: grid.hlsJsConfig(Hls.DefaultConfig.loader) },
};
```

Once the player has created hls.js (`video.engine` for Video.js 10), pass it
to `grid.attach()` to schedule against the playback position; attach again if
the player recreates it. `grid.detach()` stops the grid. The browser E2E plays
Video.js 10.0.1 this way.

## Using your own origin

Peers verify every shared segment against a `<segment>.sha256` sidecar next to
it (`<hex digest>  <segment name>`). The bundled origin writes them; with
another packager, run the sidecar writer next to it, pointed at the HLS
output directory:

```bash
# From a checkout (npm run build first)
node origin/dist/sidecars.js /var/www/hls
# Or from the published origin image; it runs as a non-root user, so let it
# write to the host directory with --user
docker run --rm --user "$(id -u):$(id -g)" -v /var/www/hls:/hls \
  ghcr.io/mytrashcan/openstreamgrid-origin:v0.6.1 origin/dist/sidecars.js /hls
```

It hashes segments once they appear in a media playlist, so it never hashes a
segment the packager is still writing, and removes sidecars whose segment was
deleted. `--once` runs a single pass; `--interval <ms>` sets how often it
looks for new segments (100 to 60000, default 1000). Serve the sidecars from the same place
as the segments, or point the SDK's `hashUrlResolver` at them.

## Tracker API

Tracker resources are under `/api/v1`. Administrators send `X-API-Key: <key>`
or, for scrapers such as Prometheus, `Authorization: Bearer <key>`.
Peer join returns a short-lived session token; peer REST calls use
`Authorization: Bearer <token>` and WebSocket upgrades use `?sessionToken=<token>`.

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
| `PORT` | `7070` | HTTP listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `STALE_PEER_MS` | `30000` | Peer inactivity timeout |
| `STORE_TYPE` | `sqlite` | Persistence backend: `sqlite` or `memory` |
| `DB_PATH` | `./data/tracker.db` | SQLite database path |
| `TRACKER_API_KEY` | unset | Admin credential for broadcast management, monitoring, and metrics |
| `PEER_SESSION_SECRET` | random per process | HMAC secret of at least 32 bytes; set explicitly in deployments |
| `PEER_SESSION_TTL_MS` | `3600000` | Peer session lifetime |
| `RATE_LIMIT_RPS` | `100` | Sustained requests per second per client |
| `RATE_LIMIT_BURST` | `200` | Token-bucket burst capacity per client |
| `MAX_PEERS_PER_BROADCAST` | `500` | Active-peer limit per broadcast |
| `TRACKER_WS_ALLOWED_ORIGINS` | unset | Comma-separated http(s) origins allowed to open `/ws` from a browser; other browser origins receive 403. Upgrades without an `Origin` header, such as Node peers, still require a valid peer session |
| `TRACKER_WS_MAX_CONNECTIONS_PER_IP` | `20` | Concurrent `/ws` connections per client address; raise it when many viewers share one NAT address |
| `TRACKER_NEIGHBOR_VIEW_SIZE` | `64` | Peers each SDK or Node peer is told about (`neighbor_view`). Audiences up to this size see everyone; `0` sends every client the whole audience |
| `TRUST_PROXY_HOPS` | `0` | Number of trusted reverse proxies in front of the tracker; per-client limits then use the client address they record in `X-Forwarded-For`. Set to `1` behind a single ingress or TLS proxy |
| `TURN_URLS` | unset | Comma-separated `turn:`/`turns:` URIs returned with short-lived credentials on peer join; browser and Node peers add them to their ICE servers |
| `TURN_SHARED_SECRET` | unset | TURN server shared secret (coturn `static-auth-secret`, at least 16 bytes); required with `TURN_URLS` |

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
| `HLS_SEGMENT_TYPE` | `mpegts` | `mpegts` for `.ts` segments or `fmp4` for CMAF/fMP4 (`.m4s` plus a per-rendition init segment) |
| `PLAYLIST_SIZE` | `8` | Segments retained per media playlist |
| `HASH_INTERVAL_MS` | `250` | Sidecar hash discovery interval |
| `FFMPEG_PATH` | `ffmpeg` on `PATH` | FFmpeg executable override |

### Node Peer

| Variable | Default | Description |
| --- | --- | --- |
| `TRACKER_URL` | `http://tracker:7070` | Tracker base URL |
| `TRACKER_API_KEY` | unset | Optional admin key; normal peer traffic uses the issued session token |
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
| `hashUrlResolver` | adjacent `.sha256` | Override signed/query-aware sidecar URL resolution |
| `assembleLowLatencySegments` | `false` | LL-HLS: join a segment's parts once the playlist lists it, verify it against the segment's sidecar, and share it with peers that load complete segments. Needs `attach()` on the hls.js instance and segment verification |

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

### Tracker capacity

One tracker serves **4000 active peers in one broadcast** at about 40% of a
CPU core, with REST p95 latency around 40 ms and about 9 MB/s of signaling,
when clients negotiate inventory batching and neighbor views (the SDK and the
Node peer do). Clients that predate those features saturate a core at about
1000 peers. Measured on an Apple M5 with the control-plane benchmark
(`npm run benchmark:tracker-capacity`); see
[Tracker capacity](docs/tracker-capacity.md) for the method and every run.

<!-- BENCHMARK_SCHEDULER:START -->
### Phase 3 scheduler policy lab: `mixed-workload`

| Policy | Deadline met | Peer wins | Origin wins | Hedges started | Completion p50 | Completion p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Node-legacy | 85% | 77.5% | 22.5% | 0% | 860.54 ms | 1,365.97 ms |
| Node-deadline-aware | 100% | 63.75% | 36.25% | 6.75% | 769.12 ms | 1,332.58 ms |
| Browser-legacy | 84.5% | 98.75% | 1.25% | 0% | 801.72 ms | 1,271.02 ms |
| Browser-deadline-aware | 100% | 81.5% | 18.5% | 0.75% | 722.18 ms | 1,265.83 ms |

_Fixed seed `phase3-mixed-2026`; 400 deterministic requests per policy. Controlled simulation using production schedulers—not a production capacity claim. See the [scheduler lab](benchmarks/scheduler-lab/README.md)._
<!-- BENCHMARK_SCHEDULER:END -->

<!-- BENCHMARK:START -->
_Benchmark data is generated by running `bash scripts/benchmark.sh --scenario benchmarks/scenarios/ci-smoke.json`. See [benchmark methodology](docs/benchmark-methodology.md) for details._
<!-- BENCHMARK:END -->

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
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

- Ask usage questions and propose ideas in [GitHub Discussions](https://github.com/mytrashcan/OpenStreamGrid/discussions).
- Report reproducible defects through [GitHub Issues](https://github.com/mytrashcan/OpenStreamGrid/issues).
- Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
- Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

The Discord community is not open yet. This badge will be linked to the official
server once one is available.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=mytrashcan/OpenStreamGrid&type=Date)](https://star-history.com/#mytrashcan/OpenStreamGrid&Date)

If OpenStreamGrid is useful to you, consider
[starring the repository](https://github.com/mytrashcan/OpenStreamGrid).

## Documentation

- [Korean README](README.ko.md)
- [API reference](API_REFERENCE.md)
- [Contributing guide](CONTRIBUTING.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
- [Release notes](RELEASE_NOTES.md)
- [Changelog](CHANGELOG.md)
- [Kubernetes deployment guide](deploy/k8s/README.md)
- [ADR 0001: Tracker horizontal scaling](docs/adr/0001-tracker-horizontal-scaling.md)
- [ADR 0002: Sharing LL-HLS partial segments](docs/adr/0002-llhls-part-sharing.md)
- [Tracker capacity](docs/tracker-capacity.md)
- [Browser SDK example](sdk/examples/basic.html)

## License

OpenStreamGrid is licensed under the [MIT License](LICENSE).
