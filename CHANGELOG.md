# Changelog

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
