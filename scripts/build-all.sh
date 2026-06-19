#!/usr/bin/env bash
#
# One-command build for philont (pure TypeScript, no Rust needed).
#
# Builds all TS packages + web-ui + launcher in dependency order.
# The server runs via tsx (no build script), so it only gets deps installed.
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

build_pkg() {
  echo ""
  echo "==> build $1"
  ( cd "$1" && npm install --no-audit --no-fund && npm run build )
}

# TS packages, bottom-up (agent-policy is the base; the rest depend on it)
for p in agent-policy agent-tools agent-mcp agent-plugins agent-memory; do
  build_pkg "$p"
done

echo ""
echo "==> install server deps (runs via tsx, no build)"
( cd server && npm install --no-audit --no-fund )

build_pkg web-ui     # vite  -> web-ui/dist
build_pkg launcher   # tsc   -> launcher/dist

echo ""
echo "==> setup Python env (managed venv for document/office tools + z3)"
# Non-fatal: a missing Python or blocked PyPI must not break the TS build.
# The if-condition shields this from 'set -e'.
if bash "$ROOT/scripts/setup-python-env.sh"; then
  :
else
  echo "WARN: Python env setup did not complete. Document/office tools need it."
  echo "      Install Python 3.9+ then run: ./scripts/setup-python-env.sh"
fi

echo ""
echo "Build complete. Start with: ./scripts/start.sh"
