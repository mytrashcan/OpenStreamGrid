#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
OpenStreamGrid Docker benchmark

Usage:
  bash scripts/benchmark.sh [options]

Options:
  --scenario FILE                    Benchmark scenario JSON
  --peers N                          Number of virtual peers
  --duration SECONDS                 Measurement duration
  --ramp-up SECONDS                  Peer startup ramp
  --churn FRACTION                   Per-check churn probability (0-1)
  --report-interval SECONDS          Console report interval
  --p2p-enabled BOOLEAN              Enable or disable P2P fetches
  --quality NAME                     HLS rendition: low, med, or high
  --segment-duration SECONDS         Origin HLS target segment duration
  --upload-bandwidth-limit MBPS      Per-peer upload limit
  --concurrent-upload-limit N        Concurrent uploads per peer
  --p2p-timeout-ms MS                Peer request deadline
  --seed INTEGER                     Unsigned 32-bit random seed
  --output FILE                      Result JSON destination
  --help                             Show this help

Precedence:
  scenario file < environment variables < CLI options
EOF
}

require_option_value() {
  local option="$1"
  local value="${2-}"
  if [[ -z "$value" || "$value" == --* ]]; then
    printf '[Benchmark] ERROR: Option %s requires a value\n' "$option" >&2
    exit 1
  fi
}

capture_environment() {
  local name="$1"
  local set_variable="$2"
  local value_variable="$3"
  if [[ -n "${!name+x}" ]]; then
    printf -v "$set_variable" '%s' 1
    printf -v "$value_variable" '%s' "${!name}"
  else
    printf -v "$set_variable" '%s' 0
    printf -v "$value_variable" '%s' ""
  fi
}

resolve_value() {
  local value="$1"
  local scenario_value="$2"
  local environment_is_set="$3"
  local environment_value="$4"
  local cli_is_set="$5"
  local cli_value="$6"
  if [[ -n "$scenario_value" ]]; then value="$scenario_value"; fi
  if [[ "$environment_is_set" -eq 1 ]]; then value="$environment_value"; fi
  if [[ "$cli_is_set" -eq 1 ]]; then value="$cli_value"; fi
  printf '%s' "$value"
}

scenario_value() {
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const scenario = JSON.parse(readFileSync(process.argv[1], "utf8"));
    const value = scenario[process.argv[2]];
    if (value !== undefined) process.stdout.write(String(value));
  ' "$SCENARIO_FILE" "$1"
}

for name in \
  PEER_COUNT DURATION_SECONDS RAMP_UP_SECONDS CHURN_RATE \
  REPORT_INTERVAL_SECONDS P2P_ENABLED QUALITY SEGMENT_DURATION_SECONDS \
  UPLOAD_BANDWIDTH_MBPS MAX_UPLOAD_CONNECTIONS P2P_TIMEOUT_MS SEED \
  BENCHMARK_OUTPUT; do
  capture_environment "$name" "ENV_${name}_SET" "ENV_${name}_VALUE"
done

