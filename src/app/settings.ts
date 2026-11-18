/**
 * User settings: stream filters tuned for what the Switch decodes well, the
 * stream sort order, and diagnostics. Stored as one JSON value next to the
 * core's profile; unknown or invalid fields fall back to the defaults.
 */
import type { KeyValueStore } from '../shims';
import type { MaxResolution, SourceFilter, StreamFilters, StreamSort } from '../stremio/stream-info';

export interface Settings extends StreamFilters {
	/** How decoded frames are prepared for the screen (see VIDEO_MODES). */
	videoMode: VideoMode;
	/** When an episode ends, continue with the next one from the same source. */
	autoplayNext: boolean;
	/** Per-second player stats in torrent-log.txt (costs CPU and SD writes). */
	diagnostics: boolean;
}

/** Switch-friendly defaults: no 4K, no HDR/DV (no tone mapping), no software-decoded codecs, no CAM rips. */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
	maxResolution: 1080,
	hideHdr: true,
	hideDolbyVision: true,
	hideSoftwareCodecs: true,
	hideHevc: false,
	hideCam: true,
	hideRemux: false,
	maxSizeGB: 0,
	sources: 'all',
	hideUncached: false,
	excludeKeywords: '',
	sort: 'addon',
	videoMode: 'sharp',
	autoplayNext: true,
	diagnostics: false,
});

const STORAGE_KEY = 'stremio-nx:settings';

export type VideoMode = 'sharp' | 'balanced' | 'fast' | 'gpu';
const VIDEO_MODE_NAMES: VideoMode[] = ['sharp', 'balanced', 'fast', 'gpu'];
/** CPU conversion size as a fraction of the screen, per mode. */
const VIDEO_SCALE: Record<VideoMode, number> = { sharp: 1, balanced: 0.75, fast: 0.6, gpu: 1 };

/**
 * What to ask of the video element for a mode: the largest size frames are
 * converted to on the CPU, and whether the GPU converts colours instead. GPU
 * mode falls back to Sharp on a runtime without it (`unavailable`).
 */
export function videoPlan(mode: VideoMode, screenWidth: number, screenHeight: number, gpuSupported: boolean): { width: number; height: number; gpu: boolean; unavailable: boolean } {
	const scale = VIDEO_SCALE[mode] ?? 1;
	// Even dimensions: 4:2:0 video scales cleanly to them.
	const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
	return { width: even(screenWidth), height: even(screenHeight), gpu: mode === 'gpu' && gpuSupported, unavailable: mode === 'gpu' && !gpuSupported };
}
const RESOLUTIONS: MaxResolution[] = [0, 2160, 1440, 1080, 720, 480];
const SIZES = [0, 2, 4, 8, 15, 25, 50];
const SOURCES: SourceFilter[] = ['all', 'http', 'torrent'];
const SORTS: StreamSort[] = ['addon', 'quality', 'size', 'seeders'];

type Choice<T> = { value: T; label: string };

/** A settings row: cycled with A / left / right, or edited with the keyboard (`text`). */
export type SettingItem =
	| { kind: 'choice'; key: keyof Settings; label: string; help: string; choices: Choice<unknown>[] }
	| { kind: 'text'; key: 'excludeKeywords'; label: string; help: string; placeholder: string }
	| { kind: 'action'; id: 'reset' | 'account'; label: string; help: string };

const onOff: Choice<boolean>[] = [{ value: true, label: 'On' }, { value: false, label: 'Off' }];

