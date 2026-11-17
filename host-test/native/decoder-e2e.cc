// End-to-end: the real decoder (media-decoder.cc) with the two-core converter,
// software-decoding a 1080p clip to 1280x720 BGRA, played for 3 s, then destroyed.
#include "media-decoder.h"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <thread>
int main(int argc, char **argv) {
	char err[256] = {};
	nx_media_t *m = nx_media_open(argc > 1 ? argv[1] : "clip.mkv", nullptr, 0, nullptr, nullptr, err, sizeof err, 1280, 720);
	if (!m) { printf("open failed: %s\n", err); return 1; }
	printf("opened %dx%d -> render %dx%d, decoder %s\n", nx_media_width(m), nx_media_height(m), nx_media_render_width(m), nx_media_render_height(m), nx_media_video_decoder(m));
	const size_t size = (size_t)nx_media_render_width(m) * nx_media_render_height(m) * 4;
	uint8_t *buf = (uint8_t *)calloc(1, size);
	nx_media_play(m);
	auto t0 = std::chrono::steady_clock::now();
	int got = 0; double peak_t = 0, peak_c = 0;
	while (std::chrono::steady_clock::now() - t0 < std::chrono::seconds(3)) {
		if (nx_media_present(m, &buf)) got++;
		double t, c; nx_media_frame_times(m, &t, &c); if (c > peak_c) peak_c = c; if (t > peak_t) peak_t = t;
		std::this_thread::sleep_for(std::chrono::milliseconds(4));
	}
	size_t nonzero = 0; for (size_t i = 0; i < size; i += 4) nonzero += buf[i] | buf[i + 1] | buf[i + 2] ? 1 : 0;
	printf("presented %d frames in 3 s (%llu presented, %llu dropped), peak convert %.2f ms, %.0f%% of pixels non-black\n", got,
	       (unsigned long long)nx_media_presented_frames(m), (unsigned long long)nx_media_dropped_frames(m), peak_c, 100.0 * nonzero / (size / 4));
	nx_media_destroy(m);
	puts("destroyed cleanly");
	free(buf);
	return got >= 60 ? 0 : 4;
}
