#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_NAME="${E2E_PROJECT_NAME:-openstreamgrid-e2e}"
COMPOSE=(docker compose --project-directory "$ROOT_DIR" --project-name "$PROJECT_NAME")
TRACKER_URL="${TRACKER_URL:-http://127.0.0.1:7070}"
TRACKER_API_KEY="${TRACKER_API_KEY:-openstreamgrid-local-admin}"
ORIGIN_URL="${ORIGIN_URL:-http://127.0.0.1:8080}"
BROADCAST_ID="${BROADCAST_ID:-live}"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openstreamgrid-e2e.XXXXXX")"
TEST_SUCCEEDED=0

log() {
  printf '[E2E] %s\n' "$*"
}

fail() {
  printf '[E2E] ERROR: %s\n' "$*" >&2
  return 1
}

cleanup() {
  local exit_code=$?
  if [[ "$TEST_SUCCEEDED" -ne 1 ]]; then
    "${COMPOSE[@]}" ps || true
    "${COMPOSE[@]}" logs --no-color --tail=50 || true
  fi
  log "Stopping the Docker Compose stack"
  "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  if [[ -d "$TEMP_DIR" && "$TEMP_DIR" == *openstreamgrid-e2e.* ]]; then
    rm -r -- "$TEMP_DIR"
  fi
  return "$exit_code"
}
trap cleanup EXIT

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command '$1' was not found"
}

curl_json() {
  curl --fail --silent --show-error --max-time 10 \
    --header "X-API-Key: $TRACKER_API_KEY" "$1"
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

stat_value() {
  local field="$1"
  local body
  body="$(curl_json "$TRACKER_URL/api/v1/broadcasts/$BROADCAST_ID/stats")"
  node -e '
    const body = JSON.parse(process.argv[1]);
    const value = body[process.argv[2]];
    if (!Number.isFinite(value)) process.exit(2);
    process.stdout.write(String(value));
  ' "$body" "$field"
}

wait_for_stat_greater_than() {
  local field="$1"
  local baseline="$2"
  local attempts="${3:-90}"
  local attempt value
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    value="$(stat_value "$field")"
    if ((value > baseline)); then
      log "$field reached $value"
      return 0
    fi
    sleep 1
  done
  fail "Timed out waiting for $field to exceed $baseline"
}

wait_for_peer_count() {
  local expected="$1"
  local attempts="${2:-60}"
  local attempt body count
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    body="$(curl_json "$TRACKER_URL/api/v1/broadcasts/$BROADCAST_ID/peers")"
    count="$(node -e '
      const body = JSON.parse(process.argv[1]);
      process.stdout.write(String(Array.isArray(body.peers) ? body.peers.length : -1));
    ' "$body")"
    if ((count == expected)); then
      log "Tracker reports $count connected peers"
      return 0
    fi
    sleep 1
  done
  fail "Timed out waiting for $expected connected peers"
}

wait_for_peer_segments() {
  local peer_id="$1"
  local attempts="${2:-60}"
  local attempt body count
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    body="$(curl_json "$TRACKER_URL/api/v1/broadcasts/$BROADCAST_ID/peers")"
    count="$(node -e '
      const body = JSON.parse(process.argv[1]);
      const peer = body.peers?.find(({ id }) => id === process.argv[2]);
      process.stdout.write(String(Array.isArray(peer?.segments) ? peer.segments.length : 0));
    ' "$body" "$peer_id")"
    if ((count > 0)); then
      log "$peer_id advertises $count cached segments"
      return 0
    fi
    sleep 1
  done
  fail "Timed out waiting for $peer_id to advertise a segment"
}

wait_for_http_transport_log() {
  local attempts="${1:-90}"
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if "${COMPOSE[@]}" logs --no-color peer-a peer-b 2>/dev/null \
      | grep -q '"source":"p2p".*"transport":"http"'; then
      log "A peer completed a P2P transfer through HTTP with WebRTC unavailable"
      return 0
    fi
    sleep 1
  done
  fail "Timed out waiting for an HTTP transport P2P transfer"
}

require_command curl
require_command docker
require_command grep
require_command node
docker compose version >/dev/null
docker info >/dev/null

cd "$ROOT_DIR"
log "Removing any stale isolated E2E stack"
"${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true

log "Starting tracker, origin, peer-a, and peer-b"
"${COMPOSE[@]}" up --detach --build --quiet-build tracker origin peer-a peer-b

wait_for_url tracker "$TRACKER_URL/health"
wait_for_url origin "$ORIGIN_URL/health"
wait_for_url peer-a http://127.0.0.1:9091/health
wait_for_url peer-b http://127.0.0.1:9092/health

log "Verifying broadcast registration"
broadcast_json="$(curl_json "$TRACKER_URL/api/v1/broadcasts/$BROADCAST_ID")"
created_at="$(node -e '
  const body = JSON.parse(process.argv[1]);
  if (body.broadcast?.id !== process.argv[2]) {
    throw new Error(`Broadcast ${process.argv[2]} is not registered`);
  }
  if (typeof body.broadcast.createdAt !== "string") {
    throw new Error("Broadcast creation timestamp is missing");
  }
  process.stdout.write(body.broadcast.createdAt);
' "$broadcast_json" "$BROADCAST_ID")"
log "Broadcast '$BROADCAST_ID' was registered at $created_at"

log "Verifying the Origin master playlist, media playlist, and MPEG-TS segment"
master_url="$ORIGIN_URL/hls/stream.m3u8"
master_playlist="$(curl_json "$master_url")"
media_url="$(node -e '
  const playlist = process.argv[1];
  const masterUrl = process.argv[2];
  if (!playlist.startsWith("#EXTM3U")) throw new Error("Invalid HLS playlist");
  if (playlist.includes("#EXTINF")) {
    process.stdout.write(masterUrl);
    process.exit(0);
  }
  const variant = playlist.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && line.includes(".m3u8"));
  if (!variant) throw new Error("No HLS media playlist was found");
  process.stdout.write(new URL(variant, masterUrl).href);
