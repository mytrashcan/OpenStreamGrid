# OpenStreamGrid Scheduler Architecture

## Overview

The scheduler abstraction separates delivery decisions from the code that
executes those decisions. It gives OpenStreamGrid a defined policy boundary for
choosing between P2P and Origin delivery, ranking eligible peers, and assigning
work in a batch without moving transport, cache, verification, or tracker
responsibilities into the policy.

Phase 2 preserves existing behavior because the Node peer and browser SDK
policies are already in production-facing paths. Changing their defaults while
extracting them would make regressions difficult to distinguish from intentional
improvements. Characterization and decision-replay tests record ordering and
fallback details around the shared scheduler interface.

This phase is an extraction, not a scheduling improvement. It makes the current
decisions explicit and testable while preserving public configuration,
thresholds, weights, and runtime-specific policies.

## Decision Boundaries

A scheduler decides:

- whether a segment should use Origin delivery or attempt P2P delivery;
- which peers are eligible, including self-exclusion and trust filtering;
- how eligible peers are ranked;
- whether a request uses one peer or parallel peer probes;
- how segments and distinct peers are assigned within a batch wave; and
- why the plan was selected, expressed as a stable reason code.

The fetcher and transport layers remain responsible for:

- network I/O and request cancellation;
- P2P and Origin timeouts;
- cache reads, writes, and eviction;
- segment integrity verification;
- tracker communication and peer discovery;
- traffic and failure statistics;
- peer failure reporting; and
- executing safe Origin fallback when a P2P plan cannot be completed.

The scheduler does not fetch bytes. It produces a plan from a snapshot of the
available inputs, and the integration layer validates and executes that plan.

## Scheduler Inputs and Outputs

Scheduler inputs are:

- a peer list with identity, segment inventory, latency, success rate, upload
  bandwidth, trust score, and transport metadata where available;
- segment identity and playlist or batch position;
- urgency information such as `segmentsAhead`;
- the local peer ID used for self-exclusion;
- policy defaults and compatible caller configuration; and
- Node observation state when the Node weighted policy is used.

Scheduler outputs are:

- an ordered list of eligible peers;
- a delivery plan of `origin`, `single-peer`, or `parallel-peers`;
- batch assignments when more than one segment is planned; and
- reason codes such as `urgent_origin`, `no_eligible_candidates`,
  `peer_selected`, and `parallel_peer_probe`.

Reason codes describe policy decisions. Runtime failures remain structured
execution results owned by the integration layer.

## Node: Weighted Score Policy

The Node peer uses a normalized weighted score:

| Metric | Weight | Normalization |
| --- | ---: | --- |
| Latency | `0.3` | `1 - min(max(latencyMs, 0) / 1000, 1)` |
| Success rate | `0.3` | Clamped to `[0, 1]` |
| Upload bandwidth | `0.2` | Divided by the maximum candidate bandwidth and clamped to `[0, 1]` |
| Trust | `0.2` | Clamped to `[0, 1]` |

The current Node defaults and behavior are:

- minimum trust score: `0.3`;
- peer metric EMA alpha: `0.3`;
- urgent threshold: `segmentsAhead >= 2` permits a P2P attempt, while a lower
  value uses Origin directly;
- latency normalization is capped at `1000 ms`;
- bandwidth is normalized against the maximum bandwidth among eligible
  candidates;
- a non-positive maximum bandwidth gives every candidate a zero bandwidth
  contribution;
- equal scores preserve input order through JavaScript's stable sort; and
- the local peer is never eligible.

Batch requests preserve the current playlist behavior:

1. Duplicate segment names are removed.
2. Playlist order is reversed so later entries are processed first.
3. Work is divided into waves of at most `maxParallel`, which defaults to `3`.
4. A peer can receive at most one new segment assignment in a wave.
5. Each wave settles before the next wave starts.
6. A failed peer transfer falls back to Origin for that segment without
   discarding successful work in the same wave.

## Browser: Trust-Latency Probe Policy

The browser SDK implements this policy in
`TrustLatencyProbeScheduler` with `policyName =
"trust-latency-probe"`:

1. Exclude the local browser peer while collecting candidates.
2. Sort by trust score descending.
3. For equal trust scores, sort by latency ascending.
4. Probe at most the first `3` peers in parallel.
5. Ignore failed probes while other probes remain pending.
6. Return the first successful result.
7. Abort the remaining probes after a success.
8. Return `null` when every probe fails, allowing the caller to use Origin.

