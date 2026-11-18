/**
 * Host tests for the UI model with fake services: board rows and the rail,
 * card navigation, discover chips, search through the keyboard prompt,
 * details -> streams -> player, series episodes, scrubbing, and touch hooks.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CatalogRef, CatalogRow, MetaDetails, MetaItem, MetaPreview, StreamOption } from '../src/stremio/client';
import { UiModel, boardRows, gridRows, type Playback, type UiServices } from '../src/app/ui';
import { DEFAULT_SETTINGS, type Settings } from '../src/app/settings';

const cinemeta: CatalogRef = { addonName: 'Cinemeta', addonUrl: 'http://cm/manifest.json', type: 'movie', id: 'top', name: 'Popular' };
const pd: CatalogRef = { addonName: 'PD', addonUrl: 'http://pd/manifest.json', type: 'movie', id: 'pd', name: 'Public Domain' };
const item = (id: string, type = 'movie'): MetaPreview => ({ id, name: `Title ${id}`, type, poster: `http://img/${id}` });
const torrent: StreamOption = { addonName: 'PD', addonUrl: pd.addonUrl, stream: { name: '720p', infoHash: 'ab'.repeat(20), fileIdx: 0 } };
const web: StreamOption = { addonName: 'Hub', addonUrl: 'http://hub', stream: { name: 'Web', url: 'http://x' } };

function fake(calls: string[], overrides: Partial<UiServices> = {}) {
	let now = 1000;
	let playback: Playback | null = null;
	const services: UiServices = {
		addons: () => [], installAddon: async () => {}, removeAddon: async () => {}, addonSetup: () => ({ url: 'http://switch:11471', code: 'ABCD1234' }),
		openExternal: async url => { calls.push(`external ${url}`); return 'Open the phone setup page.'; },
		tracks: () => [], selectTrack: async () => {}, subtitleDelay: () => 0, trackNotice: () => '',
		catalogs: () => [cinemeta, pd],
		loadBoard: async () => {
			calls.push('board');
			const rows: CatalogRow[] = [
				{ id: 'top', type: 'movie', name: 'Popular', addonName: 'Cinemeta', addonId: 'cm', items: [item('m1'), item('m2'), item('m3')], ref: cinemeta },
				{ id: 'pd', type: 'movie', name: 'Public Domain', addonName: 'PD', addonId: 'pd', items: [item('p1'), item('s1', 'series')], ref: pd },
			];
			return rows;
		},
		continueWatching: () => [{ ...item('cw1'), progress: 0.4 }],
		loadCatalog: async (c) => { calls.push(`catalog ${c.id}`); return Array.from({ length: 9 }, (_, i) => item(`${c.id}${i}`)); },
		loadLibrary: async () => { calls.push('library'); return []; },
		search: async (q) => { calls.push(`search ${q}`); return [{ id: 'top', type: 'movie', name: 'Popular', addonName: 'Cinemeta', addonId: 'cm', items: [item('r1')], ref: cinemeta }]; },
		promptText: async () => 'zombie',
		loadDetails: async (it, videoId) => {
			calls.push(`details ${it.id}${videoId ? `/${videoId}` : ''}`);
			const meta: MetaItem = it.type === 'series'
				? { ...it, videos: [{ id: `${it.id}:1:1`, title: 'Pilot', season: 1, episode: 1 }, { id: `${it.id}:1:2`, title: 'Two', season: 1, episode: 2 }] }
				: { ...it, description: 'A film.' };
			const details: MetaDetails = { meta, streams: [web, torrent] };
			return details;
		},
		play: async (option, meta, videoId, onProgress) => { onProgress('connecting'); calls.push(`play ${meta.id}/${videoId} ${option.stream.infoHash?.slice(0, 4)}`); playback = { time: 100, duration: 5000, paused: false }; },
		stop: () => { calls.push('stop'); playback = null; },
		togglePause: () => { calls.push('pause'); if (playback) playback.paused = !playback.paused; },
		seekTo: (s) => calls.push(`seekTo ${s}`),
		playback: () => playback,
		log: () => {},
		...overrides,
	};
	const clock = { now: () => now, advance: (ms: number) => { now += ms; } };
	return { services, clock };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('URL sources play and external service links hand off without entering the player', async () => {
	const calls: string[] = [];
	const { services } = fake(calls);
	const ui = new UiModel(services); await settle();
	ui.press('a'); await settle();
	assert.equal(ui.listRows()[0].detail, 'HTTP video · Hub');
	ui.press('a'); await settle(); assert.equal(ui.screen, 'player');
	assert.ok(calls.some(c => c.startsWith('play cw1/')));
	ui.stopPlayback();
	ui.details!.streams = [{ ...web, stream: { externalUrl: 'https://provider.example/watch', name: 'WatchHub' } }, { ...web, stream: { url: 'javascript:bad' } }];
	ui.details!.cursor = 0;
	assert.deepEqual(ui.listRows().map(r => r.enabled), [true, false]);
	ui.press('a'); await settle(); assert.equal(ui.screen, 'details');
	assert.ok(calls.includes('external https://provider.example/watch'));
	assert.match(ui.message, /phone setup/);
});

test('controller and touch track menus keep playback running and support subtitle delay', async () => {
	const calls: string[] = [];
	let delay = 0;
	const { services, clock } = fake(calls, {
		tracks: kind => kind === 'audio' ? [{ id: '2', label: 'Spanish', selected: true, enabled: true }] : [
			{ id: 'off', label: 'Off', selected: true, enabled: true }, { id: 'embedded:3', label: 'English', selected: false, enabled: true },
			{ id: 'embedded:4', label: 'Bitmap', selected: false, enabled: false }],
		selectTrack: async (kind, id) => { calls.push(`${kind}:${id}`); },
		subtitleDelay: delta => { if (delta !== undefined) delay += delta; return delay; },
		playback: () => ({ time: 20, duration: 100, paused: false }),
	});
	const ui = new UiModel(services, clock.now); await settle(); ui.screen = 'player';
	ui.press('y'); assert.equal(ui.mediaMenu?.kind, 'subtitles');
	clock.advance(5000); ui.tick(clock.now()); assert.equal(ui.osd.visible, true);
	ui.press('down'); ui.press('a'); await settle(); assert.ok(calls.includes('subtitles:embedded:3'));
	ui.press('right'); assert.equal(delay, .5); assert.ok(!calls.some(c => c.startsWith('seekTo')));
	ui.tap({ kind: 'subtitleDelay', delta: -.5 }); assert.equal(delay, 0);
	ui.press('down'); ui.press('a'); await settle(); assert.ok(!calls.includes('subtitles:embedded:4'));
	ui.press('l'); assert.equal(ui.mediaMenu?.kind, 'audio');
	ui.tap({ kind: 'trackRow', index: 0 }); await settle(); assert.ok(calls.includes('audio:2'));
	ui.press('b'); assert.equal(ui.mediaMenu, undefined); assert.equal(ui.screen, 'player'); assert.ok(!calls.includes('stop'));
	ui.press('b'); assert.ok(calls.includes('stop'));
});

test('add-on screen installs links, refreshes catalogs and confirms removal', async () => {
	const calls: string[] = [];
	let addons = [{ transportUrl: 'https://example.com/manifest.json', manifest: { id: 'sample', name: 'Sample', version: '1.0.0', types: [], resources: [], catalogs: [] } }];
	const { services } = fake(calls, { addons: () => addons, promptText: async () => 'stremio://example.com/manifest.json',
		installAddon: async url => { calls.push(`install ${url}`); }, removeAddon: async url => { calls.push(`remove ${url}`); addons = []; } });
	const ui = new UiModel(services); await settle();
	ui.tap({ kind: 'rail', section: 'addons' });
	assert.equal(ui.section, 'addons'); assert.equal(ui.addonSetup().code, 'ABCD1234');
	ui.press('y'); await settle(); assert.ok(calls.includes('install stremio://example.com/manifest.json')); assert.equal(ui.sections.home.loaded, false);
	ui.press('a'); assert.ok(ui.addonConfirm); assert.ok(!calls.some(c => c.startsWith('remove')));
	ui.press('b'); assert.equal(ui.addonConfirm, undefined);
	ui.tap({ kind: 'addonRow', index: 0 }); ui.press('a'); await settle(); assert.equal(ui.addons().length, 0);
	assert.ok(calls.includes('remove https://example.com/manifest.json'));
});

test('default UI clock matches render ticks for OSD hiding and scrub commits', async () => {
	const calls: string[] = [];
	const { services } = fake(calls, { playback: () => ({ time: 100, duration: 5000, paused: false }) });
	const ui = new UiModel(services);
	await settle();
	ui.screen = 'player';
	ui.press('up');
	ui.tick(performance.now() + 4001);
	assert.equal(ui.osd.visible, false);
	ui.press('right');
	ui.tick(performance.now() + 451);
	assert.equal(calls.at(-1), 'seekTo 110');
	assert.equal(ui.osd.scrubTarget, undefined);
});

test('board rows: continue watching first, catalogs with a "See all" card', async () => {
	const rows = boardRows([{ ...item('cw'), progress: 0.5 }], [{ id: 'top', type: 'movie', name: 'Popular', addonName: 'Cinemeta', addonId: 'cm', items: [item('a')], ref: cinemeta }]);
	assert.deepEqual(rows.map((r) => r.title), ['Continue watching', 'Popular · movie']);
	assert.equal(rows[1].cards.at(-1)?.seeAll, cinemeta);
	assert.equal(gridRows(Array.from({ length: 15 }, (_, i) => item(String(i))), 7).length, 3);
});

test('home: navigate cards and rows, open details, play, scrub and stop', async () => {
	const calls: string[] = [];
	const { services, clock } = fake(calls);
	const ui = new UiModel(services, clock.now);
	await settle();
	assert.equal(ui.screen, 'section');
	assert.deepEqual(ui.current().rows.map((r) => r.title), ['Continue watching', 'Popular · movie', 'Public Domain · movie']);

	ui.press('down');
	ui.press('right');
	assert.equal(ui.focusedCard()?.meta.id, 'm2');
	ui.press('a');
	await settle();
	assert.equal(ui.screen, 'details');
	assert.equal(ui.details?.mode, 'streams');
	assert.deepEqual(ui.listRows().map((r) => r.enabled), [true, true]);
	ui.press('down');
	ui.press('a');
	await settle();
	assert.equal(ui.screen, 'player');
	assert.equal(ui.osd.visible, true);
	assert.deepEqual(calls.filter((c) => c.startsWith('play')), ['play m2/m2 abab']);

	// Scrub: two 10 s steps within the commit window, committed once presses stop.
	ui.press('right');
	ui.press('right');
	assert.equal(ui.osd.scrubTarget, 120);
	clock.advance(500);
	ui.tick(clock.now());
	assert.equal(calls.at(-1), 'seekTo 120');
	assert.equal(ui.osd.scrubTarget, undefined);

	ui.press('a');
	assert.equal(calls.at(-1), 'pause');
	ui.press('b');
	assert.equal(ui.screen, 'details');
	assert.equal(calls.at(-1), 'stop');
	ui.press('b');
	assert.equal(ui.screen, 'section');
});

test('rail: left from the first card focuses it; A switches section; L/R cycle', async () => {
	const calls: string[] = [];
	const { services } = fake(calls);
	const ui = new UiModel(services);
	await settle();
	ui.press('left');
	assert.equal(ui.railFocused, true);
	ui.press('down');
	ui.press('down');
	ui.press('a');
	await settle();
	assert.equal(ui.section, 'library');
	assert.ok(calls.includes('library'));
	assert.match(ui.message, /empty/);
	ui.press('r');
	await settle();
	assert.equal(ui.section, 'search');
	assert.ok(calls.includes('search zombie'));
	assert.equal(ui.current().rows[0].cards[0].meta.id, 'r1');
});

test('discover: chips row, opening a catalog builds a grid; "See all" jumps there', async () => {
	const calls: string[] = [];
	const { services } = fake(calls);
	const ui = new UiModel(services);
	await settle();
	ui.press('r');
	await settle();
	assert.equal(ui.section, 'discover');
	assert.equal(ui.current().rows[0].kind, 'chips');
	ui.press('right');
	ui.press('a');
	await settle();
	assert.ok(calls.includes('catalog pd'));
	assert.equal(ui.current().rows.length, 1 + 2); // chips + 9 items in rows of 7
	assert.equal(ui.current().row, 1);
	// Back to home, "See all" on the Popular row.
	ui.press('l');
	await settle();
	ui.press('down');
	for (let i = 0; i < 5; i++) ui.press('right');
	assert.equal(ui.focusedCard()?.label, 'See all');
	ui.press('a');
	await settle();
	assert.equal(ui.section, 'discover');
	assert.ok(calls.includes('catalog top'));
});

test('series: episodes list first, then streams for the chosen episode', async () => {
	const calls: string[] = [];
	const { services } = fake(calls);
	const ui = new UiModel(services);
	await settle();
	ui.press('down');
	ui.press('down');
	ui.press('right');
	assert.equal(ui.focusedCard()?.meta.id, 's1');
	ui.press('a');
	await settle();
	assert.equal(ui.details?.mode, 'episodes');
	ui.press('down');
	ui.press('a');
	await settle();
	assert.equal(ui.details?.mode, 'streams');
	assert.equal(calls.at(-1), 'details s1/s1:1:2');
	ui.press('b');
	assert.equal(ui.details?.mode, 'episodes');
	assert.equal(ui.details?.cursor, 1);
});

test('touch: tapping a card opens it, tapping the rail switches, seek taps and swipes', async () => {
	const calls: string[] = [];
	const { services } = fake(calls);
	const ui = new UiModel(services);
	await settle();
	ui.swipe(2, 0);
	assert.equal(ui.current().col, 0); // continue-watching row has one card
	ui.swipe(0, 1);
	ui.swipe(2, 0);
	assert.equal(ui.focusedCard()?.meta.id, 'm3');
	ui.tap({ kind: 'card', row: 1, col: 0 });
	await settle();
	assert.equal(ui.screen, 'details');
	assert.equal(calls.at(-1), 'details m1');
	ui.tap({ kind: 'listRow', index: 1 });
	await settle();
	assert.equal(ui.screen, 'player');
	ui.tap({ kind: 'osdSeek', fraction: 0.5 });
	assert.equal(calls.at(-1), 'seekTo 2500');
	ui.tap({ kind: 'osdBack' });
	assert.equal(ui.screen, 'details');
	ui.tap({ kind: 'back' });
	assert.equal(ui.screen, 'section');
	ui.tap({ kind: 'rail', section: 'library' });
	await settle();
	assert.equal(ui.section, 'library');
});

test('a dismissed search prompt and a failed load leave a message, not a crash', async () => {
	const calls: string[] = [];
	const { services } = fake(calls, { promptText: async () => null, loadBoard: async () => { throw new Error('offline'); } });
	const ui = new UiModel(services);
	await settle();
	assert.equal(ui.message, 'Failed: offline');
	ui.press('l'); // wraps to settings
	ui.press('l'); // add-ons
	ui.press('l'); // search
	await settle();
	assert.equal(ui.section, 'search');
	assert.equal(ui.message, '', 'dismissing restores the previous (empty) state; the search screen explains what to do');
	assert.equal(ui.keyboard, undefined);
	assert.equal(ui.busy, false);
});

// ---- filters, settings and progressive loading ----

const uhdStream: StreamOption = { addonName: 'T', addonUrl: 'http://t', stream: { name: 'T\n4k', title: 'Film.2160p.HDR.x265\n💾 20 GB', infoHash: 'cd'.repeat(20) } };
const fhdStream: StreamOption = { addonName: 'T', addonUrl: 'http://t', stream: { name: 'T\n1080p', title: 'Film.1080p.x264\n💾 4 GB', infoHash: 'ef'.repeat(20) } };
const debridStream: StreamOption = { addonName: 'D', addonUrl: 'http://d', stream: { name: '[RD+] D\n1080p', title: 'Film.1080p.WEB-DL', url: 'https://debrid.example/1' } };

test('streams arrive progressively without moving the cursor off the focused stream', async () => {
	const calls: string[] = [];
	let update: ((d: MetaDetails) => void) | undefined;
	const { services } = fake(calls, {
		loadDetails: async (it, _videoId, onUpdate) => { update = onUpdate; return { meta: { ...it }, streams: [fhdStream], pendingAddons: 1 }; },
	});
	const ui = new UiModel(services); await settle();
	ui.press('a'); await settle();
	assert.equal(ui.screen, 'details');
	assert.equal(ui.busy, false, 'the details screen opens before the slow add-on answers');
	assert.equal(ui.listRows().length, 1);
	assert.match(ui.streamsHeader(), /waiting for 1 add-on/);
	assert.ok(update, 'a progressive listener was passed');
	update!({ meta: ui.details!.meta, streams: [debridStream, fhdStream], pendingAddons: 0 });
	assert.equal(ui.listRows().length, 2);
	assert.equal(ui.details!.cursor, 1, 'still on the 1080p torrent');
	assert.doesNotMatch(ui.streamsHeader(), /waiting/);
	ui.press('a'); await settle();
	assert.ok(calls.some((c) => c.startsWith('play cw1/') && c.endsWith('efef')), 'played the stream that was focused');
});

test('4K is hidden by default; X reveals it dimmed with the reason, and it still plays', async () => {
	const calls: string[] = [];
	const { services } = fake(calls, { loadDetails: async (it) => ({ meta: { ...it }, streams: [uhdStream, fhdStream] }) });
	const ui = new UiModel(services); await settle();
	ui.press('a'); await settle();
	assert.deepEqual(ui.listRows().map((r) => r.badges?.[0]), ['1080p']);
	assert.match(ui.hint(), /X show 1 hidden/);
	assert.match(ui.streamsHeader(), /1 hidden by filters/);
	ui.press('x');
	const rows = ui.listRows();
	assert.equal(rows.length, 2);
	assert.equal(rows[1].dimmed, true);
	assert.equal(rows[1].detail, 'Hidden: 4K');
	assert.deepEqual(rows[1].badges?.slice(0, 3), ['4K', 'HDR', 'HEVC']);
	ui.press('down');
	ui.press('a'); await settle();
	assert.ok(calls.some((c) => c.endsWith('cdcd')), 'the revealed 4K stream plays on request');
	ui.stopPlayback();
	ui.press('x');
	assert.equal(ui.listRows().length, 1);
	assert.equal(ui.details!.cursor, 0, 'cursor clamps when the focused stream hides again');
});

test('when every stream is filtered the hint says how to see them', async () => {
	const { services } = fake([], { loadDetails: async (it) => ({ meta: { ...it }, streams: [uhdStream] }) });
	const ui = new UiModel(services); await settle();
	ui.press('a'); await settle();
	assert.equal(ui.listRows().length, 0);
	assert.match(ui.hint(), /X show 1 hidden/);
	ui.press('a'); await settle(); // nothing to play: no crash, no player
	assert.equal(ui.screen, 'details');
});

test('settings: cycle, edit words, reset; changes persist and the stream list follows', async () => {
	const saved: Settings[] = [];
	const calls: string[] = [];
	const { services } = fake(calls, {
		getSettings: () => ({ ...DEFAULT_SETTINGS }),
		setSettings: (s) => { saved.push(s); },
		loadDetails: async (it) => ({ meta: { ...it }, streams: [uhdStream, fhdStream] }),
		promptText: async () => 'x264, cam',
	});
	const ui = new UiModel(services); await settle();
	ui.press('l');
	assert.equal(ui.section, 'settings');
	assert.deepEqual([ui.settingRows()[0].label, ui.settingRows()[0].value], ['Stremio account', 'Sign in']);
	ui.press('down'); // past the account row, onto Maximum resolution
	assert.equal(ui.settingRows()[1].value, '1080p');
	ui.press('left'); // 1080p -> 1440p
	ui.press('left'); // -> 4K
	assert.equal(ui.settingRows()[1].value, '4K');
	assert.equal(saved.at(-1)?.maxResolution, 2160);
	const wordsIndex = ui.settingRows().findIndex((r) => r.kind === 'text');
	for (let i = 1; i < wordsIndex; i++) ui.press('down');
	ui.press('a'); await settle();
	assert.equal(saved.at(-1)?.excludeKeywords, 'x264, cam');
	assert.equal(ui.settingRows()[wordsIndex].value, 'x264, cam');
	// The stream list uses the new settings: 4K allowed but HDR still hidden; x264 excluded.
	ui.press('r'); // wraps to home
	ui.press('a'); await settle();
	assert.equal(ui.listRows().length, 0);
	assert.match(ui.streamsHeader(), /2 hidden/);
	ui.press('b');
	ui.press('l');
	for (let i = 0; i < 20; i++) ui.press('down');
	ui.press('a');
	assert.equal(ui.resetConfirm, true);
	ui.press('a');
	assert.deepEqual(saved.at(-1), DEFAULT_SETTINGS);
	assert.equal(ui.settingRows()[1].value, '1080p');
	ui.press('b');
	assert.equal(ui.railFocused, true, 'B leaves the settings list for the rail');
});

test('the home board fills in as catalogs answer and keeps the cursor on its row', async () => {
	let release: () => void = () => {};
	const popular: CatalogRow = { id: 'top', type: 'movie', name: 'Popular', addonName: 'Cinemeta', addonId: 'cm', items: [item('m1'), item('m2')], ref: cinemeta };
	const slowLoading: CatalogRow = { id: 'pd', type: 'movie', name: 'Public Domain', addonName: 'PD', addonId: 'pd', items: [], ref: pd, loading: true };
	const slowReady: CatalogRow = { ...slowLoading, items: [item('p1')], loading: undefined };
	const { services } = fake([], {
		continueWatching: () => [],
		loadBoard: (onUpdate) => new Promise((resolve) => {
			onUpdate?.([slowLoading, popular]);
			release = () => resolve([slowReady, popular]);
		}),
	});
	const ui = new UiModel(services); await settle();
	const home = ui.current();
	assert.equal(home.rows.length, 2);
	assert.equal(home.rows[0].loading, true);
	assert.equal(ui.busy, false, 'browsable while the slow catalog loads');
	ui.press('down');
	ui.press('right');
	assert.equal(ui.focusedCard()?.meta.id, 'm2');
	release(); await settle();
	assert.equal(home.rows[0].loading, undefined);
	assert.equal(ui.focusedCard()?.meta.id, 'm2', 'cursor stayed on the same card');
	assert.equal(ui.message, '');
});

test('a slow details update from a title the user left is ignored', async () => {
	const updates = new Map<string, (d: MetaDetails) => void>();
	const { services } = fake([], {
		loadDetails: async (it, _v, onUpdate) => { if (onUpdate) updates.set(it.id, onUpdate); return { meta: { ...it }, streams: [], pendingAddons: 1 }; },
	});
	const ui = new UiModel(services); await settle();
	ui.press('a'); await settle(); // cw1
	ui.press('b');
	ui.press('down');
	ui.press('a'); await settle(); // m1
	assert.equal(ui.details!.meta.id, 'm1');
	updates.get('cw1')!({ meta: { ...item('cw1') }, streams: [fhdStream], pendingAddons: 0 });
	assert.equal(ui.details!.meta.id, 'm1');
	assert.equal(ui.listRows().length, 0, 'stale streams did not leak into the new title');
	updates.get('m1')!({ meta: ui.details!.meta, streams: [fhdStream], pendingAddons: 0 });
	assert.equal(ui.listRows().length, 1);
});

test('search shows that it is searching, then the results or a no-results line for the query', async () => {
	let finish: (rows: CatalogRow[]) => void = () => {};
	const { services } = fake([], {
		promptText: async () => '  harbor  ',
		search: (_q, onUpdate) => new Promise((resolve) => { onUpdate?.([]); finish = resolve; }),
	});
	const ui = new UiModel(services); await settle();
	ui.press('l'); ui.press('l'); ui.press('l'); // settings, add-ons, search
	await settle();
	assert.equal(ui.section, 'search');
	assert.equal(ui.searching, true);
	assert.equal(ui.current().query, 'harbor', 'the query is trimmed');
	finish([]); await settle();
	assert.equal(ui.searching, false);
	assert.equal(ui.message, 'No results for “harbor”.');
});

// ---- search rewrite: in-app search bar over the inline keyboard ----

/** A controllable keyboard: the test types, submits or cancels; the UI sees live input. */
function keyboardFake() {
	const opened: { ok: string; initial: string }[] = [];
	let input: ((text: string, cursor: number, height: number) => void) | undefined;
	let resolve: ((v: string | null) => void) | undefined;
	return {
		opened,
		promptText: (ok: string, initial: string, onInput?: (text: string, cursor: number, height: number) => void) => {
			opened.push({ ok, initial });
			input = onInput;
			onInput?.(initial, initial.length, 330);
			return new Promise<string | null>((r) => { resolve = r; });
		},
		type: (text: string) => input?.(text, text.length, 330),
		submit: (text: string) => { input?.(text, text.length, 330); resolve?.(text); },
		cancel: () => resolve?.(null),
	};
}

