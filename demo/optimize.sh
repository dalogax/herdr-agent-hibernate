#!/usr/bin/env bash
# Shrink demo/demo.gif: speed up the idle wait, cap fps and palette.
set -euo pipefail
in=demo/demo.gif; tmp=$(mktemp -d)
ffmpeg -v error -i "$in" -vf "setpts=PTS/${SPEED:-1.6},fps=8,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" -y "$tmp/out.gif"
mv "$tmp/out.gif" "$in"; rmdir "$tmp"
ls -lh "$in"
