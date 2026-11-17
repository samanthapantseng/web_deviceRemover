#!/usr/bin/env bash
# Turns one photo (someone holding a phone) into fake-webcam clips for scripts/headless_check.mjs.
# Needs ffmpeg. Output is uncompressed video (about 100-170 MB each) in captures/, which is gitignored.
#
#   bash scripts/make_test_clip.sh captures/still-20261112-170000.png
#
#   captures/clip_static.y4m   the photo plus sensor-like noise (tests flicker)
#   captures/clip_moving.y4m   the same, slowly panning (tests tracking and dropouts)
set -euo pipefail
IMG="${1:?usage: make_test_clip.sh <image>}"
cd "$(dirname "$0")/.."
mkdir -p captures

ffmpeg -y -loglevel error -loop 1 -i "$IMG" -t 8 -r 30 \
  -vf "scale=640:480:force_original_aspect_ratio=increase,crop=640:480,noise=alls=7:allf=t,format=yuv420p" \
  -f yuv4mpegpipe captures/clip_static.y4m

ffmpeg -y -loglevel error -loop 1 -i "$IMG" -t 12 -r 30 \
  -vf "scale=736:552:force_original_aspect_ratio=increase,crop=736:552,crop=640:480:x='48+40*sin(2*PI*t/3)':y='36+24*cos(2*PI*t/4)',noise=alls=7:allf=t,format=yuv420p" \
  -f yuv4mpegpipe captures/clip_moving.y4m

ls -lh captures/clip_*.y4m
