// Two-core BGRA frame conversion. See frame-convert.h.
#include "frame-convert.h"

extern "C" {
#include <libavutil/buffer.h>
#include <libavutil/frame.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
#include <libswscale/swscale.h>
}

#include <condition_variable>
#include <mutex>
#include <stdio.h>
#include <thread>

#ifdef __SWITCH__
// libnx: Result svcSetThreadCoreMask(Handle, s32 core_id, u32 affinity_mask).
// Declared here to keep libnx headers (and their macros) out of the ffmpeg TU.
extern "C" uint32_t svcSetThreadCoreMask(uint32_t handle, int32_t core_id, uint32_t affinity_mask);
#endif

void nx_pin_current_thread(int core) {
#ifdef __SWITCH__
	if (core < 0) return;
	const uint32_t rc = svcSetThreadCoreMask(0xFFFF8000u /* CUR_THREAD_HANDLE */, core, 1u << core);
	if (rc != 0) fprintf(stderr, "[video] thread stays on its default core (core %d refused: 0x%x)\n", core, (unsigned)rc);
#else
	(void)core;
#endif
}

namespace {

constexpr int MIN_SPLIT_ROWS = 64;

int sws_colorspace_of(int colorspace, int height) {
	switch (colorspace) {
		case AVCOL_SPC_BT709: return SWS_CS_ITU709;
		case AVCOL_SPC_BT470BG:
		case AVCOL_SPC_SMPTE170M: return SWS_CS_ITU601;
		case AVCOL_SPC_SMPTE240M: return SWS_CS_SMPTE240M;
		case AVCOL_SPC_FCC: return SWS_CS_FCC;
		case AVCOL_SPC_BT2020_NCL:
		case AVCOL_SPC_BT2020_CL: return SWS_CS_BT2020;
		default:
			// Unflagged: HD sources are BT.709, SD ones BT.601 (what players assume).
			return height >= 720 ? SWS_CS_ITU709 : SWS_CS_ITU601;
	}
}

SwsContext *make_context(int sw, int sh, AVPixelFormat sf, int dw, int dh, int colorspace, int range) {
	SwsContext *c = sws_alloc_context();
	if (!c) return nullptr;
	av_opt_set_int(c, "srcw", sw, 0);
	av_opt_set_int(c, "srch", sh, 0);
	av_opt_set_int(c, "src_format", sf, 0);
	av_opt_set_int(c, "dstw", dw, 0);
	av_opt_set_int(c, "dsth", dh, 0);
	av_opt_set_int(c, "dst_format", AV_PIX_FMT_BGRA, 0);
	av_opt_set_int(c, "sws_flags", SWS_BILINEAR, 0);
	av_opt_set_int(c, "threads", 1, 0); // our own two threads; swscale's pool would sit on core 0
	if (sws_init_context(c, nullptr, nullptr) < 0) {
		sws_freeContext(c);
		return nullptr;
	}
	// Colours: the matrix the source was mastered with (swscale defaults to BT.601).
	int *inv_table = nullptr, *table = nullptr;
	int src_range = 0, dst_range = 0, brightness = 0, contrast = 0, saturation = 0;
	if (sws_getColorspaceDetails(c, &inv_table, &src_range, &table, &dst_range, &brightness, &contrast, &saturation) >= 0) {
		// YUVJ formats already report full range; otherwise trust the stream's flag.
		if (range == AVCOL_RANGE_JPEG) src_range = 1;
		sws_setColorspaceDetails(c, sws_getCoefficients(sws_colorspace_of(colorspace, sh)), src_range, table, dst_range,
		                         brightness, contrast, saturation);
	}
	return c;
}

void no_free(void *, uint8_t *) {}

// One output slice [y0, y0 + h) of the whole frame through context `c`.
int convert_slice(SwsContext *c, const AVFrame *src, AVFrame *dst, int y0, int h) {
	int ret = sws_frame_start(c, dst, src);
	if (ret < 0) return ret;
	ret = sws_send_slice(c, 0, src->height);
	if (ret >= 0) ret = sws_receive_slice(c, y0, h);
	sws_frame_end(c);
	return ret;
}

} // namespace

struct nx_frame_converter {
	SwsContext *ctx[2] = {nullptr, nullptr};
	int src_w = 0, src_h = 0, src_fmt = -1, dst_w = 0, dst_h = 0, colorspace = -1, range = -1;
	bool split_ok = true; // cleared after a failed split; single-threaded from then on
	bool last_split = false;
	int helper_core = -1;

