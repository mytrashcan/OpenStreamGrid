# Tracker capacity

This page records how many peers one tracker instance serves in a single
broadcast. It is step 2 of [ADR 0001](adr/0001-tracker-horizontal-scaling.md).

## Method

`scripts/tracker-capacity.mjs` simulates the tracker control plane without media:
each simulated peer joins over REST, subscribes over WebSocket, reports a new
segment every 2 s (one added and one evicted entry), and sends a heartbeat and a
stats report every 5 s, like the Node peer and browser SDK. Peers connect in
batches of 50 and are spread evenly across the 2 s interval. Each peer has its
own `X-Forwarded-For` address, so the tracker runs with `TRUST_PROXY_HOPS=1` and
limits high enough for the test:

```bash
TRUST_PROXY_HOPS=1 RATE_LIMIT_RPS=100000 RATE_LIMIT_BURST=100000 \
MAX_PEERS_PER_BROADCAST=5000 TRACKER_API_KEY=<key> node tracker/dist/server.js

npm run benchmark:tracker-capacity -- --api-key <key> \
  --peers 100,250,500,1000 --duration 30 --tracker-pid <pid>
```

For each peer count the script reports the latency of a REST probe
(`GET /api/v1/broadcasts/:id/peers?segment=…` every 0.5 s, for a segment the
peers currently hold), WebSocket messages delivered per second, tracker CPU
(CPU time used during the stage divided by its wall time, from `ps`) and RSS,
and connection failures.

## Results

Apple M5 (10 cores), Node.js 22.23, SQLite store, load generator on the same
machine, 30 s per stage. CPU is one tracker process; 100% is one core. Results
depend on hardware; rerun the script on your target environment.

### Before: stats fan-out to every peer

| Peers | Probe p50 | Probe p95 | Probe p99 | WS msgs/s | Tracker CPU | Dropped |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 4.3 ms | 7.2 ms | 8.4 ms | 6,996 | 12.9% | 0 |
| 250 | 4.4 ms | 7.7 ms | 186.7 ms | 43,606 | 27.8% | 0 |
| 500 | 4.7 ms | 1,053.3 ms | 1,231.5 ms | 168,448 | 60.7% | 0 |
| 1000 | 932.8 ms | 77,417.8 ms | 77,417.8 ms | 262,051 | 98.5% | 992 |

Every stats report (one per peer every 5 s) recomputed the broadcast totals and
sent them to every peer as `stats_update`, which neither the SDK nor the Node
peer uses.

### After: stats stay on the dashboard SSE stream

| Peers | Probe p50 | Probe p95 | Probe p99 | WS msgs/s | Tracker CPU | Dropped |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 3.8 ms | 7.0 ms | 53.3 ms | 5,002 | 8.8% | 0 |
| 250 | 4.7 ms | 8.6 ms | 10.0 ms | 31,245 | 24.2% | 0 |
| 500 | 4.7 ms | 8.4 ms | 9.8 ms | 124,980 | 47.3% | 0 |
| 1000 | 778.2 ms | 88,671.3 ms | 88,671.3 ms | 286,326 | 98.9% | 468 |

### After: plus per-broadcast subscriber index and one serialization per fan-out

| Peers | Probe p50 | Probe p95 | Probe p99 | WS msgs/s | Tracker CPU | Dropped |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 4.7 ms | 6.7 ms | 6.8 ms | 5,001 | 10.4% | 0 |
| 250 | 4.6 ms | 8.2 ms | 70.2 ms | 31,242 | 24.1% | 0 |
| 500 | 5.0 ms | 10.3 ms | 31.5 ms | 124,988 | 45.6% | 0 |
| 1000 | 942.2 ms | 84,643.5 ms | 84,643.5 ms | 314,410 | 99.3% | 968 |

The fan-out serialized the same message once per recipient and scanned the
subscribers of every broadcast. Serializing once and indexing subscribers by
broadcast trims CPU at 500 peers only slightly (47.3% to 45.6%, within
run-to-run noise) and does not move the saturation point: per-recipient sends
still dominate.

At 1000 peers every variant saturates a core. The backlog grows for the whole
stage, so a probe can wait more than a minute (p95 equals the slowest probe
because a saturated stage completes only a few probes, one of which failed in
each run), and the tracker closes most connections with code 1008 as the
backlog builds. These rows show where the tracker breaks, not a usable
operating point.

## Findings

- One tracker comfortably serves **about 500 active peers in one broadcast**
  (p95 around 10 ms at under half a core), which matches the default
  `MAX_PEERS_PER_BROADCAST=500`, once stats are no longer fanned out.
- At 1000 peers the tracker saturates a core at roughly 260,000 to 310,000
  delivered WebSocket messages per second. The remaining cost is the number of
  inventory messages (`segment_inventory_delta`): each segment report goes to
  every peer, so messages grow with the square of the peer count (about 500
  reports/s times 1000 recipients). Cheaper per-message work does not change
  that.
- The next optimization is to batch segment availability per broadcast, for
  example one aggregated update per segment interval, which turns the fan-out
  from one message per report into one message per interval per peer.
  Sharding by broadcast (ADR option A) adds capacity across broadcasts but not
  within one.
