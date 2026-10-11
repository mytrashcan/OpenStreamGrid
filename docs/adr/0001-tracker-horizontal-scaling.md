# ADR 0001: Tracker horizontal scaling

- **Status:** Proposed — awaiting a maintainer decision
- **Date:** 2026-10-11
- **Scope:** `tracker/`, Helm chart, browser SDK and Node peer tracker clients

## Context

The tracker runs as a single replica. The Helm chart refuses autoscaling and
multiple replicas with the default SQLite store, and with `STORE_TYPE=memory`
each replica would hold disjoint state. That makes the tracker both a single
point of failure and the limit on how many peers one deployment can serve.

What is already instance-independent:

- **Peer session tokens** are HMAC-signed with `PEER_SESSION_SECRET`, so any
  replica that shares the secret can verify them.
- **The origin and media delivery** do not depend on the tracker after peers
  have segments; viewers fall back to the origin when the tracker is down.

What is bound to one process today:

| State | Where | Why it matters for scaling |
| --- | --- | --- |
| Broadcasts, peers, segment ownership, stats | `TrackerStoreBackend` (memory or SQLite) | The interface is **synchronous** (18 methods). Atomic peer admission (`joinPeerDetailed`, #47) relies on a synchronous transaction. |
| WebSocket subscriptions and WebRTC signaling relay | `TrackerWebSocketHub` maps | An offer from peer A is forwarded to peer B's socket, so **both must be connected to the same process**. |
| Per-IP WebSocket limits, REST rate-limit buckets | in-memory maps | Limits become per-replica. |
| Dashboard SSE clients, Prometheus counters | `TrackerStatsSse`, `TrackerMetrics` | Views and counters become per-replica. |

## Decision drivers

1. Survive the loss of a tracker instance without a long playback-affecting
   outage (viewers already fall back to the origin, so the impact is lost P2P
   offload, not failed playback).
2. Serve more peers than one instance can handle.
3. Keep the operational footprint small for a middleware project.
4. Avoid a risky rewrite of the admission and signaling paths that #47 hardened.

## Options

### A. Broadcast sharding (stateful shards, route by broadcast ID)

Each replica owns a subset of broadcasts. Ingress or a thin router uses
consistent hashing on the broadcast ID; peers send it on every request (an
`X-OpenStreamGrid-Broadcast` header for REST and a `broadcastId` query
parameter on `/ws`). The chart runs a StatefulSet with one SQLite volume per
shard.

- **Pros:** No change to the synchronous store or to admission atomicity. All
  peers of a broadcast meet on one replica, so signaling stays local. Scales
  with the number of broadcasts.
- **Cons:** One very large broadcast is still limited to one replica. Global
  endpoints (broadcast list, global stats, dashboard, `/metrics`) need
  aggregation or become per-shard. Losing a shard drops P2P for its broadcasts
  until the pod restarts (state survives on its volume). Resharding moves
  broadcasts, which means peers rejoin; sessions are re-issued on join, so this
  is recoverable.
- **Effort:** Medium. Routing header/query in the SDK and Node peer, Helm
  StatefulSet and ingress annotations, a fan-out for global endpoints.

### B. Shared store and pub/sub (for example Redis)

All replicas are stateless. Broadcasts, peers, segments, and stats live in an
external store. Signaling, peer events, and SSE fan out through pub/sub channels
per broadcast; rate limits use the shared store.

- **Pros:** True active-active. Any replica serves any request, and a hot
  broadcast scales across replicas.
- **Cons:** `TrackerStoreBackend` becomes asynchronous, which touches every
  call site in `server.ts` and `websocket.ts`. Admission atomicity must be
  rebuilt (transactions or Lua scripts). Adds a stateful dependency to operate
  and secure, and network latency to every tracker call.
- **Effort:** Large. Async store refactor, a Redis adapter, cross-replica
  signaling and events, migration and tests.

### C. Single active replica with fast recovery (current model, hardened)

Keep one replica and make failure cheap: persistent SQLite (already the
default), startup and readiness probes (already in the chart), a priority class
so the tracker is rescheduled first, peers that reconnect with backoff (already
implemented), and a documented recovery time. A `PodDisruptionBudget` is not
useful here: with one replica it would only block node drains.

- **Pros:** Smallest change and no new failure modes. Viewers keep playing from
  the origin during the gap.
- **Cons:** No horizontal scaling; seconds to minutes of lost P2P offload during
  restarts.
- **Effort:** Small.

## Recommendation

1. **Now:** harden option C, which is cheap and already mostly in place:
   an optional priority class in the chart and a documented recovery time
   (both done; see the Kubernetes guide's *Recovery* section), and a measured
   capacity figure.
2. **Measure:** done in [Tracker capacity](../tracker-capacity.md). One
   instance serves about 500 active peers per broadcast with p95 under 10 ms;
   at 1000 the `segment_available` fan-out saturates a core. Batching segment
   availability is the next step before scaling out.
3. **When the deployment has many broadcasts:** adopt **option A**. It delivers
   scale-out without destabilizing admission or signaling.
4. **Only if one broadcast outgrows one instance:** adopt **option B**, staged
   behind the existing `STORE_TYPE` switch as a new `redis` backend after the
   store interface is made asynchronous.

## Consequences

- Choosing A commits the SDK and Node peer to sending the broadcast ID on every
  tracker request, which is backward compatible because the tracker ignores it
  today.
- Choosing B commits the project to running and securing Redis and to an
  asynchronous store interface; the in-memory and SQLite backends must be
  adapted too.
- Either way, the dashboard and `/metrics` need a cluster-wide view, either by
  aggregation or by scraping every replica.