const harborRows = (q: string): CatalogRow[] => [{ id: 'top', type: 'movie', name: 'Popular', addonName: 'Cinemeta', addonId: 'cm', items: [item(`${q}-1`), item(`${q}-2`)], ref: cinemeta }];

test('search opens an empty field every time and shows the typed text with the caret', async () => {
	const kb = keyboardFake();
	const searched: string[] = [];
	const { services } = fake([], { promptText: kb.promptText, search: async (q) => { searched.push(q); return harborRows(q); } });
	const ui = new UiModel(services); await settle();
	ui.press('y'); await settle(); // Y from home goes to Search with the keyboard open
	assert.equal(ui.section, 'search');
	assert.equal(ui.keyboard?.kind, 'search');
	assert.equal(kb.opened[0].initial, '');
	kb.type('harb');
	assert.equal(ui.keyboard?.text, 'harb');
	assert.equal(ui.keyboard?.cursor, 4);
	assert.equal(ui.keyboard?.height, 330, 'the keyboard height arrives for the layout');
	kb.submit('harbor'); await settle();
	assert.equal(ui.keyboard, undefined);
	assert.deepEqual(searched, ['harbor']);
	assert.equal(ui.focusedCard()?.meta.id, 'harbor-1', 'OK focuses the first result');
	ui.press('y'); await settle();
	assert.equal(kb.opened[1].initial, '', 'a new search starts with an empty field');
	kb.cancel(); await settle();
});

