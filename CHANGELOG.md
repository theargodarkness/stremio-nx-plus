# Changelog

## 0.7.2: sign-in in two steps

### Fixed
- **The password keyboard appeared but took no input.** 0.7.1 stopped the runtime's per-frame keyboard update after each prompt; closing the keyboard is a handshake that only advances while that update runs, so the next keyboard came up deaf. The update is left running again.
- Sign-in no longer opens the password keyboard by itself after the email. Enter the email, then press A again for the password, so each keyboard opens on a button press of its own (as a second search does). The email is kept between attempts; B on the row starts over.
- The log records how each keyboard closed and how many input events it delivered (never the text), to diagnose an unresponsive keyboard.

## 0.7.1: sign-in keyboard fix

### Fixed
- **The password keyboard accepted no input.** Sign-in opens a second keyboard right after the first closes. The console's keyboard, shown in the same frame it was confirmed in, comes up without accepting text. A prompt now waits 0.7 s after the previous one closed before opening (the field is shown meanwhile, and buttons stay with the prompt).
- The runtime left its per-frame keyboard update running after OK or cancel and started another with every prompt, so repeated searches stacked them. The leftover one is now stopped after each prompt.

## 0.7.0: Stremio account, smoother start

### Added
- **Stremio account sign-in** (Settings > Stremio account). Email, then password (masked on screen). The core then uses the account's library and add-ons: Continue Watching on Home and the Library section show what was watched on any device, and progress made here syncs back. Changes from other devices are fetched at launch. Signing out restores the add-ons installed on the console. The password is not stored or logged; the core keeps the session key in its profile.

### Fixed
- **Stutter while the video downloads** (debrid and direct links). Every 8 MiB range was a new connection, and its TLS handshake runs on the thread that also presents video: a 60-100 ms hitch per request, several in a row at the start (diagnostics showed `render gap` jump from about 18 ms to 60-118 ms exactly when `requests` rose). A healthy player now reads one long request (up to 64 MiB) at the pace of playback instead. Parallel fixed ranges remain for startup, seeks and a link that cannot keep up.
- **Start, pause, refill when resuming.** The resume seek happened after playback began, discarding the startup buffer. It now happens before the first frame, so the buffer fills at the resume point.
- Continue Watching and Library cards show their progress bar (the core reports a percentage, which was not read).
- A request dropped by the server while paused no longer uses up its retries when progress was made in between.

### Developer
- `player-check`: resume before the first frame, and steady playback opening at most 2 connections per 40 MiB (was 5). `npm run core-account`: sign-in, sync and sign-out against the real stremio-core with a local account API.

## 0.6.0: video modes and GPU colour conversion

### Added
- **Settings > Video mode.** Chooses how decoded frames are prepared for the screen; applies to the next video.
  - **Sharp (720p)**: the default, as before.
  - **Balanced (540p)** and **Fast (432p)**: frames are converted at a smaller size (44% and 64% fewer pixels) and enlarged by the GPU. Smoother on heavy streams, slightly softer. These work with any runtime.
  - **GPU conversion (experimental)**: no CPU colour conversion at all (native runtime: needs a from-source build).
- **GPU colour conversion** (runtime). The decoder hands frames over as NV12 planes at source size, and Skia uploads the two planes and converts and scales them in the fragment shader (`SkImages::TextureFromYUVAPixmaps`). swscale leaves the per-frame path: what remains on the CPU is a copy of about 3 MB per 1080p frame (1-2 ms on the host, against tens of milliseconds of conversion on the console). 10-bit video is reduced to 8 bits during that copy. The upload is smaller than before as well (3.1 MB of planes against 3.7 MB of BGRA).
  - Used for sources up to 1920x1088 on a GPU-backed screen. Larger sources, a raster screen, or a runtime without the feature fall back to CPU conversion, and the player says so.
  - Not yet run on a Switch. It is off unless selected; if the picture is wrong or memory grows, switch back to Sharp and report it with a diagnostics log (the stats line shows `NV12/GPU`).

### Developer
- `npm run native-check` gains `decoder-yuv`: the NV12 frame is byte-identical to ffmpeg's own for 8-bit, within rounding of the CPU path for 10-bit, and refused above 1080p.
- The canvas change compiles against Skia m146 and m159 headers; the binding against V8 15.0.

## 0.5.0: resume, seasons, next episode

### Added
- **Resume where you left off.** Playback position is now reported to the Stremio core, which it never was before. Videos resume from where you stopped (X within 8 seconds starts over), Continue Watching fills in, and progress syncs to your Stremio account when signed in.
- **Seasons.** Series list one season at a time (◀ ▶ or L/R to switch, specials last) and open on the episode you watched last. Episodes show Watched, percent watched or Upcoming.
- **Next episode.** When an episode ends, the next one starts from the same add-on and quality (same release group when the add-on marks one). Press R twice during playback to skip ahead. If no matching stream exists, the episode's stream list opens instead. Settings > Autoplay next episode turns it off.
- **Remembered languages.** The audio and subtitle language you pick (or subtitles off) is selected again on the next video that has it.
- **Instant home screen.** The rows from the last launch show at once and are replaced as add-ons answer.
- **Clear error messages.** A wrong console date, the cause of "certificate validity starts in the future", is now explained on screen with where to fix it; network failures are worded plainly.
- The player title shows the episode.

### Changed
- X and − in the player only open the developer overlays while Diagnostics logging is on. Before, a stray X press could blank the video.

### Developer
- `watch.test.ts` and new `ui.test.ts` cases; `npm run core-watch` checks resume, watched state and Continue Watching against the real stremio-core.

## 0.4.0: image subtitles (PGS, VobSub, DVB)