An abort from the segment consumer is forwarded to all active peer probes. The
current probe loop converts those aborted attempts to failed attempts and
returns `null`; the surrounding segment-loading path then observes its own
abort signal before accepting data or continuing normal delivery.

## Why Policies Differ

The Node peer has richer and longer-lived observations. It tracks latency,
success rate, measured upload bandwidth, and trust with an EMA, so a weighted
score can use locally refined peer quality.

Browser peers commonly use WebRTC and transient playback sessions. Their
metrics are less persistent and less reliable, so the browser policy uses the
tracker's current trust and latency values and hedges with a small parallel
probe set.

The policies must not be unified in this phase. Preserving both policies is an
explicit requirement: extraction must not silently replace either runtime's
behavior with the other's assumptions.

## Observation and Feedback

The Node fetcher owns peer observation state and updates it after every P2P
attempt:

```text
fetch attempt -> success or failure -> observed metrics -> EMA update
```

Successful attempts observe elapsed latency, success rate `1`, and bandwidth
derived from transferred bytes and elapsed time. Failed attempts observe
success rate `0` and bandwidth `0`. An integrity failure observes trust `0`
before EMA smoothing.

The browser scheduler has no persistent per-peer observation state. It consumes
the tracker snapshot for each decision and updates only aggregate plugin
traffic and failure counters after execution.

Each browser plan also emits a `scheduler_decision` SDK event with its policy,
mode, reason, candidate count, and selected-peer count. This exposes decisions
without moving transport outcomes or peer observation state into the scheduler.

## State Ownership

The Node `WeightedScoreScheduler` owns a per-instance
`Map<string, PeerQualityMetrics>`. Entries are initialized from tracker peer
metadata, smoothed as new observations arrive, and removed when a peer
disappears from the current candidate list.

The browser `OpenStreamGridHlsPlugin` owns per-plugin aggregate statistics and
in-flight request state, and it holds an injected `SegmentScheduler`. The
default browser scheduler does not own a per-peer observation map and remains a
pure decision over the current candidate snapshot.

## Failure Handling

Scheduler output is untrusted at the integration boundary. The integration
layer must reject malformed plans, unknown plan kinds, ineligible peer
assignments, and assignments that do not match the requested segment.

The safe default is Origin delivery. If there are no eligible peers, all peer
attempts fail, a plan is invalid, or a scheduler throws, the integration layer
must:

1. emit a structured warning with the decision context and failure reason;
2. avoid executing any remaining invalid P2P assignment; and
3. fall back to Origin unless the caller has already aborted.

Transport, HTTP, timeout, cancellation, and integrity failures remain execution
failures rather than scheduler exceptions.

## Tie Handling

Node ranking subtracts weighted scores and has no explicit secondary key.
JavaScript's stable sort therefore preserves the tracker input order for equal
scores. A peer ID tie breaker must not be added during extraction.

Browser ranking uses trust descending and latency ascending. Candidates equal
on both values retain their input order through stable sort. It also has no peer
ID tie breaker.

Both behaviors are characterized and must remain unchanged unless a later,
explicit behavior change is supported by tests and rollout evidence.

## Extension Points (Deferred to Phase 3)

Phase 2 does not include:

- deadline-aware scheduling beyond the existing `segmentsAhead` threshold;
- multi-armed bandit, reinforcement-learning, or other adaptive exploration
  policies;
- unifying the Node weighted-score policy with the browser trust-latency policy;
- changing weights, thresholds, probe counts, EMA behavior, or parallel limits;
- predictive buffer, QoE, playback-stall, or cost optimization;
- multi-source chunk scheduling or new segment-splitting behavior;
- adding a peer ID tie breaker or otherwise changing tie stability;
- persistent cross-session or cross-runtime peer observation state;
- tracker schema, persistence, or discovery-protocol changes;
- transport changes, including new WebRTC, HTTP, or QUIC behavior;
- cache, integrity-verification, or failure-reporting redesign;
- benchmark implementation or benchmark-driven policy tuning; and
- breaking existing scheduler-related configuration or public SDK behavior.

Custom scheduler injection is available through the Node fetcher and browser
SDK configuration. Alternative policies remain responsible for honoring the
shared, I/O-free contract; execution and authoritative Origin fallback stay in
the integration layer.

## Summary

Phase 2 extracts the existing Node and browser scheduling policies without
changing their default decisions. Every default parameter remains preserved,
the Node and browser policies remain intentionally distinct, custom schedulers
can be injected through the shared contract, and decision replay guards both
default policies against unintended drift.