test('while the keyboard is open no button or tap reaches the screen behind it', async () => {
	const kb = keyboardFake();
	const calls: string[] = [];
	const { services } = fake(calls, { promptText: kb.promptText });
	const ui = new UiModel(services); await settle();
	const before = { section: ui.section, row: ui.current().row, col: ui.current().col };
	ui.press('y'); await settle();
	const search = { row: ui.current().row, col: ui.current().col };
	for (const b of ['a', 'b', 'x', 'up', 'down', 'left', 'right', 'l', 'r'] as const) ui.press(b);
	ui.tap({ kind: 'rail', section: 'home' });
	ui.tap({ kind: 'card', row: 0, col: 0 });
	ui.swipe(1, 1);
	await settle();
	assert.equal(ui.section, 'search', 'L/R and rail taps were ignored');
	assert.equal(ui.screen, 'section', 'A/card taps opened nothing');
	assert.deepEqual({ row: ui.current().row, col: ui.current().col }, search);
	assert.ok(!calls.some((c) => c.startsWith('details')));
	assert.equal(ui.hint(), '', 'no footer hints for buttons that do nothing');
	kb.cancel(); await settle();
	assert.equal(ui.keyboard, undefined);
	void before;
});

test('results appear as you type after a pause; OK with the same text does not search again', async () => {
	UiModel.searchDebounceMs = 20;
	try {
		const kb = keyboardFake();
		const searched: string[] = [];
		const { services } = fake([], { promptText: kb.promptText, search: async (q) => { searched.push(q); return harborRows(q); } });
		const ui = new UiModel(services); await settle();
		ui.press('y'); await settle();
		kb.type('h');
		kb.type('ha');
		kb.type('har');
		await new Promise((r) => setTimeout(r, 60));
		assert.deepEqual(searched, ['har'], 'one search after typing pauses; single letters are not searched');
		assert.deepEqual(ui.searchMatches(5).map((m) => m.id), ['har-1', 'har-2'], 'matches listed above the keyboard');
		kb.submit('har'); await settle();
		assert.deepEqual(searched, ['har'], 'OK reused the live results');
		assert.equal(ui.focusedCard()?.meta.id, 'har-1');
	} finally {
		UiModel.searchDebounceMs = 600;
	}
});

