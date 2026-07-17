# OpenStreamGrid Devpost Video Plan

## Verified project summary

OpenStreamGrid is a general-purpose hybrid P2P-CDN middleware prototype and local testbed for HLS live streaming. It is not a complete streaming platform. The repository contains an FFmpeg-based Origin, a Tracker and control service, Node peer clients, a browser-facing Hls.js plugin SDK, monitoring, persistence, load-test tooling, and deployment manifests.

The production video is based on repository inspection, the complete unit-test suite, TypeScript builds, and a captured Docker E2E run. The E2E run generated a three-rendition HLS stream, registered a broadcast, connected two peers, observed P2P segment transfer, forced Origin fallback, forced the HTTP transport path, and verified SQLite state after a Tracker restart.

## Feature inventory

### Fully implemented and directly demonstrated

- FFmpeg test-pattern Origin with 360p, 480p, and 720p HLS renditions.
- HLS master and media playlists plus MPEG-TS segments.
- SHA-256 sidecar generation and segment verification.
- Tracker REST APIs for broadcasts, peers, segment possession, heartbeat, reports, and statistics.
- WebSocket peer and segment signaling.
- Node peer LRU cache, HTTP upload endpoint, upload rate limiting, and concurrent upload limits.
- Hybrid peer selection with immediate Origin fallback.
- P2P and Origin traffic statistics.
- Docker Compose multi-peer test environment.
- SQLite Tracker state with restart persistence.
- Monitoring dashboard and SSE statistics stream.

### Implemented and unit-tested, but not claimed as production-proven

- Quality-weighted peer ranking and metric EMA.
- Parallel downloads of different segments.
- WebRTC DataChannel adapter with HTTP fallback. A real DataChannel unit test passes; NAT traversal and production-network behavior are outside this demo.
- Browser Hls.js plugin SDK. It builds and typechecks, but this video does not claim a full browser playback E2E.
- Load-test framework and benchmark reporting.

### Partial or experimental

- Adaptive bitrate: the Origin generates three renditions, while the Docker Node peers intentionally consume one low media rendition. Automatic end-to-end quality adaptation is not demonstrated.
- Kubernetes and Helm manifests exist, but no live cluster deployment is demonstrated.
- WebRTC is experimental and is not used as evidence for production NAT traversal.

### Planned or excluded from the current demonstration

- Production-grade STUN/TURN deployment and complex NAT traversal.
- Guaranteed bandwidth reduction, cost savings, or unlimited scalability.
- Production readiness or SLA claims.
- A commercial streaming-platform integration.
- Chunking one segment across multiple peers.

## Target audience

- Devpost judges evaluating engineering depth and credibility.
- Streaming, distributed-systems, and open-source developers.
- Teams exploring a middleware layer rather than a replacement video platform.

## Core message

OpenStreamGrid demonstrates a standards-based hybrid delivery path: share verified HLS segments among peers when useful, and preserve reliability by falling back to the Origin when peer delivery is unavailable.

## Storyboard and timing

| Time | Scene | Visual | Narration and caption intent |
|---:|---|---|---|
| 0–8 s | Problem | Origin fans identical segment paths to many viewers | Centralized delivery repeats the same segment transfer. |
| 8–16 s | Introduction | OpenStreamGrid identity and positioning | Open, platform-independent hybrid P2P-CDN HLS testbed. |
| 16–25 s | Architecture | Animated Origin → Tracker → peer topology | Three HLS renditions, coordination, peers, and statistics. |
| 25–41 s | Request flow | Discover, verify, and fallback cards | Cache, announce, verify, peer transfer, and Origin fallback. |
| 41–50 s | Actual demo | Real E2E log lines and verified badges | Two peers connect and exchange segments. |
| 50–59 s | Evidence | Metrics from one captured local run | P2P bytes, Origin bytes, ratio, and forced fallbacks. |
| 59–69 s | Scope | Demonstrated versus current boundary | Honest prototype positioning and limitations. |
| 69–78 s | Closing | Project mark, tagline, repository | Distributed when possible; reliable by design. |

## Narration script

The exact English narration is stored in `assets/narration.txt`. Each paragraph is synthesized separately and placed at the same start time as its subtitle cue. This avoids drift between narration and captions.

## On-screen captions

The reusable subtitle file is `assets/subtitles.srt`. Captions are also burned into the Remotion composition for reliable Devpost playback.

## Required demo commands

```bash
npm test
npm run typecheck
bash scripts/e2e-test.sh
bash video/scripts/capture-demo.sh
```

## Required assets

- Verified E2E evidence in `assets/demo/evidence.json`.
- Actual selected E2E log lines displayed in the demo scene.
- Locally synthesized narration WAV files.
- Original code-generated ambient WAV track.
- No stock footage, proprietary logos, or third-party music.

## Demonstrable claims

- Two peers can join the same broadcast and advertise cached segments.
- A peer can obtain an HLS segment through P2P.
- Origin fallback occurs after peer unavailability.
- HTTP transport can carry a P2P segment when WebRTC is disabled.
- SHA-256 verification is present and unit-tested.
- Tracker broadcast and traffic data survive a SQLite-backed restart.
- One captured local run measured 1,642,368 P2P bytes, 36,080,584 Origin bytes, a 4.35% P2P ratio, two P2P successes, and four forced fallbacks.

## Claims that must not be used

- Guaranteed bandwidth or cost reduction.
- Production-ready, infinitely scalable, or universally compatible.
- The 4.35% result as a general benchmark.
- Production NAT traversal.
- Complete adaptive-bitrate behavior across all clients.
- A finished integration with any named commercial streaming platform.

## Known environment and technical limitations

- Validation runs on one local Docker network.
- The Node peer consumes the low rendition in the demo; the master playlist remains available to players and the browser SDK.
- Restarting peers during a sliding live window can expose already-deleted segments, producing transient 404 responses. Fallback and later requests continue; the video does not claim zero transient request failures during forced churn.
- WebRTC receives unit-level and adapter-level verification, while the Devpost runtime evidence focuses on the deterministic HTTP P2P path and Origin fallback.
- Narration uses the macOS local `say` voice, so voice timbre can differ across machines. The subtitle-driven version remains complete without narration.
