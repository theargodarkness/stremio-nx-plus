// The real media-decoder.cc on a 1080p clip with a PGS track: track is
// supported, captions appear and clear at the authored times, pixels arrive
// as RGBA with the right placement, and pixels cross only on change.
#include "media-decoder.h"
#include <chrono>
#include <cstdio>
#include <thread>
#include <vector>
int main(int argc, char **argv) {
	char err[256] = {};
	nx_media_t *m = nx_media_open(argc > 1 ? argv[1] : "clip-pgs.mkv", nullptr, 0, nullptr, nullptr, err, sizeof err, 1280, 720);
	if (!m) { printf("open failed: %s\n", err); return 1; }
	int pgs = -1;
	for (const auto &t : nx_media_tracks(m)) {
		printf("track %d %s codec=%s supported=%d lang=%s\n", t.id, t.subtitle ? "subtitle" : "audio", t.codec.c_str(), t.supported, t.language.c_str());
		if (t.subtitle && t.codec == "hdmv_pgs_subtitle") pgs = t.supported ? t.id : -2;
	}
	if (pgs < 0) { puts("FAIL: PGS track not supported"); return 2; }
	if (!nx_media_select_track(m, pgs, true)) { puts("FAIL: select"); return 3; }
	nx_media_play(m);
	const size_t buf_size = (size_t)nx_media_render_width(m) * nx_media_render_height(m) * 4;
	std::vector<uint8_t> frame(buf_size); uint8_t *fb = frame.data();
	uint64_t known = 0; int copies = 0, polls = 0;
	auto t0 = std::chrono::steady_clock::now();
	while (std::chrono::steady_clock::now() - t0 < std::chrono::milliseconds(5200)) {
		nx_media_present(m, &fb);
		const double now = nx_media_current_time(m);
		int cw = 0, ch = 0; std::vector<nx_media_subtitle_image> rects;
		const uint64_t id = nx_media_subtitle_bitmap(m, now, known, &cw, &ch, &rects);
		polls++;
		if (id != known) {
			if (id) {
				copies++;
				const auto &r = rects[0];
				// Sample: a pixel in the half-transparent bottom bar, a corner (transparent), and count opaque white pixels.
				const uint8_t *bar = &r.rgba[((size_t)(r.height - 3) * r.width + r.width / 2) * 4];
				size_t white = 0; for (size_t i = 0; i < r.rgba.size(); i += 4) white += r.rgba[i] > 240 && r.rgba[i + 1] > 240 && r.rgba[i + 2] > 240 && r.rgba[i + 3] == 255;
				printf("t=%.2fs caption #%llu canvas %dx%d rects=%zu at (%d,%d) %dx%d | corner alpha=%d bar rgba=(%d,%d,%d,%d) white px=%zu\n", now,
				       (unsigned long long)id, cw, ch, rects.size(), r.x, r.y, r.width, r.height, r.rgba[3], bar[0], bar[1], bar[2], bar[3], white);
				
			} else printf("t=%.2fs cleared\n", now);
			known = id;
		}
		std::this_thread::sleep_for(std::chrono::milliseconds(10));
	}
	printf("%d polls, %d pixel copies (only on change)\n", polls, copies);
	nx_media_destroy(m);
	return copies == 2 ? 0 : 4;
}