test('cancelling a search restores the previous results, even after live results replaced them', async () => {
	UiModel.searchDebounceMs = 10;
	try {
		const kb = keyboardFake();
		const { services } = fake([], { promptText: kb.promptText, search: async (q) => harborRows(q) });
		const ui = new UiModel(services); await settle();
		ui.press('y'); await settle();
		kb.submit('harbor'); await settle();
		ui.press('right');
		assert.equal(ui.focusedCard()?.meta.id, 'harbor-2');
		ui.press('y'); await settle();
		kb.type('ember');
		await new Promise((r) => setTimeout(r, 40));
		assert.equal(ui.searchMatches(1)[0]?.id, 'ember-1', 'live results for the new text');
		kb.cancel(); await settle();
		assert.equal(ui.current().query, 'harbor');
		assert.equal(ui.focusedCard()?.meta.id, 'harbor-2', 'back where the user was');
	} finally {
		UiModel.searchDebounceMs = 600;
	}
});

test('other keyboard prompts show their label and text above the keyboard too', async () => {
	const kb = keyboardFake();
	const saved: Settings[] = [];
	const { services } = fake([], { promptText: kb.promptText, getSettings: () => ({ ...DEFAULT_SETTINGS }), setSettings: (x) => { saved.push(x); } });
	const ui = new UiModel(services); await settle();
	ui.press('l'); // settings
	const words = ui.settingRows().findIndex((r) => r.kind === 'text');
	for (let i = 0; i < words; i++) ui.press('down');
	ui.press('a'); await settle();
	assert.equal(ui.keyboard?.kind, 'text');
	assert.equal(ui.keyboard?.label, 'Excluded words');
	kb.type('3D, HDTS');
	assert.equal(ui.keyboard?.text, '3D, HDTS');
	kb.submit('3D, HDTS'); await settle();
	assert.equal(saved.at(-1)?.excludeKeywords, '3D, HDTS');
	assert.equal(ui.keyboard, undefined);
});

