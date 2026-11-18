/**
 * Stremio account sign-in against the real stremio-core on Node, with the
 * account API answered locally in the shapes the core requests: a wrong
 * password is reported, a right one brings the account's library into
 * Continue Watching, a sync pulls changes, and signing out restores the
 * local profile. Run: npm run core-account
 * (The real API is not contacted; this checks the app's use of the core.)
 */
import assert from 'node:assert/strict';
import { installShims, MemoryStore } from '../src/shims';
import { StremioClient } from '../src/stremio/client';

const now = new Date().toISOString();
const user = { _id: 'u1', email: 'user@example.com', fbId: null, fullname: null, avatar: null, anonymous: false, gdpr_consent: { tos: true, privacy: true, marketing: false, from: 'web' }, taste: null, lang: 'eng', dateRegistered: now, lastModified: now, trakt: null, stremio_addons: null, premium_expire: now };
const item = { _id: 'tt42', name: 'Synced Show', type: 'series', poster: null, posterShape: 'poster', removed: false, temp: false, _ctime: now, _mtime: now, behaviorHints: { defaultVideoId: null, featuredVideoId: null, hasScheduledVideos: false },
	state: { lastWatched: now, timeWatched: 600000, timeOffset: 600000, overallTimeWatched: 600000, timesWatched: 0, flaggedWatched: 0, duration: 1200000, video_id: 'tt42:1:2', watched: null, noNotif: false } };
const requests: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	if (url.hostname !== 'api.strem.io') return new Response('{}', { status: 404 });
	const text = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : '';
	const body = text ? JSON.parse(text) as Record<string, unknown> : {};
	requests.push(url.pathname);
	const results: Record<string, unknown> = {
		'/api/login': body.password === 'right' ? { authKey: 'KEY', user } : undefined,
		'/api/addonCollectionGet': { addons: [], lastModified: now },
		'/api/datastoreGet': [item],
		'/api/datastoreMeta': [['tt42', Date.now()]],
	};
	const result = url.pathname in results ? results[url.pathname] : { success: true };
	return new Response(JSON.stringify(result === undefined ? { error: { message: 'Wrong passphrase', code: 3 } } : { result }), { headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	installShims({ appVersion: '0.1.0', shellVersion: 'account-check', storage: new MemoryStore() });
	const logs: string[] = [];
	const core = await StremioClient.create({ log: (m) => logs.push(m) });
	const localAddons = core.addons().length;
	assert.equal(core.account(), null);
	core.syncAccount();
	assert.deepEqual(requests, [], 'signed out: nothing is sent to the account API');

	await assert.rejects(core.signIn('user@example.com', 'wrong'), /Wrong email or password/);
	assert.equal(core.account(), null);
	console.log('[account] wrong password: rejected with "Wrong email or password."');

	await core.signIn('user@example.com', 'right');
	await sleep(200);
	assert.deepEqual(core.account(), { email: 'user@example.com' });
	const watching = core.continueWatching();
	console.log(`[account] signed in as ${core.account()?.email}; continue watching: ${JSON.stringify(watching.map((w) => [w.name, w.progress]))}; add-ons ${localAddons} -> ${core.addons().length}`);
	assert.deepEqual(watching.map((w) => [w.id, w.progress]), [['tt42', 0.5]], "the account's history, with progress");
	assert.ok(!logs.some((l) => l.includes('right') || l.includes('KEY')), 'neither the password nor the session key reaches the log');

	requests.length = 0;
	core.syncAccount();
	await sleep(300);
	assert.ok(requests.includes('/api/datastoreMeta') && requests.includes('/api/addonCollectionGet'), 'sync asks for library and add-on changes');

	await core.signOut();
	await sleep(200);
	assert.equal(core.account(), null);
	assert.equal(core.addons().length, localAddons, 'the local add-ons return');
	assert.equal(core.continueWatching().length, 0);
	console.log('[account] sync and sign-out: OK');
	console.log('[account] PASS');
	process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
