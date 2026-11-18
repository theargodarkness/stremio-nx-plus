/**
 * Watch progress against the real stremio-core on Node: the app's
 * WatchReporter drives a simulated playback; the core must then offer the
 * resume point, mark the finished episode watched, queue the next episode and
 * list the series under Continue Watching. Meta requests are answered locally.
 * Run: npm run core-watch
 */
import assert from 'node:assert/strict';
import { installShims, MemoryStore } from '../src/shims';
import { StremioClient } from '../src/stremio/client';
import { WatchReporter, resumePoint } from '../src/app/watch';

const videos = [1, 2].flatMap((s) => [1, 2, 3].map((e) => ({ id: `tt7:${s}:${e}`, title: `Episode ${e}`, season: s, episode: e, released: `201${s}-01-0${e}T00:00:00.000Z` })));
globalThis.fetch = (async (input: RequestInfo | URL) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	const body = decodeURIComponent(url.pathname) === '/meta/series/tt7.json' ? { meta: { id: 'tt7', type: 'series', name: 'Show', videos } } : null;
	return body ? new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }) : new Response('{}', { status: 404 });
}) as typeof fetch;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	installShims({ appVersion: '0.1.0', shellVersion: 'watch-check', storage: new MemoryStore() });
	const core = await StremioClient.create();
	const option = { addonName: 'A', addonUrl: 'http://127.0.0.1:9/manifest.json', stream: { url: 'http://x.invalid/v.mkv' } };
	const show = { id: 'tt7', type: 'series', name: 'Show' };
	const DURATION = 1200;

	// 1. Watch 10 minutes of S1E2, then stop.
	await core.loadPlayer(option, show, 'tt7:1:2');
	await sleep(200);
	let position = { time: 0, duration: DURATION, paused: false };
	let reporter = new WatchReporter(core, () => position, 1 << 30);
	for (let t = 5; t <= 600; t += 5) { position = { ...position, time: t }; reporter.tick(); }
	reporter.stop();
	await sleep(200);

	// 2. Opening it again offers the resume point.
	const again = await core.loadPlayer(option, show, 'tt7:1:2');
	await sleep(200);
	const resume = resumePoint(core.playerProgress('tt7:1:2').resumeMs, DURATION);
	console.log(`[watch] resume point after stopping at 10:00: ${resume}s, next: ${again.nextVideo?.id ?? core.playerProgress('tt7:1:2').nextVideo?.id}`);
	assert.equal(resume, 600);
	assert.equal(core.playerProgress('tt7:1:2').nextVideo?.id, 'tt7:1:3');
	assert.equal(core.playerProgress('tt7:1:1').resumeMs, 0, 'another episode starts from the beginning');

	// 3. Watch the rest to the end.
	position = { time: 600, duration: DURATION, paused: false };
	reporter = new WatchReporter(core, () => position, 1 << 30);
	for (let t = 605; t <= 1195; t += 5) { position = { ...position, time: t }; reporter.tick(); }
	reporter.ended();
	await sleep(200);

	// 4. The episode is watched and the series continues with the next one.
	const details = await core.loadMetaDetails('series', 'tt7', 'tt7:1:3', () => {});
	const states = (details.meta.videos ?? []).map((v) => `${v.id.slice(4)}${v.watched ? ' watched' : ''}`).join(', ');
	console.log(`[watch] episodes: ${states}`);
	console.log(`[watch] last video: ${details.lastVideoId}; continue watching: ${JSON.stringify(core.continueWatching().map((i) => i.name))}`);
	assert.equal(details.meta.videos?.find((v) => v.id === 'tt7:1:2')?.watched, true, 'the finished episode is marked watched');
	assert.equal(details.meta.videos?.find((v) => v.id === 'tt7:1:3')?.watched, false);
	assert.equal(details.lastVideoId, 'tt7:1:3', 'the library points at the next episode');
	assert.deepEqual(core.continueWatching().map((i) => i.id), ['tt7']);
	console.log('[watch] PASS');
	process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