// ---- seasons, resume and next episode ----

const ep = (s: number, e: number, extra: object = {}) => ({ id: `tt9:${s}:${e}`, title: `Ep ${e}`, season: s, episode: e, ...extra });
const seriesVideos = [ep(2, 1), ep(1, 2, { watched: true }), ep(1, 1, { watched: true }), ep(0, 1), ep(2, 2), ep(2, 3, { upcoming: true })];
const epStream = (videoId: string): StreamOption => ({ addonName: 'T', addonUrl: 'http://t', stream: { name: 'T\n1080p', title: `${videoId} 1080p x264`, url: `https://v.example/${videoId}.mkv` } });

function seriesFake(calls: string[], extra: Partial<UiServices> = {}) {
	return fake(calls, {
		loadDetails: async (it, videoId) => ({ meta: { ...it, type: 'series', videos: seriesVideos }, streams: videoId ? [epStream(videoId)] : [], lastVideoId: 'tt9:1:2' }),
		...extra,
	});
}

test('a series opens on the season and episode last watched; ◀ ▶ switch seasons, specials last', async () => {
	const { services } = seriesFake([]);
	const ui = new UiModel(services); await settle();
	ui.press('a'); await settle();
	const d = ui.details!;
	assert.deepEqual(d.seasons, [1, 2, 0]);
	assert.equal(d.season, 1);
	assert.deepEqual(ui.listRows().map((r) => [r.label, r.detail]), [['S1E1 Ep 1', 'Watched'], ['S1E2 Ep 2', 'Watched']], 'sorted, with watched state');
	assert.equal(d.cursor, 1, 'on the episode last watched');
	ui.press('right');
	assert.equal(d.season, 2);
	assert.equal(ui.listRows().length, 3);
	assert.equal(ui.listRows()[2].detail, 'Upcoming');
	ui.press('right');
	assert.equal(d.season, 0);
	ui.tap({ kind: 'season', step: 1 });
	assert.equal(d.season, 1, 'wraps');
	ui.press('left'); ui.press('left');
	assert.equal(d.season, 2);
	ui.press('a'); await settle(); // S2E1 streams
	assert.equal(d.videoId, 'tt9:2:1');
	ui.press('b');
	assert.equal(d.season, 2, 'back on the season of the episode');
	assert.match(ui.hint(), /◀ ▶ season/);
});