CLI_SCENARIO_FILE="${BENCHMARK_SCENARIO_FILE-}"
CLI_PEER_COUNT_SET=0
CLI_DURATION_SECONDS_SET=0
CLI_RAMP_UP_SECONDS_SET=0
CLI_CHURN_RATE_SET=0
CLI_REPORT_INTERVAL_SECONDS_SET=0
CLI_P2P_ENABLED_SET=0
CLI_QUALITY_SET=0
CLI_SEGMENT_DURATION_SECONDS_SET=0
CLI_UPLOAD_BANDWIDTH_MBPS_SET=0
CLI_MAX_UPLOAD_CONNECTIONS_SET=0
CLI_P2P_TIMEOUT_MS_SET=0
CLI_SEED_SET=0
CLI_BENCHMARK_OUTPUT_SET=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scenario)
      require_option_value "$1" "${2-}"
      CLI_SCENARIO_FILE="$2"
      shift 2
      ;;
    --peers)
      require_option_value "$1" "${2-}"
      CLI_PEER_COUNT_SET=1
      CLI_PEER_COUNT_VALUE="$2"
      shift 2
      ;;
    --duration)
      require_option_value "$1" "${2-}"
      CLI_DURATION_SECONDS_SET=1
      CLI_DURATION_SECONDS_VALUE="$2"
      shift 2
      ;;
    --ramp-up)
      require_option_value "$1" "${2-}"
      CLI_RAMP_UP_SECONDS_SET=1
      CLI_RAMP_UP_SECONDS_VALUE="$2"
      shift 2
      ;;
    --churn)
      require_option_value "$1" "${2-}"
      CLI_CHURN_RATE_SET=1
      CLI_CHURN_RATE_VALUE="$2"
      shift 2
      ;;
    --report-interval)
      require_option_value "$1" "${2-}"
      CLI_REPORT_INTERVAL_SECONDS_SET=1
      CLI_REPORT_INTERVAL_SECONDS_VALUE="$2"
      shift 2
      ;;
    --p2p-enabled)
      require_option_value "$1" "${2-}"
      CLI_P2P_ENABLED_SET=1
      CLI_P2P_ENABLED_VALUE="$2"
      shift 2
      ;;
    --quality)
      require_option_value "$1" "${2-}"
      CLI_QUALITY_SET=1
      CLI_QUALITY_VALUE="$2"
      shift 2
      ;;
    --segment-duration)
      require_option_value "$1" "${2-}"
      CLI_SEGMENT_DURATION_SECONDS_SET=1
      CLI_SEGMENT_DURATION_SECONDS_VALUE="$2"
      shift 2
      ;;
    --upload-bandwidth-limit)
      require_option_value "$1" "${2-}"
      CLI_UPLOAD_BANDWIDTH_MBPS_SET=1
      CLI_UPLOAD_BANDWIDTH_MBPS_VALUE="$2"
      shift 2
      ;;
    --concurrent-upload-limit)
      require_option_value "$1" "${2-}"
      CLI_MAX_UPLOAD_CONNECTIONS_SET=1
      CLI_MAX_UPLOAD_CONNECTIONS_VALUE="$2"
      shift 2
      ;;
    --p2p-timeout-ms)
      require_option_value "$1" "${2-}"
      CLI_P2P_TIMEOUT_MS_SET=1
      CLI_P2P_TIMEOUT_MS_VALUE="$2"
      shift 2
      ;;
    --seed)
      require_option_value "$1" "${2-}"
      CLI_SEED_SET=1
      CLI_SEED_VALUE="$2"
      shift 2
      ;;
    --output)
      require_option_value "$1" "${2-}"
      CLI_BENCHMARK_OUTPUT_SET=1
      CLI_BENCHMARK_OUTPUT_VALUE="$2"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      printf '[Benchmark] ERROR: Unknown option %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

SCENARIO_FILE=""
SCENARIO_PEER_COUNT=""
SCENARIO_DURATION_SECONDS=""
SCENARIO_RAMP_UP_SECONDS=""
SCENARIO_CHURN_RATE=""
SCENARIO_P2P_ENABLED=""
SCENARIO_QUALITY=""
SCENARIO_SEGMENT_DURATION_SECONDS=""
SCENARIO_UPLOAD_BANDWIDTH_MBPS=""
SCENARIO_MAX_UPLOAD_CONNECTIONS=""
SCENARIO_P2P_TIMEOUT_MS=""
SCENARIO_SEED=""
if [[ -n "$CLI_SCENARIO_FILE" ]]; then
  SCENARIO_FILE="$(cd "$(dirname "$CLI_SCENARIO_FILE")" && pwd)/$(basename "$CLI_SCENARIO_FILE")"
  node "$ROOT_DIR/scripts/validate-benchmark-schema.mjs" "$SCENARIO_FILE"
  SCENARIO_PEER_COUNT="$(scenario_value peerCount)"
  SCENARIO_DURATION_SECONDS="$(scenario_value durationSeconds)"
  SCENARIO_RAMP_UP_SECONDS="$(scenario_value rampUpSeconds)"
  SCENARIO_CHURN_RATE="$(scenario_value churnProbability)"
  SCENARIO_P2P_ENABLED="$(scenario_value p2pEnabled)"
  SCENARIO_QUALITY="$(scenario_value quality)"
  SCENARIO_SEGMENT_DURATION_SECONDS="$(scenario_value segmentDurationSeconds)"
  SCENARIO_UPLOAD_BANDWIDTH_MBPS="$(scenario_value uploadBandwidthLimit)"
  SCENARIO_MAX_UPLOAD_CONNECTIONS="$(scenario_value concurrentUploadLimit)"
  SCENARIO_P2P_TIMEOUT_MS="$(scenario_value p2pTimeoutMs)"
  SCENARIO_SEED="$(scenario_value randomSeed)"