### Added (native runtime: needs a from-source build, see docs/building.md)
- **Blu-ray PGS subtitles** (`hdmv_pgs_subtitle`), plus DVD VobSub and DVB image subtitles, are now selectable. Before, they were listed as unsupported.
- The decoder turns each subtitle image into RGBA once, on the decode thread. It keeps each one showing until the next subtitle event, since PGS subtitles end when an empty update clears them. Pixels are handed to the app only when the subtitle changes.
- Subtitles are drawn in the coordinate space the disc was authored for, fitted to the screen. That also places them correctly on cropped (letterboxed) encodes, and the subtitle delay setting applies to them.
- The track menu shows readable formats: PGS (image), VobSub (image), SRT, ASS and so on.
- On runtimes without this support (an NRO built from an older runtime), image tracks stay marked unsupported. Nothing else changes.

### Developer
- `npm run native-check` now also writes a PGS stream (`host-test/native/make-pgs.py`, Python + Pillow) and checks the real decoder's timing, placement and pixels.

## 0.3.0: search rewrite and faster video decoding

### Search, rewritten
- **A real search bar.** The Switch's inline keyboard has no text field of its own, so the app now draws one above the keyboard with your text and caret as you type. The add-on link and Excluded words prompts get the same field.
- **Results as you type.** After a short pause (2+ letters) matching titles are listed above the keyboard. OK shows them as poster rows with the first result selected; B puts back whatever was there before.
- **Each search starts empty.**
- **Nothing behind the keyboard reacts.** While the keyboard is open, buttons and taps (including taps on the on-screen keys) no longer reach the menus underneath.
- Y opens search from Home, Discover and Library too; tapping the search bar works as well.

### Video (native runtime: needs a from-source build, see docs/building.md)
- **Decoding no longer shares the UI core.** On the Switch every new thread starts on core 0 unless moved, so 1080p frame conversion (scaling + YUV to RGB on the CPU) competed with the JavaScript UI thread, the network feed, GPU presentation and the audio renderer, while cores 1 and 2 sat idle. The decode thread now runs on core 1.
- **Frame conversion split across two cores.** Each frame's conversion is shared between the decode thread (top half) and a helper thread on core 2 (bottom half) through swscale's output-slice API. The output is byte-identical to a single full-frame conversion, and about 1.8x faster on two cores in host benchmarks (`npm run native-check`).
- **Correct colours for HD.** Frames were converted with the SD (BT.601) matrix. HD video now uses BT.709 (or what the stream declares), which fixes slightly shifted greens and reds.
- If the split ever fails, conversion falls back to one thread; if the new converter fails, the previous conversion runs.

### Video (app)
- The render loop reads subtitles per presented frame instead of per display refresh. It queries playback state only while the controls are visible, and clears only the letterbox bars instead of the whole screen each frame.

## 0.2.1: search fix

### Fixed
- **Search never ran.** When you press OK, the runtime hides the keyboard and only then reports the submitted text. The keyboard prompt treated the hide as a cancel, so every query was thrown away (this was also in 0.1.1). A hide now counts as a cancel only if no submit follows in the same dispatch. This also fixes Settings > Excluded words, which used the same prompt.
- The button that confirms the keyboard (A or +) no longer acts on the screen behind it once the keyboard closes.
- While a search runs, the screen says "Searching…" instead of "Press Y to search.". An empty result now says "No results for “…”".

## 0.2.0: stream filters and performance

### Added
- **Settings** section with stream filters: maximum resolution (default 1080p, hides 4K), HDR, Dolby Vision, AV1 and 10-bit H.264, HEVC, CAM/TS, REMUX, maximum file size, source type (direct/debrid or torrents), uncached debrid results and excluded words. Settings persist across launches.
- Stream sort orders: add-on order, best quality, smallest first, most seeders.
- Stream list tags for resolution, HDR/DV, codec, size, seeders and debrid cache state. Emoji the system font cannot draw are removed from stream names.
- X on a stream list shows the filtered streams (dimmed, with the reason they are hidden) and hides them again.
- A playback notice when an unlabelled source turns out to be above 1080p.

### Faster
- **Details open as soon as the title's metadata arrives** (about 0.1 s in tests) instead of waiting for every stream add-on. Streams from slower add-ons appear as they answer, and the cursor stays on the stream it was on.
- **A slow or silent add-on no longer fails a screen.** Before, one add-on taking over 30 s made the whole details page or home board fail with "timed out". Now it is counted as unavailable after 25 s and everything else stays. A title with no stream add-ons no longer waits 30 s for nothing.
- **The home board and search results fill in row by row** with placeholder cards, and can be browsed while slower catalogs load.
- **Smaller posters:** IMDb, TMDB and metahub image URLs are requested at about thumbnail size instead of full size. That is far fewer bytes to download and decode, and full-size IMDb posters were up to 24 MB decoded.
- **Poster queue:** on-screen posters load first, posters scrolled past are dropped from the queue, 4 parallel loads instead of 2, a 15 s timeout per image, and failed posters retry after 30 s instead of staying blank.
- **Smoother playback:** with diagnostics off (the new default), the player no longer samples the native heap every 10 s (a 10-30 ms stall on the JS thread that also pumps video frames). It also no longer builds a long stats line every second or rewrites a log of up to about 2 MB to the SD card every 5 s.
- Text layout (clipping and wrapping) is cached between redraws, and the stream list is filtered once per change instead of on every frame.

### Developer
- New host tests: `stream-info.test.ts`, `settings.test.ts` and progressive/filter/settings cases in `ui.test.ts`.
- `npm run core-progressive` checks progressive loading against the real stremio-core with local mock add-ons (fast, slow and silent).
