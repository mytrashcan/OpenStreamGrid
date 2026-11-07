# LEARN.md — Build OpenStreamGrid from scratch

OpenStreamGrid is peer-assisted delivery middleware for live HLS: viewers send
each other the media segments they already downloaded, and every peer falls back
to your origin or CDN the moment the swarm cannot meet the playback deadline.

This file is a build guide, not an API tour. It walks through the same decisions
the repository makes, in the order they have to be made, with the files to read
and the commands to run at each step. By the end you will have a working tracker,
a test origin, Node peers, a browser SDK, integrity checks, measurements, and
containers you could deploy.

Read the [README](README.md) first if you only want to run the project.

---

## What you will learn

- How a control plane (tracker) and a data plane (peers) are split for a live
  streaming system, and why the split has to be drawn there.
- How to design a scheduler contract that runs unchanged in Node and in a browser.
- How to keep a peer swarm honest with SHA-256 sidecars instead of trust.
- Why "fall back to the origin" is a feature you design first, not a catch block.
- How to measure a signaling server so numbers mean something (event-loop delay,
  not `ps` CPU percentage).
- How the same TypeScript types travel from a Node package into an ES module
  bundle that a player loads in a page.

## What you need

| Tool | Version | Why |
| --- | --- | --- |
| Node.js | 22+ | native `--test`, `fetch`, ESM |
| npm | 10+ | workspaces, `--prefix` builds |
| Docker + Compose v2 | any recent | run tracker, origin, two peers together |
| FFmpeg | 6+ | generate the test HLS stream |
| Git | any | checkout |

Helpful but not required: familiarity with HLS (`m3u8`, `.ts`, fMP4), TypeScript,
and the idea of a WebRTC DataChannel.

Rough time: a weekend to reproduce the first working grid, a few evenings more for
integrity, scheduling, and measurement.

---

## How the pieces fit

```text
  encoder ──► origin ──────────► tracker (REST + WS + SQLite)
                │                    │
                ├── HLS renditions    ├── peer discovery
                └── .sha256 sidecars  └── dashboard + metrics
                │
                └──────── CDN / origin fallback
                              │
                   Node peer A ◄──► Node peer B
                        │   HTTP / WebRTC
                        ▼
                   Hls.js browser SDK
```

| Piece | Directory | Responsibility |
| --- | --- | --- |
| Shared contracts | `common/` | Types and the scheduler interface both runtimes use |
| Tracker | `tracker/` | Broadcasts, peers, inventory, signaling, stats, persistence |
| Origin (test only) | `origin/` | Generates HLS, serves it, writes sidecars |
| Node peer | `peer/` | Headless peer: cache, fetch, upload, WebRTC |
| Browser SDK | `sdk/` | Hls.js/Shaka plugins, WebRTC peer, cache, scheduler |
| Tooling | `test/`, `scripts/`, `benchmarks/` | Integration, load, capacity, scheduler lab |

TypeScript in every package, compiled with `tsc`; the SDK bundles with esbuild.
Originally one runtime, split later so a stream keeps working whether viewers are
Node processes or plain browsers.

---

## Step 0 — Watch it work before you read the code

```bash
git clone --branch v0.7.0 --depth 1 https://github.com/mytrashcan/OpenStreamGrid.git
cd OpenStreamGrid
docker compose up --build --detach
docker compose ps
```

Then open:

| Service | URL |
| --- | --- |
| Dashboard | <http://localhost:7070/dashboard> |
| Tracker health | <http://localhost:7070/health> |
| Master playlist | <http://localhost:8080/hls/stream.m3u8> |
| Peer A / Peer B | <http://localhost:9091> / <http://localhost:9092> |

You should see two peers register, exchange segments, and traffic counters move.
Doing this first matters: when your own build misbehaves later, you need one known
good reference to compare against.

`docker compose down` when you are done.

---

## Step 1 — Bootstrap the TypeScript workspace

One repository, npm workspaces, no build orchestrator.

`package.json` (root):

```json
{
  "name": "openstreamgrid",
  "type": "module",
  "private": true,
  "workspaces": ["common", "tracker", "origin", "peer"],
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "npm run build --workspaces --if-present && npm --prefix sdk run build",
    "typecheck": "npm run typecheck --workspaces --if-present && npm --prefix sdk run typecheck",
    "test": "node --test test/*.test.mjs && npm run test --workspaces --if-present && npm --prefix sdk test",
    "lint": "eslint ."
  }
}
```