fi

PROJECT_NAME="${BENCHMARK_PROJECT_NAME:-openstreamgrid-benchmark}"
COMPOSE=(docker compose --project-directory "$ROOT_DIR" --project-name "$PROJECT_NAME")
PEER_COUNT="$(resolve_value 10 "$SCENARIO_PEER_COUNT" "$ENV_PEER_COUNT_SET" "$ENV_PEER_COUNT_VALUE" "$CLI_PEER_COUNT_SET" "${CLI_PEER_COUNT_VALUE-}")"
DURATION_SECONDS="$(resolve_value 60 "$SCENARIO_DURATION_SECONDS" "$ENV_DURATION_SECONDS_SET" "$ENV_DURATION_SECONDS_VALUE" "$CLI_DURATION_SECONDS_SET" "${CLI_DURATION_SECONDS_VALUE-}")"
RAMP_UP_SECONDS="$(resolve_value 5 "$SCENARIO_RAMP_UP_SECONDS" "$ENV_RAMP_UP_SECONDS_SET" "$ENV_RAMP_UP_SECONDS_VALUE" "$CLI_RAMP_UP_SECONDS_SET" "${CLI_RAMP_UP_SECONDS_VALUE-}")"
CHURN_RATE="$(resolve_value 0.15 "$SCENARIO_CHURN_RATE" "$ENV_CHURN_RATE_SET" "$ENV_CHURN_RATE_VALUE" "$CLI_CHURN_RATE_SET" "${CLI_CHURN_RATE_VALUE-}")"
REPORT_INTERVAL_SECONDS="$(resolve_value 10 "" "$ENV_REPORT_INTERVAL_SECONDS_SET" "$ENV_REPORT_INTERVAL_SECONDS_VALUE" "$CLI_REPORT_INTERVAL_SECONDS_SET" "${CLI_REPORT_INTERVAL_SECONDS_VALUE-}")"
P2P_ENABLED="$(resolve_value true "$SCENARIO_P2P_ENABLED" "$ENV_P2P_ENABLED_SET" "$ENV_P2P_ENABLED_VALUE" "$CLI_P2P_ENABLED_SET" "${CLI_P2P_ENABLED_VALUE-}")"
QUALITY="$(resolve_value low "$SCENARIO_QUALITY" "$ENV_QUALITY_SET" "$ENV_QUALITY_VALUE" "$CLI_QUALITY_SET" "${CLI_QUALITY_VALUE-}")"
SEGMENT_DURATION_SECONDS="$(resolve_value 2 "$SCENARIO_SEGMENT_DURATION_SECONDS" "$ENV_SEGMENT_DURATION_SECONDS_SET" "$ENV_SEGMENT_DURATION_SECONDS_VALUE" "$CLI_SEGMENT_DURATION_SECONDS_SET" "${CLI_SEGMENT_DURATION_SECONDS_VALUE-}")"
UPLOAD_BANDWIDTH_MBPS="$(resolve_value 4 "$SCENARIO_UPLOAD_BANDWIDTH_MBPS" "$ENV_UPLOAD_BANDWIDTH_MBPS_SET" "$ENV_UPLOAD_BANDWIDTH_MBPS_VALUE" "$CLI_UPLOAD_BANDWIDTH_MBPS_SET" "${CLI_UPLOAD_BANDWIDTH_MBPS_VALUE-}")"
MAX_UPLOAD_CONNECTIONS="$(resolve_value 3 "$SCENARIO_MAX_UPLOAD_CONNECTIONS" "$ENV_MAX_UPLOAD_CONNECTIONS_SET" "$ENV_MAX_UPLOAD_CONNECTIONS_VALUE" "$CLI_MAX_UPLOAD_CONNECTIONS_SET" "${CLI_MAX_UPLOAD_CONNECTIONS_VALUE-}")"
P2P_TIMEOUT_MS="$(resolve_value 2000 "$SCENARIO_P2P_TIMEOUT_MS" "$ENV_P2P_TIMEOUT_MS_SET" "$ENV_P2P_TIMEOUT_MS_VALUE" "$CLI_P2P_TIMEOUT_MS_SET" "${CLI_P2P_TIMEOUT_MS_VALUE-}")"
SEED_VALUE="$(resolve_value "" "$SCENARIO_SEED" "$ENV_SEED_SET" "$ENV_SEED_VALUE" "$CLI_SEED_SET" "${CLI_SEED_VALUE-}")"
BENCHMARK_OUTPUT="$(resolve_value "$ROOT_DIR/benchmark-results.json" "" "$ENV_BENCHMARK_OUTPUT_SET" "$ENV_BENCHMARK_OUTPUT_VALUE" "$CLI_BENCHMARK_OUTPUT_SET" "${CLI_BENCHMARK_OUTPUT_VALUE-}")"
TRACKER_URL="${TRACKER_URL:-http://127.0.0.1:7070}"
ORIGIN_URL="${ORIGIN_URL:-http://127.0.0.1:8080}"
TEMP_DIR=""
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
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" && "$TEMP_DIR" == *openstreamgrid-benchmark.* ]]; then
    rm -r -- "$TEMP_DIR"
  fi
  return "$exit_code"
}

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

