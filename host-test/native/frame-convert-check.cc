// Benchmark + exactness check (npm run native-check) for frame-convert.cc against the decoder's
// previous single-threaded conversion, on NV12 frames (what the Switch's
// hardware decoder hands over) from a real 1080p H.264 clip.
#include "frame-convert.h"
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>
}
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

using clk = std::chrono::steady_clock;
static double ms(clk::time_point a, clk::time_point b) { return std::chrono::duration<double, std::milli>(b - a).count(); }

int main(int argc, char **argv) {
	const char *path = argc > 1 ? argv[1] : "clip.mkv";
	const int DW = 1280, DH = 720;
	AVFormatContext *fmt = nullptr;
	if (avformat_open_input(&fmt, path, nullptr, nullptr) < 0 || avformat_find_stream_info(fmt, nullptr) < 0) return 1;
	const AVCodec *codec = nullptr;
	int vs = av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, &codec, 0);
	AVCodecContext *dec = avcodec_alloc_context3(codec);
	avcodec_parameters_to_context(dec, fmt->streams[vs]->codecpar);
	avcodec_open2(dec, codec, nullptr);

	// Decode everything up front as NV12 frames.
	std::vector<AVFrame *> frames;
	AVPacket *pkt = av_packet_alloc();
	AVFrame *f = av_frame_alloc();
	SwsContext *to_nv12 = nullptr;
	auto take = [&]() {
		while (avcodec_receive_frame(dec, f) == 0) {
			AVFrame *n = av_frame_alloc();
			n->format = AV_PIX_FMT_NV12; n->width = f->width; n->height = f->height;
			av_frame_get_buffer(n, 64);
			to_nv12 = sws_getCachedContext(to_nv12, f->width, f->height, (AVPixelFormat)f->format, f->width, f->height, AV_PIX_FMT_NV12, SWS_POINT, nullptr, nullptr, nullptr);
			sws_scale(to_nv12, f->data, f->linesize, 0, f->height, n->data, n->linesize);
			n->colorspace = f->colorspace; n->color_range = f->color_range;
			frames.push_back(n);
		}
	};
	while (av_read_frame(fmt, pkt) >= 0) { if (pkt->stream_index == vs) { avcodec_send_packet(dec, pkt); take(); } av_packet_unref(pkt); }
	avcodec_send_packet(dec, nullptr); take();
	printf("decoded %zu frames %dx%d as NV12, colorspace=%d range=%d -> BGRA %dx%d\n", frames.size(), frames[0]->width, frames[0]->height, frames[0]->colorspace, frames[0]->color_range, DW, DH);

	std::vector<uint8_t> a(DW * DH * 4), b(DW * DH * 4), ref(DW * DH * 4);

	// 1. Previous path: sws_getCachedContext + sws_scale, BILINEAR, one thread, default (BT.601) matrix.
	SwsContext *legacy = nullptr;
	double legacy_total = 0, legacy_max = 0;
	for (AVFrame *fr : frames) {
		auto t0 = clk::now();
		legacy = sws_getCachedContext(legacy, fr->width, fr->height, (AVPixelFormat)fr->format, DW, DH, AV_PIX_FMT_BGRA, SWS_BILINEAR, nullptr, nullptr, nullptr);
		uint8_t *dst[4] = {a.data()}; int stride[4] = {DW * 4};
		sws_scale(legacy, fr->data, fr->linesize, 0, fr->height, dst, stride);
		double t = ms(t0, clk::now()); legacy_total += t; if (t > legacy_max) legacy_max = t;
	}

	// 2. New path: two-core converter.
	nx_frame_converter *conv = nx_frame_converter_new(-1);
	double split_total = 0, split_max = 0; int failures = 0;
	for (AVFrame *fr : frames) {
		auto t0 = clk::now();
		if (nx_frame_convert(conv, fr, fr->colorspace, fr->color_range, b.data(), DW, DH) != 0) failures++;
		double t = ms(t0, clk::now()); split_total += t; if (t > split_max) split_max = t;
	}
	printf("split active: %s, failures: %d\n", nx_frame_converter_split(conv) ? "yes" : "no", failures);

	// 3. Exactness: the same configuration as one full-frame conversion (BT.709 matrix, one context).
	SwsContext *full = sws_alloc_context();
	av_opt_set_int(full, "srcw", frames[0]->width, 0); av_opt_set_int(full, "srch", frames[0]->height, 0);
	av_opt_set_int(full, "src_format", AV_PIX_FMT_NV12, 0); av_opt_set_int(full, "dstw", DW, 0); av_opt_set_int(full, "dsth", DH, 0);
	av_opt_set_int(full, "dst_format", AV_PIX_FMT_BGRA, 0); av_opt_set_int(full, "sws_flags", SWS_BILINEAR, 0);
	if (sws_init_context(full, nullptr, nullptr) < 0) return 1;
	int *inv, *tab, sr, dr, br, co, sa;
	sws_getColorspaceDetails(full, &inv, &sr, &tab, &dr, &br, &co, &sa);
	sws_setColorspaceDetails(full, sws_getCoefficients(SWS_CS_ITU709), sr, tab, dr, br, co, sa);
	size_t mismatched_frames = 0, max_diff = 0;
	double legacy_vs_new = 0;
	for (size_t i = 0; i < frames.size(); i++) {
		AVFrame *fr = frames[i];
		uint8_t *dst[4] = {ref.data()}; int stride[4] = {DW * 4};
		sws_scale(full, fr->data, fr->linesize, 0, fr->height, dst, stride);
		nx_frame_convert(conv, fr, fr->colorspace, fr->color_range, b.data(), DW, DH);
		size_t d = 0;
		for (size_t k = 0; k < b.size(); k++) { size_t x = (size_t)abs((int)b[k] - (int)ref[k]); if (x > d) d = x; }
		if (d) mismatched_frames++;
		if (d > max_diff) max_diff = d;
		if (i == frames.size() / 2) {
			uint8_t *ld[4] = {a.data()};
			sws_scale(legacy, fr->data, fr->linesize, 0, fr->height, ld, stride);
			double sum = 0; for (size_t k = 0; k < a.size(); k++) sum += abs((int)a[k] - (int)b[k]);
			legacy_vs_new = sum / a.size();
		}
	}
	const double n = (double)frames.size();
	printf("previous (1 thread, BT.601):  avg %.2f ms  max %.2f ms per frame\n", legacy_total / n, legacy_max);
	printf("new (2 threads, BT.709):      avg %.2f ms  max %.2f ms per frame  (%.2fx faster)\n", split_total / n, split_max, legacy_total / split_total);
	printf("exactness vs one full-frame conversion: %zu/%zu frames differ, max channel diff %zu\n", mismatched_frames, frames.size(), max_diff);
	printf("mean channel difference new vs previous (colour matrix fix): %.2f/255\n", legacy_vs_new);
	nx_frame_converter_free(conv);
	return failures ? 2 : (mismatched_frames ? 3 : 0);
}
