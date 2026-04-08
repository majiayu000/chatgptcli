#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="${CHATGPTCLI_OPENCLI_ROOT:-$ROOT_DIR/.omx/reference/opencli}/extension"
PROFILE_DIR="${HOME}/.chatgptcli/chrome-profile"
CHROME_APP="/Applications/Google Chrome.app"

if [ ! -d "$CHROME_APP" ]; then
  echo "Google Chrome.app not found at $CHROME_APP" >&2
  exit 1
fi

if [ ! -d "$EXT_DIR" ]; then
  echo "OpenCLI extension directory not found at $EXT_DIR" >&2
  exit 1
fi

mkdir -p "$PROFILE_DIR"

open -na "$CHROME_APP" --args \
  --user-data-dir="$PROFILE_DIR" \
  --load-extension="$EXT_DIR" \
  https://chatgpt.com/
