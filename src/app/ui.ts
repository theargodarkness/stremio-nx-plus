/**
 * The app's screens as one state machine, pure of canvas, controller and
 * touch so the host tests can drive it:
 *
 *   rail: home | discover | library | search
 *   section screen: rows of poster cards (board rows, a catalog grid, the
 *   library, search results), a d-pad cursor, the rail on the left
 *   details: backdrop + info + a vertical list (episodes, then streams)
 *   player: on-screen display with a progress bar, scrubbing, pause
 *
 * `main.ts` feeds it button presses, taps and swipes, and draws it.
 */
import type { CatalogRef, CatalogRow, MetaDetails, MetaItem, MetaPreview, StreamOption, Video } from '../stremio/client';
import type { Button } from './input';
import type { Addon } from '../stremio/addons';
import { streamKind } from '../stremio/streams';
import { filterStreams, streamBadges, type FilterResult } from '../stremio/stream-info';
import { DEFAULT_SETTINGS, SETTING_ITEMS, activeFilterCount, cycleSetting, sanitizeSettings, settingValueLabel, type SettingItem, type Settings } from './settings';

export type Section = 'home' | 'discover' | 'library' | 'search' | 'addons' | 'settings';
export const SECTIONS: Section[] = ['home', 'discover', 'library', 'search', 'addons', 'settings'];
export const SECTION_TITLES: Record<Section, string> = { home: 'Home', discover: 'Discover', library: 'Library', search: 'Search', addons: 'Add-ons', settings: 'Settings' };

export type Screen = 'section' | 'details' | 'player';

export interface Card {
	meta: MetaPreview;
	label: string;
	/** "See all" card: opens this catalog in Discover. */
	seeAll?: CatalogRef;
}

export interface Row {
	title: string;
	kind: 'posters' | 'chips';
	cards: Card[];
	/** Stable identity across progressive updates (keeps the cursor on the same row). */
	key?: string;
	/** The add-on has not answered yet: drawn as placeholder cards. */
	loading?: boolean;
}

export interface ListRow {
	label: string;
	detail?: string;
	enabled: boolean;
	/** Quality tags drawn as pills before the label (streams only). */
	badges?: string[];
	/** Shown only because hidden streams are revealed (X); drawn dimmed. */
	dimmed?: boolean;
}

/** A keyboard prompt in progress: the UI draws the text field above the keyboard. */
export interface KeyboardState {
	kind: 'search' | 'text';
	label: string;
	text: string;
	cursor: number;
	/** Height of the keyboard from the bottom of the screen (0 until known). */
	height: number;
	placeholder?: string;
}

export interface SettingRow {
	label: string;
	value: string;
	help: string;
	kind: SettingItem['kind'];
}

/** What a tap landed on; the renderer records these with each drawn element. */
export type HitTarget =
	| { kind: 'rail'; section: Section }
	| { kind: 'card'; row: number; col: number }
	| { kind: 'listRow'; index: number }
	| { kind: 'back' }
	| { kind: 'video' }
	| { kind: 'osdPause' }
	| { kind: 'osdBack' }
	| { kind: 'tracks'; tab: 'audio' | 'subtitles' }
	| { kind: 'trackRow'; index: number }
	| { kind: 'subtitleDelay'; delta: number }
	| { kind: 'closeTracks' }
	| { kind: 'addonRow'; index: number }
	| { kind: 'addonInstall' }
	| { kind: 'settingRow'; index: number }
	| { kind: 'settingStep'; index: number; step: 1 | -1 }
	| { kind: 'toggleHidden' }
	| { kind: 'searchBar' }
	| { kind: 'osdSeek'; fraction: number };

export interface TrackOption { id: string; label: string; selected: boolean; enabled: boolean }

export interface Playback {
	time: number;
	duration: number;
	paused: boolean;
	/** The decoder is waiting for bytes (after a seek, or a slow swarm). */
	buffering?: boolean;
	/** Contiguous data ahead of the decoder, in MiB. */
	aheadMiB?: number;
	/** A playback hint for the display (e.g. a 4K source that may stutter). */
	notice?: string;
}

/** What the UI needs from the core, the player and the console, without knowing them. */
export interface UiServices {
	catalogs(): CatalogRef[];
	/** `onUpdate` receives rows as add-ons answer; the promise resolves with the final rows. */
	loadBoard(onUpdate?: (rows: CatalogRow[]) => void): Promise<CatalogRow[]>;
	continueWatching(): MetaPreview[];
	loadCatalog(catalog: CatalogRef): Promise<MetaPreview[]>;
	loadLibrary(): Promise<MetaPreview[]>;
	search(query: string, onUpdate?: (rows: CatalogRow[]) => void): Promise<CatalogRow[]>;
	/**
	 * On-screen keyboard; null when dismissed. `ok` labels the OK key (8 chars).
	 * The console's inline keyboard draws no text field, so `onInput` reports
	 * the text, caret and keyboard height as they change for the UI to draw.
	 */
	promptText(ok: string, initial: string, onInput?: (text: string, cursor: number, keyboardHeight: number) => void): Promise<string | null>;
	/** Resolves once the meta item is known; streams from slower add-ons follow through `onUpdate`. */
	loadDetails(item: MetaPreview, videoId?: string, onUpdate?: (details: MetaDetails) => void): Promise<MetaDetails>;
	/** Persisted settings (defaults when absent, e.g. in host tests). */
	getSettings?(): Settings;
	setSettings?(settings: Settings): void;
	/** Start playing; resolves once playback has begun. `onProgress` updates the footer meanwhile. */
	play(option: StreamOption, meta: MetaItem, videoId: string, onProgress: (message: string) => void): Promise<void>;
	stop(): void;
	togglePause(): void;
	seekTo(seconds: number): void;
	playback(): Playback | null;
	tracks(kind: 'audio' | 'subtitles'): TrackOption[];
	selectTrack(kind: 'audio' | 'subtitles', id: string): Promise<void>;
	subtitleDelay(delta?: number): number;
	trackNotice(): string;
	addons(): Addon[];
	installAddon(url: string): Promise<void>;
	removeAddon(url: string): Promise<void>;
	addonSetup(): { url: string; code: string };
	openExternal(url: string): Promise<string>;
	log(msg: string): void;
}

