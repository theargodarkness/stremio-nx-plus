/**
 * What a stream offers, read from the free text add-ons put in its name,
 * title, description and filename (there is no structured quality field in
 * the add-on protocol), plus the filters and sort orders built on it.
 *
 * Parsing is heuristic: unknown values stay unknown and are never hidden by
 * a filter that needs them (an unlabelled stream survives "max 1080p").
 */
import type { Stream, StreamOption } from './client';
import { streamKind } from './streams';

export type Codec = 'hevc' | 'avc' | 'av1' | 'vp9';

export interface StreamInfo {
	/** Vertical resolution class: 2160, 1440, 1080, 720, 480, or 0 when unknown. */
	resolution: number;
	hdr: boolean;
	dolbyVision: boolean;
	codec?: Codec;
	tenBit: boolean;
	cam: boolean;
	remux: boolean;
	sizeBytes?: number;
	seeders?: number;
	/** Debrid cache state: true cached, false not cached, undefined unknown or not debrid. */
	cached?: boolean;
	kind: ReturnType<typeof streamKind>;
	/** Single-line, emoji-free description for the list (filename or title). */
	text: string;
	/** Lower-cased haystack used for keyword exclusion. */
	haystack: string;
}

export type MaxResolution = 0 | 2160 | 1440 | 1080 | 720 | 480;
export type SourceFilter = 'all' | 'http' | 'torrent';
export type StreamSort = 'addon' | 'quality' | 'size' | 'seeders';

export interface StreamFilters {
	/** Highest resolution to show; 0 shows everything. */
	maxResolution: MaxResolution;
	hideHdr: boolean;
	hideDolbyVision: boolean;
	/** AV1 and 10-bit H.264 have no hardware decoder on the Switch. */
	hideSoftwareCodecs: boolean;
	hideHevc: boolean;
	hideCam: boolean;
	hideRemux: boolean;
	/** Largest file to show, in GB; 0 disables the limit. */
	maxSizeGB: number;
	sources: SourceFilter;
	hideUncached: boolean;
	/** Comma-separated words; a stream mentioning any of them is hidden. */
	excludeKeywords: string;
	sort: StreamSort;
}

export interface FilteredStream {
	option: StreamOption;
	info: StreamInfo;
	/** Why the active filters hide this stream; undefined when it is shown. */
	hiddenBy?: string;
}

export interface FilterResult {
	/** Sorted; hidden streams are included (after the shown ones) only when `showAll` was set. */
	rows: FilteredStream[];
	shown: number;
	hidden: number;
}

const B = '(?<![a-z0-9])'; // word start that treats `.`, `_`, `-`, `[` and spaces as separators
const E = '(?![a-z0-9])';
const RX = {
	r2160: new RegExp(`${B}(2160p|4k|uhd|3840x2160)${E}`, 'i'),
	r1440: new RegExp(`${B}(1440p|2560x1440)${E}`, 'i'),
	r1080: new RegExp(`${B}(1080p|1080i|fhd|1920x1080)${E}`, 'i'),
	r720: new RegExp(`${B}(720p|1280x720)${E}`, 'i'),
	r480: new RegExp(`${B}(576p|540p|480p|360p|240p|sd|dvdrip|dvd)${E}`, 'i'),
	dv: new RegExp(`${B}(dv|dovi|dolby[ ._-]?vision)${E}`, 'i'),
	hdr: new RegExp(`${B}(hdr|hdr10|hdr10\\+|hdr10plus|hlg)(?![a-z0-9+])`, 'i'),
	hevc: new RegExp(`${B}(x\\.?265|h\\.?265|hevc)${E}`, 'i'),
	avc: new RegExp(`${B}(x\\.?264|h\\.?264|avc)${E}`, 'i'),
	av1: new RegExp(`${B}av1${E}`, 'i'),
	vp9: new RegExp(`${B}vp9${E}`, 'i'),
	tenBit: new RegExp(`${B}(10[ ._-]?bits?|hi10p?)${E}`, 'i'),
	cam: new RegExp(`${B}(cam|camrip|hdcam|hd-?cam|telesync|hdts|hd-?ts|telecine|hdtc|screener|scr|dvdscr|pdvd|predvd)${E}|${B}ts(?=[ ._\\])-])`, 'i'),
	remux: new RegExp(`${B}(bd)?remux${E}`, 'i'),
	size: /(\d+(?:[.,]\d+)?)\s*(TB|TiB|GB|GiB|MB|MiB)(?![a-z])/i,
	seeders: /(?:👤|👥|seeders?:?|seeds?:?)\s*(\d+)/i,
	cached: /\[(?:rd|ad|pm|tb|dl|ed|oc|pk|dr|trd|en)\s*(?:\+|⚡)\]|⚡|(?<!un)cached/i,
	uncached: /\[(?:rd|ad|pm|tb|dl|ed|oc|pk|dr|trd|en)\s*(?:download|dl)\]|uncached|⏳/i,
};
// Pictographs, dingbats, variation selectors and joiners: the system font has no glyphs for them.
// Explicit ranges, not \p{Extended_Pictographic}: property escapes need ICU, which the
// Switch runtime's V8 is built without (a SyntaxError there would stop the whole app).
const SYMBOLS = /[\u{1F000}-\u{1FAFF}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{E0020}-\u{E007F}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]/gu;

