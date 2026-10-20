# Roadmap

This page tracks where OpenStreamGrid is headed. The [changelog](../CHANGELOG.md)
records what shipped, and the ADRs record design decisions in depth.

## Done

The three implementation phases in the original plan are complete:

- **Phase 1, foundation:** tracker REST API, FFmpeg test origin, Node peer with
  LRU cache, SHA-256 verification, upload limits and origin fallback, and a
  Docker multi-peer test.
- **Phase 2, signaling and browser:** WebSocket signaling, quality-based peer
  selection, parallel downloads, the browser SDK (Hls.js plugin, Shaka adapter,
  Video.js 10 through `hlsJsConfig()`), multi-quality ABR, and the monitoring
  dashboard.
- **Phase 3, hardening:** WebRTC DataChannel transport, SQLite store, load and
  capacity benchmarks, Helm chart, CI, and linting.

Since v0.6.1 (unreleased, see the changelog):

- Tracker signaling scales linearly with the audience (`inventory_batch` and
  `neighbor_view`); one tracker serves 4000 peers in one broadcast at under
  half a core ([Tracker capacity](tracker-capacity.md)).
- LL-HLS viewers can assemble and share complete segments
  (`assembleLowLatencySegments`, [ADR 0002](adr/0002-llhls-part-sharing.md)
  option B).
- A sidecar writer for existing origins, and Node peers that follow a
  multivariant playlist to one rendition and skip peers on other renditions.
- Hardening against abusive peers: reserved peer addresses (including
  IPv4-mapped and DNS forms), bounded metadata, upload stall timeouts, and
  jittered reconnects.
- Observability: metrics for signaling traffic, event-loop delay, and refused
  requests, a Security row in the Grafana dashboard, and optional Prometheus
  alerts.
- An SDK package whose type declarations work for TypeScript consumers, a
  prerequisite for publishing it to npm.

## Next

- **Release 0.7.0** with the unreleased changes above.
- **Publish the browser SDK to npm.** It is build- and publish-dry-run checked
  in CI but not yet on the registry.
- **Refresh the performance baseline** (`scripts/benchmark.sh`) on a machine
  with Docker, since it predates the signaling changes.

## Waiting on a decision

- **Tracker horizontal scaling** ([ADR 0001](adr/0001-tracker-horizontal-scaling.md)):
  broadcast sharding first when deployments have many broadcasts, a shared
  store only if one broadcast outgrows one tracker.
- **Turning on segment assembly by default** (ADR 0002 option B), after
  measuring its offload on a mixed audience and checking which packagers
  produce parts that concatenate to the segment.

## Later

- **Sharing LL-HLS parts directly** (ADR 0002 option C), only if option B's
  offload is not enough. It needs per-part sidecars, progress-based part
  inventory, and a test origin that publishes parts while the segment is
  still being written.
- **QUIC or WebTransport** as another peer transport.
- **NAT traversal beyond STUN/TURN configuration**, such as tracker-assisted
  relay selection, measured on real networks.

Proposals are welcome as issues; larger changes start as an ADR in
[`docs/adr`](adr).