Notes that save time later:

- `sdk/` is **not** a workspace. It has its own `node_modules` and an esbuild
  pipeline; keeping it out of the workspace graph avoids hoisting `hls.js` into
  the server packages.
- Every package has `tsconfig.test.json` compiling tests into `dist-test/`, so
  `node --test dist-test/test/*.test.js` runs compiled JavaScript with no loader
  flags.
- Each package stays `"type": "module"`; nothing needs a CJS build except the SDK,
  which emits both ESM and CJS because players are loaded from bundlers and from
  plain script tags.

Per-package `tsconfig.json` extends `tsconfig.base.json` and only sets `outDir`
and `include`. Resist adding path aliases: `@openstreamgrid/common` resolves
through the workspace symlink, which also mirrors how consumers install it.

---

## Step 2 — Write the shared contracts first (`common/`)

`common/src/index.ts` holds the wire types: `Peer`, `Broadcast`,
`SegmentPossessionReport`, `PeerTrafficStats`, and the scheduler types. This is
the only package imported by both the tracker and the peers, so it must not
import Node built-ins if browser code also needs the type.

`common/src/scheduler.ts` is the interesting part. Both runtimes must choose a
peer for a segment, but they have different information: Node peers have long
observation histories, browser sessions do not. Rather than fork the logic, the
repository defines one contract and validates every output:

```ts
export interface SegmentScheduler {
  schedule(context: SegmentSchedulingContext): SegmentSchedulingPlan;
}
```

A plan is either `origin` or `single-peer`, and validation rejects plans with
codes instead of throwing strings:

```ts
export type SchedulerPlanValidationFailure = {
  code:
    | "invalid_plan" | "policy_mismatch" | "unknown_peer" | "self_peer"
    | "segment_unavailable" | "parallelism_exceeded" | "non_finite_score"
    | "invalid_deadline" | "invalid_execution_hints";
  message: string;
};
```

Why bother validating your own scheduler? Because a scheduler is where a bad peer
turns into stalled playback. Returning a failure code lets the delivery layer fall
back to the origin deterministically, and lets tests assert on the exact reason
instead of on a boolean.

Rule of thumb used throughout this project: **the data plane may distrust the
scheduler, but it must never distrust the origin.**

---

## Step 3 — Build the tracker (`tracker/`)

The tracker is the control plane. It knows who is watching, which segments they
hold, and how to introduce them. It never carries media bytes.

Deliberate choices:

- **`node:http`, no framework.** The WebSocket server (`ws`) has to upgrade on the
  same port, and the routing is small enough that a framework adds more surface
  than it removes.
- **SQLite with WAL via `better-sqlite3`, behind `TrackerStoreBackend`.** The
  store interface is synchronous, which makes atomic peer admission a single
  transaction. A `memory` backend exists for tests and demos.
- **Peer identity is separate from admin identity.** `TRACKER_API_KEY` authenticates
  broadcasts and monitoring; peer join returns a short-lived HMAC session token
  scoped to one peer (`tracker/src/peer-session.ts`). Viewer code never sees the
  admin key.

