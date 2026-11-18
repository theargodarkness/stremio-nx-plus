# Stremio NX

![Stremio NX](assets/logo.png)

An independent video player for Nintendo Switch homebrew, compatible with Stremio add-ons.

Browse catalogs and play torrents or direct HTTP links, including compatible debrid streams. Supports subtitles, audio-track selection, add-on management, controller input and touch.

## Install

1. Download `stremio-nx.nro` from [Releases](https://github.com/jrgf/stremio-nx/releases), under Assets.
2. Copy `stremio-nx.nro` to `/switch/` on your SD card.
3. Open the Homebrew Menu through title override by holding R while launching a game, then start Stremio NX.

## Controls

| Button | Action |
| --- | --- |
| D-pad | Navigate; Left/Right seeks during playback |
| A | Select; pause or resume playback |
| B | Back; stop playback |
| L/R | Switch sections |
| Y | Search (from Home, Discover, Library or Search); open audio/subtitle selection during playback |
| X | On a stream list: show or hide the streams your filters removed. Just after a resume: start from the beginning |
| R (twice) | During a series episode: play the next episode |
| ◀ ▶ | On an episode list: change season |
| + | Exit |

## Subtitles

Press Y during playback to choose a subtitle track. Text subtitles (SRT, ASS, WebVTT, add-on subtitles) and image subtitles from Blu-rays and DVDs (PGS, VobSub, DVB) are supported. Image subtitles need a runtime built from this source (see docs/building.md).

## Stream filters

Open **Settings** (the gear at the bottom of the rail) to choose which streams appear. The defaults suit the Switch:

| Setting | Default | Why |
| --- | --- | --- |
| Maximum resolution | 1080p | 4K decodes and scales poorly on the Switch |
| Hide HDR | On | No HDR tone mapping: HDR10/HDR10+/HLG look washed out |
| Hide Dolby Vision | On | DV-only files show green/purple colours |
| Hide AV1 and 10-bit H.264 | On | No hardware decoder; software decoding drops frames |
| Hide CAM, TS and screeners | On | Camcorder and telesync rips |
| Hide HEVC, Hide REMUX, Maximum file size, Sources, Hide uncached debrid | Off | Optional |
| Excluded words | None | Comma-separated, e.g. `3D, HDTS` |
| Sort streams | Add-on order | Or best quality, smallest first, most seeders |
| Video mode | Sharp (720p) | Balanced (540p) and Fast (432p) convert fewer pixels for smoother playback; GPU conversion (experimental) needs a from-source build |
| Autoplay next episode | On | Continues a series from the same add-on and quality |
| Diagnostics logging | Off | Per-second player stats in `torrent-log.txt` (costs CPU) |

Quality is read from the stream names add-ons send. A stream whose resolution or size is not listed is never hidden by those filters. The stream list shows each stream's resolution, HDR, codec, size, seeders and debrid cache state as tags. The header shows how many streams the filters hid; press X to show them dimmed, each with the reason it was hidden.

## Add-ons

Open Add-ons and press Y to enter a manifest URL. For add-ons that need browser setup, open the displayed address on a phone connected to the same Wi-Fi, enter the pairing code, and paste the configured install link.

Direct video links must support byte ranges. HLS, DASH and DRM playback are not supported. WatchHub links open the provider on your phone.

## License

Original project code uses [GPL-3.0-or-later](LICENSE). Dependencies retain their [own licenses](THIRD_PARTY_NOTICES.txt). Not affiliated with Stremio or Nintendo.

[Build from source](docs/building.md) · [License review](LICENSE_REVIEW.md)