function resolutionOf(text: string): number {
	if (RX.r2160.test(text)) return 2160;
	if (RX.r1440.test(text)) return 1440;
	if (RX.r1080.test(text)) return 1080;
	if (RX.r720.test(text)) return 720;
	if (RX.r480.test(text)) return 480;
	return 0;
}

function sizeOf(text: string): number | undefined {
	const m = RX.size.exec(text);
	if (!m) return undefined;
	const value = Number(m[1].replace(',', '.'));
	if (!Number.isFinite(value) || value <= 0) return undefined;
	const unit = m[2].toUpperCase();
	const scale = unit.startsWith('T') ? 1024 ** 4 : unit.startsWith('G') ? 1024 ** 3 : 1024 ** 2;
	return Math.round(value * scale);
}

const cache = new WeakMap<Stream, StreamInfo>();

/** Parse once per stream object (the UI redraws often; the core hands out new objects on change). */
export function streamInfo(stream: Stream): StreamInfo {
	const hit = cache.get(stream);
	if (hit) return hit;
	const name = String(stream.name ?? '');
	const title = String(stream.title ?? stream.description ?? '');
	const filename = String(stream.behaviorHints?.filename ?? '');
	const all = `${name}\n${title}\n${filename}`;
	// Add-ons put their resolution label in `name`; trust it before the release title.
	const resolution = resolutionOf(name) || resolutionOf(filename) || resolutionOf(title);
	const dolbyVision = RX.dv.test(all);
	const codec: Codec | undefined = RX.hevc.test(all) ? 'hevc' : RX.av1.test(all) ? 'av1' : RX.vp9.test(all) ? 'vp9' : RX.avc.test(all) ? 'avc' : undefined;
	const hinted = stream.behaviorHints?.videoSize;
	const seeders = RX.seeders.exec(all);
	const uncached = RX.uncached.test(name) || RX.uncached.test(title);
	const cached = !uncached && (RX.cached.test(name) || RX.cached.test(title));
	const kind = streamKind(stream);
	const firstLine = (s: string) => s.split('\n').map((l) => l.replace(SYMBOLS, ' ').replace(/\s+/g, ' ').trim()).find((l) => l.length > 0) ?? '';
	const text = firstLine(filename) || firstLine(title) || firstLine(name.replace(/\n/g, ' '));
	const info: StreamInfo = {
		resolution,
		hdr: RX.hdr.test(all) || dolbyVision,
		dolbyVision,
		codec,
		tenBit: RX.tenBit.test(all),
		cam: RX.cam.test(name) || RX.cam.test(filename) || RX.cam.test(title.split('\n')[0] ?? ''),
		remux: RX.remux.test(all),
		sizeBytes: typeof hinted === 'number' && Number.isFinite(hinted) && hinted > 0 ? hinted : sizeOf(all),
		seeders: seeders ? Number(seeders[1]) : undefined,
		cached: uncached ? false : cached ? true : undefined,
		kind,
		text,
		haystack: all.replace(SYMBOLS, ' ').toLowerCase(),
	};
	cache.set(stream, info);
	return info;
}

export function resolutionLabel(resolution: number): string {
	return resolution === 2160 ? '4K' : resolution ? `${resolution}p` : '';
}

/** Short tags for the stream list, most decisive first. */
export function streamBadges(info: StreamInfo): string[] {
	const badges: string[] = [];
	if (info.resolution) badges.push(resolutionLabel(info.resolution));
	if (info.dolbyVision) badges.push('DV');
	else if (info.hdr) badges.push('HDR');
	if (info.codec) badges.push(info.codec === 'avc' ? (info.tenBit ? 'H.264 10-bit' : 'H.264') : info.codec.toUpperCase());
	if (info.remux) badges.push('REMUX');
	if (info.cam) badges.push('CAM');
	if (info.sizeBytes) badges.push(formatSize(info.sizeBytes));
	if (info.cached === true) badges.push('Cached');
	else if (info.cached === false) badges.push('Not cached');
	if (info.seeders !== undefined && info.kind === 'torrent') badges.push(`${info.seeders} seeds`);
	return badges;
}

