#!/bin/bash
# Native checks for the video conversion path, built against the host's FFmpeg
# (Ubuntu: apt install libavcodec-dev libavformat-dev libswscale-dev
# libswresample-dev libavutil-dev ffmpeg pkg-config). Not part of CI: the
# runner has no FFmpeg development packages by default.
#   1. frame-convert-check: two-core conversion vs the previous single-thread
#      path on NV12 frames of a 1080p clip (speed, byte-exactness, colours).
#   2. decoder-e2e: the real media-decoder.cc playing the clip for 3 s.
#   4. decoder-yuv: GPU colour conversion's NV12 frames match the CPU path.
#   3. decoder-pgs: Blu-ray PGS image subtitles (a stream written by
#      make-pgs.py, needs Python + Pillow) decoded with the right timing,
#      placement and RGBA pixels.
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
g++ -std=c++20 -O2 -pthread -I"$SRC" "$HERE/decoder-pgs.cc" "$SRC/media-decoder.cc" "$SRC/media-source.cc" \
	"$SRC/http-reader.cc" "$SRC/audio-graph.cc" "$SRC/frame-convert.cc" $LIBS -o "$OUT/decoder-pgs"
g++ -std=c++20 -O2 -pthread -I"$SRC" "$HERE/decoder-yuv.cc" "$SRC/media-decoder.cc" "$SRC/media-source.cc" \
	"$SRC/http-reader.cc" "$SRC/audio-graph.cc" "$SRC/frame-convert.cc" $LIBS -o "$OUT/decoder-yuv"
# GPU colour conversion (decoder side): 8-bit, 10-bit (when the encoder can make it) and above 1080p.
"$OUT/decoder-yuv" "$CLIP" "$OUT/first.nv12"
# The packed frame must equal ffmpeg's own NV12 rendering of frame 0, byte for byte.
ffmpeg -hide_banner -loglevel error -y -i "$CLIP" -frames:v 1 -pix_fmt nv12 -f rawvideo "$OUT/first-ref.nv12"
cmp "$OUT/first.nv12" "$OUT/first-ref.nv12" && echo "  first NV12 frame is byte-identical to ffmpeg's"
CLIP10="$OUT/clip-1080p-10bit.mkv"
[ -f "$CLIP10" ] || ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=1920x1080:rate=24 -t 3 \
	-pix_fmt yuv420p10le -colorspace bt709 -c:v libx264 -preset ultrafast "$CLIP10" 2>/dev/null || rm -f "$CLIP10"
if [ -f "$CLIP10" ]; then "$OUT/decoder-yuv" "$CLIP10"; else echo "skipping the 10-bit check: this ffmpeg cannot encode 10-bit H.264"; fi
CLIP4K="$OUT/clip-2160p.mkv"
[ -f "$CLIP4K" ] || ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=3840x2160:rate=24 -t 1 \
	-pix_fmt yuv420p -c:v libx264 -preset ultrafast "$CLIP4K"
"$OUT/decoder-yuv" "$CLIP4K"
"$OUT/frame-convert-check" "$CLIP"
"$OUT/decoder-e2e" "$CLIP"
if python3 -c 'import PIL' 2>/dev/null; then
	python3 "$HERE/make-pgs.py" "$OUT/test.sup" >/dev/null
	# -copyts keeps the subtitle timestamps as authored (no re-basing to 0).
	ffmpeg -hide_banner -loglevel error -y -copyts -i "$CLIP" -i "$OUT/test.sup" -map 0:v -map 1:s -c copy "$OUT/clip-pgs.mkv"
	"$OUT/decoder-pgs" "$OUT/clip-pgs.mkv"
else
	echo "skipping the PGS check: python3 with Pillow is needed to write the test subtitles"
fi
