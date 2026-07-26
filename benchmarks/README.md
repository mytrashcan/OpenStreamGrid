# OpenStreamGrid Benchmarks

This directory contains versioned benchmark inputs and generated result storage.
The scenarios are intended for repeatable regression comparisons on a controlled
development or CI host. They are not production capacity claims.

## Structure

- `scenarios/` contains checked-in benchmark configurations.
- `schema/benchmark-scenario.schema.json` defines scenario version 1 using JSON
  Schema draft-07.
- `results/` is the default location for generated benchmark artifacts. Only its
  `.gitkeep` placeholder is committed.

## Running a scenario

Validate a scenario before running it:

```bash
node scripts/validate-benchmark-schema.mjs benchmarks/scenarios/baseline.json
```

Run the Docker benchmark:

```bash
bash scripts/benchmark.sh --scenario benchmarks/scenarios/baseline.json
```

Configuration precedence is:

1. scenario file values;
2. environment variable overrides;
3. `scripts/benchmark.sh` CLI flag overrides.

The benchmark runner keeps the existing environment variables and also accepts
the scenario-oriented variables below.

| Scenario field | Environment override | Runner CLI flag |
| --- | --- | --- |
| `peerCount` | `PEER_COUNT` | `--peers` |
| `durationSeconds` | `DURATION_SECONDS` | `--duration` |
| `rampUpSeconds` | `RAMP_UP_SECONDS` | `--ramp-up` |
| `churnProbability` | `CHURN_RATE` | `--churn` |
| `p2pEnabled` | `P2P_ENABLED` | `--p2p-enabled` |
| `quality` | `QUALITY` | `--quality` |
| `segmentDurationSeconds` | `SEGMENT_DURATION_SECONDS` | `--segment-duration` |
| `uploadBandwidthLimit` | `UPLOAD_BANDWIDTH_MBPS` | `--upload-bandwidth-limit` |
| `concurrentUploadLimit` | `MAX_UPLOAD_CONNECTIONS` | `--concurrent-upload-limit` |
| `p2pTimeoutMs` | `P2P_TIMEOUT_MS` | `--p2p-timeout-ms` |
| `randomSeed` | `SEED` | `--seed` |

`repetitionCount` records the intended number of repetitions for later benchmark
orchestration. Chunk 1 executes one run per invocation.

## Included scenarios

- `baseline.json`: the standard 10-peer deterministic comparison.
- `no-churn.json`: isolates steady-state delivery by keeping all peers online.
- `high-churn.json`: stresses peer discovery and Origin fallback with a 50%
  per-check churn probability.
- `origin-only.json`: disables P2P to establish the Origin traffic reference.
- `ci-smoke.json`: a short three-peer configuration for CI wiring checks.
