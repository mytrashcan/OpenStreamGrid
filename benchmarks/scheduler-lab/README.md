# Phase 3 Scheduler Lab

This lab compares OpenStreamGrid's four production scheduling policies in a
controlled, deterministic simulation:

- Node legacy: `WeightedScoreScheduler`
- Node deadline-aware: `DeadlineAwareScheduler` wrapping
  `WeightedScoreScheduler`
- Browser legacy: `TrustLatencyProbeScheduler`
- Browser deadline-aware: the SDK `DeadlineAwareScheduler` wrapping
  `TrustLatencyProbeScheduler`

The runner imports the compiled production schedulers from `peer/dist/` and
`sdk/dist/sdk.js`. It does not duplicate their selection or deadline logic.
Only transport timing, peer success, and Origin timing are simulated.

This is a scheduler experiment, not a network load test or a production
capacity claim. Its results show how the policies react to identical synthetic
requests under controlled assumptions. They do not predict throughput, viewer
capacity, Internet latency, or CDN savings in a production deployment.

## Run

Build the production packages, then pass one checked-in scenario to the runner:

```bash
npm run build
npm run benchmark:scheduler -- benchmarks/scheduler-lab/scenarios/mixed-workload.json
```

Every scenario contains a fixed seed. Repeating a scenario produces the same
request samples and policy outcomes; only the artifact timestamp and output
directory change.

## Scenarios

| Scenario | Controlled condition |
| --- | --- |
| `relaxed.json` | 6,000 ms slack with reliable peers |
| `tight.json` | 2,000 ms slack with variable peer timing |
| `critical.json` | 500 ms slack |
| `slow-origin.json` | 2,000 ms Origin latency |
| `unreliable-peers.json` | 50% peer success probability |
| `mixed-workload.json` | Relaxed, tight, critical, and unknown deadlines |

## Artifacts

Each run writes the following files below
`results/<scenario>_<seed>_<timestamp>/`:

- `raw.json`: every scheduler decision and simulated completion
- `aggregate.json`: policy-level and deadline-kind summaries
- `results.csv`: flat request-level results
- `report.md`: human-readable policy comparison
- `deadline-met-rate.svg`: inline SVG bar chart
- `winning-source-rate.svg`: inline SVG bar chart

The runner also writes a timestamped `*_aggregate.json` convenience copy
directly below `results/`. This makes the documented README update command
shell-friendly:

```bash
node scripts/benchmark-update-readme-scheduler.mjs \
  benchmarks/scheduler-lab/results/*aggregate.json README.md README.ko.md
```

If the glob contains multiple runs, the updater publishes the newest aggregate
by `generatedAt`.

## Simulation model

The fixed-seed workload is generated once and replayed unchanged for every
policy. Each request includes advertised peer metrics, realized peer
completion/failure samples, Origin latency, and a playback deadline.

Legacy policies try their selected peers first and start Origin after the peer
attempt resolves or reaches the configured timeout. Deadline-aware policies
execute the production plan's `origin-only`, `legacy-p2p-first`, or
`hedged-origin` hint. Node hedged requests enforce the production peer-attempt
budget; browser hedged requests preserve the SDK's parallel probe behavior.
Origin latency estimates are updated only after a completed Origin win.

The seed controls all simulated variation. No wall-clock timing, sockets,
HTTP requests, or browser APIs participate in the experiment.
