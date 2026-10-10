#!/usr/bin/env bash
#
# Philont installer for macOS and Linux — the counterpart of install.ps1.
#
#   curl -fsSL https://philont.ai/install.sh | bash
#
# What it does, in order, with nothing outside INSTALL_DIR and ~/.philont touched:
#   1. downloads a pinned portable Node.js (checksum-verified against nodejs.org's SHASUMS256.txt),
#      so no system Node, no sudo and no version manager are needed;
#   2. downloads the Philont source for REF (default: main) from GitHub;
#   3. builds it with scripts/build-all.sh using that Node;
#   4. writes INSTALL_DIR/philont (a stable launcher command) and, unless --no-launch, starts it —
#      the launcher serves the setup page on http://localhost:20267 and asks for your model key.
#
# Flags (also as environment variables):
#   --install-dir DIR   PHILONT_INSTALL_DIR   default ~/.local/share/philont (macOS: ~/Library/Application Support/Philont)
#   --ref REF           PHILONT_REF           git ref to install, default main
#   --source-dir DIR    PHILONT_SOURCE_DIR    build from a local checkout instead of downloading (CI / offline)
#   --no-launch         PHILONT_NO_LAUNCH=1   install only
#
# A previous install is moved aside and restored if the new build fails; the workspace is cleaned up.
set -euo pipefail

NODE_VERSION='24.16.0'
REPOSITORY='ruozhuoruoyu/Philont-Agent'

REF="${PHILONT_REF:-main}"
SOURCE_DIR="${PHILONT_SOURCE_DIR:-}"
NO_LAUNCH="${PHILONT_NO_LAUNCH:-0}"
INSTALL_DIR="${PHILONT_INSTALL_DIR:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --source-dir) SOURCE_DIR="$2"; shift 2 ;;
    --no-launch) NO_LAUNCH=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

work_dir=''
backup_dir=''
old_moved=0
new_placed=0

step() { printf '\n==> %s\n' "$*"; }
# Restore the previous install (if one was moved aside) and remove the workspace. Safe to call at any
# point: every variable it reads is initialised above.
rollback() {
  if [ "$new_placed" = 1 ] && [ -n "${INSTALL_DIR:-}" ] && [ -d "$INSTALL_DIR" ]; then rm -rf "$INSTALL_DIR"; fi
  if [ "$old_moved" = 1 ] && [ -d "$backup_dir" ] && [ ! -d "$INSTALL_DIR" ]; then
    mv "$backup_dir" "$INSTALL_DIR"; echo 'The previous installation has been restored.' >&2
  fi
  if [ -n "$work_dir" ] && [ -d "$work_dir" ]; then rm -rf "$work_dir"; fi
}
# `exit` inside a function does not fire the ERR trap, so die() restores explicitly.
die() { printf '\nInstallation failed: %s\n' "$*" >&2; rollback; exit 1; }

os="$(uname -s)"
case "$os" in
  Darwin) platform='darwin' ;;
  Linux) platform='linux' ;;
  *) die "This installer is for macOS and Linux (got $os). Use install.ps1 on Windows." ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch='x64' ;;
  arm64|aarch64) arch='arm64' ;;
  *) die "Unsupported CPU architecture: $(uname -m)" ;;
esac

if [ -z "$INSTALL_DIR" ]; then
  if [ "$platform" = 'darwin' ]; then INSTALL_DIR="$HOME/Library/Application Support/Philont"; else INSTALL_DIR="$HOME/.local/share/philont"; fi
fi
case "$REF" in
  *..*|'') die "Invalid Git ref: $REF" ;;
esac
if ! printf '%s' "$REF" | grep -Eq '^[A-Za-z0-9._/-]+$'; then die "Invalid Git ref: $REF"; fi

for tool in curl tar; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' is required."
done
if command -v shasum >/dev/null 2>&1; then sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v sha256sum >/dev/null 2>&1; then sha256() { sha256sum "$1" | cut -d' ' -f1; }
else die "Neither shasum nor sha256sum is available to verify the Node.js download."; fi

# Refuse to clobber a running install.
if [ -d "$INSTALL_DIR" ] && curl -fs --max-time 2 http://127.0.0.1:20267/api/launcher/status >/dev/null 2>&1; then
  die "Philont is running. Stop its launcher (Ctrl+C in its terminal), then run the installer again."
fi

