#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${DEMO_DIR}/docker-compose.demo.yml"
TRACKER_URL="${TRACKER_URL:-http://127.0.0.1:7070}"
WARMUP_SECONDS="${WARMUP_SECONDS:-20}"

command -v docker >/dev/null 2>&1 || {
  echo "Docker with Compose v2 is required." >&2
  exit 1
}
command -v curl >/dev/null 2>&1 || {
  echo "curl is required to display tracker statistics." >&2
  exit 1
}

echo "Starting tracker, origin, and five peers..."
docker compose -f "${COMPOSE_FILE}" up --build --detach --wait

echo "All containers are healthy. Warming the peer caches for ${WARMUP_SECONDS}s..."
sleep "${WARMUP_SECONDS}"

STATS="$(curl --fail --silent --show-error "${TRACKER_URL}/api/v1/stats")"
PEERS="$(curl --fail --silent --show-error "${TRACKER_URL}/api/v1/broadcasts/live/peers")"

echo
echo "Global delivery statistics"
if command -v jq >/dev/null 2>&1; then
  jq '{broadcasts, peers, bytesDownloadedP2P, bytesDownloadedOrigin, bytesUploadedP2P, p2pRequests, p2pSuccesses, fallbacks}' <<<"${STATS}"
  echo
  echo "Active peer IDs"
  jq -r '.peers[].id' <<<"${PEERS}"
else
  echo "${STATS}"
  echo
  echo "Active peers"
  echo "${PEERS}"
fi

echo
echo "Dashboard: ${TRACKER_URL}/dashboard"
echo "HLS stream: http://127.0.0.1:8080/hls/stream.m3u8"
echo "Stop the demo with: docker compose -f ${COMPOSE_FILE} down"