Minimal route set (`/api/v1`):

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/broadcasts` | register a broadcast |
| `POST` | `/api/v1/broadcasts/:id/peers` | join, returns session token |
| `POST` | `/api/v1/broadcasts/:id/peers/:peerId/segments` | report cached segments |
| `PUT` | `/api/v1/broadcasts/:id/peers/:peerId/heartbeat` | liveness |
| `POST` | `/api/v1/broadcasts/:id/peers/:peerId/stats` | traffic totals |
| `GET` | `/api/v1/broadcasts/:id/peers?segment=` | who has this segment |
| `GET` | `/ws` | signaling + inventory subscriptions |

Four things that are easy to skip and expensive to add later:

1. **Session tokens.** Sign `{peerId, broadcastId, exp}` with
   `PEER_SESSION_SECRET`; verify on every REST call (`Authorization: Bearer …`) and
   on WebSocket upgrade (`?sessionToken=…`). Rotating the secret invalidates the
   fleet, which is exactly what you want during an incident.
2. **Token-bucket rate limits** per client (`RATE_LIMIT_RPS`, `RATE_LIMIT_BURST`)
   plus inventory caps (`MAX_SEGMENTS_PER_REPORT`). Without them, one buggy peer
   can flatten the tracker.
3. **Client address resolution** that understands `TRUST_PROXY_HOPS`. Behind one
   ingress, per-IP limits are useless unless you read `X-Forwarded-For` — but only
   as many hops as you actually trust (`tracker/src/client-address.ts`).
4. **Bounded neighbor views.** Sending every peer every other peer's inventory
   grows with the square of the audience. `neighbor_view` gives each client a
   bounded, mostly mutual subset (`TRACKER_NEIGHBOR_VIEW_SIZE`, default 64), and
   `inventory_batch` merges inventory updates per peer into one message every
   250 ms (`tracker/src/neighbor-views.ts`, `tracker/src/websocket.ts`).

That last point is the whole scalability story; the measurements in Step 8 show
what it buys.

Verify your tracker before writing any peer:

```bash
npm ci
npm run build
node tracker/dist/server.js &
curl -s localhost:7070/health
curl -s -X POST localhost:7070/api/v1/broadcasts \
  -H "X-API-Key: openstreamgrid-local-admin" \
  -H "content-type: application/json" \
  -d '{"id":"live","playlistUrl":"http://localhost:8080/hls/stream.m3u8"}'