test('resuming shows where and X starts over, once', async () => {
	const calls: string[] = [];
	let now = 0;
	const { services } = fake(calls, { play: async () => ({ resumedAt: 754 }), seekTo: (t) => { calls.push(`seek ${t}`); } });
	const ui = new UiModel(services, () => now); await settle();
	ui.press('a'); await settle();
	ui.press('a'); await settle();
	assert.equal(ui.screen, 'player');
	assert.equal(ui.playerNotice(), 'Resumed at 12:34. Press X to start from the beginning.');
	ui.press('x');
	assert.ok(calls.includes('seek 0'));
	assert.equal(ui.playerNotice(), '');
	ui.press('x');
	assert.equal(calls.filter((c) => c === 'seek 0').length, 1);
	now = 20000; ui.tick(now);
	assert.equal(ui.playerNotice(), '');
});

test('when an episode ends the next one plays from the same add-on; the last one returns to the title', async () => {
	const calls: string[] = [];
	const played: string[] = [];
	const { services } = seriesFake(calls, { play: async (_o, _m, videoId) => { played.push(videoId); } });
	const ui = new UiModel(services); await settle();
	ui.press('a'); await settle();   // series, cursor on S1E2
	ui.press('a'); await settle();   // its streams
	ui.press('a'); await settle();   // play
	assert.deepEqual(played, ['tt9:1:2']);
	assert.equal(ui.nextEpisode()?.id, 'tt9:2:1', 'crosses into the next season');
	assert.match(ui.hint(), /R next episode/);
	ui.playbackEnded(); await settle(); await settle();
	assert.deepEqual(played, ['tt9:1:2', 'tt9:2:1']);
	assert.equal(ui.screen, 'player');
	assert.equal(ui.details!.season, 2);
	ui.playbackEnded(); await settle(); await settle();
	assert.deepEqual(played.at(-1), 'tt9:2:2');
	assert.equal(ui.nextEpisode(), undefined, 'upcoming and special episodes are not queued');
	ui.playbackEnded(); await settle();
	assert.equal(ui.screen, 'details');
});