interface SectionState {
	rows: Row[];
	row: number;
	col: number;
	loaded: boolean;
	/** Discover: the catalog whose grid is shown. */
	catalog?: CatalogRef;
	/** Search: the last query. */
	query?: string;
}

export interface DetailsState {
	meta: MetaItem;
	streams: StreamOption[];
	videos: Video[];
	mode: 'episodes' | 'streams';
	cursor: number;
	videoId: string;
	/** Reveal streams the filters hide (X). */
	showAll?: boolean;
	/** Stream add-ons still loading / failed for the current video. */
	pendingAddons?: number;
	failedAddons?: number;
}

export interface OsdState {
	visible: boolean;
	/** Timestamp after which the display hides (unless paused or scrubbing). */
	hideAt: number;
	/** Seek target while scrubbing with the d-pad; committed after a short pause. */
	scrubTarget?: number;
	commitAt?: number;
	/** Consecutive scrub presses (drives the accelerating step). */
	scrubPresses: number;
	lastScrubAt: number;
}

const GRID_COLUMNS = 7;
const OSD_SHOW_MS = 4000;
const SCRUB_COMMIT_MS = 450;
const SCRUB_STEPS = [10, 10, 10, 30, 30, 60];
const SEE_ALL_ID = '__see_all__';

export class UiModel {
	screen: Screen = 'section';
	section: Section = 'home';
	railFocused = false;
	railIndex = 0;
	sections: Record<Section, SectionState> = {
		home: { rows: [], row: 0, col: 0, loaded: false },
		discover: { rows: [], row: 0, col: 0, loaded: false },
		library: { rows: [], row: 0, col: 0, loaded: false },
		search: { rows: [], row: 0, col: 0, loaded: false },
		addons: { rows: [], row: 0, col: 0, loaded: false },
		settings: { rows: [], row: 0, col: 0, loaded: true },
	};
	details?: DetailsState;
	settingsCursor = 0;
	/** A search is waiting for add-ons (the body says so instead of "Press Y"). */
	searching = false;
	/** Open keyboard prompt; all pad and touch input belongs to the keyboard meanwhile. */
	keyboard?: KeyboardState;
	/** Pause after the last keystroke before searching as you type. */
	static searchDebounceMs = 600;
	/** Set after the first A on "Reset to defaults"; the second A resets. */
	resetConfirm = false;
	osd: OsdState = { visible: false, hideAt: 0, scrubPresses: 0, lastScrubAt: 0 };
	/** Footer text while something loads, or after an error. */
	message = '';
	busy = false;
	/** Bumped on every visible change so the presenter redraws lazily. */
	version = 0;
	mediaMenu?: { kind: 'audio' | 'subtitles'; cursor: number };
	trackBusy = false;
	addonCursor = 0;
	addonConfirm?: string;

	#services: UiServices;
	#now: () => number;
	#trackOperation = 0;
	#settings: Settings;
	#settingsVersion = 0;
	/** Generation counters: a newer load makes older progressive updates stale. */
	#boardToken = 0;
	#searchToken = 0;
	#detailsToken = 0;
	#liveTimer?: ReturnType<typeof setTimeout>;
	/** Query of the latest search started (live or final). */
	#lastQuery = '';
	/** Streams that arrived before the details screen they belong to was set up. */
	#lateStreams?: { token: number; videoId: string; details: MetaDetails };
	#streamView?: { streams: StreamOption[]; version: number; showAll: boolean; result: FilterResult };
	#listRows?: { source: object; rows: ListRow[] };

	constructor(services: UiServices, now: () => number = () => performance.now()) {
		this.#services = services;
		this.#now = now;
		this.#settings = sanitizeSettings(services.getSettings?.() ?? DEFAULT_SETTINGS);
		void this.#enterSection('home');
	}

	settings(): Settings {
		return this.#settings;
	}

	updateSettings(next: Settings): void {
		this.#settings = sanitizeSettings(next);
		this.#settingsVersion++;
		this.#services.setSettings?.(this.#settings);
		if (this.details) this.details.cursor = Math.max(0, Math.min(this.details.cursor, this.listRows().length - 1));
		this.#touch();
	}

	// ---- queries for the renderer ----

	current(): SectionState {
		return this.sections[this.section];
	}

	title(): string {
		switch (this.screen) {
			case 'section': {
				const s = this.current();
				if (this.section === 'discover' && s.catalog) return `${s.catalog.name} · ${s.catalog.addonName}`;
				return SECTION_TITLES[this.section];
			}
			case 'details':
			case 'player':
				return this.details?.meta.name ?? '';
		}
	}

	hint(): string {
		switch (this.screen) {
			case 'player':
				return 'A pause   ◀ ▶ scrub   Y audio/subtitles   B back';
			case 'details': {
				const d = this.details;
				if (d?.mode !== 'streams') return 'A select   B back';
				const view = this.streamView();
				if (d.showAll) return `A play   X hide filtered streams   B back`;
				return view.hidden > 0 ? `A play   X show ${view.hidden} hidden   B back` : 'A play   B back';
			}
			default:
				if (this.keyboard) return '';
				if (this.section === 'search') return this.railFocused ? 'A select   L/R sections' : 'Y new search   A open   B rail   L/R sections';
				if (this.section === 'settings') return this.resetConfirm ? 'A confirm reset   B cancel' : '◀ ▶ change   A select   B rail   L/R sections';
				if (this.section === 'addons') return this.addonConfirm ? 'A confirm removal   B cancel' : 'Y install link   A remove selected   L/R sections';
				return 'A open   Y search   L/R sections   + exit';
		}
	}

