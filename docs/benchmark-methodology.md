# OpenStreamGrid Benchmark Methodology

## Purpose

The OpenStreamGrid benchmark provides a reproducible way to measure changes in
hybrid P2P-Origin delivery behavior. It is intended for regression detection,
implementation comparisons, and validation of benchmark plumbing. It is not a
capacity-planning exercise and does not predict the behavior of a production
streaming service.

Versioned scenarios under `benchmarks/scenarios/` define the workload. Raw
results use schema version 2, while `scripts/benchmark-suite.mjs` repeats a
scenario and produces aggregate JSON, Markdown, and CSV summaries.

## System under test

The benchmark exercises three OpenStreamGrid components:

1. **Origin server**: generates and serves adaptive HLS playlists, MPEG-TS
   segments, and SHA-256 sidecars.
2. **Tracker server**: registers the broadcast, manages peer sessions and
   segment availability, and distributes peer updates over WebSocket.
3. **Virtual peers**: fetch segments from eligible peers when possible, serve
   cached segments over HTTP, and fall back to the Origin after a failed or
   unavailable P2P path.

The benchmark does not include a production CDN. The Origin HTTP server
represents the reliable Origin/CDN path for metric naming and fallback
behavior.

## Topology

`scripts/benchmark.sh` starts the Origin and Tracker with Docker Compose, then
runs one `load-test` container on the same user-defined bridge network. The
load-test process creates the configured number of virtual peers in one Node.js
process and exposes one shared HTTP upload server that routes requests to each
peer's independent cache and limits.

All services run on one physical or virtual Docker host. Consequently, peer and
Origin traffic traverse the host's Docker bridge and kernel network stack; no
wide-area network, NAT traversal, or geographically distributed latency is
present.

## Origin and Tracker configuration

The Compose topology uses one broadcast named `live`.

- The Tracker listens on port 7070, uses its normal peer-session and WebSocket
  paths, and stores state in the benchmark's isolated Compose project.
- The Origin listens on port 8080, registers the broadcast with the Tracker,
  writes HLS output to a container-local temporary filesystem, and publishes
  the low, medium, and high renditions.
- `scripts/benchmark.sh` creates an isolated Compose project, waits for both
  health endpoints, and removes its containers, network, volumes, and orphans
  through an `EXIT` trap.
- The scenario's `segmentDurationSeconds` value is passed to the Origin.
  Other scenario values configure the virtual-peer process.

Host environment overrides and command-line flags can change a scenario at run
time. The raw result records the resolved scenario, command, random seed, Node
version, platform, architecture, CPU count, memory, and execution time. Compare
those provenance fields before treating two aggregates as comparable.

## Peer behavior

`test/load-test.mjs` is a virtual-peer load generator rather than the production
Node peer executable. Each virtual peer:

- joins the Tracker after a deterministic ramp-up delay;
- subscribes to peer and segment updates over WebSocket;
- polls its selected media playlist;
- maintains an independent bounded segment cache;
- shuffles eligible segment owners with the seeded pseudo-random generator;
- tries up to the configured number of peers with a P2P deadline;
- immediately requests the segment from the Origin when no peer is eligible or
  all attempted P2P requests fail;
- reports segment possession and transfer statistics to the Tracker;
- serves cached segments through the shared upload server while enforcing
  per-peer bandwidth and concurrent-upload limits; and
- may leave and rejoin based on the scenario's churn probability.

The generator does not decode video, render frames, or maintain a real media
player buffer.

## Media properties

The Origin invokes FFmpeg with a synthetic `testsrc2` video pattern at 1280×720
and 30 frames per second plus a synthetic 1 kHz audio source. It creates three
HLS renditions:

| Rendition | Resolution | Video bitrate | Audio bitrate |
| --- | ---: | ---: | ---: |
| `low` | 640×360 | 500 kbit/s | 64 kbit/s |
| `med` | 854×480 | 1,500 kbit/s | 128 kbit/s |
| `high` | 1280×720 | 3,000 kbit/s | 128 kbit/s |

Scenarios select one rendition and define the target HLS segment duration.
Generated segment sizes can vary because encoding a moving test pattern is not
byte-for-byte constant across all FFmpeg versions and host capabilities.

## Metric definitions

Let:

- \(S_{p2p}\) be successful P2P segment requests;
- \(R_{p2p}\) be all P2P transport requests;
- \(R_{origin}\) be logical segment requests sent to the Origin;
- \(F_{fallback}\) be logical segment fetches that tried P2P before Origin;
- \(B_{p2p}\) and \(B_{origin}\) be downloaded bytes from each source;
- \(D\) be deadline misses;
- \(A\) be total logical segment attempts, calculated as
  \(S_{p2p} + R_{origin}\); and
