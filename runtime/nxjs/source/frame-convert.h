#pragma once
// BGRA conversion of decoded video frames for the presentation ring, split
// across two CPU cores.
//
// Scaling + YUV->RGB conversion is the costliest CPU step of playback (NVDEC
// decodes, VIC copies, but swscale runs on the CPU): for a 1080p source on
// the 720p canvas it is tens of milliseconds per frame on the Switch's
// A57. The converter renders the top half of the output on the calling
// (decode) thread and the bottom half on a helper thread, each with its own
// SwsContext, using swscale's output-slice API (sws_frame_start /
// sws_send_slice / sws_receive_slice, FFmpeg 5.0+) - the same mechanism
// swscale's internal slice threading uses, so the result is identical to a
// single full-frame conversion.
//
// On the Switch, new threads start on the process's default core (core 0,
// shared with the JS main thread and the audio renderer) unless moved, so
// nx_pin_current_thread() lets the decode thread and the helper run on
// cores 1 and 2 instead. Off-console it does nothing.
//
// Pure ffmpeg + C++ threads: no V8, no libnx headers (host-buildable).
#include <stdint.h>

struct AVFrame;
struct nx_frame_converter;

// `helper_core`: core for the helper thread (-1 = leave it on the default core).
nx_frame_converter *nx_frame_converter_new(int helper_core);
void nx_frame_converter_free(nx_frame_converter *c);

// Convert `src` (a software frame, refcounted) to tightly packed BGRA in
// `dst` (dst_w x dst_h, stride dst_w * 4). `colorspace` / `range` are the
// decoder's AVColorSpace / AVColorRange for the frame (hardware transfers
// do not copy them onto the downloaded frame). Returns 0, or a negative
// AVERROR when the caller should fall back to its own conversion.
int nx_frame_convert(nx_frame_converter *c, const AVFrame *src, int colorspace, int range,
                     uint8_t *dst, int dst_w, int dst_h);

// Whether the last conversion was split across two threads (diagnostics).
bool nx_frame_converter_split(const nx_frame_converter *c);

// Move the calling thread to `core` (Switch only; logs and continues on refusal).
void nx_pin_current_thread(int core);
