#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_NAME="${BENCHMARK_PROJECT_NAME:-openstreamgrid-benchmark}"
COMPOSE=(docker compose --project-directory "$ROOT_DIR" --project-name "$PROJECT_NAME")
PEER_COUNT="${PEER_COUNT:-10}"
DURATION_SECONDS="${DURATION_SECONDS:-60}"
RAMP_UP_SECONDS="${RAMP_UP_SECONDS:-5}"
CHURN_RATE="${CHURN_RATE:-0.15}"
REPORT_INTERVAL_SECONDS="${REPORT_INTERVAL_SECONDS:-10}"
BENCHMARK_OUTPUT="${BENCHMARK_OUTPUT:-$ROOT_DIR/benchmark-results.json}"
TRACKER_URL="${TRACKER_URL:-http://127.0.0.1:7070}"
ORIGIN_URL="${ORIGIN_URL:-http://127.0.0.1:8080}"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openstreamgrid-benchmark.XXXXXX")"
BENCHMARK_SUCCEEDED=0

log() {
  printf '[Benchmark] %s\n' "$*"
}

fail() {
  printf '[Benchmark] ERROR: %s\n' "$*" >&2
  return 1
}

cleanup() {
  local exit_code=$?
  if [[ "$BENCHMARK_SUCCEEDED" -ne 1 ]]; then
    "${COMPOSE[@]}" ps || true
    "${COMPOSE[@]}" logs --no-color --tail=120 || true
  fi
  "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  if [[ -d "$TEMP_DIR" && "$TEMP_DIR" == *openstreamgrid-benchmark.* ]]; then
    rm -r -- "$TEMP_DIR"
  fi
  return "$exit_code"
}
trap cleanup EXIT

wait_for_url() {
  local name="$1"
  local url="$2"
  local attempts="${3:-90}"
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl --fail --silent --show-error --max-time 3 "$url" >/dev/null 2>&1; then
      log "$name is healthy"
      return 0
    fi
    sleep 1
  done
  fail "Timed out waiting for $name at $url"
}

for command_name in curl docker node tee; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "Required command '$command_name' was not found"
done
docker compose version >/dev/null
docker info >/dev/null

node -e '
  const [peers, duration, rampUp, churn, reportInterval] = process.argv.slice(1).map(Number);
  if (!Number.isSafeInteger(peers) || peers < 2) throw new Error("PEER_COUNT must be an integer of at least 2");
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("DURATION_SECONDS must be positive");
  if (!Number.isFinite(rampUp) || rampUp < 0) throw new Error("RAMP_UP_SECONDS cannot be negative");
  if (!Number.isFinite(churn) || churn < 0 || churn > 1) throw new Error("CHURN_RATE must be between 0 and 1");
  if (!Number.isFinite(reportInterval) || reportInterval <= 0) throw new Error("REPORT_INTERVAL_SECONDS must be positive");
' "$PEER_COUNT" "$DURATION_SECONDS" "$RAMP_UP_SECONDS" "$CHURN_RATE" "$REPORT_INTERVAL_SECONDS"

cd "$ROOT_DIR"
log "Removing any stale isolated benchmark stack"
"${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true

log "Starting tracker and origin"
"${COMPOSE[@]}" up --detach --build tracker origin
wait_for_url tracker "$TRACKER_URL/health"
wait_for_url origin "$ORIGIN_URL/health"

log "Building the virtual-peer load generator"
"${COMPOSE[@]}" build load-test

log "Running $PEER_COUNT virtual peers for ${DURATION_SECONDS}s with churn rate $CHURN_RATE"
"${COMPOSE[@]}" run --rm --no-deps load-test \
  --peers "$PEER_COUNT" \
  --duration "$DURATION_SECONDS" \
  --ramp-up "$RAMP_UP_SECONDS" \
  --churn "$CHURN_RATE" \
  --report-interval "$REPORT_INTERVAL_SECONDS" \
  | tee "$TEMP_DIR/load-test.log"

result_json="$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const prefix = "[LoadTest] RESULT ";
  const line = readFileSync(process.argv[1], "utf8")
    .split(/\r?\n/)
    .findLast((entry) => entry.startsWith(prefix));
  if (!line) throw new Error("Load test did not emit a benchmark result");
  const result = JSON.parse(line.slice(prefix.length));
  if (result.schemaVersion !== 1) throw new Error("Unsupported benchmark schema");
  process.stdout.write(JSON.stringify(result));
' "$TEMP_DIR/load-test.log")"

node --input-type=module -e '
  import { mkdirSync, writeFileSync } from "node:fs";
  import { dirname, resolve } from "node:path";
  const result = JSON.parse(process.argv[1]);
  const destination = resolve(process.argv[2]);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(destination);
' "$result_json" "$BENCHMARK_OUTPUT" > "$TEMP_DIR/output-path"
output_path="$(<"$TEMP_DIR/output-path")"

printf '\nOpenStreamGrid Benchmark Results\n'
node -e '
  const result = JSON.parse(process.argv[1]);
  const rows = [
    ["Virtual peers", result.scenario.peerCount],
    ["Duration", `${result.scenario.elapsedSeconds.toFixed(1)} s`],
    ["P2P efficiency ratio", `${result.metrics.p2pEfficiencyRatioPercent.toFixed(2)}%`],
    ["CDN traffic reduction", `${result.metrics.cdnTrafficReductionPercent.toFixed(2)}%`],
    ["Latency p50", `${result.metrics.latencyMs.p50.toFixed(2)} ms`],
    ["Latency p95", `${result.metrics.latencyMs.p95.toFixed(2)} ms`],
    ["Latency p99", `${result.metrics.latencyMs.p99.toFixed(2)} ms`],
    ["Average upload / peer", `${(result.metrics.averageUploadBytesPerPeer / 1_000_000).toFixed(2)} MB`],
    ["Churn events", result.churn.events],
    ["Peer sessions", result.churn.sessions],
    ["Churn / fetch errors", result.churn.errors + result.churn.segmentFailures],
  ];
  const metricWidth = Math.max("Metric".length, ...rows.map(([label]) => label.length));
  const valueWidth = Math.max("Value".length, ...rows.map(([, value]) => String(value).length));
  const border = `+-${"-".repeat(metricWidth)}-+-${"-".repeat(valueWidth)}-+`;
  console.log(border);
  console.log(`| ${"Metric".padEnd(metricWidth)} | ${"Value".padEnd(valueWidth)} |`);
  console.log(border);
  for (const [label, value] of rows) {
    console.log(`| ${label.padEnd(metricWidth)} | ${String(value).padStart(valueWidth)} |`);
  }
  console.log(border);
' "$result_json"

printf '\nJSON result (%s):\n' "$output_path"
node -e 'console.log(JSON.stringify(JSON.parse(process.argv[1]), null, 2))' "$result_json"

BENCHMARK_SUCCEEDED=1
log "Benchmark completed successfully"
