/** Settings persistence, validation and cycling; poster URL sizing and queue order. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore } from '../src/shims';
import { DEFAULT_SETTINGS, SETTING_ITEMS, cycleSetting, loadSettings, sanitizeSettings, saveSettings, settingValueLabel } from '../src/app/settings';
import { sizedImageUrl, ThumbnailCache } from '../src/app/posters';

test('settings round-trip through storage and survive corrupt or out-of-range values', () => {
	const store = new MemoryStore();
	assert.deepEqual(loadSettings(store), DEFAULT_SETTINGS);
	saveSettings(store, { ...DEFAULT_SETTINGS, maxResolution: 720, excludeKeywords: '3D', sort: 'quality' });
	const loaded = loadSettings(store);
	assert.equal(loaded.maxResolution, 720);
	assert.equal(loaded.excludeKeywords, '3D');
	assert.equal(loaded.sort, 'quality');
	store.setItem('stremio-nx:settings', '{not json');
	assert.deepEqual(loadSettings(store), DEFAULT_SETTINGS);
	const odd = sanitizeSettings({ maxResolution: 999, hideHdr: 'yes', sources: 'ftp', maxSizeGB: 3, diagnostics: true });
	assert.equal(odd.maxResolution, DEFAULT_SETTINGS.maxResolution);
	assert.equal(odd.hideHdr, DEFAULT_SETTINGS.hideHdr);
	assert.equal(odd.sources, 'all');
	assert.equal(odd.maxSizeGB, 0);
	assert.equal(odd.diagnostics, true);
});

test('choice settings cycle both ways with wrap-around and show readable labels', () => {
	const res = SETTING_ITEMS.find((i) => i.kind === 'choice' && i.key === 'maxResolution')!;
	let s = { ...DEFAULT_SETTINGS };
	assert.equal(settingValueLabel(res, s), '1080p');
	s = cycleSetting(res, s, 1);
	assert.equal(settingValueLabel(res, s), '720p');
	s = cycleSetting(res, s, -1);
	s = cycleSetting(res, s, -1);
	assert.equal(settingValueLabel(res, s), '1440p');
	s = cycleSetting(res, s, -1);
	s = cycleSetting(res, s, -1);
	assert.equal(settingValueLabel(res, s), 'Any');
	s = cycleSetting(res, s, -1);
	assert.equal(settingValueLabel(res, s), '480p', 'wraps');
	const words = SETTING_ITEMS.find((i) => i.kind === 'text')!;
	assert.equal(settingValueLabel(words, DEFAULT_SETTINGS), 'None');
	assert.ok(SETTING_ITEMS.every((i) => i.help.length > 0), 'every setting explains itself');
});

test('poster URLs from sizeable CDNs are rewritten close to the thumbnail size', () => {
	assert.equal(sizedImageUrl('https://image.tmdb.org/t/p/original/abc.jpg', 'poster'), 'https://image.tmdb.org/t/p/w342/abc.jpg');
	assert.equal(sizedImageUrl('https://image.tmdb.org/t/p/original/abc.jpg', 'backdrop'), 'https://image.tmdb.org/t/p/w1280/abc.jpg');
	assert.equal(sizedImageUrl('https://m.media-amazon.com/images/M/MV5Babc@._V1_.jpg', 'poster'), 'https://m.media-amazon.com/images/M/MV5Babc@._V1_SX300.jpg');
	assert.equal(sizedImageUrl('https://m.media-amazon.com/images/M/MV5Babc@._V1_QL75_UX380_CR0,1,380,562_.jpg', 'poster'), 'https://m.media-amazon.com/images/M/MV5Babc@._V1_SX300.jpg');
	assert.equal(sizedImageUrl('https://images.metahub.space/poster/large/tt0000001/img', 'poster'), 'https://images.metahub.space/poster/medium/tt0000001/img');
	assert.equal(sizedImageUrl('https://images.metahub.space/poster/small/tt0000001/img', 'poster'), 'https://images.metahub.space/poster/small/tt0000001/img');
	assert.equal(sizedImageUrl('https://example.com/poster.jpg', 'poster'), 'https://example.com/poster.jpg');
	assert.equal(sizedImageUrl('not a url', 'poster'), 'not a url');
});

test('the poster queue loads what was wanted most recently first and drops stale requests', async () => {
	const requested: string[] = [];
	const finish: (() => void)[] = [];
	const g = globalThis as Record<string, unknown>;
	const saved = { fetch: g.fetch };
	// Each request settles (as a 404) only when the test says so.
	g.fetch = (url: string) => { requested.push(url.replace('https://x.example/', '')); return new Promise((resolve) => finish.push(() => resolve({ ok: false, status: 404 }))); };
	const tick = () => new Promise((r) => setTimeout(r, 0));
	try {
		let now = 0;
		const cache = new ThumbnailCache(() => {}, 200, () => now);
		for (let i = 0; i < 10; i++) { now = i; cache.get(`https://x.example/${i}.jpg`, 'poster'); }
		// Four slots went to the first four; the rest wait.
		assert.deepEqual(requested, ['0.jpg', '1.jpg', '2.jpg', '3.jpg']);
		assert.equal(cache.queued, 6);
		// Much later the user has scrolled: 9 is still on screen, 42 just appeared, 4..8 are gone.
		now = 20000;
		cache.get('https://x.example/9.jpg', 'poster');
		cache.get('https://x.example/42.jpg', 'poster');
		finish.shift()!(); await tick();
		finish.shift()!(); await tick();
		assert.deepEqual(requested.slice(4), ['9.jpg', '42.jpg'], 'on-screen posters jump the queue');
		assert.equal(cache.queued, 0, 'posters scrolled past long ago were dropped');
		// A failed poster is retried once it is wanted again after a pause.
		while (finish.length) { finish.shift()!(); await tick(); }
		const before = requested.length;
		now = 21000;
		cache.get('https://x.example/9.jpg', 'poster');
		assert.equal(requested.length, before, 'no immediate retry');
		now = 60000;
		cache.get('https://x.example/9.jpg', 'poster');
		assert.equal(requested.at(-1), '9.jpg');
	} finally {
		g.fetch = saved.fetch;
	}
});