- \(x_i\) be the bytes uploaded by peer \(i\).

### P2P efficiency

\[
\text{P2P efficiency} =
\frac{S_{p2p}}{S_{p2p} + R_{origin}} \times 100
\]

This measures the share of completed logical fetch paths served by peers. It is
not the same as the P2P transport success rate.

### CDN traffic reduction

\[
\text{CDN traffic reduction} =
\frac{B_{p2p}}{B_{p2p} + B_{origin}} \times 100
\]

The name assumes peer-delivered bytes replace bytes that would otherwise use
the Origin/CDN path. In this topology, the measured non-P2P endpoint is the
local Origin rather than a commercial CDN.

### P2P success rate

\[
\text{P2P success rate} =
\frac{S_{p2p}}{R_{p2p}} \times 100
\]

If no P2P requests occur, the implementation reports zero rather than an
undefined percentage.

### Fallback rate

\[
\text{Fallback rate} =
\frac{F_{fallback}}{R_{p2p}} \times 100
\]

A fallback is counted once for a logical segment even when more than one peer
was attempted. Therefore the numerator and denominator have different units
when multiple peer attempts are enabled; use this metric primarily for
same-scenario regression comparisons.

### Deadline miss rate

\[
\text{Deadline miss rate} = \frac{D}{A} \times 100
\]

The current generator increments \(D\) for every failed P2P transport attempt
and uses logical segment attempts for \(A\). With multiple peer attempts, the
rate can exceed the share of logical segments that experienced a delay. Read it
alongside `requestTimeoutCount` and the configured maximum peer attempts.

### Jain's fairness index

\[
J(x_1,\ldots,x_n) =
\frac{\left(\sum_{i=1}^{n}x_i\right)^2}
{n\sum_{i=1}^{n}x_i^2}
\]

The index is 1 when upload bytes are perfectly even across peers and approaches
\(1/n\) when one peer supplies nearly all bytes. The benchmark reports 1 when
all peers upload zero bytes, meaning there is no observed inequality; that
special case does not demonstrate useful P2P participation.

### Stall proxy

`stallProxyDurationMs` is a synthetic delay indicator, not observed playback
stall time. For each P2P-to-Origin fallback, the current generator adds twice
the measured Origin fetch latency:

\[
\text{stall proxy} =
\sum_{\text{fallbacks}} 2 \times
\text{Origin fetch latency}_{i}
\]

The factor of two deliberately makes the proxy sensitive to slow fallback
paths. Because no video is decoded and no buffer is modeled, this value must
not be described as rebuffering time or viewer stall duration.

### Latency percentiles

`fetchLatencyMs.p50`, `.p95`, and `.p99` use the nearest-rank percentile over
recorded successful P2P and Origin fetch durations. The aggregate suite then
summarizes each per-run percentile; it does not pool all request samples across
runs.

## Experimental controls

### Fixed seed

Each scenario supplies an unsigned 32-bit `randomSeed`. The seeded PRNG controls
peer ordering, polling intervals, and churn decisions. The resolved seed is
stored in result provenance. A fixed seed controls application-level random
choices but cannot control Docker or operating-system scheduling.

### Warm-up

Peer joins are distributed over `rampUpSeconds`. This ramp is part of the
measured run rather than a separately discarded warm-up interval. For
steady-state analysis, choose a duration long enough that the ramp is a small
fraction of the run and keep it identical across comparisons.

### Repetition

`repetitionCount` specifies the number of independent executions performed by
`scripts/benchmark-suite.mjs`. Each execution rebuilds the isolated Docker
topology and uses the same scenario seed. This distinguishes run-to-run
infrastructure noise from differences caused by changing the simulated random
sequence.

Other controls include a versioned scenario file, a fixed HLS rendition,
explicit upload and concurrency limits, an isolated Compose project name, and
captured environment provenance.

## Repetition strategy

Use the short `ci-smoke` scenario to verify wiring, not to characterize
performance. For a regression decision:

1. select one checked-in scenario and keep it unchanged;
2. set a repetition count appropriate to the variability and cost of the run;
3. run the baseline and candidate on comparable idle hosts;
4. alternate baseline and candidate execution order when host conditions may
   drift over time;
5. retain raw per-run JSON and inspect failed runs; and
6. compare both effect size and confidence intervals.

Three repetitions are only a minimal smoke-level statistical sample. Prefer
more repetitions when variance is high or the expected effect is small.

## Statistical aggregation