	/** The filtered, sorted streams of the details screen (memoized per stream list, settings and X state). */
	streamView(): FilterResult {
		const d = this.details;
		if (!d) return { rows: [], shown: 0, hidden: 0 };
		const showAll = !!d.showAll;
		const cached = this.#streamView;
		if (cached && cached.streams === d.streams && cached.version === this.#settingsVersion && cached.showAll === showAll) return cached.result;
		const result = filterStreams(d.streams, this.#settings, showAll);
		this.#streamView = { streams: d.streams, version: this.#settingsVersion, showAll, result };
		return result;
	}

	/** One-line status above the stream list: counts, hidden streams, slow add-ons. */
	streamsHeader(): string {
		const d = this.details;
		if (!d || d.mode !== 'streams') return '';
		const view = this.streamView();
		const parts = [`${view.shown} stream${view.shown === 1 ? '' : 's'}`];
		if (view.hidden > 0) parts.push(d.showAll ? `${view.hidden} filtered (dimmed)` : `${view.hidden} hidden by ${activeFilterCount(this.#settings) === 1 ? 'a filter' : 'filters'}`);
		if (d.pendingAddons) parts.push(`waiting for ${d.pendingAddons} add-on${d.pendingAddons === 1 ? '' : 's'}…`);
		else if (d.failedAddons) parts.push(`${d.failedAddons} add-on${d.failedAddons === 1 ? '' : 's'} unavailable`);
		return parts.join('  ·  ');
	}

	/** The vertical list on the details screen (episodes or streams); memoized, it is read on every redraw and press. */
	listRows(): ListRow[] {
		const d = this.details;
		if (!d) return [];
		const source: object = d.mode === 'episodes' ? d.videos : this.streamView();
		if (this.#listRows?.source === source) return this.#listRows.rows;
		const rows: ListRow[] = d.mode === 'episodes'
			? d.videos.map((v) => ({ label: videoLabel(v), detail: v.released?.slice(0, 10), enabled: true }))
			: this.streamView().rows.map(({ option, info, hiddenBy }) => ({
				label: (info.text || `${option.stream.name ?? option.addonName}`.replace(/\s+/g, ' ')).slice(0, 160),
				detail: hiddenBy ? `Hidden: ${hiddenBy}` : `${{ torrent: 'torrent', url: 'HTTP video', external: 'open on phone', unsupported: 'unsupported source' }[info.kind]} · ${option.addonName}`,
				enabled: info.kind !== 'unsupported',
				badges: streamBadges(info),
				dimmed: !!hiddenBy,
			}));
		this.#listRows = { source, rows };
		return rows;
	}

	/** Settings rows for the renderer. */
	settingRows(): SettingRow[] {
		return SETTING_ITEMS.map((item) => ({ label: item.label, value: settingValueLabel(item, this.#settings), help: item.help, kind: item.kind }));
	}

	focusedCard(): Card | undefined {
		const s = this.current();
		return s.rows[s.row]?.cards[s.col];
	}

	// ---- input ----

	/** One button press. Async work runs in the background; `busy` gates input meanwhile. */
	press(button: Button): void {
		if (this.keyboard) return; // the keyboard has the controls
		if (this.busy) {
			if (button === 'b') this.#services.stop(); // abandon a pending load/connect
			return;
		}
		switch (this.screen) {
			case 'player':
				return this.#pressInPlayer(button);
			case 'details':
				return this.#pressInDetails(button);
			default:
				return this.#pressInSection(button);
		}
	}

	/** Touch: something drawn was tapped. */
	tap(target: HitTarget): void {
		if (this.keyboard) return;
		if (target.kind === 'searchBar') { this.railFocused = false; void this.openSearch(); return; }
		if (this.busy) return;
		if (this.mediaMenu && !['tracks', 'trackRow', 'subtitleDelay', 'closeTracks'].includes(target.kind)) return;
		switch (target.kind) {
			case 'tracks': return this.openTracks(target.tab);
			case 'closeTracks': this.mediaMenu = undefined; return this.#showOsd();
			case 'trackRow':
				if (this.mediaMenu && this.trackRows()[target.index]) { this.mediaMenu.cursor = target.index; void this.#selectTrack(); }
				return;
			case 'subtitleDelay': this.#services.subtitleDelay(target.delta); return this.#touch();
			case 'addonRow': this.addonCursor = target.index; void this.#activateAddon(); return;
			case 'addonInstall': void this.#installAddon(); return;
			case 'settingRow': this.settingsCursor = target.index; this.railFocused = false; void this.#activateSetting(); return;
			case 'settingStep': this.settingsCursor = target.index; this.railFocused = false; return this.#stepSetting(target.step);
			case 'toggleHidden': return this.#toggleHidden();
			case 'rail':
				void this.#enterSection(target.section);
				return;
			case 'card': {
				const s = this.current();
				if (!s.rows[target.row]?.cards[target.col]) return;
				this.railFocused = false;
				s.row = target.row;
				s.col = target.col;
				this.#touch();
				void this.#activateCard();
				return;
			}
			case 'listRow':
				if (!this.details) return;
				this.details.cursor = target.index;
				this.#touch();
				void this.#activateListRow();
				return;
			case 'back':
				return this.press('b');
			case 'video':
				return this.#showOsd();
			case 'osdPause':
				this.#services.togglePause();
				return this.#showOsd();
			case 'osdBack':
				return this.stopPlayback();
			case 'osdSeek': {
				const p = this.#services.playback();
				if (p && p.duration > 0) this.#services.seekTo(target.fraction * p.duration);
				return this.#showOsd();
			}
		}
	}

	/** Touch: a horizontal or vertical swipe on the section screen, in card steps. */
	swipe(dxSteps: number, dySteps: number): void {
		if (this.keyboard || this.busy || this.screen !== 'section') return;
		const s = this.current();
		if (dySteps !== 0) this.#moveRow(s, dySteps);
		if (dxSteps !== 0) this.#moveCol(s, dxSteps);
	}

	/** Per-frame housekeeping: hides the display and commits a pending scrub. Returns true if it changed something. */
	tick(now: number): boolean {
		let changed = false;
		if (this.screen === 'player') {
			const p = this.#services.playback();
			if (this.osd.scrubTarget !== undefined && this.osd.commitAt !== undefined && now >= this.osd.commitAt) {
				this.#services.seekTo(this.osd.scrubTarget);
				this.osd.scrubTarget = undefined;
				this.osd.commitAt = undefined;
				this.osd.scrubPresses = 0;
				this.osd.hideAt = now + OSD_SHOW_MS;
				changed = true;
			}
			const buffering = p?.buffering ?? false;
			const keep = !!this.mediaMenu || (p?.paused ?? false) || buffering || this.osd.scrubTarget !== undefined;
			if (buffering && !this.osd.visible) {
				this.osd.visible = true;
				changed = true;
			}
			if (this.osd.visible && !keep && now >= this.osd.hideAt) {
				this.osd.visible = false;
				changed = true;
			}
		}
		if (changed) this.#touch();
		return changed;
	}

	/** Leave the player (also called when the video ends). */
	stopPlayback(): void {
		if (this.screen !== 'player') return;
		this.#services.stop();
		this.mediaMenu = undefined;
		this.trackBusy = false;
		this.#trackOperation++;
		this.osd = { visible: false, hideAt: 0, scrubPresses: 0, lastScrubAt: 0 };
		this.screen = 'details';
		this.#touch();
	}

	/** Live status for the footer while a load is in flight. */
	progress(message: string): void {
		if (!this.busy) return;
		this.message = message;
		this.#touch();
	}

	/** Ask the presenter to redraw (e.g. a poster finished loading). */
	invalidate(): void {
		this.#touch();
	}

	addons(): Addon[] { return this.#services.addons(); }
	addonSetup(): { url: string; code: string } { return this.#services.addonSetup(); }
	addonsChanged(): void {
		for (const section of ['home', 'discover', 'search'] as const) this.sections[section].loaded = false;
		this.#boardToken++;
		this.#searchToken++;
		this.addonCursor = Math.max(0, Math.min(this.addonCursor, this.addons().length - 1));
		this.addonConfirm = undefined;
		this.#touch();
	}

	openTracks(kind: 'audio' | 'subtitles'): void {
		if (this.screen !== 'player') return;
		this.osd.scrubTarget = undefined;
		this.osd.commitAt = undefined;
		this.message = '';
		const rows = this.#services.tracks(kind);
		this.mediaMenu = { kind, cursor: Math.max(0, rows.findIndex(r => r.selected)) };
		this.#showOsd();
	}
	trackRows(): TrackOption[] { return this.mediaMenu ? this.#services.tracks(this.mediaMenu.kind) : []; }
	trackNotice(): string { return this.message || this.#services.trackNotice(); }
	subtitleDelay(): number { return this.#services.subtitleDelay(); }

	async #selectTrack(): Promise<void> {
		const menu = this.mediaMenu, row = menu && this.trackRows()[menu.cursor];
		if (!menu || !row?.enabled || this.trackBusy) return;
		this.trackBusy = true;
		const operation = ++this.#trackOperation;
		this.message = 'Loading track…';
		this.#touch();
		try { await this.#services.selectTrack(menu.kind, row.id); if (operation === this.#trackOperation) this.message = ''; }
		catch (error) { if (operation === this.#trackOperation) this.message = error instanceof Error ? error.message : 'Could not load this track.'; }
		finally { if (operation === this.#trackOperation) { this.trackBusy = false; this.#touch(); } }
	}

	async #installAddon(): Promise<void> {
		await this.#run('Enter the add-on install link…', async () => {
			const url = await this.#prompt({ kind: 'text', label: 'Add-on install link', ok: 'Install', initial: 'https://' });
			if (!url?.trim()) return;
			this.progress('Installing add-on…');
			await this.#services.installAddon(url);
			this.addonsChanged();
			this.message = 'Add-on installed.';
		});
	}

	async #activateAddon(): Promise<void> {
		const addon = this.addons()[this.addonCursor];
		if (!addon) return;
		if (addon.flags?.protected) { this.message = 'This built-in add-on cannot be removed.'; this.#touch(); return; }
		if (this.addonConfirm !== addon.transportUrl) {
			this.addonConfirm = addon.transportUrl;
			this.message = `Remove ${addon.manifest.name}? A confirms · B cancels`;
			this.#touch();
			return;
		}
		await this.#run('Removing add-on…', async () => {
			await this.#services.removeAddon(addon.transportUrl);
			this.addonsChanged();
			this.message = 'Add-on removed.';
		});
	}

	// ---- section screen ----

	#pressInSection(button: Button): void {
		const s = this.current();
		if (button === 'l' || button === 'r') {
			const i = SECTIONS.indexOf(this.section) + (button === 'l' ? -1 : 1);
			const next = SECTIONS[(i + SECTIONS.length) % SECTIONS.length];
			void this.#enterSection(next);
			return;
		}
		if (this.railFocused) return this.#pressInRail(button);
		if (this.section === 'settings') return this.#pressInSettings(button);
		if (this.section === 'addons') {
			if (button === 'y') { void this.#installAddon(); return; }
			if (button === 'a') { void this.#activateAddon(); return; }
			if (button === 'b' && this.addonConfirm) { this.addonConfirm = undefined; this.message = ''; this.#touch(); return; }
			if (button === 'up' || button === 'down') {
				this.addonCursor = Math.max(0, Math.min(this.addons().length - 1, this.addonCursor + (button === 'up' ? -1 : 1)));
				this.addonConfirm = undefined; this.message = ''; this.#touch(); return;
			}
		}
		switch (button) {
			case 'up':
				return this.#moveRow(s, -1);
			case 'down':
				return this.#moveRow(s, 1);
			case 'left':
				if (s.col === 0 || s.rows.length === 0) {
					this.railFocused = true;
					this.railIndex = SECTIONS.indexOf(this.section);
					return this.#touch();
				}
				return this.#moveCol(s, -1);
			case 'right':
				return this.#moveCol(s, 1);
			case 'a':
				return void this.#activateCard();
			case 'y':
				// Y searches from any browsing section.
				if (this.section !== 'search') void this.#enterSection('search', false);
				void this.openSearch();
				return;
			case 'b':
				if (this.section !== 'home') {
					this.railFocused = true;
					this.railIndex = SECTIONS.indexOf(this.section);
					this.#touch();
				}
				return;
		}
	}

	#pressInSettings(button: Button): void {
		switch (button) {
			case 'up':
			case 'down':
				this.settingsCursor = Math.max(0, Math.min(SETTING_ITEMS.length - 1, this.settingsCursor + (button === 'up' ? -1 : 1)));
				this.resetConfirm = false;
				this.message = '';
				return this.#touch();
			case 'left':
			case 'right':
				return this.#stepSetting(button === 'left' ? -1 : 1);
			case 'a':
				return void this.#activateSetting();
			case 'b':
				if (this.resetConfirm) { this.resetConfirm = false; this.message = ''; return this.#touch(); }
				this.railFocused = true;
				this.railIndex = SECTIONS.indexOf(this.section);
				return this.#touch();
		}
	}

	#stepSetting(step: 1 | -1): void {
		const item = SETTING_ITEMS[this.settingsCursor];
		if (item?.kind !== 'choice') return;
		this.resetConfirm = false;
		this.message = '';
		this.updateSettings(cycleSetting(item, this.#settings, step));
	}

	async #activateSetting(): Promise<void> {
		const item = SETTING_ITEMS[this.settingsCursor];
		if (!item) return;
		if (item.kind === 'choice') return this.#stepSetting(1);
		if (item.kind === 'text') {
			const value = await this.#prompt({ kind: 'text', label: item.label, ok: 'Save', initial: this.#settings[item.key], placeholder: 'e.g. 3D, HDTS' });
			if (value === null) return;
			this.updateSettings({ ...this.#settings, [item.key]: value });
			this.message = value.trim() ? 'Excluded words saved.' : 'Excluded words cleared.';
			return this.#touch();
		}
		if (!this.resetConfirm) {
			this.resetConfirm = true;
			this.message = 'Reset every setting to the defaults? A confirms · B cancels';
			return this.#touch();
		}
		this.resetConfirm = false;
		this.updateSettings({ ...DEFAULT_SETTINGS });
		this.message = 'Settings reset to defaults.';
		this.#touch();
	}

	#toggleHidden(): void {
		const d = this.details;
		if (!d || d.mode !== 'streams' || this.screen !== 'details') return;
		const rows = this.streamView().rows;
		const focused = rows[d.cursor]?.option;
		d.showAll = !d.showAll;
		const next = this.streamView().rows;
		const i = focused ? next.findIndex((r) => r.option === focused) : -1;
		d.cursor = i >= 0 ? i : Math.max(0, Math.min(d.cursor, next.length - 1));
		this.#touch();
	}

	/** Replace a section's rows, keeping the cursor on the same row and card when they still exist. */
	#setRows(s: SectionState, rows: Row[]): void {
		const focusRow = s.rows[s.row];
		const focusCard = focusRow?.cards[s.col]?.meta.id;
		s.rows = rows;
		const r = focusRow?.key ? rows.findIndex((x) => x.key === focusRow.key) : -1;
		s.row = r >= 0 ? r : Math.max(0, Math.min(s.row, rows.length - 1));
		const cards = rows[s.row]?.cards ?? [];
		const c = r >= 0 && focusCard !== undefined ? cards.findIndex((x) => x.meta.id === focusCard) : -1;
		s.col = c >= 0 ? c : Math.max(0, Math.min(s.col, cards.length - 1));
		this.#touch();
	}

	#pressInRail(button: Button): void {
		switch (button) {
			case 'up':
				this.railIndex = Math.max(0, this.railIndex - 1);
				return this.#touch();
			case 'down':
				this.railIndex = Math.min(SECTIONS.length - 1, this.railIndex + 1);
				return this.#touch();
			case 'a':
				this.railFocused = false;
				void this.#enterSection(SECTIONS[this.railIndex]);
				return;
			case 'right':
			case 'b':
				this.railFocused = false;
				return this.#touch();
		}
	}

	#moveRow(s: SectionState, delta: number): void {
		if (s.rows.length === 0) return;
		const next = Math.max(0, Math.min(s.rows.length - 1, s.row + delta));
		if (next === s.row) return;
		s.row = next;
		s.col = Math.min(s.col, Math.max(0, s.rows[next].cards.length - 1));
		if (s.rows[next].kind === 'chips') this.#selectChip(s, s.col);
		this.#touch();
	}

	#moveCol(s: SectionState, delta: number): void {
		const row = s.rows[s.row];
		if (!row || row.cards.length === 0) return;
		const next = Math.max(0, Math.min(row.cards.length - 1, s.col + delta));
		if (next === s.col) return;
		s.col = next;
		if (row.kind === 'chips') this.#selectChip(s, next);
		this.#touch();
	}

	/** Discover: highlight a catalog chip; its grid loads when it is activated. */
	#selectChip(_s: SectionState, _col: number): void {}

	async #enterSection(section: Section, openKeyboard = true): Promise<void> {
		this.section = section;
		this.screen = 'section';
		this.railFocused = false;
		this.message = '';
		this.addonConfirm = undefined;
		this.resetConfirm = false;
		this.#touch();
		const s = this.sections[section];
		if (s.loaded) return;
		switch (section) {
			case 'addons':
			case 'settings':
				return;
			case 'home': {
				// Rows appear as each add-on answers; a slow or failing add-on no longer blocks the board.
				const token = ++this.#boardToken;
				const loading = 'Loading catalogs…';
				s.loaded = true;
				this.message = loading;
				this.#touch();
				const apply = (rows: CatalogRow[]) => {
					if (token !== this.#boardToken) return;
					this.#setRows(s, boardRows(this.#services.continueWatching(), rows));
				};
				try {
					apply(await this.#services.loadBoard(apply));
					if (token === this.#boardToken && this.message === loading) this.message = s.rows.length ? '' : 'No catalogs loaded. Check the connection or your add-ons.';
				} catch (err) {
					if (token !== this.#boardToken) return;
					s.loaded = false;
					this.message = `Failed: ${err instanceof Error ? err.message : String(err)}`;
					this.#services.log(this.message);
				}
				this.#touch();
				return;
			}
			case 'discover': {
				s.rows = [{ title: 'Catalogs', kind: 'chips', cards: this.#services.catalogs().map((c) => ({ meta: { id: `${c.addonUrl}|${c.type}|${c.id}`, type: c.type, name: c.name }, label: `${c.name} · ${c.type}`, seeAll: c })) }];
				s.loaded = true;
				s.row = 0;
				s.col = 0;
				this.#touch();
				return;
			}
			case 'library':
				return this.#run('Loading library…', async () => {
					const items = await this.#services.loadLibrary();
					s.rows = gridRows(items, GRID_COLUMNS);
					s.loaded = true;
					s.row = 0;
					s.col = 0;
					if (items.length === 0) this.message = 'Your library is empty. Watched titles show up here.';
				});
			case 'search':
				if (openKeyboard) return this.openSearch();
				return;
		}
	}

	/** Discover: open a catalog as a grid under the chips row. */
	async openCatalog(catalog: CatalogRef): Promise<void> {
		const s = this.sections.discover;
		this.section = 'discover';
		this.screen = 'section';
		this.railFocused = false;
		if (!s.loaded) {
			s.rows = [{ title: 'Catalogs', kind: 'chips', cards: this.#services.catalogs().map((c) => ({ meta: { id: `${c.addonUrl}|${c.type}|${c.id}`, type: c.type, name: c.name }, label: `${c.name} · ${c.type}`, seeAll: c })) }];
			s.loaded = true;
		}
		const chipIndex = s.rows[0].cards.findIndex((c) => c.seeAll?.addonUrl === catalog.addonUrl && c.seeAll.type === catalog.type && c.seeAll.id === catalog.id);
		await this.#run(`Loading ${catalog.name}…`, async () => {
			const items = await this.#services.loadCatalog(catalog);
			s.catalog = catalog;
			s.rows = [s.rows[0], ...gridRows(items, GRID_COLUMNS)];
			s.row = items.length > 0 ? 1 : 0;
			s.col = items.length > 0 ? 0 : Math.max(0, chipIndex);
		});
	}

	/**
	 * A keyboard prompt with the text field drawn by the UI (the console's
	 * inline keyboard has none). Input is modal while it is open.
	 */
	async #prompt(opts: { kind: KeyboardState['kind']; label: string; ok: string; initial: string; placeholder?: string; onText?: (text: string) => void }): Promise<string | null> {
		if (this.keyboard) return null;
		const k: KeyboardState = { kind: opts.kind, label: opts.label, text: opts.initial, cursor: opts.initial.length, height: 0, placeholder: opts.placeholder };
		this.keyboard = k;
		this.#touch();
		try {
			return await this.#services.promptText(opts.ok, opts.initial, (text, cursor, height) => {
				if (this.keyboard !== k) return;
				const changed = text !== k.text;
				k.text = text;
				k.cursor = Math.max(0, Math.min(cursor, text.length));
				if (height > 0) k.height = height;
				this.#touch();
				if (changed) opts.onText?.(text);
			});
		} finally {
			if (this.keyboard === k) this.keyboard = undefined;
			this.#touch();
		}
	}

	/**
	 * Search: an empty field every time, results as you type (after a short
	 * pause), OK keeps the results and focuses them, B restores what was
	 * there before.
	 */
	async openSearch(): Promise<void> {
		if (this.keyboard || this.busy) return;
		const s = this.sections.search;
		const before = { query: s.query, rows: s.rows, row: s.row, col: s.col, lastQuery: this.#lastQuery, message: this.message };
		const value = await this.#prompt({
			kind: 'search', label: 'Search', ok: 'Search', initial: '', placeholder: 'Movies, series, channels…',
			onText: (text) => {
				clearTimeout(this.#liveTimer);
				const q = text.trim();
				if (q.length < 2 || q === this.#lastQuery) return;
				this.#liveTimer = setTimeout(() => void this.#runSearch(q), UiModel.searchDebounceMs);
			},
		});
		clearTimeout(this.#liveTimer);
		const q = value?.trim() ?? '';
		if (!q) {
			// Dismissed: back to the previous results (a live search may have replaced them).
			this.#searchToken++;
			this.searching = false;
			Object.assign(s, { query: before.query, rows: before.rows, row: before.row, col: before.col, loaded: true });
			this.#lastQuery = before.lastQuery;
			this.message = before.message;
			this.#touch();
			return;
		}
		this.railFocused = false;
		if (q === this.#lastQuery) {
			// The search typed so far is already running or done: keep it, focus the first result.
			s.row = 0;
			s.col = 0;
			this.message = this.searching ? `Searching “${q}”…` : s.rows.length === 0 ? `No results for “${q}”.` : '';
			this.#touch();
			return;
		}
		await this.#runSearch(q);
	}

	async #runSearch(q: string): Promise<void> {
		const s = this.sections.search;
		const token = ++this.#searchToken;
		const searching = `Searching “${q}”…`;
		this.#lastQuery = q;
		s.query = q;
		s.loaded = true;
		this.searching = true;
		if (!this.keyboard) {
			// A final search starts clean; while typing, the previous matches stay until new ones arrive.
			s.rows = [];
			s.row = 0;
			s.col = 0;
			this.message = searching;
		}
		this.#touch();
		const apply = (rows: CatalogRow[]) => {
			if (token !== this.#searchToken) return;
			this.#setRows(s, rows.map((r) => ({ title: `${r.name} · ${r.type}`, kind: 'posters' as const, cards: r.items.map(cardOf), key: rowKey(r), loading: r.loading })));
		};
		try {
			const rows = await this.#services.search(q, apply);
			apply(rows);
			if (token === this.#searchToken) this.message = this.keyboard ? '' : rows.length === 0 ? `No results for “${q}”.` : this.message === searching ? '' : this.message;
		} catch (err) {
			if (token !== this.#searchToken) return;
			this.message = `Failed: ${err instanceof Error ? err.message : String(err)}`;
			this.#services.log(this.message);
		} finally {
			if (token === this.#searchToken) this.searching = false;
		}
		this.#touch();
	}

	/** Distinct titles from the current search rows, for the list above the keyboard. */
	searchMatches(limit: number): MetaPreview[] {
		const seen = new Set<string>();
		const out: MetaPreview[] = [];
		for (const row of this.sections.search.rows) {
			for (const card of row.cards) {
				if (card.seeAll || seen.has(card.meta.id)) continue;
				seen.add(card.meta.id);
				out.push(card.meta);
				if (out.length >= limit) return out;
			}
		}
		return out;
	}

	async #activateCard(): Promise<void> {
		const card = this.focusedCard();
		if (!card) return;
		if (card.seeAll) return void this.openCatalog(card.seeAll);
		await this.#openDetails(card.meta);
	}

	async #openDetails(item: MetaPreview): Promise<void> {
		const token = ++this.#detailsToken;
		await this.#run(`Loading ${item.name}…`, async () => {
			const details = await this.#services.loadDetails(item, undefined, (next) => this.#streamsArrived(token, item.id, next));
			if (token !== this.#detailsToken) return;
			const videos = details.meta.videos ?? [];
			this.details = { meta: details.meta, streams: details.streams, videos, mode: videos.length > 0 ? 'episodes' : 'streams', cursor: 0, videoId: item.id,
				pendingAddons: details.pendingAddons ?? 0, failedAddons: details.failedAddons ?? 0 };
			this.screen = 'details';
			this.#applyLateStreams(token);
		});
	}

	/** Progressive stream results; keeps the cursor on the stream it was on. */
	#streamsArrived(token: number, videoId: string, next: MetaDetails): void {
		if (token !== this.#detailsToken) return;
		const d = this.details;
		if (!d || d.videoId !== videoId) { this.#lateStreams = { token, videoId, details: next }; return; }
		const focused = d.mode === 'streams' ? this.streamView().rows[d.cursor]?.option : undefined;
		d.streams = next.streams;
		d.pendingAddons = next.pendingAddons ?? 0;
		d.failedAddons = next.failedAddons ?? 0;
		if (d.mode === 'streams') {
			const rows = this.streamView().rows;
			const key = focused && streamKey(focused);
			const i = key ? rows.findIndex((r) => streamKey(r.option) === key) : -1;
			d.cursor = i >= 0 ? i : Math.max(0, Math.min(d.cursor, rows.length - 1));
		}
		this.#touch();
	}

	#applyLateStreams(token: number): void {
		const late = this.#lateStreams;
		this.#lateStreams = undefined;
		if (late && late.token === token) this.#streamsArrived(token, late.videoId, late.details);
	}

	// ---- details screen ----

	#pressInDetails(button: Button): void {
		const d = this.details;
		if (!d) return;
		const rows = this.listRows();
		switch (button) {
			case 'up':
			case 'down': {
				if (rows.length === 0) return;
				d.cursor = (d.cursor + (button === 'up' ? -1 : 1) + rows.length) % rows.length;
				return this.#touch();
			}
			case 'a':
				return void this.#activateListRow();
			case 'x':
				return this.#toggleHidden();
			case 'b':
				if (d.mode === 'streams' && d.videos.length > 0) {
					d.mode = 'episodes';
					d.cursor = Math.max(0, d.videos.findIndex((v) => v.id === d.videoId));
					return this.#touch();
				}
				this.screen = 'section';
				this.message = '';
				return this.#touch();
		}
	}

	async #activateListRow(): Promise<void> {
		const d = this.details;
		if (!d) return;
		if (d.mode === 'episodes') {
			const video = d.videos[d.cursor];
			if (!video) return;
			const token = ++this.#detailsToken;
			await this.#run(`Loading ${videoLabel(video)}…`, async () => {
				const details = await this.#services.loadDetails(d.meta, video.id, (next) => this.#streamsArrived(token, video.id, next));
				if (token !== this.#detailsToken || this.details !== d) return;
				d.streams = details.streams;
				d.videoId = video.id;
				d.mode = 'streams';
				d.cursor = 0;
				d.showAll = false;
				d.pendingAddons = details.pendingAddons ?? 0;
				d.failedAddons = details.failedAddons ?? 0;
				this.#applyLateStreams(token);
			});
			return;
		}
		const option = this.streamView().rows[d.cursor]?.option;
		if (!option || streamKind(option.stream) === 'unsupported') return;
		if (streamKind(option.stream) === 'external') {
			await this.#run('Preparing service link…', async () => { this.message = await this.#services.openExternal(option.stream.externalUrl!); });
			return;
		}
		await this.#run('Opening video…', async () => {
			await this.#services.play(option, d.meta, d.videoId, (m) => this.progress(m));
			this.screen = 'player';
			this.#showOsd();
		});
	}

	// ---- player ----

	#pressInPlayer(button: Button): void {
		if (this.mediaMenu) {
			const menu = this.mediaMenu;
			if (button === 'b' || button === 'y') { this.mediaMenu = undefined; this.#showOsd(); return; }
			if (button === 'l' || button === 'r') { this.openTracks(menu.kind === 'audio' ? 'subtitles' : 'audio'); return; }
			if (button === 'up' || button === 'down') menu.cursor = Math.max(0, Math.min(this.trackRows().length - 1, menu.cursor + (button === 'up' ? -1 : 1)));
			if (button === 'a') void this.#selectTrack();
			if (menu.kind === 'subtitles' && (button === 'left' || button === 'right')) this.#services.subtitleDelay(button === 'left' ? -.5 : .5);
			this.#touch();
			return;
		}
		switch (button) {
			case 'y': return this.openTracks('subtitles');
			case 'a':
				this.#services.togglePause();
				return this.#showOsd();
			case 'left':
			case 'right':
				return this.#scrub(button === 'left' ? -1 : 1);
			case 'b':
				return this.stopPlayback();
			case 'up':
			case 'down':
				return this.#showOsd();
		}
	}

	/** Accelerating d-pad scrub: the target moves now, the seek happens once the presses stop. */
	#scrub(direction: 1 | -1): void {
		const p = this.#services.playback();
		if (!p) return;
		const now = this.#now();
		if (now - this.osd.lastScrubAt > SCRUB_COMMIT_MS) this.osd.scrubPresses = 0;
		const step = SCRUB_STEPS[Math.min(this.osd.scrubPresses, SCRUB_STEPS.length - 1)];
		const from = this.osd.scrubTarget ?? p.time;
		const max = p.duration > 0 ? p.duration - 1 : Number.POSITIVE_INFINITY;
		this.osd.scrubTarget = Math.max(0, Math.min(max, from + direction * step));
		this.osd.scrubPresses++;
		this.osd.lastScrubAt = now;
		this.osd.commitAt = now + SCRUB_COMMIT_MS;
		this.#showOsd();
	}

	#showOsd(): void {
		this.osd.visible = true;
		this.osd.hideAt = this.#now() + OSD_SHOW_MS;
		this.#touch();
	}

	// ---- helpers ----

	async #run(message: string, work: () => Promise<void>): Promise<void> {
		this.busy = true;
		this.message = message;
		this.#touch();
		try {
			await work();
			if (this.message === message) this.message = '';
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			this.message = reason === 'cancelled' ? '' : `Failed: ${reason}`;
			if (this.message) this.#services.log(this.message);
		} finally {
			this.busy = false;
			this.#touch();
		}
	}

	#touch(): void {
		this.version++;
	}
}

function cardOf(meta: MetaPreview): Card {
	return { meta, label: meta.name };
}

function rowKey(c: CatalogRow): string {
	return `${c.addonId}/${c.type}/${c.id}`;
}

/** Identity of a stream across core state updates (the core re-serializes objects). */
function streamKey(o: StreamOption): string {
	const s = o.stream;
	return `${o.addonUrl}|${s.infoHash ?? ''}|${s.fileIdx ?? ''}|${s.url ?? s.externalUrl ?? ''}|${s.name ?? ''}|${s.title ?? s.description ?? ''}`;
}

/** Board rows: continue watching first (when there is any), then every catalog with a "See all" card. */
export function boardRows(continueWatching: MetaPreview[], catalogs: CatalogRow[]): Row[] {
	const rows: Row[] = [];
	if (continueWatching.length > 0) rows.push({ title: 'Continue watching', kind: 'posters', cards: continueWatching.map(cardOf), key: 'continue-watching' });
	for (const c of catalogs) {
		const cards = c.items.map(cardOf);
		if (c.ref && !c.loading) cards.push({ meta: { id: SEE_ALL_ID, type: c.type, name: 'See all' }, label: 'See all', seeAll: c.ref });
		rows.push({ title: `${c.name} · ${c.type}`, kind: 'posters', cards, key: rowKey(c), loading: c.loading });
	}
	return rows;
}

/** A flat list as rows of `columns` cards (a grid). */
export function gridRows(items: MetaPreview[], columns: number): Row[] {
	const rows: Row[] = [];
	for (let i = 0; i < items.length; i += columns) rows.push({ title: '', kind: 'posters', cards: items.slice(i, i + columns).map(cardOf) });
	return rows;
}

export function videoLabel(v: Video): string {
	const se = v.season !== undefined && v.episode !== undefined ? `S${v.season}E${v.episode} ` : '';
	return `${se}${v.title ?? v.id}`;
}
