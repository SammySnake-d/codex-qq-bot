#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_ENV_FILE="$PROJECT_DIR/config/local.env"

if [ -f "$LOCAL_ENV_FILE" ]; then
  set -a
  source "$LOCAL_ENV_FILE"
  set +a
fi

cd "$PROJECT_DIR"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ]; then
  print -u2 "node is not available; set NODE_BIN in config/local.env"
  exit 127
fi

exec "$NODE_BIN" src/group-summary/cli.js run "$@"
