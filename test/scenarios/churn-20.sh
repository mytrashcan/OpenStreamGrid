#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

docker compose up --detach --wait tracker origin
docker compose --profile load-test run --rm load-test \
  --peers 20 \
  --duration 180 \
  --ramp-up 10 \
  --churn 0.2 \
  --report-interval 10
