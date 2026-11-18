/**
 * App-facing wrapper around stremio-core: dispatch + typed state waits for
 * the few flows this app drives (catalog, meta details + streams, player,
 * streaming-server probe). Runtime-agnostic: the host prototype and the
 * Switch app share it. `installShims()` must run before `create()`.
 */
import type { CoreEvent, StremioCore } from '../core';
import { InfoHash, type TorrentRequest } from '../torrent/types';
import { fetchAddon, type Addon } from './addons';

export type Loadable<T> = { type: 'Loading' } | { type: 'Ready'; content: T } | { type: 'Err'; content: unknown };

export interface ResourcePath {
	resource: string;
	type: string;
	id: string;
	extra: [string, string][];
}

export interface MetaPreview {
	id: string;
	name: string;
	type: string;
	poster?: string;
	/** Watch progress 0..1 (continue watching / library items). */
	progress?: number;
}

export interface MetaItem extends MetaPreview {
	description?: string;
	releaseInfo?: string;
	background?: string;
	logo?: string;
	runtime?: string;
	links?: { name: string; category: string; url: string }[];
	/** Episodes (series) or extra videos; streams are requested per video id. */
	videos?: Video[];
}

export interface Video {
	id: string;
	title?: string;
	season?: number;
	episode?: number;
	released?: string;
	/** From the user's library: finished, or how far in (percent). */
	watched?: boolean;
	progress?: number | null;
	upcoming?: boolean;
}

/** A catalog an installed addon offers. */
export interface CatalogRef {
	addonName: string;
	addonUrl: string;
	type: string;
	id: string;
	name: string;
}

interface CtxState {
	profile: { addons: Addon[] };
}

/** A stream as the core serializes it; torrent sources carry `infoHash`. */
export interface Stream {
	name?: string;
	title?: string;
	description?: string;
	infoHash?: string;
	fileIdx?: number | null;
	announce?: string[];
	url?: string;
	externalUrl?: string;
	behaviorHints?: { filename?: string; videoSize?: number; proxyHeaders?: { request?: Record<string, string>; response?: Record<string, string> } };
	ytId?: string;
	deepLinks?: unknown;
}

export interface StreamOption {
	addonName: string;
	addonUrl: string;
	stream: Stream;
}

export interface MetaDetails {
	meta: MetaItem;
	streams: StreamOption[];
	/** Stream add-ons that have not answered yet (updates follow through `onUpdate`). */
	pendingAddons?: number;
	/** Stream add-ons that failed or timed out. */
	failedAddons?: number;
	/** Where the user left off in this title (from the library). */
	lastVideoId?: string;
}

/** What the core knows when a stream is loaded into the player. */
export interface PlayerLoad {
	stream: Stream;
	/** Milliseconds into this video where the user stopped last time (0 = start). */
	resumeMs: number;
	/** The episode that follows this one. */
	nextVideo?: Video;
}

export interface StreamingServerState {
	settings: Loadable<unknown>;
	baseUrl: string | null;
	networkInfo: Loadable<unknown>;
	deviceInfo: Loadable<unknown>;
	playbackDevices: Loadable<unknown>;
}

interface DetailsState {
	selected?: { streamPath?: { id?: string } | null } | null;
	libraryItem?: { state?: { video_id?: string | null } } | null;
	metaItem: { content: Loadable<MetaItem> } | null;
	streams: { addon: { manifest: { name: string }; transportUrl: string }; content: Loadable<Stream[]> }[];
}

interface CatalogState {
	catalog: { content: Loadable<MetaPreview[]> } | null;
}

interface PlayerState {
	selected: { stream: Stream } | null;
	nextVideo?: Video | null;
	libraryItem?: { state?: { timeOffset?: number; video_id?: string | null } } | null;
}

/** A catalog row on the board or in search results. */
export interface CatalogRow {
	id: string;
	type: string;
	name: string;
	addonName: string;
	addonId: string;
	items: MetaPreview[];
	/** The catalog to open for "see all" (resolved from the installed addons). */
	ref?: CatalogRef;
	/** Still waiting for the add-on (progressive updates only). */
	loading?: boolean;
}