parent_dir="$(dirname "$INSTALL_DIR")"
mkdir -p "$parent_dir"
work_dir="$(mktemp -d "$parent_dir/.philont-install-XXXXXX")"
stage_dir="$work_dir/stage"
backup_dir="$INSTALL_DIR.previous"
trap rollback ERR

step "Downloading portable Node.js $NODE_VERSION ($platform-$arch)"
node_file="node-v$NODE_VERSION-$platform-$arch.tar.gz"
node_base="https://nodejs.org/dist/v$NODE_VERSION"
curl -fsSL --retry 3 -o "$work_dir/node.tgz" "$node_base/$node_file"
expected="$(curl -fsSL --retry 3 "$node_base/SHASUMS256.txt" | grep -E "[[:space:]]$node_file\$" | head -1 | cut -d' ' -f1 | tr 'A-F' 'a-f')"
[ -n "$expected" ] || die "Node.js checksum not found for $node_file"
actual="$(sha256 "$work_dir/node.tgz")"
[ "$actual" = "$expected" ] || die 'Node.js archive checksum verification failed.'
mkdir -p "$work_dir/node-extract"
tar -xzf "$work_dir/node.tgz" -C "$work_dir/node-extract"
node_dir="$work_dir/node-extract/node-v$NODE_VERSION-$platform-$arch"
[ -x "$node_dir/bin/node" ] || die 'Portable Node.js extraction failed.'

if [ -n "$SOURCE_DIR" ]; then
  step "Copying Philont source from $SOURCE_DIR"
  [ -f "$SOURCE_DIR/scripts/build-all.sh" ] || die "$SOURCE_DIR does not contain scripts/build-all.sh"
  mkdir -p "$stage_dir"
  # A checkout may carry node_modules/dist from another Node ABI; build from clean sources.
  tar -C "$SOURCE_DIR" --exclude='./.git' --exclude='node_modules' --exclude='dist' -cf - . | tar -C "$stage_dir" -xf -
else
  step "Downloading Philont ($REF)"
  curl -fsSL --retry 3 -o "$work_dir/source.tgz" "https://github.com/$REPOSITORY/archive/$REF.tar.gz"
  mkdir -p "$work_dir/source-extract"
  tar -xzf "$work_dir/source.tgz" -C "$work_dir/source-extract"
  src="$(find "$work_dir/source-extract" -mindepth 1 -maxdepth 1 -type d | head -1)"
  [ -n "$src" ] && [ -f "$src/scripts/build-all.sh" ] || die 'Philont source archive did not contain scripts/build-all.sh.'
  mv "$src" "$stage_dir"
fi

mkdir -p "$stage_dir/runtime"
mv "$node_dir" "$stage_dir/runtime/node"

# Build at the final path (file: dependencies are linked by absolute path); keep the old install
# until the new build succeeds.
step "Installing files to $INSTALL_DIR"
rm -rf "$backup_dir"
if [ -d "$INSTALL_DIR" ]; then mv "$INSTALL_DIR" "$backup_dir"; old_moved=1; fi
mv "$stage_dir" "$INSTALL_DIR"
new_placed=1

export PATH="$INSTALL_DIR/runtime/node/bin:$PATH"
step 'Building Philont'
(cd "$INSTALL_DIR" && bash scripts/build-all.sh) || die 'Philont build failed.'
[ -f "$INSTALL_DIR/launcher/dist/index.js" ] && [ -f "$INSTALL_DIR/web-ui/dist/index.html" ] || die 'Build completed without the launcher or Web UI output.'

cat > "$INSTALL_DIR/philont" <<'CMD'
#!/usr/bin/env bash
# Start Philont with its bundled Node.js (written by install.sh).
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$here/runtime/node/bin:$PATH"
cd "$here"
exec bash scripts/start.sh
CMD
chmod +x "$INSTALL_DIR/philont"

rm -rf "$backup_dir"
trap - ERR
rm -rf "$work_dir"

printf '\nPhilont is installed.\n'
printf 'Program: %s\n' "$INSTALL_DIR"
printf 'Data:    %s\n' "${PHILONT_HOME:-$HOME/.philont}"
printf 'Start:   %s\n' "$INSTALL_DIR/philont"
echo 'The setup page will ask for your model endpoint and API key.'

if [ "$NO_LAUNCH" != 1 ]; then
  exec "$INSTALL_DIR/philont"
fi
