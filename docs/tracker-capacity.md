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
peers currently hold), WebSocket messages and megabytes delivered per second,
tracker CPU (CPU time used during the stage divided by its wall time, from
`ps`) and RSS, and connection failures.

Simulated peers declare the `inventory_batch` subscribe feature like the SDK
and the Node peer. Pass `--inventory-batch false` to measure clients that
receive every inventory report as its own message; the first three tables below
predate the feature and were measured that way.

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

### After: inventory batching (`inventory_batch`)

| Peers | Probe p50 | Probe p95 | Probe p99 | WS msgs/s | WS MB/s | Tracker CPU | Dropped |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 5.9 ms | 6.8 ms | 8.3 ms | 381 | 0.3 | 4.5% | 0 |
| 250 | 8.5 ms | 10.7 ms | 29.2 ms | 965 | 2.0 | 8.8% | 0 |
| 500 | 11.9 ms | 14.7 ms | 15.0 ms | 1,919 | 8.0 | 13.4% | 0 |
| 1000 | 18.0 ms | 25.8 ms | 64.0 ms | 3,759 | 31.6 | 22.9% | 0 |
| 2000 | 22.9 ms | 43.4 ms | 57.6 ms | 13,713 | 127.0 | 32.5% | 0 |

The tracker merges inventory updates per peer and sends each subscriber one
`segment_inventory_batch` every 250 ms for every 256 peers that changed in that
interval. With 2 s segments that is four messages per second per subscriber
until about 2000 active peers (some batches split in two at 2000), after which
it grows in steps. Total messages still grow with the square of the audience,
but about 256 times more slowly than one message per report. CPU at 1000 peers
drops from a saturated core to under a quarter of one, and 2000 peers run
without drops.

Probe latency is higher than with legacy clients at the same peer count (p50
11.9 ms against 4.7 ms at 500 peers) and grows with the audience. Each flush
writes the batch to every subscriber in one event-loop turn, so a probe that
arrives during a flush waits for it, and the probe response itself lists every
peer that holds the segment. Spreading a flush across several turns would
trade some of that wait for batch delay.

### With the monitoring dashboard open

The dashboard's SSE stream sends a snapshot of every peer with its segments.
Every stats report (one per peer every 5 s) and every join or leave used to
rebuild and send one, so a single open dashboard dominated the tracker.
Event-driven snapshots are now coalesced to at most one per second (the first
at once, the rest in one trailing update). The "before" rows were measured
with neighbor views and the "after" rows with batching only, whose signaling
is heavier, so the improvement is if anything understated.

| Peers | Dashboard | Probe p95 | Tracker CPU | SSE data in the run |
| ---: | --- | ---: | ---: | ---: |
| 500 | before | 534.0 ms | 28.4% | |
| 1000 | before | 3,896.7 ms | 70.7% | 4.4 GB for both stages |
| 500 | after | 16.3 ms | 14.3% | |
| 1000 | after | 28.7 ms | 22.8% | 17.5 MB for both stages |

## Findings

- With clients that negotiate `inventory_batch` (the SDK and the Node peer),
  one tracker serves **2000 active peers in one broadcast** at a third of a
  core with p95 under 50 ms. The default `MAX_PEERS_PER_BROADCAST=500` leaves
  a wide margin; raise it after measuring on the target hardware.
- With legacy clients, the limit is **about 500 active peers in one broadcast**
  (p95 around 10 ms at under half a core). At 1000 the tracker saturates a core
  at roughly 260,000 to 310,000 delivered WebSocket messages per second,
  because each inventory report goes to every peer and messages grow with the
  square of the peer count.
- Batching cuts messages, not bytes: every update still reaches every peer,
  so delivered bytes grow with the square of the peer count (127 MB/s at 2000
  peers, about 1 Gbit/s). That is the next limit within one broadcast. Sending
  each peer only the inventory of the peers it may connect to would remove it.
  Sharding by broadcast (ADR option A) adds capacity across broadcasts but not
  within one.
