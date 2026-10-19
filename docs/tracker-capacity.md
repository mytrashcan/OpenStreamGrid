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
`ps`) and RSS, and connection failures. It also prints how long joining and
connecting the peers took.

Simulated peers declare the `inventory_batch` and `neighbor_view` subscribe
features like the SDK and the Node peer. Pass `--neighbor-view false` to send
every client the whole audience, or `--inventory-batch false` to measure
clients that receive every inventory report as its own message. The first
three tables below predate both features and were measured that way; the
batching table predates neighbor views.

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

### After: neighbor views (`neighbor_view`, 64 neighbors)

| Peers | Probe p50 | Probe p95 | Probe p99 | WS msgs/s | WS MB/s | Tracker CPU | Dropped |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 500 | 11.7 ms | 14.9 ms | 18.4 ms | 1,904 | 1.2 | 15.2% | 0 |
| 1000 | 16.9 ms | 23.3 ms | 57.2 ms | 3,701 | 2.3 | 23.8% | 0 |
| 2000 | 23.7 ms | 30.7 ms | 35.1 ms | 7,144 | 4.7 | 31.7% | 0 |
| 4000 | 28.2 ms | 61.7 ms | 195.0 ms | 13,556 | 9.3 | 40.2% | 0 |

Each client hears about 64 neighbors instead of the whole audience, so
delivered bytes grow linearly: 4.7 MB/s at 2000 peers against 127 MB/s with
batching alone, and 9.3 MB/s at 4000. CPU is about the same as with batching
alone, because the tracker still writes the same number of messages; it is now
the limit, at under half a core for 4000 peers. Probe latency at 4000 peers
reflects the 4000-entry probe response as well as flush time.

Measuring 4000 peers exposed per-peer work that scanned the whole audience:
the WebSocket upgrade, `subscribe`, and the rejoin check each listed every
peer (with its segments) to find one. With single-peer lookups, 4000 peers
join in 0.8 s and connect in 1.2 s; connecting took 24.8 s before, long enough
for the first peers to expire.

## Findings

- With clients that negotiate `inventory_batch` and `neighbor_view` (the SDK
  and the Node peer), one tracker serves **4000 active peers in one broadcast**
  at under half a core and about 10 MB/s of signaling. The default
  `MAX_PEERS_PER_BROADCAST=500` leaves a wide margin; raise it after measuring
  on the target hardware.
- With legacy clients, the limit is **about 500 active peers in one broadcast**
  (p95 around 10 ms at under half a core). At 1000 the tracker saturates a core
  at roughly 260,000 to 310,000 delivered WebSocket messages per second,
  because each inventory report goes to every peer and messages grow with the
  square of the peer count.
- Batching alone cuts messages, not bytes: every update still reaches every
  peer, so delivered bytes grow with the square of the peer count (127 MB/s at
  2000 peers, about 1 Gbit/s). Neighbor views make bytes grow linearly.
- The remaining limit within one broadcast is tracker CPU for writing batches
  and serving REST, which grows linearly with the audience. Sharding by
  broadcast (ADR option A) adds capacity across broadcasts but not within one.