For every finite numeric value under `result.metrics`, the suite reports:

- count;
- arithmetic mean;
- median;
- minimum and maximum;
- sample standard deviation, using denominator \(n-1\); and
- a two-sided 95% confidence interval for the mean.

For 2 through 30 samples, the confidence interval is:

\[
\bar{x} \pm t_{0.975,n-1}\frac{s}{\sqrt{n}}
\]

where \(\bar{x}\) is the sample mean, \(s\) is the sample standard deviation,
and the critical value comes from Student's t distribution. For more than 30
samples, the implementation uses 1.96 as the normal approximation. A single
sample has zero reported standard deviation and a zero-width interval; this
reflects insufficient information, not certainty.

Traffic counters used by reports are aggregated separately with the same
statistics. Failed runs are listed and excluded from numeric summaries.

## Known sources of noise

- Docker container startup, image build caching, and CPU scheduling;
- Linux bridge, virtual Ethernet, loopback, and host network-stack behavior;
- competing host processes, filesystem activity, and memory pressure;
- CPU frequency scaling, thermal throttling, and virtual-machine throttling;
- Node.js garbage collection and event-loop scheduling;
- FFmpeg version, codec implementation, and encoder scheduling;
- transient Tracker, Origin, and load-generator startup timing; and
- wall-clock drift and timer resolution.

Run benchmarks on an otherwise idle host, record provenance, and avoid comparing
results across materially different Docker, Node.js, FFmpeg, kernel, CPU, or
virtualization configurations.

## Limitations

- The topology is single-host and does not model internet latency, loss,
  congestion, NAT, TURN relays, or geographic distribution.
- Traffic is synthetic and uses an FFmpeg test pattern rather than a real live
  production encoder and content mix.
- Virtual peers share one Node.js process and one upload server, so they do not
  reproduce independent devices, browsers, clocks, or network interfaces.
- There is no real browser, Hls.js integration, decoder, adaptive player
  buffer, or viewer quality-of-experience measurement.
- P2P transfer uses the benchmark's HTTP virtual-peer path.
- The local Origin stands in for both Origin and CDN behavior.
- A fixed seed does not make execution timing deterministic.
- Confidence intervals quantify variation in the observed sample only; they do
  not remove systematic bias in the topology or workload.

## Reproduction

Requirements are Node.js 22 or later, npm dependencies, Docker Engine, and
Docker Compose v2.

Validate a scenario:

```bash
node scripts/validate-benchmark-schema.mjs \
  benchmarks/scenarios/baseline.json
```

Run one raw benchmark:

```bash
bash scripts/benchmark.sh \
  --scenario benchmarks/scenarios/baseline.json \
  --output benchmark-results.json
```

Run the configured repetitions and generate aggregates:

```bash
node scripts/benchmark-suite.mjs benchmarks/scenarios/baseline.json
```

Generate SVG charts from the emitted aggregate:

```bash
node scripts/benchmark-report.mjs \
  benchmarks/results/<scenario>-<timestamp>-aggregate.json
```

Compare two aggregates:

```bash
node scripts/benchmark-compare.mjs \
  benchmarks/results/<baseline>-aggregate.json \
  benchmarks/results/<candidate>-aggregate.json
```

Convert an aggregate for a continuous-benchmark service:

```bash
node scripts/benchmark-bencher.mjs \
  benchmarks/results/<scenario>-aggregate.json
```

Generated raw results, summaries, and charts should remain build artifacts.
Do not commit them as project performance claims.

## Interpretation guidelines

- Compare identical scenarios and matching environment provenance.
- Treat P2P efficiency and CDN traffic reduction as complementary: request
  counts and bytes can move differently when segment sizes vary.
- Read success, fallback, timeout, deadline-miss, and stall-proxy metrics
  together rather than optimizing one in isolation.
- Inspect the raw result and failed-run list before relying on an aggregate.
- Consider the confidence interval and practical effect size; a directional
  change smaller than run-to-run noise is not actionable evidence.
- A high fairness index with zero upload traffic is not a successful P2P result.
- Do not infer viewer quality from the stall proxy or fetch percentiles without
  a player-buffer experiment.

## Why these are not production capacity claims

Production capacity depends on distributed client hardware, access networks,
geography, NAT behavior, browser constraints, real content bitrates, CDN edge
placement, failures, observability overhead, and sustained service load. This
benchmark intentionally excludes most of those factors and co-locates all
traffic on one host. Its results can reveal regressions within a controlled
development setup, but they cannot establish supported concurrency, bandwidth
savings, latency service-level objectives, or viewer quality for a production
deployment.