```

---

## Step 4 — Build a test origin and the sidecar writer (`origin/`)

You cannot develop a delivery layer without a reproducible stream. The origin
generates one with FFmpeg: three renditions, a master playlist, a sliding window,
`mpegts` (`.ts`) or `fmp4` (`.m4s` + init) segments.

Its second job matters more: **publishing hashes**.

Peers verify every byte they receive against a `<segment>.sha256` sidecar
containing `<hex digest>  <file name>`, served from the same place as the media.
`origin/src/sidecars.ts` only hashes a segment once a media playlist lists it, so
it never hashes a file the packager is still writing, and it deletes sidecars
whose segment disappeared.

Keeping the writer separate from the generator is what makes the project usable
with a real origin:

```bash
node origin/dist/sidecars.js /var/www/hls            # watch mode
node origin/dist/sidecars.js /var/www/hls --once     # one pass
node origin/dist/sidecars.js /var/www/hls --interval 500
```

For LL-HLS, `HLS_PARTS_PER_SEGMENT` emits `EXT-X-PART` entries for the test
stream. Parts have no sidecars, which is why the client sends part loads straight
to the origin and only shares complete segments — see
[ADR 0002](docs/adr/0002-llhls-part-sharing.md), then the opt-in
`assembleLowLatencySegments` setting for viewers at the live edge.

---

## Step 5 — Build the Node peer (`peer/`)

The Node peer is a full data-plane participant: it polls the playlist, decides
where to get each segment, verifies it, caches it, and serves it to others.

Loop, in order:

1. **Poll** the media playlist (`PLAYLIST_POLL_MS`). Follow a multivariant
   playlist to one rendition (`RENDITION`, lowest bandwidth by default) and wait
   for the origin to serve it before joining the tracker.
2. **Ask the scheduler.** `WeightedScoreScheduler` scores peers on latency, success
   rate, upload bandwidth, and trust from longer-lived observations
   (`peer/src/weighted-score-scheduler.ts`). A plan is `origin` or a single peer.
3. **Fetch** with a deadline (`P2P_TIMEOUT_MS`, default 2 s). Try WebRTC first,
   then HTTP (`transport-manager.ts`); the origin is authoritative.
4. **Verify** the SHA-256 against the sidecar before the bytes enter the cache
   (`peer/src/verifier.ts`). A mismatch is a peer failure report, not a retry
   loop: trust scoring drops that peer for everyone.
5. **Cache** with TTL and size limits (`CACHE_SIZE`, `CACHE_TTL_MS`), coalescing
   concurrent requests for the same segment.
6. **Serve** cached segments through a token-bucket uploader
   (`MAX_UPLOAD_SPEED`, `MAX_CONNECTIONS`) and report traffic totals.
7. **Heartbeat** so the tracker can expire silent peers (`STALE_PEER_MS`).

Two small components carry disproportionate weight later:

- `origin-latency-estimator.ts` keeps a running estimate of how long the origin
  takes. Without it, the scheduler cannot tell "a peer is slow" from "everything
  is slow right now".
- `deadline-aware-scheduler.ts` starts a hedged origin request when the remaining
  budget makes a peer response unlikely to arrive in time. Hedging is what turns
  a 85% deadline-met rate into 100% in Step 8.

Verify with the stack: `docker compose logs -f peer-a` should show verified
segments and occasional origin fallbacks, and the dashboard should list both peers.

---

## Step 6 — Build the browser SDK (`sdk/`)

The SDK is the same delivery core without a Node runtime. The hard part is not
WebRTC, it is integration with players.

**Hls.js.** Hls.js lets you replace its loader. `OpenStreamGridHlsPlugin` registers
a loader that routes media segment requests (`.ts`, `.m4s`) through the grid and
leaves playlists, keys, and init segments to the origin. Attach it before
`loadSource`:

```ts
const hls = new Hls();
const plugin = new OpenStreamGridHlsPlugin({
  trackerUrl: "https://stream.example.com",
  broadcastId: "live",
  originBaseUrl: "https://stream.example.com/hls",
  maxUploadBitrate: 1_000_000,
  maxUploadConnections: 3,
});
plugin.attach(hls);
hls.loadSource("https://stream.example.com/hls/stream.m3u8");
hls.attachMedia(document.querySelector("video")!);
```

**Shaka Player** has no loader override; it has scheme plugins. The adapter
registers one HTTP(S) scheme plugin, which is global per page, and derives a
deadline from Shaka's retry and stall timeouts because Shaka does not expose the
playback position to network plugins.

**Other players.** Anything that creates hls.js itself (Video.js 10's
`<hlsjs-video>`) takes `plugin.hlsJsConfig(Hls.DefaultConfig.loader)` as hls.js
configuration, then call `attach()` on the instance the player created.

Browser-specific rules that keep it honest:

- A viewer registers with the tracker and receives its own session token. The
  admin key must never appear in page source.
- Uploads are rate-limited and connection-limited by default; participation can
  be turned off entirely with `peerParticipation: false`.
- `TrustLatencyProbeScheduler` ranks the tracker snapshot by trust, then latency,
  and probes at most three peers in parallel — browser sessions have no history
  to learn from, so cheap probing beats elaborate scoring.
- TURN credentials come from the tracker with each session (`TURN_URLS`,
  `TURN_SHARED_SECRET`) instead of being baked into viewer code.

Build it locally, since the package is not published to npm yet:

```bash
npm ci --prefix sdk
npm run build --prefix sdk
```

---

## Step 7 — Prove integrity and fallback before adding features

Four checks that must pass for every change to the delivery path:

1. **Tampered segment.** Replace a cached segment's bytes, keep the sidecar. The
   peer must reject it, report the failure, and still play from the origin.
2. **Peer disappears.** `docker compose stop peer-b` mid-playback. The remaining
   peer and any browser viewer must continue with origin/CDN fallback and no
   buffer stall.
3. **Slow peer.** Add artificial latency to a peer's upload. The deadline-aware
   scheduler must hedge to the origin rather than miss the deadline.
4. **Tracker down.** Stop the tracker. Existing viewers keep playing from the
   origin; the dashboard goes dark, playback does not.

If any of these needs a code change to "handle", the design is wrong: the
fallback path is the product. Everything else is optimization.

---

## Step 8 — Measure, and describe the numbers correctly

Three measurement tools, each answering a different question:

```bash
bash scripts/benchmark.sh                                   # P2P offload, latency
npm run benchmark:tracker-capacity                          # control-plane capacity
npm run benchmark:scheduler                                 # policy comparison
```

What the repository reports, and how it words it:

- Default local Docker scenario (10 peers, 60 s): **46.07% P2P efficiency**,
  **47.44% CDN traffic reduction** — described as *regression data, not a
  production capacity claim*.
- One tracker: **4000 peers in one broadcast at about 40% of a core**, REST p95
  ~40 ms, ~9 MB/s signaling — with clients that negotiate `inventory_batch` and
  `neighbor_view`. Legacy clients saturate a core at about 1000 peers.
- Scheduler lab (`mixed-workload`, 400 deterministic requests per policy):
  deadline met rises from 85% (Node legacy) and 84.5% (browser legacy) to 100%
  with deadline-aware policies, while peer-win share drops — that trade is the
  point.

Two habits to copy:

- Size a signaling server by **event-loop delay** (`monitorEventLoopDelay`), not by
  `ps` CPU percentage. CPU can look idle while the loop is starved.
- Always state the environment and what the number is *not*: one machine, fixed
  seed, synthetic requests. A number without its limits is marketing.

---

## Step 9 — Harden it enough to expose

The tracker and peers sit on the internet; assume hostile clients.

- Admin key (`X-API-Key`) only on origin/operations paths. Peer traffic uses
  short-lived session tokens; WebSocket upgrades accept only declared browser
  origins (`TRACKER_WS_ALLOWED_ORIGINS`).
- Per-IP connection caps for WebSockets, because a single NAT can hide thousands
  of viewers (`TRACKER_WS_MAX_CONNECTIONS_PER_IP`).
- TURN credentials are time-limited and issued per session, with a grace window
  for renewal (`tracker/src/turn-credentials.ts`).
- TLS terminates at a reverse proxy; set `TRUST_PROXY_HOPS` so limits see the real
  client address.
- Containers run read-only, `cap_drop: ALL`, `no-new-privileges`, with an `init`
  process and health checks (`docker-compose.yml`).
- Metrics expose refused requests (`auth_failures`, `ws_upgrades_rejected`,
  `http_responses` by status class), so an attack shows up as a series instead of
  a mystery.

Security policy and reporting: [SECURITY.md](SECURITY.md).

---

## Step 10 — Automate the boring parts

- CI: typecheck, lint, unit tests per package, browser E2E, chart lint, Docker
  health test.
- Images: multi-arch (`linux/amd64`, `linux/arm64`) to GHCR, tagged `vX.Y.Z` and
  `X.Y.Z`; use immutable tags in deployments.
- Helm chart with the dashboard, `ServiceMonitor`, and optional `PrometheusRule`
  alerts (no tracker up, integrity failures, fallback spikes, event-loop lag).
- Release notes that say what changed and what to check before upgrading.

---

## Problems this project actually hit (and the fixes)

| Symptom | Cause | Fix |
| --- | --- | --- |
| Node peer found no segments | Joined from a multivariant playlist and never selected a rendition | Follow the master playlist to one rendition (`RENDITION`), wait for the origin, then join |
| Verified-segment failures between renditions | Every rendition used the same file names | Give renditions distinct names; verification rejects the wrong rendition but wastes the attempt and drops trust |
| LL-HLS viewers got almost no offload | Parts have no sidecars and a sub-second deadline | Send parts to the origin, share complete segments; opt in to `assembleLowLatencySegments` |
| Signaling grew with the square of the audience | Every inventory report went to every peer | `inventory_batch` (250 ms merge) + bounded `neighbor_view` |
| Capacity numbers disagreed with reality | CPU percentage read from `ps` | Instrument event-loop delay percentiles and size by that |
| Playback stalls during peer churn | Peer responses had no deadline | Deadline-aware scheduling with hedged origin requests |
| A misbehaving client could exhaust the tracker | No caps on reports or connections | Inventory caps, token-bucket limits, per-IP WS limits |

## What I would do differently

- Publish the browser SDK to npm earlier. "Clone and build" is a real adoption
  barrier, and CI already verifies the package.
- Start the tracker capacity benchmark before optimizing the tracker. It changed
  which optimizations were worth doing.
- Write the integrity acceptance checks (Step 7) on day one. Every later feature
  has to keep passing them, and that constraint kept the design simple.
- Treat the origin sidecar writer as a first-class deliverable from the start;
  it is what makes the middleware usable with an existing packager.

## Where to go next

- Tracker scaling options and their trade-offs:
  [ADR 0001](docs/adr/0001-tracker-horizontal-scaling.md).
- Sharing LL-HLS parts:
  [ADR 0002](docs/adr/0002-llhls-part-sharing.md).
- Scheduler internals: [docs/scheduler-architecture.md](docs/scheduler-architecture.md).
- Full HTTP/WS contract: [API_REFERENCE.md](API_REFERENCE.md).
- Roadmap: [docs/ROADMAP.md](docs/ROADMAP.md).

## License

MIT — see [LICENSE](LICENSE). Learn from it, fork it, ship it; please keep the
copyright notice.
