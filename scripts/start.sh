#!/usr/bin/env bash
#
# Start philont: launch only (no auto-build).
#
# Run ./scripts/build-all.sh first (or after a git pull) to (re)build.
# The launcher serves the web UI (localhost:20267), opens your browser to the
# setup wizard, and supervises the agent process.
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f launcher/dist/index.js ] || [ ! -d web-ui/dist ]; then
  echo "Build output missing (launcher/dist or web-ui/dist). Run ./scripts/build-all.sh first." >&2
  exit 1
fi

# Make the managed Python interpreter available to philont (document / z3 tools).
# Env vars only reach new shells; loading from the manifest guarantees this launch
# has it regardless of when the env var propagates.
if [ -z "${PHILONT_PYTHON:-}" ]; then
  manifest="$HOME/.philont/python-env.json"
  if [ -f "$manifest" ]; then
    pp="$(sed -n 's/.*"pythonPath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -1)"
    if [ -n "$pp" ] && [ -x "$pp" ]; then
      export PHILONT_PYTHON="$pp"
      echo "Using managed Python: $pp"
    fi
  fi
fi

echo "Starting launcher (serves web UI + supervises agent + opens browser; Ctrl+C to exit)..."
exec node launcher/dist/index.js