' "$master_playlist" "$master_url")"
media_playlist="$(curl_json "$media_url")"
segment_url="$(node -e '
  const playlist = process.argv[1];
  const mediaUrl = process.argv[2];
  if (!playlist.includes("#EXTINF")) throw new Error("Invalid HLS media playlist");
  const segment = playlist.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && line.includes(".ts"));
  if (!segment) throw new Error("No MPEG-TS segment was found");
  process.stdout.write(new URL(segment, mediaUrl).href);
' "$media_playlist" "$media_url")"
curl --fail --silent --show-error --max-time 10 \
  --output "$TEMP_DIR/origin-segment.ts" "$segment_url"
[[ -s "$TEMP_DIR/origin-segment.ts" ]] || fail "Origin returned an empty segment"
log "Origin served $(wc -c < "$TEMP_DIR/origin-segment.ts" | tr -d ' ') bytes from $segment_url"

log "Verifying peer discovery and P2P segment exchange"
wait_for_peer_count 2
wait_for_peer_segments peer-a
wait_for_stat_greater_than p2pSuccesses 0
p2p_phase_stats="$(curl_json "$TRACKER_URL/api/v1/broadcasts/$BROADCAST_ID/stats")"

log "Stopping peer-b cleanly before simulating an abrupt peer-a crash"
"${COMPOSE[@]}" stop peer-b
wait_for_peer_count 1 15
"${COMPOSE[@]}" kill peer-a
log "Restarting peer-b while the unreachable peer-a lease is still advertised"
PEER_B_WEBRTC_ENABLED=false \
  "${COMPOSE[@]}" up --detach --no-deps --force-recreate peer-b
wait_for_url peer-b http://127.0.0.1:9092/health 30
wait_for_stat_greater_than fallbacks 0 60
fallback_phase_stats="$(curl_json "$TRACKER_URL/api/v1/broadcasts/$BROADCAST_ID/stats")"

log "Restarting peer-a and recreating peer-b with WebRTC unavailable"
log "Waiting for the crashed peer-a lease to expire before reusing its identity"
wait_for_peer_count 1 75
"${COMPOSE[@]}" up --detach --no-deps peer-a
wait_for_url peer-a http://127.0.0.1:9091/health 30
wait_for_peer_segments peer-a 60
PEER_B_WEBRTC_ENABLED=false \
  "${COMPOSE[@]}" up --detach --no-deps --force-recreate peer-b
wait_for_url peer-b http://127.0.0.1:9092/health 30
wait_for_http_transport_log 90

log "Restarting tracker to verify SQLite persistence"
stats_before_restart="$(curl_json "$TRACKER_URL/api/v1/broadcasts/$BROADCAST_ID/stats")"
"${COMPOSE[@]}" restart tracker
wait_for_url tracker "$TRACKER_URL/health" 60
broadcast_after_restart="$(curl_json "$TRACKER_URL/api/v1/broadcasts/$BROADCAST_ID")"
node -e '
  const body = JSON.parse(process.argv[1]);
  const expectedCreatedAt = process.argv[2];
  if (body.broadcast?.createdAt !== expectedCreatedAt) {
    throw new Error("Broadcast state did not persist across tracker restart");
  }
' "$broadcast_after_restart" "$created_at"
stats_after_restart="$(curl_json "$TRACKER_URL/api/v1/broadcasts/$BROADCAST_ID/stats")"
node -e '
  const before = JSON.parse(process.argv[1]);
  const after = JSON.parse(process.argv[2]);
  for (const field of ["bytesDownloadedP2P", "bytesDownloadedOrigin", "p2pSuccesses", "fallbacks"]) {
    if (!Number.isFinite(after[field])) throw new Error(`Missing persisted statistic ${field}`);
  }
  if (before.broadcastId !== after.broadcastId) {
    throw new Error("Broadcast statistics identity changed after restart");
  }
' "$stats_before_restart" "$stats_after_restart"
log "Broadcast and traffic data survived the tracker restart"

log "P2P and Origin traffic summary"
node -e '
  const initial = JSON.parse(process.argv[1]);
  const fallback = JSON.parse(process.argv[2]);
  const final = JSON.parse(process.argv[3]);
  const totalBytes = final.bytesDownloadedP2P + final.bytesDownloadedOrigin;
  const ratio = totalBytes === 0 ? 0 : final.bytesDownloadedP2P / totalBytes * 100;
  console.log(JSON.stringify({
    p2pBytes: final.bytesDownloadedP2P,
    originBytes: final.bytesDownloadedOrigin,
    p2pTrafficRatioPercent: Number(ratio.toFixed(2)),
    p2pSuccesses: final.p2pSuccesses,
    originFallbacks: fallback.fallbacks,
    initialP2pSuccesses: initial.p2pSuccesses,
  }, null, 2));
  if (initial.p2pSuccesses < 1 || fallback.fallbacks < 1 || totalBytes < 1) {
    throw new Error("Required P2P, fallback, or traffic evidence is missing");
  }
' "$p2p_phase_stats" "$fallback_phase_stats" "$stats_after_restart"

TEST_SUCCEEDED=1
log "All Phase 4 E2E checks passed"
