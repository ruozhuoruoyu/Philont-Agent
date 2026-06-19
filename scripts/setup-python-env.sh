#!/usr/bin/env bash
# setup-python-env.sh — provision philont's managed Python virtualenv (POSIX).
#
# Creates a dedicated venv, installs requirements.txt into it, and prints
# PHILONT_PYTHON so the shell / z3 / document tools always use this interpreter
# instead of pip-installing at runtime.
#
# Usage:
#   ./scripts/setup-python-env.sh                 # create / update the venv
#   PHILONT_PYENV_DIR=/opt/philont/pyenv ./scripts/setup-python-env.sh
#
# Idempotent: re-running reuses an existing venv and just re-installs deps.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REQUIREMENTS="$REPO_ROOT/requirements.txt"
if [ ! -f "$REQUIREMENTS" ]; then
  echo "requirements.txt not found at $REQUIREMENTS" >&2
  exit 1
fi

# Resolve the venv directory (default: ~/.philont/pyenv — next to philont's data dir).
VENV_DIR="${PHILONT_PYENV_DIR:-$HOME/.philont/pyenv}"
PHILONT_HOME="$(dirname "$VENV_DIR")"

# Find a base Python 3 interpreter.
BASE_PYTHON=""
for cand in python3 python; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" --version 2>&1 | grep -q "Python 3"; then
    BASE_PYTHON="$cand"
    break
  fi
done
if [ -z "$BASE_PYTHON" ]; then
  echo "No Python 3 found. Install Python 3.9+ and re-run." >&2
  exit 1
fi
echo "[setup] base python: $BASE_PYTHON"

VENV_PYTHON="$VENV_DIR/bin/python"

if [ -x "$VENV_PYTHON" ]; then
  echo "[setup] reusing existing venv at $VENV_DIR"
else
  echo "[setup] creating venv at $VENV_DIR"
  if ! "$BASE_PYTHON" -m venv "$VENV_DIR" 2>/dev/null; then
    echo "venv creation failed. On Debian/Ubuntu install the venv module: apt-get install -y python3-venv" >&2
    exit 1
  fi
fi

echo "[setup] upgrading pip"
"$VENV_PYTHON" -m pip install --upgrade pip --quiet

echo "[setup] installing requirements (this is the only time deps install — runtime never pip-installs)"
"$VENV_PYTHON" -m pip install -r "$REQUIREMENTS"

# Write a machine-readable hook for the launcher.
VENV_PYTHON_ABS="$(cd "$(dirname "$VENV_PYTHON")" && pwd)/$(basename "$VENV_PYTHON")"
mkdir -p "$PHILONT_HOME"
cat > "$PHILONT_HOME/python-env.json" <<EOF
{
  "pythonPath": "$VENV_PYTHON_ABS",
  "venvDir": "$VENV_DIR",
  "requirements": "$REQUIREMENTS",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo ""
echo "[setup] done."
echo "  PHILONT_PYTHON = $VENV_PYTHON_ABS"
echo "  Export it for philont (add to your shell rc to persist):"
echo "    export PHILONT_PYTHON=\"$VENV_PYTHON_ABS\""