node -e '
  const [
    peers,
    duration,
    rampUp,
    churn,
    reportInterval,
    segmentDuration,
    uploadBandwidth,
    uploadConnections,
    p2pTimeout,
  ] = process.argv.slice(1, 10).map(Number);
  const [p2pEnabled, quality, seed] = process.argv.slice(10);
  if (!Number.isSafeInteger(peers) || peers < 2) throw new Error("PEER_COUNT must be an integer of at least 2");
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("DURATION_SECONDS must be positive");
  if (!Number.isFinite(rampUp) || rampUp < 0) throw new Error("RAMP_UP_SECONDS cannot be negative");
  if (!Number.isFinite(churn) || churn < 0 || churn > 1) throw new Error("CHURN_RATE must be between 0 and 1");
  if (!Number.isFinite(reportInterval) || reportInterval <= 0) throw new Error("REPORT_INTERVAL_SECONDS must be positive");
  if (!Number.isFinite(segmentDuration) || segmentDuration <= 0) throw new Error("SEGMENT_DURATION_SECONDS must be positive");
  if (!Number.isFinite(uploadBandwidth) || uploadBandwidth <= 0) throw new Error("UPLOAD_BANDWIDTH_MBPS must be positive");
  if (!Number.isSafeInteger(uploadConnections) || uploadConnections <= 0) throw new Error("MAX_UPLOAD_CONNECTIONS must be a positive integer");
  if (!Number.isSafeInteger(p2pTimeout) || p2pTimeout <= 0) throw new Error("P2P_TIMEOUT_MS must be a positive integer");
  if (!["true", "false", "1", "0", "yes", "no"].includes(p2pEnabled.toLowerCase())) throw new Error("P2P_ENABLED must be true or false");
  if (!["low", "med", "high"].includes(quality)) throw new Error("QUALITY must be low, med, or high");
  if (seed !== "" && (!Number.isSafeInteger(Number(seed)) || Number(seed) < 0 || Number(seed) > 0xFFFFFFFF)) {
    throw new Error("SEED must be an unsigned 32-bit integer");
  }
