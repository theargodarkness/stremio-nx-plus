/** Watch reporting, resume points, track language memory, the board cache, next-stream choice and error wording. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore } from '../src/shims';
import { WatchReporter, resumePoint, type WatchPosition } from '../src/app/watch';
import { loadTrackPrefs, preferredTrack, sameLanguage, saveTrackPrefs } from '../src/app/track-prefs';
import { fillFromCache, loadBoardCache, saveBoardCache } from '../src/app/board-cache';
import { filterStreams, pickNextStream } from '../src/stremio/stream-info';
import { DEFAULT_SETTINGS } from '../src/app/settings';
import { friendlyError } from '../src/app/ui';
import type { CatalogRow, StreamOption } from '../src/stremio/client';

function sink() {
	const calls: string[] = [];
	return { calls, playerTime: (t: number, d: number) => calls.push(`time ${t}/${d}`), playerPaused: (p: boolean) => calls.push(`paused ${p}`),
		playerEnded: () => calls.push('ended'), unloadPlayer: () => calls.push('unload') };
}

test('the reporter sends time when it moves, pause changes, and a final position on stop', () => {
	const s = sink();
	let pos: WatchPosition | null = { time: 0, duration: 1200, paused: false };
	const r = new WatchReporter(s, () => pos, 1 << 30);
	assert.deepEqual(s.calls, ['paused false']);
	pos = { time: 5, duration: 1200, paused: false }; r.tick();
	r.tick(); // unchanged: nothing sent
	pos = { time: 5.2, duration: 1200, paused: true }; r.tick();
	pos = { time: 65, duration: 1200, paused: true };
	r.stop();
	r.stop(); r.tick(); r.ended(); // finished: no more reports
	assert.deepEqual(s.calls, ['paused false', 'time 5000/1200000', 'paused true', 'time 65000/1200000', 'unload']);
});

test('the end of a video reports the full length, then Ended', () => {
	const s = sink();
	const r = new WatchReporter(s, () => ({ time: 1198.7, duration: 1200, paused: false }), 1 << 30);
	r.ended();
	assert.deepEqual(s.calls, ['paused false', 'time 1200000/1200000', 'ended', 'unload']);
});

test('a core that rejects an action never interrupts playback', () => {
	const s = { ...sink(), playerTime: () => { throw new Error('core'); } };
	const r = new WatchReporter(s, () => ({ time: 9, duration: 100, paused: false }), 1 << 30);
	assert.doesNotThrow(() => { r.tick(); r.stop(); });
});

test('resume: not for the first half minute, not when nearly finished', () => {
	assert.equal(resumePoint(700_000, 1200), 700);
	assert.equal(resumePoint(20_000, 1200), 0);
	assert.equal(resumePoint(1_170_000, 1200), 0, 'last minute');
	assert.equal(resumePoint(5_800_000, 6000), 0, 'past 95%');
	assert.equal(resumePoint(700_000, 0), 0, 'unknown length');
});

test('remembered languages pick a matching track once, across code styles', () => {
	const store = new MemoryStore();
	assert.deepEqual(loadTrackPrefs(store), { audio: undefined, subtitles: undefined });
	saveTrackPrefs(store, { audio: 'jpn', subtitles: 'eng' });
	assert.deepEqual(loadTrackPrefs(store), { audio: 'jpn', subtitles: 'eng' });
	assert.ok(sameLanguage('eng', 'en') && sameLanguage('en-US', 'English') && sameLanguage('fre', 'fra') && sameLanguage('ger', 'de'));
	assert.ok(!sameLanguage('eng', 'spa') && !sameLanguage('en', undefined));
	const subs = [
		{ id: 'off', selected: true, enabled: true },
		{ id: 'embedded:2', language: 'spa', selected: false, enabled: true },
		{ id: 'embedded:3', language: 'eng', selected: false, enabled: false },
		{ id: 'external:0', language: 'en', selected: false, enabled: true },
	];
	assert.equal(preferredTrack(subs, 'eng')?.id, 'external:0', 'skips the unsupported track');
	assert.equal(preferredTrack(subs, 'ger'), undefined);
	assert.equal(preferredTrack(subs, undefined), undefined);
	assert.equal(preferredTrack(subs, 'off'), undefined, 'already off');
	subs[0].selected = false; subs[3].selected = true;
	assert.equal(preferredTrack(subs, 'eng'), undefined, 'already selected: nothing to do');
	assert.equal(preferredTrack(subs, 'off')?.id, 'off');
});

const row = (id: string, items: string[], loading?: boolean): CatalogRow => ({ id, type: 'movie', name: id, addonName: 'A', addonId: 'a', loading, items: items.map((n) => ({ id: n, type: 'movie', name: n, poster: `http://p/${n}`, description: 'long text not worth caching' } as never)) });

test('the board cache fills loading rows from the last launch and never revives removed rows', () => {
	const store = new MemoryStore();
	assert.equal(loadBoardCache(store).size, 0);
	saveBoardCache(store, [row('top', ['a', 'b']), row('gone', ['x']), row('empty', []), row('pending', ['p'], true)]);
	const cache = loadBoardCache(store);
	assert.deepEqual([...cache.keys()], ['a/movie/top', 'a/movie/gone']);
	assert.deepEqual(Object.keys(cache.get('a/movie/top')![0]).sort(), ['id', 'name', 'poster', 'type'], 'only what a card needs');
	const filled = fillFromCache([row('top', [], true), row('new', [], true), row('fresh', ['f'])], cache);
	assert.deepEqual(filled.map((r) => [r.id, r.loading ?? false, r.items.map((i) => i.id)]), [['top', false, ['a', 'b']], ['new', true, []], ['fresh', false, ['f']]]);
	store.setItem('stremio-nx:board-cache', '{broken');
	assert.equal(loadBoardCache(store).size, 0);
});

const stream = (addon: string, name: string, title: string, extra: object = {}): StreamOption => ({ addonName: addon, addonUrl: `http://${addon}`, stream: { name, title, infoHash: 'ab'.repeat(20), ...extra } });

test('the next episode follows the same release group, else the same add-on and resolution', () => {
	const prev = stream('t', 'T\n1080p', 'Show.S01E01.1080p.WEB.x264-GRP', { behaviorHints: { bingeGroup: 't|1080p|GRP' } });
	const rows = (list: StreamOption[]) => filterStreams(list, DEFAULT_SETTINGS).rows;
	const other = stream('o', 'O\n1080p', 'Show.S01E02.1080p.WEB', { behaviorHints: { bingeGroup: 't|1080p|GRP' } });
	const hd = stream('t', 'T\n720p', 'Show.S01E02.720p.WEB');
	const fhd = stream('t', 'T\n1080p', 'Show.S01E02.1080p.BluRay');
	const group = stream('t', 'T\n1080p', 'Show.S01E02.1080p.WEB.x264-GRP', { behaviorHints: { bingeGroup: 't|1080p|GRP' } });
	const uhd = stream('t', 'T\n4k', 'Show.S01E02.2160p.WEB', { behaviorHints: { bingeGroup: 't|1080p|GRP' } });
	assert.equal(pickNextStream(prev, rows([other, hd, fhd, group])), group, 'binge group from the same add-on');
	assert.equal(pickNextStream(prev, rows([other, hd, fhd])), fhd, 'same add-on and resolution');
	assert.equal(pickNextStream(prev, rows([other, hd])), hd, "that add-on's first shown stream");
	assert.equal(pickNextStream(prev, rows([other])), undefined, 'another add-on: the user chooses');
	assert.equal(pickNextStream(prev, rows([uhd, hd])), hd, 'filtered streams are never auto-played');
});

test('errors are worded for the person holding the console', () => {
	const x509 = 'catalog failed: {"type":"Err","content":"Env: Failed to fetch: X509 verification failed (flags=0x00000200): The certificate validity starts in the future\\n"}';
	assert.match(friendlyError(x509), /date and time are wrong/);
	assert.match(friendlyError('Env: Failed to fetch: getaddrinfo failed'), /Check that the Switch is online/);
	assert.equal(friendlyError('no playable data after 90 s'), 'Failed: no playable data after 90 s');
});
