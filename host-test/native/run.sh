#!/bin/bash
# Native checks for the video conversion path, built against the host's FFmpeg
# (Ubuntu: apt install libavcodec-dev libavformat-dev libswscale-dev
# libswresample-dev libavutil-dev ffmpeg pkg-config). Not part of CI: the
# runner has no FFmpeg development packages by default.
#   1. frame-convert-check: two-core conversion vs the previous single-thread
#      path on NV12 frames of a 1080p clip (speed, byte-exactness, colours).
#   2. decoder-e2e: the real media-decoder.cc playing the clip for 3 s.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../../runtime/nxjs/source"
OUT="$HERE/../dist/native"
mkdir -p "$OUT"
CLIP="$OUT/clip-1080p.mkv"
[ -f "$CLIP" ] || ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=1920x1080:rate=24 -t 5 \
	-pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -c:v libx264 -preset ultrafast "$CLIP"
LIBS="$(pkg-config --cflags --libs libavformat libavcodec libswscale libswresample libavutil)"
g++ -std=c++20 -O2 -pthread -I"$SRC" "$HERE/frame-convert-check.cc" "$SRC/frame-convert.cc" $LIBS -o "$OUT/frame-convert-check"
g++ -std=c++20 -O2 -pthread -I"$SRC" "$HERE/decoder-e2e.cc" "$SRC/media-decoder.cc" "$SRC/media-source.cc" \
	"$SRC/http-reader.cc" "$SRC/audio-graph.cc" "$SRC/frame-convert.cc" $LIBS -o "$OUT/decoder-e2e"
"$OUT/frame-convert-check" "$CLIP"
"$OUT/decoder-e2e" "$CLIP"