' "$PEER_COUNT" "$DURATION_SECONDS" "$RAMP_UP_SECONDS" "$CHURN_RATE" "$REPORT_INTERVAL_SECONDS" \
  "$SEGMENT_DURATION_SECONDS" "$UPLOAD_BANDWIDTH_MBPS" "$MAX_UPLOAD_CONNECTIONS" \
  "$P2P_TIMEOUT_MS" "$P2P_ENABLED" "$QUALITY" "$SEED_VALUE"

for command_name in curl docker node tee; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "Required command '$command_name' was not found"
done
docker compose version >/dev/null
docker info >/dev/null
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openstreamgrid-benchmark.XXXXXX")"
trap cleanup EXIT

export SEGMENT_DURATION_SECONDS
if [[ -n "$SCENARIO_FILE" ]]; then
  export BENCHMARK_SCENARIO_FILE="$SCENARIO_FILE"
  log "Scenario: $(basename "$SCENARIO_FILE")"
else
  unset BENCHMARK_SCENARIO_FILE || true
fi

cd "$ROOT_DIR"
log "Removing any stale isolated benchmark stack"
"${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true

log "Starting tracker and origin"
"${COMPOSE[@]}" up --detach --build tracker origin
wait_for_url tracker "$TRACKER_URL/health"
wait_for_url origin "$ORIGIN_URL/health"

log "Building the virtual-peer load generator"
"${COMPOSE[@]}" build load-test

LOAD_TEST_RUN_ARGS=(run --rm --no-deps)
LOAD_TEST_ARGS=(
  --peers "$PEER_COUNT"
  --duration "$DURATION_SECONDS"
  --ramp-up "$RAMP_UP_SECONDS"
  --churn "$CHURN_RATE"
  --report-interval "$REPORT_INTERVAL_SECONDS"
  --p2p-enabled "$P2P_ENABLED"
  --quality "$QUALITY"
  --segment-duration "$SEGMENT_DURATION_SECONDS"
  --upload-bandwidth-mbps "$UPLOAD_BANDWIDTH_MBPS"
  --max-upload-connections "$MAX_UPLOAD_CONNECTIONS"
  --p2p-timeout-ms "$P2P_TIMEOUT_MS"
)
if [[ -n "$SEED_VALUE" ]]; then
  LOAD_TEST_ARGS+=(--seed "$SEED_VALUE")
fi
if [[ -n "$SCENARIO_FILE" ]]; then
  LOAD_TEST_RUN_ARGS+=(
    --volume "$SCENARIO_FILE:$SCENARIO_FILE:ro"
    --env "BENCHMARK_SCENARIO_FILE=$SCENARIO_FILE"
  )
  LOAD_TEST_ARGS+=(--scenario "$SCENARIO_FILE")
fi

log "Running $PEER_COUNT virtual peers for ${DURATION_SECONDS}s with churn rate $CHURN_RATE"
"${COMPOSE[@]}" "${LOAD_TEST_RUN_ARGS[@]}" load-test "${LOAD_TEST_ARGS[@]}" \
  | tee "$TEMP_DIR/load-test.log"

result_json="$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const prefix = "[LoadTest] RESULT ";
  const line = readFileSync(process.argv[1], "utf8")
    .split(/\r?\n/)
    .findLast((entry) => entry.startsWith(prefix));
  if (!line) throw new Error("Load test did not emit a benchmark result");
  const result = JSON.parse(line.slice(prefix.length));
  if (result.schemaVersion !== 2) throw new Error("Unsupported benchmark schema");
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
