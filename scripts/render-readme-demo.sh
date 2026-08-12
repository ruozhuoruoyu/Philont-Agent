#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
svg_path="$repo_dir/docs/media/readme-demo.svg"
output_path="$repo_dir/docs/media/philont-demo.gif"
frames_dir="$(mktemp -d)"
trap 'rm -rf "$frames_dir"' EXIT

if ! command -v rsvg-convert >/dev/null; then
  echo "rsvg-convert is required (package: librsvg2-bin)." >&2
  exit 1
fi
if ! command -v ffmpeg >/dev/null; then
  echo "ffmpeg is required." >&2
  exit 1
fi

for frame in 1 2 3 4 5 6 7; do
  sed "s/FRAME_CLASS/frame${frame}/" "$svg_path" > "$frames_dir/frame-${frame}.svg"
  rsvg-convert -w 960 -h 600 "$frames_dir/frame-${frame}.svg" -o "$frames_dir/frame-${frame}.png"
done

ffmpeg -y -framerate 0.55 -i "$frames_dir/frame-%d.png" \
  -vf "split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
  -loop 0 "$output_path" >/dev/null 2>&1

echo "Wrote $output_path"