test('R skips to the next episode on the second press; autoplay can be turned off', async () => {
	const played: string[] = [];
	let now = 0;
	const { services } = seriesFake([], { play: async (_o, _m, videoId) => { played.push(videoId); }, getSettings: () => ({ ...DEFAULT_SETTINGS, autoplayNext: false }) });
	const ui = new UiModel(services, () => now); await settle();
	ui.press('a'); await settle(); ui.press('a'); await settle(); ui.press('a'); await settle();
	ui.press('r');
	assert.match(ui.playerNotice(), /Press R again for the next episode: S2E1/);
	assert.equal(played.length, 1);
	now = 9000; ui.tick(now); // the prompt expired: a later press asks again
	ui.press('r');
	assert.equal(played.length, 1);
	ui.press('r'); await settle(); await settle();
	assert.deepEqual(played, ['tt9:1:2', 'tt9:2:1']);
	ui.playbackEnded(); await settle();
	assert.equal(ui.screen, 'details', 'autoplay off: back to the title');
	assert.equal(played.length, 2);
});

test('without a matching stream the next episode opens its stream list instead of guessing', async () => {
	const played: string[] = [];
	const { services } = seriesFake([], {
		play: async (_o, _m, videoId) => { played.push(videoId); },
		loadDetails: async (it, videoId) => ({ meta: { ...it, type: 'series', videos: seriesVideos }, lastVideoId: 'tt9:1:2',
			streams: videoId === 'tt9:1:2' ? [epStream(videoId)] : videoId ? [{ ...epStream(videoId), addonUrl: 'http://other', addonName: 'O' }] : [] }),
	});
	const ui = new UiModel(services); await settle();
	ui.press('a'); await settle(); ui.press('a'); await settle(); ui.press('a'); await settle();
	ui.playbackEnded(); await settle(); await settle();
	assert.equal(played.length, 1);
	assert.equal(ui.screen, 'details');
	assert.equal(ui.details!.videoId, 'tt9:2:1');
	assert.equal(ui.message, 'Choose a stream for S2E1 Ep 1.');
	assert.equal(ui.listRows().length, 1);
});

