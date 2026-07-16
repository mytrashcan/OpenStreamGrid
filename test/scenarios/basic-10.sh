#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

docker compose up --detach --wait tracker origin
docker compose --profile load-test run --rm load-test \
  --peers 10 \
  --duration 60 \
  --ramp-up 5 \
  --churn 0 \
  --report-interval 5