interface CatalogsWithExtraState {
	catalogs: { id: string; name: string; type: string; addon: { manifest: { id: string; name: string } }; content: Loadable<MetaPreview[]> | null }[];
}

interface LibraryState {
	catalog: { _id: string; name: string; type: string; poster?: string; state?: { timeOffset?: number; duration?: number } }[];
}

interface ContinueWatchingState {
	items: { _id: string; name: string; type: string; poster?: string; state?: { timeOffset?: number; duration?: number } }[];
}

/** A core event: `event` names it; errors carry `args.error` and the `args.source` event they answer. */
export interface CoreEventArgs { event?: string; args?: { error?: { message?: string; code?: number; type?: string }; source?: { event?: string } } & Record<string, unknown> }

export const CINEMETA = 'https://v3-cinemeta.strem.io/manifest.json';
const DEFAULT_TIMEOUT_MS = 30000;
/** How long progressive loads keep waiting for slow add-ons before showing what arrived. */
const SLOW_ADDON_MS = 25000;

export class StremioClient {
	#core: StremioCore;
	#eventListeners = new Set<(event: CoreEventArgs) => void>();
	/** Change listeners per state field (several flows may wait on one field). */
	#waiters = new Map<string, Set<() => void>>();
	#log: (msg: string) => void;
	#changingAddons = false;

	private constructor(core: StremioCore, log: (msg: string) => void) {
		this.#core = core;
		this.#log = log;
	}