test('a wrong console clock is named when no catalog loads', async () => {
	const { services } = fake([], { continueWatching: () => [], loadBoard: async () => [], clockWrong: () => true });
	const ui = new UiModel(services); await settle();
	assert.match(ui.message, /date and time are wrong/);
});

// ---- Stremio account ----

test('sign in asks for email then a masked password; sign out needs a second press', async () => {
	const kb = keyboardFake();
	const calls: string[] = [];
	let signedIn: { email: string } | null = null;
	const { services } = fake(calls, {
		promptText: kb.promptText,
		account: () => signedIn,
		signIn: async (email, password) => { if (password !== 'right') throw new Error('Wrong email or password.'); signedIn = { email }; calls.push(`signin ${email}`); },
		signOut: async () => { signedIn = null; calls.push('signout'); },
	});
	const ui = new UiModel(services); await settle();
	ui.press('l'); // settings, cursor on the account row
	ui.press('a'); await settle();
	assert.equal(ui.keyboard?.kind, 'text');
	kb.submit(' me@example.com '); await settle();
	assert.equal(ui.keyboard?.kind, 'password', 'the password field is masked by its kind');
	assert.equal(ui.keyboard?.label, 'Password for me@example.com');
	kb.submit('wrong'); await settle(); await settle();
	assert.equal(ui.message, 'Failed: Wrong email or password.');
	assert.equal(ui.settingRows()[0].value, 'Sign in');
	ui.press('a'); await settle(); kb.submit('me@example.com'); await settle(); kb.submit('right'); await settle(); await settle();
	assert.ok(calls.includes('signin me@example.com'));
	assert.equal(ui.settingRows()[0].value, 'me@example.com');
	assert.match(ui.message, /Signed in as me@example.com/);
	assert.equal(ui.sections.home.loaded, false, 'home reloads with the account\'s add-ons and history');
	ui.press('a'); await settle();
	assert.match(ui.message, /Sign out of me@example.com\?/);
	assert.ok(!calls.includes('signout'));
	ui.press('a'); await settle(); await settle();
	assert.ok(calls.includes('signout'));
	assert.equal(ui.settingRows()[0].value, 'Sign in');
});

test('cancelling either prompt signs nobody in', async () => {
	const kb = keyboardFake();
	const calls: string[] = [];
	const { services } = fake(calls, { promptText: kb.promptText, account: () => null, signIn: async () => { calls.push('signin'); }, signOut: async () => {} });
	const ui = new UiModel(services); await settle();
	ui.press('l'); ui.press('a'); await settle();
	kb.cancel(); await settle();
	assert.equal(ui.keyboard, undefined);
	ui.press('a'); await settle(); kb.submit('me@example.com'); await settle(); kb.cancel(); await settle();
	assert.deepEqual(calls.filter((c) => c === 'signin'), []);
});
