#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is not installed or not on PATH. Install from https://bun.sh" >&2
  exit 1
fi

bun run src/main.js setup
