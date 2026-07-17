#!/usr/bin/env bash
set -Eeuo pipefail

VIDEO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$VIDEO_DIR"

npm run audio
npm run render
npm run validate