	static async create(opts: { log?: (msg: string) => void } = {}): Promise<StremioClient> {
		const log = opts.log ?? (() => {});
		// Imported after the shims: the glue touches `document` at module evaluation.
		const { createCore } = await import('../core');
		let client: StremioClient | undefined;
		const core = await createCore((event: CoreEvent) => {
			if (event.name === 'NewState' && Array.isArray(event.args)) {
				if (client) for (const field of event.args) { const set = client.#waiters.get(field); if (set) for (const fn of [...set]) fn(); }
			} else if (event.name === 'CoreEvent') {
				// Add-on descriptors can contain private configuration tokens in URLs.
				log(`core event: ${(event.args as { event?: string } | null)?.event ?? 'update'}`);
				if (client) for (const fn of [...client.#eventListeners]) fn(event.args as CoreEventArgs);
			}
		});
		client = new StremioClient(core, log);
		return client;
	}

	/** Calls `fn` for every core event (results and errors of actions) until the returned function is called. */
	onEvent(fn: (event: CoreEventArgs) => void): () => void {
		this.#eventListeners.add(fn);
		return () => { this.#eventListeners.delete(fn); };
	}

	/** The signed-in Stremio account, or null. */
	account(): { email: string } | null {
		const auth = this.getState<{ profile: { auth?: { user?: { email?: string } } | null } }>('ctx').profile.auth;
		return auth?.user?.email ? { email: auth.user.email } : null;
	}

	/**
	 * Sign in to a Stremio account. The core then loads the account's add-ons
	 * and library (watch history, Continue Watching) in place of the local
	 * ones and keeps them in sync. Rejects with the API's reason.
	 */
	signIn(email: string, password: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const done = (error?: Error) => { clearTimeout(timer); off(); error ? reject(error) : resolve(); };
			const timer = setTimeout(() => done(new Error('The Stremio account service did not answer.')), DEFAULT_TIMEOUT_MS);
			const off = this.onEvent((event) => {
				if (event.event === 'UserAuthenticated') done();
				else if (event.event === 'Error' && event.args?.source?.event === 'UserAuthenticated') {
					const message = event.args.error?.message ?? 'Sign-in failed.';
					done(new Error(/passphrase|password|user not found/i.test(message) ? 'Wrong email or password.' : message));
				}
			});
			this.dispatch({ action: 'Ctx', args: { action: 'Authenticate', args: { type: 'Login', email, password, facebook: false } } });
		});
	}

	/** Sign out: the local profile (default add-ons, empty library) returns. */
	async signOut(): Promise<void> {
		this.dispatch({ action: 'Ctx', args: { action: 'Logout' } });
		await this.waitState<{ profile: { auth?: unknown } }>('ctx', (s) => !s.profile.auth);
	}

	/** Fetch changes made on other devices (library and add-ons); no-op when signed out. */
	syncAccount(): void {
		if (!this.account()) return;
		this.dispatch({ action: 'Ctx', args: { action: 'SyncLibraryWithAPI' } });
		this.dispatch({ action: 'Ctx', args: { action: 'PullAddonsFromAPI' } });
	}

	dispatch(action: unknown, field: string | null = null): void {
		this.#core.dispatch(action, field);
	}

	getState<T>(field: string): T {
		return this.#core.getState<T>(field);
	}

	/** Calls `fn` on every change of `field` until the returned function is called. */
	watch(field: string, fn: () => void): () => void {
		let set = this.#waiters.get(field);
		if (!set) this.#waiters.set(field, set = new Set());
		set.add(fn);
		return () => {
			set.delete(fn);
			if (set.size === 0 && this.#waiters.get(field) === set) this.#waiters.delete(field);
		};
	}

	/** Resolves with the state of `field` once `ready` holds (checked now and on every change). */
	waitState<T>(field: string, ready: (state: T) => boolean, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			let unwatch = () => {};
			const timer = setTimeout(() => {
				unwatch();
				reject(new Error(`${field}: timed out`));
			}, timeoutMs);
			const check = () => {
				const state = this.#core.getState<T>(field);
				if (!ready(state)) return false;
				clearTimeout(timer);
				unwatch();
				resolve(state);
				return true;
			};
			if (!check()) unwatch = this.watch(field, check);
		});
	}

	/**
	 * Follow `field` until `done` holds, the state stops being ours (`current`
	 * false: the user opened something else), or `timeoutMs` passes; `update`
	 * runs on every change and once more at the end with `final` set.
	 */
	#follow<T>(field: string, opts: { current: (s: T) => boolean; done: (s: T) => boolean; update: (s: T, final: boolean) => void; timeoutMs: number }): Promise<T> {
		return new Promise<T>((resolve) => {
			let finished = false;
			let unwatch = () => {};
			const finish = (state: T, report: boolean) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				unwatch();
				if (report) opts.update(state, true);
				resolve(state);
			};
			const timer = setTimeout(() => {
				const state = this.#core.getState<T>(field);
				finish(state, opts.current(state));
			}, opts.timeoutMs);
			const check = () => {
				const state = this.#core.getState<T>(field);
				if (!opts.current(state)) return finish(state, false);
				if (opts.done(state)) return finish(state, true);
				opts.update(state, false);
			};
			check();
			if (!finished) unwatch = this.watch(field, check);
		});
	}

	/** Catalogs of every installed addon, in profile order. */
	addons(): Addon[] {
		return this.getState<CtxState>('ctx').profile.addons;
	}

	async installAddon(input: string): Promise<void> {
		if (this.#changingAddons) throw new Error('An add-on change is in progress. Try again shortly.');
		this.#changingAddons = true;
		try {
			const addon = await fetchAddon(input);
			const existing = this.addons().find(a => a.transportUrl === addon.transportUrl);
			if (existing?.flags?.protected) throw new Error('This built-in add-on is protected.');
			this.dispatch({ action: 'Ctx', args: { action: existing ? 'UpgradeAddon' : 'InstallAddon', args: addon } });
			await this.waitState<CtxState>('ctx', s => s.profile.addons.some(a => a.transportUrl === addon.transportUrl && a.manifest.version === addon.manifest.version));
		} finally { this.#changingAddons = false; }
	}

	async removeAddon(transportUrl: string): Promise<void> {
		if (this.#changingAddons) throw new Error('An add-on change is in progress. Try again shortly.');
		this.#changingAddons = true;
		try {
			const addon = this.addons().find(a => a.transportUrl === transportUrl);
			if (!addon) throw new Error('Add-on is no longer installed.');
			if (addon.flags?.protected) throw new Error('This built-in add-on cannot be removed.');
			this.dispatch({ action: 'Ctx', args: { action: 'UninstallAddon', args: addon } });
			await this.waitState<CtxState>('ctx', s => !s.profile.addons.some(a => a.transportUrl === transportUrl));
		} finally { this.#changingAddons = false; }
	}

	catalogs(): CatalogRef[] {
		const ctx = this.getState<CtxState>('ctx');
		const out: CatalogRef[] = [];
		for (const addon of ctx.profile.addons) {
			for (const c of addon.manifest.catalogs) {
				out.push({ addonName: addon.manifest.name, addonUrl: addon.transportUrl, type: c.type, id: c.id, name: c.name ?? c.id });
			}
		}
		return out;
	}

	/**
	 * The board: every addon catalog (no type filter), the first `rows` loaded.
	 * `onUpdate` receives the rows as they arrive (still-loading ones flagged);
	 * the promise resolves with the final rows, dropping add-ons that failed or
	 * are still silent after SLOW_ADDON_MS instead of failing the whole board.
	 */
	loadBoard(rows = 8, onUpdate?: (rows: CatalogRow[]) => void): Promise<CatalogRow[]> {
		return this.#loadCatalogRows('board', [], rows, onUpdate);
	}

	/** Search across all catalogs (progressive like the board). */
	search(query: string, rows = 8, onUpdate?: (rows: CatalogRow[]) => void): Promise<CatalogRow[]> {
		return this.#loadCatalogRows('search', [['search', query]], rows, onUpdate);
	}

	async #loadCatalogRows(field: 'board' | 'search', extra: [string, string][], rows: number, onUpdate?: (rows: CatalogRow[]) => void): Promise<CatalogRow[]> {
		this.dispatch({ action: 'Load', args: { model: 'CatalogsWithExtra', args: { type: null, extra } } }, field);
		const initial = await this.waitState<CatalogsWithExtraState>(field, (s) => Array.isArray(s.catalogs));
		const end = Math.min(rows, initial.catalogs.length);
		if (end > 0) this.dispatch({ action: 'CatalogsWithExtra', args: { action: 'LoadRange', args: { start: 0, end } } }, field);
		const refs = this.catalogs();
		const collect = (s: CatalogsWithExtraState, final: boolean): CatalogRow[] => {
			const out: CatalogRow[] = [];
			for (const c of s.catalogs.slice(0, end)) {
				const loading = !c.content || c.content.type === 'Loading';
				if (c.content?.type === 'Err' || (loading && final)) continue;
				const ref = refs.find((r) => r.type === c.type && r.id === c.id && r.addonName === c.addon.manifest.name);
				const items = c.content?.type === 'Ready' ? c.content.content : [];
				if (!loading && items.length === 0) continue;
				out.push({ id: c.id, type: c.type, name: c.name, addonName: c.addon.manifest.name, addonId: c.addon.manifest.id, items, ref, loading: loading || undefined });
			}
			return out;
		};
		let lastKey = '';
		let result: CatalogRow[] = [];
		const extraKey = JSON.stringify(extra);
		await this.#follow<CatalogsWithExtraState & { selected?: { extra?: unknown } | null }>(field, {
			// A newer search replaces this one in the same field.
			current: (s) => Array.isArray(s.catalogs) && (s.selected?.extra === undefined || JSON.stringify(s.selected.extra) === extraKey),
			done: (s) => s.catalogs.slice(0, end).every((c) => c.content !== null && c.content.type !== 'Loading'),
			update: (s, final) => {
				result = collect(s, final);
				const key = result.map((r) => `${r.addonId}/${r.type}/${r.id}:${r.loading ? 0 : r.items.length}`).join('|');
				if (!final && key !== lastKey) { lastKey = key; onUpdate?.(result); }
			},
			timeoutMs: SLOW_ADDON_MS,
		});
		return result;
	}

	/** Library items in continue-watching order (empty until something was watched). */
	continueWatching(): MetaPreview[] {
		const state = this.getState<ContinueWatchingState>('continue_watching_preview');
		return (state.items ?? []).map(libraryToPreview);
	}

	async loadLibrary(): Promise<MetaPreview[]> {
		this.dispatch({ action: 'Load', args: { model: 'LibraryWithFilters', args: { request: { type: null, sort: 'lastwatched', page: 1 } } } }, 'library');
		const state = await this.waitState<LibraryState>('library', (s) => Array.isArray(s.catalog));
		return state.catalog.map(libraryToPreview);
	}

	/** Probe the streaming server the profile points at (our loopback server). */
	async reloadStreamingServer(): Promise<StreamingServerState> {
		this.dispatch({ action: 'StreamingServer', args: { action: 'Reload' } }, 'streaming_server');
		return this.waitState<StreamingServerState>('streaming_server', (s) => s.settings.type !== 'Loading');
	}

	async loadCatalog(base: string, type: string, id: string): Promise<MetaPreview[]> {
		this.dispatch(
			{ action: 'Load', args: { model: 'CatalogWithFilters', args: { request: { base, path: { resource: 'catalog', type, id, extra: [] } } } } },
			'discover',
		);
		const state = await this.waitState<CatalogState>('discover', (s) => !!s.catalog && s.catalog.content.type !== 'Loading');
		return unwrap(state.catalog!.content, 'catalog');
	}

	/**
	 * Meta item plus the streams every installed addon offers for it (for a
	 * series, for the episode `videoId`; movies stream under their own id).
	 */
	async loadMetaDetails(type: string, id: string, videoId = id, onUpdate?: (details: MetaDetails) => void): Promise<MetaDetails> {
		const metaPath: ResourcePath = { resource: 'meta', type, id, extra: [] };
		const streamPath: ResourcePath = { resource: 'stream', type, id: videoId, extra: [] };
		this.dispatch({ action: 'Load', args: { model: 'MetaDetails', args: { metaPath, streamPath, guessStream: false } } }, 'meta_details');
		const ours = (s: DetailsState) => !s.selected?.streamPath || s.selected.streamPath.id === videoId;
		const allAnswered = (s: DetailsState) => s.streams.every((x) => x.content.type !== 'Loading');
		// Without a listener there is nobody to update later: wait for every add-on (bounded).
		const state = await this.waitState<DetailsState>(
			'meta_details',
			(s) => ours(s) && !!s.metaItem && s.metaItem.content.type !== 'Loading' && (!!onUpdate || allAnswered(s)),
			onUpdate ? DEFAULT_TIMEOUT_MS : SLOW_ADDON_MS + DEFAULT_TIMEOUT_MS,
		);
		const meta = unwrap(state.metaItem!.content, 'meta');
		const reported = new Set<string>();
		const snapshot = (s: DetailsState, final: boolean): MetaDetails => {
			const streams: StreamOption[] = [];
			let pending = 0, failed = 0;
			for (const entry of s.streams) {
				if (entry.content.type === 'Loading') { if (final) failed++; else pending++; continue; }
				if (entry.content.type !== 'Ready') {
					failed++;
					if (!reported.has(entry.addon.transportUrl)) { reported.add(entry.addon.transportUrl); this.#log(`streams from ${entry.addon.manifest.name}: ${entry.content.type}`); }
					continue;
				}
				for (const stream of entry.content.content) streams.push({ addonName: entry.addon.manifest.name, addonUrl: entry.addon.transportUrl, stream });
			}
			return { meta, streams, pendingAddons: pending, failedAddons: failed, lastVideoId: s.libraryItem?.state?.video_id ?? undefined };
		};
		const first = snapshot(state, false);
		if (onUpdate && first.pendingAddons) {
			let lastCount = first.streams.length, lastPending = first.pendingAddons;
			void this.#follow<DetailsState>('meta_details', {
				current: ours,
				done: allAnswered,
				update: (s, final) => {
					const next = snapshot(s, final);
					if (!final && next.streams.length === lastCount && next.pendingAddons === lastPending) return;
					lastCount = next.streams.length;
					lastPending = next.pendingAddons ?? 0;
					onUpdate(next);
				},
				timeoutMs: SLOW_ADDON_MS,
			});
		}
		return first;
	}

	/** Load the Player with a chosen stream; returns the stream the core selected. */
	async loadPlayer(option: StreamOption, meta: MetaPreview, videoId = meta.id): Promise<PlayerLoad> {
		const { deepLinks: _deepLinks, ...stream } = option.stream;
		this.dispatch(
			{
				action: 'Load',
				args: {
					model: 'Player',
					args: {
						stream,
						streamRequest: { base: option.addonUrl, path: { resource: 'stream', type: meta.type, id: videoId, extra: [] } },
						metaRequest: { base: CINEMETA, path: { resource: 'meta', type: meta.type, id: meta.id, extra: [] } },
						subtitlesPath: null,
					},
				},
			},
			'player',
		);
		const state = await this.waitState<PlayerState>('player', (s) => !!s.selected);
		return { stream: state.selected!.stream, ...this.playerProgress(videoId) };
	}

	/**
	 * The resume point and next episode for the loaded video. They come from
	 * the meta item and library, which can arrive a moment after the stream.
	 */
	playerProgress(videoId: string): { resumeMs: number; nextVideo?: Video } {
		const state = this.getState<PlayerState>('player');
		const item = state.libraryItem?.state;
		return { resumeMs: item?.video_id === videoId ? Math.max(0, item.timeOffset ?? 0) : 0, nextVideo: state.nextVideo ?? undefined };
	}

	/**
	 * Report playback to the core, which keeps the library's resume point,
	 * watched episodes and Continue Watching (and syncs them when signed in).
	 */
	playerTime(timeMs: number, durationMs: number): void {
		if (!(durationMs > 0) || !(timeMs >= 0)) return;
		this.dispatch({ action: 'Player', args: { action: 'TimeChanged', args: { time: Math.round(timeMs), duration: Math.round(durationMs), device: 'switch' } } }, 'player');
	}

	playerPaused(paused: boolean): void {
		this.dispatch({ action: 'Player', args: { action: 'PausedChanged', args: { paused } } }, 'player');
	}

	playerEnded(): void {
		this.dispatch({ action: 'Player', args: { action: 'Ended' } }, 'player');
	}

	unloadPlayer(): void {
		this.dispatch({ action: 'Unload' }, 'player');
	}
}

