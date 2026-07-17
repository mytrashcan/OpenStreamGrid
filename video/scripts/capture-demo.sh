#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ASSET_DIR="$ROOT_DIR/video/assets/demo"
mkdir -p "$ASSET_DIR"

cd "$ROOT_DIR"
bash scripts/e2e-test.sh 2>&1 | tee "$ASSET_DIR/e2e.log"
