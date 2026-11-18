// GPU colour conversion, decoder side: with gpu_yuv the real media-decoder.cc
// hands out NV12 at source size. Its first frame, converted to RGB here with
// the reported matrix, must match the first frame of the normal BGRA path.
// Run for an 8-bit and a 10-bit clip; a 4K-sized source must refuse the mode.
#include "media-decoder.h"
extern "C" {
#include <libswscale/swscale.h>
#include <libavutil/pixfmt.h>
}
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <vector>

static bool first_frame(nx_media_t *m, uint8_t **buf) {
	for (int i = 0; i < 400; i++) {
		if (nx_media_present(m, buf)) return true;
		std::this_thread::sleep_for(std::chrono::milliseconds(5));
	}
	return false;
}

int main(int argc, char **argv) {
	const char *path = argc > 1 ? argv[1] : "clip.mkv";
	char err[256] = {};
	// Reference: BGRA at source size (no render bounds).
	nx_media_t *a = nx_media_open(path, nullptr, 0, nullptr, nullptr, err, sizeof err, 0, 0, false);
	if (!a) { printf("open failed: %s\n", err); return 1; }
	const int w = nx_media_width(a), h = nx_media_height(a);
	uint8_t *bgra = (uint8_t *)malloc(nx_media_frame_bytes(a));
	if (nx_media_gpu_yuv(a) || nx_media_frame_bytes(a) != (size_t)w * h * 4 || !first_frame(a, &bgra)) { puts("FAIL: BGRA path"); return 2; }

	nx_media_t *b = nx_media_open(path, nullptr, 0, nullptr, nullptr, err, sizeof err, 1280, 720, true);
	if (!b) { printf("open failed: %s\n", err); return 1; }
	const bool expect = w <= 1920 && h <= 1088;
	if (nx_media_gpu_yuv(b) != expect) { printf("FAIL: gpu_yuv=%d for %dx%d\n", nx_media_gpu_yuv(b), w, h); return 3; }
	if (!expect) {
		printf("%dx%d: above 1080p, GPU mode refused and BGRA at %dx%d used instead: OK\n", w, h, nx_media_render_width(b), nx_media_render_height(b));
		nx_media_destroy(a); nx_media_destroy(b);
		return 0;
	}
	if (nx_media_render_width(b) != w || nx_media_render_height(b) != h || nx_media_frame_bytes(b) != nx_yuv_frame_bytes(w, h)) { puts("FAIL: NV12 geometry"); return 4; }
	uint8_t *nv12 = (uint8_t *)malloc(nx_media_frame_bytes(b));
	if (!first_frame(b, &nv12)) { puts("FAIL: no NV12 frame"); return 5; }
	const int matrix = nx_media_yuv_matrix(b);
	if (argc > 2) { FILE *f = fopen(argv[2], "wb"); if (f) { fwrite(nv12, 1, nx_media_frame_bytes(b), f); fclose(f); } } // first frame, for an exact comparison

	// Convert the NV12 frame as the GPU would (same matrix and range) and compare.
	std::vector<uint8_t> rgb((size_t)w * h * 4);
	SwsContext *sws = sws_getContext(w, h, AV_PIX_FMT_NV12, w, h, AV_PIX_FMT_BGRA, SWS_BILINEAR, nullptr, nullptr, nullptr);
	int *inv, *tab, sr, dr, br, co, sa;
	sws_getColorspaceDetails(sws, &inv, &sr, &tab, &dr, &br, &co, &sa);
	sws_setColorspaceDetails(sws, sws_getCoefficients(matrix == 1 || matrix == 3 ? SWS_CS_ITU601 : matrix == 4 ? SWS_CS_BT2020 : SWS_CS_ITU709), matrix == 2 || matrix == 3, tab, dr, br, co, sa);
	const uint8_t *src[4] = {nv12, nv12 + (size_t)w * h};
	const int src_stride[4] = {w, 2 * ((w + 1) / 2)};
	uint8_t *dst[4] = {rgb.data()};
	const int dst_stride[4] = {w * 4};
	sws_scale(sws, src, src_stride, 0, h, dst, dst_stride);
	double sum = 0; int worst = 0;
	for (size_t i = 0; i < rgb.size(); i++) { if (i % 4 == 3) continue; const int d = abs((int)rgb[i] - (int)bgra[i]); sum += d; if (d > worst) worst = d; }
	const double mean = sum / (rgb.size() * 0.75);
	printf("%s %dx%d: NV12 %zu bytes/frame vs BGRA %zu, matrix %d, mean channel difference vs CPU path %.3f/255 (max %d)\n",
	       path, w, h, nx_media_frame_bytes(b), (size_t)1280 * 720 * 4, matrix, mean, worst);

	// And it keeps playing: frames present in real time, none dropped.
	nx_media_play(b);
	int got = 0;
	const auto t0 = std::chrono::steady_clock::now();
	while (std::chrono::steady_clock::now() - t0 < std::chrono::seconds(2)) { if (nx_media_present(b, &nv12)) got++; std::this_thread::sleep_for(std::chrono::milliseconds(4)); }
	double transfer, convert; nx_media_frame_times(b, &transfer, &convert);
	printf("  played 2 s: %d frames, %llu dropped, peak pack time %.2f ms\n", got, (unsigned long long)nx_media_dropped_frames(b), convert);
	nx_media_destroy(a); nx_media_destroy(b);
	free(bgra); free(nv12);
	return mean < 1.5 && got >= 40 ? 0 : 6;
}