	// Helper thread: converts the bottom slice while the caller does the top.
	std::thread thread;
	std::mutex mu;
	std::condition_variable cv_job, cv_done;
	bool started = false, job = false, done = true, quit = false;
	const AVFrame *job_src = nullptr;
	AVFrame *job_dst = nullptr;
	int job_y0 = 0, job_h = 0, job_result = 0;

	void helper_main() {
		nx_pin_current_thread(helper_core);
		std::unique_lock<std::mutex> lock(mu);
		for (;;) {
			cv_job.wait(lock, [this] { return job || quit; });
			if (quit) return;
			job = false;
			const AVFrame *src = job_src;
			AVFrame *dst = job_dst;
			const int y0 = job_y0, h = job_h;
			lock.unlock();
			const int r = convert_slice(ctx[1], src, dst, y0, h);
			lock.lock();
			job_result = r;
			done = true;
			cv_done.notify_one();
		}
	}
};

nx_frame_converter *nx_frame_converter_new(int helper_core) {
	auto *c = new nx_frame_converter();
	c->helper_core = helper_core;
	return c;
}

void nx_frame_converter_free(nx_frame_converter *c) {
	if (!c) return;
	if (c->started) {
		{
			std::lock_guard<std::mutex> lock(c->mu);
			c->quit = true;
		}
		c->cv_job.notify_one();
		c->thread.join();
	}
	sws_freeContext(c->ctx[0]);
	sws_freeContext(c->ctx[1]);
	delete c;
}

bool nx_frame_converter_split(const nx_frame_converter *c) {
	return c && c->last_split;
}

int nx_frame_convert(nx_frame_converter *c, const AVFrame *src, int colorspace, int range,
                     uint8_t *dst, int dst_w, int dst_h) {
	if (!c || !src || !src->buf[0] || dst_w <= 0 || dst_h <= 0) return AVERROR(EINVAL);
	// (Re)configure on any change of geometry, format or colours.
	if (!c->ctx[0] || c->src_w != src->width || c->src_h != src->height || c->src_fmt != src->format ||
	    c->dst_w != dst_w || c->dst_h != dst_h || c->colorspace != colorspace || c->range != range) {
		sws_freeContext(c->ctx[0]);
		sws_freeContext(c->ctx[1]);
		c->ctx[0] = make_context(src->width, src->height, (AVPixelFormat)src->format, dst_w, dst_h, colorspace, range);
		c->ctx[1] = c->ctx[0] ? make_context(src->width, src->height, (AVPixelFormat)src->format, dst_w, dst_h, colorspace, range) : nullptr;
		if (!c->ctx[0]) return AVERROR(EINVAL);
		c->src_w = src->width; c->src_h = src->height; c->src_fmt = src->format;
		c->dst_w = dst_w; c->dst_h = dst_h; c->colorspace = colorspace; c->range = range;
	}

	// The destination ring slot as a refcounted frame (swscale refs it; nothing is freed).
	AVFrame *out = av_frame_alloc();
	if (!out) return AVERROR(ENOMEM);
	out->buf[0] = av_buffer_create(dst, (size_t)dst_w * dst_h * 4, no_free, nullptr, 0);
	if (!out->buf[0]) { av_frame_free(&out); return AVERROR(ENOMEM); }
	out->data[0] = dst;
	out->linesize[0] = dst_w * 4;
	out->width = dst_w;
	out->height = dst_h;
	out->format = AV_PIX_FMT_BGRA;

	int ret;
	const bool split = c->split_ok && c->ctx[1] && dst_h >= MIN_SPLIT_ROWS;
	if (split) {
		if (!c->started) {
			c->started = true;
			c->thread = std::thread([c] { c->helper_main(); });
		}
		const int half = dst_h / 2;
		{
			std::lock_guard<std::mutex> lock(c->mu);
			c->job_src = src; c->job_dst = out; c->job_y0 = half; c->job_h = dst_h - half;
			c->done = false; c->job = true;
		}
		c->cv_job.notify_one();
		const int top = convert_slice(c->ctx[0], src, out, 0, half);
		int bottom;
		{
			std::unique_lock<std::mutex> lock(c->mu);
			c->cv_done.wait(lock, [c] { return c->done; });
			bottom = c->job_result;
		}
		ret = top < 0 ? top : bottom;
		if (ret < 0) {
			// Never fail playback over the optimisation: one thread from now on.
			fprintf(stderr, "[video] split conversion failed (%d); converting on one thread\n", ret);
			c->split_ok = false;
			ret = convert_slice(c->ctx[0], src, out, 0, dst_h);
		}
	} else {
		ret = convert_slice(c->ctx[0], src, out, 0, dst_h);
	}
	c->last_split = split && c->split_ok;
	av_frame_free(&out);
	return ret < 0 ? ret : 0;
}
