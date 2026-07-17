#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_NAME="${HEALTH_PROJECT_NAME:-openstreamgrid-health}"
COMPOSE=(docker compose --project-directory "$ROOT_DIR" --project-name "$PROJECT_NAME")
SERVICES=(tracker origin peer-a peer-b)

cleanup() {
  local exit_code=$?
  if [[ "$exit_code" -ne 0 ]]; then
    "${COMPOSE[@]}" ps || true
    "${COMPOSE[@]}" logs --no-color --tail=100 || true
  fi
  "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  return "$exit_code"
}
trap cleanup EXIT

for command in curl docker node; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required command '$command' was not found" >&2
    exit 1
  }
done
docker compose version >/dev/null
docker info >/dev/null

cd "$ROOT_DIR"
"${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
"${COMPOSE[@]}" up --detach --build --wait --wait-timeout 120 "${SERVICES[@]}"

for service in "${SERVICES[@]}"; do
  container_id="$("${COMPOSE[@]}" ps --quiet "$service")"
  [[ -n "$container_id" ]] || {
    echo "No container was created for $service" >&2
    exit 1
  }
  health="$(docker inspect --format '{{.State.Health.Status}}' "$container_id")"
  [[ "$health" == "healthy" ]] || {
    echo "$service health status was '$health'" >&2
    exit 1
  }
done

assert_health() {
  local url="$1"
  local expected_service="$2"
  local body
  body="$(curl --fail --silent --show-error --max-time 5 "$url")"
  node -e '
    const body = JSON.parse(process.argv[1]);
    const expectedService = process.argv[2];
    if (body.status !== "ok" || body.service !== expectedService) {
      throw new Error(`Unexpected health response for ${expectedService}: ${JSON.stringify(body)}`);
    }
  ' "$body" "$expected_service"
}

assert_health http://127.0.0.1:7070/health tracker
assert_health http://127.0.0.1:8080/health origin
assert_health http://127.0.0.1:9091/health peer
assert_health http://127.0.0.1:9092/health peer

echo "Docker Compose health check test passed for tracker, origin, peer-a, and peer-b."