export const SETTING_ITEMS: SettingItem[] = [
	{ kind: 'action', id: 'account', label: 'Stremio account', help: 'Sign in to bring your watch history, Continue Watching and library from your Stremio account, and keep them in sync. Your account\'s add-ons replace the ones installed here. Sign-in uses email and password.' },
	{ kind: 'choice', key: 'maxResolution', label: 'Maximum resolution', help: 'Hides streams above this. 4K stutters on the Switch; 1080p is the sweet spot docked or handheld.',
		choices: RESOLUTIONS.map((value) => ({ value, label: value === 0 ? 'Any' : value === 2160 ? '4K' : `${value}p` })) },
	{ kind: 'choice', key: 'hideHdr', label: 'Hide HDR', help: 'HDR10, HDR10+ and HLG. There is no HDR tone mapping, so these look washed out.', choices: onOff },
	{ kind: 'choice', key: 'hideDolbyVision', label: 'Hide Dolby Vision', help: 'Dolby Vision files often show green and purple colours without DV processing.', choices: onOff },
	{ kind: 'choice', key: 'hideSoftwareCodecs', label: 'Hide AV1 and 10-bit H.264', help: 'No hardware decoder for these. Software decoding drops frames.', choices: onOff },
	{ kind: 'choice', key: 'hideHevc', label: 'Hide HEVC (x265)', help: 'HEVC is hardware-decoded and usually plays well. Hide it only if a source misbehaves.', choices: onOff },
	{ kind: 'choice', key: 'hideCam', label: 'Hide CAM, TS and screeners', help: 'Hides camcorder and telesync recordings.', choices: onOff },
	{ kind: 'choice', key: 'hideRemux', label: 'Hide REMUX', help: 'Remuxes are untouched discs: very high bitrates that need fast Wi-Fi.', choices: onOff },
	{ kind: 'choice', key: 'maxSizeGB', label: 'Maximum file size', help: 'Hides streams whose listed size is larger. Streams without a listed size stay visible.',
		choices: SIZES.map((value) => ({ value, label: value === 0 ? 'No limit' : `${value} GB` })) },
	{ kind: 'choice', key: 'sources', label: 'Sources', help: 'Direct and debrid links start fastest. Torrents depend on the number of peers.',
		choices: [{ value: 'all', label: 'All' }, { value: 'http', label: 'Direct and debrid only' }, { value: 'torrent', label: 'Torrents only' }] },
	{ kind: 'choice', key: 'hideUncached', label: 'Hide uncached debrid', help: 'Hides results that your debrid service marks as not cached yet.', choices: onOff },
	{ kind: 'text', key: 'excludeKeywords', label: 'Excluded words', help: 'Comma-separated. Streams that mention any of these are hidden, e.g. 3D, HDTS, Hindi. Press A to edit.', placeholder: 'None' },
	{ kind: 'choice', key: 'sort', label: 'Sort streams', help: 'Add-on order keeps the order the add-ons send. Best quality puts the highest allowed resolution and cached results first.',
		choices: [{ value: 'addon', label: 'Add-on order' }, { value: 'quality', label: 'Best quality' }, { value: 'size', label: 'Smallest first' }, { value: 'seeders', label: 'Most seeders' }] },
	{ kind: 'choice', key: 'videoMode', label: 'Video mode', help: 'Sharp converts each frame at 720p. Balanced (540p) and Fast (432p) convert fewer pixels and let the GPU enlarge them: smoother, slightly softer. GPU skips CPU colour conversion entirely (experimental, needs the from-source build). Applies to the next video.',
		choices: [{ value: 'sharp', label: 'Sharp (720p)' }, { value: 'balanced', label: 'Balanced (540p)' }, { value: 'fast', label: 'Fast (432p)' }, { value: 'gpu', label: 'GPU conversion (experimental)' }] },
	{ kind: 'choice', key: 'autoplayNext', label: 'Autoplay next episode', help: 'When an episode ends, the next one starts from the same add-on and quality. R during playback skips to it.', choices: onOff },
	{ kind: 'choice', key: 'diagnostics', label: 'Diagnostics logging', help: 'Writes per-second player statistics to torrent-log.txt. Costs CPU during playback. Turn on only to report a problem.', choices: onOff },
	{ kind: 'action', id: 'reset', label: 'Reset to defaults', help: 'Restores the Switch-friendly defaults. Press A to reset.' },
];

/** Merge stored values over the defaults, dropping anything out of range. */
export function sanitizeSettings(input: unknown): Settings {
	const out: Settings = { ...DEFAULT_SETTINGS };
	if (!input || typeof input !== 'object') return out;
	const v = input as Record<string, unknown>;
	const bool = (key: keyof Settings) => { if (typeof v[key] === 'boolean') (out as unknown as Record<string, unknown>)[key] = v[key]; };
	if (RESOLUTIONS.includes(v.maxResolution as MaxResolution)) out.maxResolution = v.maxResolution as MaxResolution;
	if (SIZES.includes(v.maxSizeGB as number)) out.maxSizeGB = v.maxSizeGB as number;
	if (SOURCES.includes(v.sources as SourceFilter)) out.sources = v.sources as SourceFilter;
	if (SORTS.includes(v.sort as StreamSort)) out.sort = v.sort as StreamSort;
	if (VIDEO_MODE_NAMES.includes(v.videoMode as VideoMode)) out.videoMode = v.videoMode as VideoMode;
	if (typeof v.excludeKeywords === 'string') out.excludeKeywords = v.excludeKeywords.slice(0, 512);
	for (const key of ['hideHdr', 'hideDolbyVision', 'hideSoftwareCodecs', 'hideHevc', 'hideCam', 'hideRemux', 'hideUncached', 'autoplayNext', 'diagnostics'] as const) bool(key);
	return out;
}

export function loadSettings(storage: KeyValueStore): Settings {
	try {
		const raw = storage.getItem(STORAGE_KEY);
		return sanitizeSettings(raw ? JSON.parse(raw) : undefined);
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function saveSettings(storage: KeyValueStore, settings: Settings): void {
	try { storage.setItem(STORAGE_KEY, JSON.stringify(sanitizeSettings(settings))); }
	catch { /* Storage full or unavailable: keep the in-memory value. */ }
}

/** The label of an item's current value. */
export function settingValueLabel(item: SettingItem, settings: Settings): string {
	switch (item.kind) {
		case 'choice': return item.choices.find((c) => c.value === settings[item.key])?.label ?? String(settings[item.key]);
		case 'text': return settings[item.key].trim() || item.placeholder;
		case 'action': return '';
	}
}

/** The next value of a choice item, `step` = +1 / -1 with wrap-around. */
export function cycleSetting(item: SettingItem, settings: Settings, step: 1 | -1): Settings {
	if (item.kind !== 'choice') return settings;
	const i = item.choices.findIndex((c) => c.value === settings[item.key]);
	const next = item.choices[(Math.max(0, i) + step + item.choices.length) % item.choices.length];
	return sanitizeSettings({ ...settings, [item.key]: next.value });
}

/** How many filters differ from "show everything" (for the streams header). */
export function activeFilterCount(s: StreamFilters): number {
	return [s.maxResolution !== 0, s.hideHdr, s.hideDolbyVision, s.hideSoftwareCodecs, s.hideHevc, s.hideCam, s.hideRemux, s.maxSizeGB > 0, s.sources !== 'all', s.hideUncached, s.excludeKeywords.trim() !== ''].filter(Boolean).length;
}
