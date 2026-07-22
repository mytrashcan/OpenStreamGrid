#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose --project-directory "$ROOT_DIR")
TRACKER_API_KEY="${TRACKER_API_KEY:-openstreamgrid-local-admin}"
TEST_SUCCEEDED=0

cleanup() {
  if [[ "$TEST_SUCCEEDED" -ne 1 ]]; then
    "${COMPOSE[@]}" logs --no-color --tail=80 || true
  fi
  if [[ "${KEEP_RUNNING:-0}" != "1" ]]; then
    "${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

wait_for_url() {
  local name="$1"
  local url="$2"
  local attempts="${3:-60}"
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl --fail --silent --show-error "$url" >/dev/null 2>&1; then
      echo "$name is ready"
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for $name at $url" >&2
  return 1
}

stat_value() {
  local field="$1"
  local body
  body="$(curl --fail --silent --show-error --header "X-API-Key: $TRACKER_API_KEY" http://127.0.0.1:7070/api/v1/broadcasts/live/stats)"
  node -e 'const body=JSON.parse(process.argv[1]); const value=body[process.argv[2]]; if(typeof value!=="number") process.exit(2); process.stdout.write(String(value));' "$body" "$field"
}

wait_for_stat_greater_than() {
  local field="$1"
  local baseline="$2"
  local attempts="${3:-60}"
  local value
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    value="$(stat_value "$field")"
    if ((value > baseline)); then
      echo "$field reached $value"
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for $field to exceed $baseline" >&2
  return 1
}

cd "$ROOT_DIR"
"${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
"${COMPOSE[@]}" build
"${COMPOSE[@]}" up --detach

wait_for_url tracker http://127.0.0.1:7070/health
wait_for_url origin http://127.0.0.1:8080/health
wait_for_url peer-a http://127.0.0.1:9091/health
wait_for_url peer-b http://127.0.0.1:9092/health
wait_for_stat_greater_than p2pSuccesses 0 60

p2p_stats="$(curl --fail --silent --show-error --header "X-API-Key: $TRACKER_API_KEY" http://127.0.0.1:7070/api/v1/broadcasts/live/stats)"
fallbacks_before="$(stat_value fallbacks)"
echo "Forcing a stale-peer request to exercise origin fallback"
"${COMPOSE[@]}" kill peer-b peer-a
"${COMPOSE[@]}" up --detach --no-deps peer-b
wait_for_url peer-b http://127.0.0.1:9092/health 20
wait_for_stat_greater_than fallbacks "$fallbacks_before" 20

stats="$(curl --fail --silent --show-error --header "X-API-Key: $TRACKER_API_KEY" http://127.0.0.1:7070/api/v1/broadcasts/live/stats)"
node -e '
const p2pPhase = JSON.parse(process.argv[1]);
const fallbackPhase = JSON.parse(process.argv[2]);
if (p2pPhase.p2pSuccesses < 1) throw new Error("No P2P transfer was recorded");
if (fallbackPhase.fallbacks < 1) throw new Error("No origin fallback was recorded");
if (p2pPhase.integrityFailures !== 0 || fallbackPhase.integrityFailures !== 0) {
  throw new Error("Unexpected integrity failures");
}
console.log(JSON.stringify({ p2pPhase, fallbackPhase }, null, 2));
' "$p2p_stats" "$stats"

TEST_SUCCEEDED=1
echo "Docker MVP test passed: P2P sharing and origin fallback were both observed."
