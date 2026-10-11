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
(`GET /api/v1/broadcasts/:id/peers?segment=…` every 0.5 s), WebSocket messages
delivered per second, the tracker process CPU and RSS (sampled with `ps`), and
connection failures.

## Results

Apple M5 (10 cores), Node.js 22.23, SQLite store, load generator on the same
machine, 30 s per stage. CPU is one tracker process; 100% is one core. Results
depend on hardware; rerun the script on your target environment.

### Before: stats fan-out to every peer

| Peers | Probe p50 | Probe p95 | Probe p99 | WS msgs/s | Tracker CPU | Dropped |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 3.8 ms | 6.1 ms | 7.4 ms | 6,680 | 12.0% | 0 |
| 250 | 5.4 ms | 133.1 ms | 221.8 ms | 41,681 | 36.6% | 0 |
| 500 | 4.6 ms | 1,046.3 ms | 1,513.3 ms | 168,321 | 56.7% | 0 |
| 1000 | 965.3 ms | 67,650.6 ms | 67,650.6 ms | 261,261 | 100.2% | 979 |

Every stats report (one per peer every 5 s) recomputed the broadcast totals and
sent them to every peer as `stats_update`, which neither the SDK nor the Node
peer uses.

### After: stats stay on the dashboard SSE stream

| Peers | Probe p50 | Probe p95 | Probe p99 | WS msgs/s | Tracker CPU | Dropped |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 4.1 ms | 5.8 ms | 6.4 ms | 4,998 | 12.5% | 0 |
| 250 | 4.2 ms | 6.1 ms | 7.2 ms | 31,249 | 25.0% | 0 |
| 500 | 4.7 ms | 6.8 ms | 8.0 ms | 124,984 | 48.7% | 0 |
| 1000 | 967.2 ms | 15,780.5 ms | 15,780.5 ms | 283,644 | 99.0% | 0 |

## Findings

- One tracker comfortably serves **about 500 active peers in one broadcast**
  (p95 under 10 ms at roughly half a core), which matches the default
  `MAX_PEERS_PER_BROADCAST=500`.
- At 1000 peers the tracker saturates a core. The remaining cost is the
  `segment_available` fan-out: each segment report goes to every other peer,
  so messages grow with the square of the peer count (about 500 reports/s
  times 1000 recipients).
- The next optimization is to batch segment availability per broadcast, for
  example one aggregated update per segment interval, which turns the fan-out
  from one message per report into one message per interval per peer.
  Sharding by broadcast (ADR option A) adds capacity across broadcasts but not
  within one.