export function formatSize(bytes: number): string {
	const gib = bytes / 1024 ** 3;
	return gib >= 1 ? `${gib >= 100 ? gib.toFixed(0) : gib.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** Normalized exclusion words: lower-cased, trimmed, deduplicated, at most 32. */
export function parseKeywords(input: string): string[] {
	return [...new Set(input.split(/[,;\n]/).map((w) => w.trim().toLowerCase()).filter((w) => w.length > 0 && w.length <= 40))].slice(0, 32);
}

function keywordMatcher(words: string[]): (haystack: string) => string | undefined {
	const tests = words.map((word) => {
		// Plain words match whole tokens ("3d" must not hide "3DS Max"); others match anywhere.
		if (/^[a-z0-9]+$/.test(word)) {
			const rx = new RegExp(`${B}${word}${E}`, 'i');
			return (h: string) => rx.test(h);
		}
		return (h: string) => h.includes(word);
	});
	return (haystack) => {
		for (let i = 0; i < tests.length; i++) if (tests[i](haystack)) return words[i];
		return undefined;
	};
}

/** The first active filter that hides this stream, as a short reason, or undefined. */
export function hiddenReason(info: StreamInfo, f: StreamFilters, keyword?: (haystack: string) => string | undefined): string | undefined {
	if (f.maxResolution && info.resolution > f.maxResolution) return info.resolution === 2160 ? '4K' : `above ${resolutionLabel(f.maxResolution)}`;
	if (f.hideDolbyVision && info.dolbyVision) return 'Dolby Vision';
	if (f.hideHdr && info.hdr && !info.dolbyVision) return 'HDR';
	if (f.hideSoftwareCodecs && info.codec === 'av1') return 'AV1';
	if (f.hideSoftwareCodecs && info.codec === 'avc' && info.tenBit) return '10-bit H.264';
	if (f.hideHevc && info.codec === 'hevc') return 'HEVC';
	if (f.hideCam && info.cam) return 'CAM/TS';
	if (f.hideRemux && info.remux) return 'REMUX';
	if (f.maxSizeGB > 0 && info.sizeBytes !== undefined && info.sizeBytes > f.maxSizeGB * 1024 ** 3) return `over ${f.maxSizeGB} GB`;
	if (f.sources === 'http' && info.kind === 'torrent') return 'P2P torrent';
	if (f.sources === 'torrent' && (info.kind === 'url' || info.kind === 'external')) return 'not a torrent';
	if (f.hideUncached && info.cached === false) return 'not cached';
	const word = keyword?.(info.haystack);
	if (word) return `"${word}"`;
	return undefined;
}

function compare(a: FilteredStream & { index: number }, b: FilteredStream & { index: number }, sort: StreamSort): number {
	const cachedRank = (x: StreamInfo) => (x.cached === true ? 0 : x.cached === undefined ? 1 : 2);
	switch (sort) {
		case 'quality':
			return (b.info.resolution - a.info.resolution) || (cachedRank(a.info) - cachedRank(b.info)) || ((b.info.seeders ?? -1) - (a.info.seeders ?? -1)) || (a.index - b.index);
		case 'size': {
			const sa = a.info.sizeBytes ?? Number.POSITIVE_INFINITY, sb = b.info.sizeBytes ?? Number.POSITIVE_INFINITY;
			return sa === sb ? a.index - b.index : sa < sb ? -1 : 1;
		}
		case 'seeders':
			return ((b.info.seeders ?? -1) - (a.info.seeders ?? -1)) || (cachedRank(a.info) - cachedRank(b.info)) || (a.index - b.index);
		default:
			return a.index - b.index;
	}
}

/** Apply filters and the sort order. Unsupported sources are never hidden here (the list shows them disabled). */
export function filterStreams(options: StreamOption[], f: StreamFilters, showAll = false): FilterResult {
	const words = parseKeywords(f.excludeKeywords);
	const keyword = words.length ? keywordMatcher(words) : undefined;
	const shown: (FilteredStream & { index: number })[] = [];
	const hidden: (FilteredStream & { index: number })[] = [];
	options.forEach((option, index) => {
		const info = streamInfo(option.stream);
		const hiddenBy = hiddenReason(info, f, keyword);
		(hiddenBy ? hidden : shown).push({ option, info, hiddenBy, index });
	});
	shown.sort((a, b) => compare(a, b, f.sort));
	hidden.sort((a, b) => compare(a, b, f.sort));
	const strip = ({ option, info, hiddenBy }: FilteredStream): FilteredStream => ({ option, info, hiddenBy });
	return { rows: (showAll ? [...shown, ...hidden] : shown).map(strip), shown: shown.length, hidden: hidden.length };
}

/**
 * The stream to continue a series with: the same release group the add-on
 * marks as binge-compatible, else the same add-on at the same resolution,
 * else that add-on's first shown stream. Undefined leaves the choice to the user.
 */
export function pickNextStream(previous: StreamOption, rows: FilteredStream[]): StreamOption | undefined {
	const playable = rows.filter((r) => !r.hiddenBy && (r.info.kind === 'url' || r.info.kind === 'torrent'));
	const sameAddon = playable.filter((r) => r.option.addonUrl === previous.addonUrl);
	const group = (o: StreamOption) => (o.stream.behaviorHints as { bingeGroup?: string } | undefined)?.bingeGroup;
	const wanted = group(previous);
	const before = streamInfo(previous.stream);
	return (wanted ? sameAddon.find((r) => group(r.option) === wanted) : undefined)?.option
		?? sameAddon.find((r) => r.info.resolution === before.resolution && r.info.kind === before.kind)?.option
		?? sameAddon[0]?.option;
}