/** The engine request for a torrent stream the core selected, or null for other sources. */
export function torrentRequestFromStream(stream: Stream, extraTrackers: string[] = []): TorrentRequest | null {
	if (!stream.infoHash) return null;
	return {
		infoHash: InfoHash.fromHex(stream.infoHash),
		announce: [...new Set([...(stream.announce ?? []), ...extraTrackers])],
		fileIdx: stream.fileIdx ?? null,
		displayName: stream.title ?? stream.name,
	};
}

function libraryToPreview(item: { _id: string; name: string; type: string; poster?: string; progress?: number | null; state?: { timeOffset?: number; duration?: number } }): MetaPreview {
	// The core reports progress as a percentage; older states carry offset and duration.
	const { timeOffset = 0, duration = 0 } = item.state ?? {};
	const progress = typeof item.progress === 'number' && item.progress > 0 ? Math.min(1, item.progress / 100) : duration > 0 ? Math.min(1, timeOffset / duration) : undefined;
	return { id: item._id, name: item.name, type: item.type, poster: item.poster ?? undefined, progress };
}

function unwrap<T>(loadable: Loadable<T>, what: string): T {
	if (loadable.type === 'Ready') return loadable.content;
	throw new Error(`${what} failed: ${JSON.stringify(loadable).slice(0, 200)}`);
}
