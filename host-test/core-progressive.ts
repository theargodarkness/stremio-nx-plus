/**
 * Progressive loading against the real stremio-core on Node with local mock
 * add-ons: a fast and a slow stream add-on, an add-on that never answers, a
 * slow catalog and a search catalog. Checks that details open as soon as the
 * meta item is known, later streams arrive through onUpdate, a silent add-on
 * cannot fail the screen, and the board/search fill in progressively.
 * Run: npm run core-progressive   (no internet needed; the official add-ons just fail)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { installShims, MemoryStore } from '../src/shims';
import { StremioClient, type CatalogRow, type MetaDetails } from '../src/stremio/client';

type Route = { delay: number; body: unknown } | 'hang';

function addon(port: number, manifest: object, routes: Record<string, Route>): Promise<http.Server> {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			const path = decodeURIComponent((req.url ?? '').split('?')[0]);
			res.setHeader('access-control-allow-origin', '*');
			res.setHeader('content-type', 'application/json');
			if (path === '/manifest.json') { res.end(JSON.stringify(manifest)); return; }
			const route = Object.entries(routes).find(([p]) => path.startsWith(p))?.[1];
			if (!route) { res.statusCode = 404; res.end('{}'); return; }
			if (route === 'hang') return; // never answers
			setTimeout(() => res.end(JSON.stringify(route.body)), route.delay);
		});
		server.listen(port, '127.0.0.1', () => resolve(server));
	});
}

const base = { version: '1.0.0', types: ['movie'], idPrefixes: ['tt'] };

async function main() {
	const servers = [
		await addon(7200, { ...base, id: 'mock.meta', name: 'MockMeta', resources: ['catalog', 'meta'], catalogs: [
			{ type: 'movie', id: 'fast', name: 'Fast' }, { type: 'movie', id: 'slow', name: 'Slow' },
			{ type: 'movie', id: 'find', name: 'Find', extra: [{ name: 'search', isRequired: true }], extraSupported: ['search'], extraRequired: ['search'] },
		] }, {
			'/catalog/movie/fast': { delay: 50, body: { metas: [{ id: 'tt1', type: 'movie', name: 'One' }] } },
			'/catalog/movie/slow': { delay: 2500, body: { metas: [{ id: 'tt2', type: 'movie', name: 'Two' }] } },
			'/catalog/movie/find/search=zom': { delay: 300, body: { metas: [{ id: 'tt3', type: 'movie', name: 'Zombie Film' }] } },
			'/meta/movie/tt1': { delay: 50, body: { meta: { id: 'tt1', type: 'movie', name: 'One' } } },
		}),
		await addon(7201, { ...base, id: 'mock.fast', name: 'FastStreams', resources: ['stream'], catalogs: [] }, {
			'/stream/movie/tt1': { delay: 100, body: { streams: [{ name: 'Fast\n1080p', title: 'One.1080p.x264', url: 'http://127.0.0.1:9/a.mkv' }] } },
		}),
		await addon(7202, { ...base, id: 'mock.slow', name: 'SlowStreams', resources: ['stream'], catalogs: [] }, {
			'/stream/movie/tt1': { delay: 2500, body: { streams: [{ name: 'Slow\n4k', title: 'One.2160p.HDR.x265', infoHash: 'ab'.repeat(20) }] } },
		}),
		await addon(7203, { ...base, id: 'mock.hang', name: 'SilentStreams', resources: ['stream'], catalogs: [] }, { '/stream/movie/tt1': 'hang' }),
	];
	try {
		installShims({ appVersion: '0.1.0', shellVersion: 'progressive-check', storage: new MemoryStore() });
		const core = await StremioClient.create();
		for (const port of [7200, 7201, 7202, 7203]) await core.installAddon(`http://127.0.0.1:${port}/manifest.json`);

		// 1. Details open on the meta item; streams follow.
		const updates: { at: number; d: MetaDetails }[] = [];
		const t0 = Date.now();
		const first = await core.loadMetaDetails('movie', 'tt1', 'tt1', (d) => updates.push({ at: Date.now() - t0, d }));
		const openMs = Date.now() - t0;
		console.log(`[details] opened in ${openMs} ms with ${first.streams.length} stream(s), ${first.pendingAddons} add-on(s) pending`);
		assert.equal(first.meta.name, 'One');
		assert.ok(openMs < 2000, `details must not wait for the slow add-on (took ${openMs} ms)`);
		assert.ok((first.pendingAddons ?? 0) >= 2, 'slow and silent add-ons are pending');
		await new Promise((r) => setTimeout(r, 4000));
		const slow = updates.find((u) => u.d.streams.some((s) => s.addonName === 'SlowStreams'));
		console.log(`[details] slow add-on streams arrived after ${slow?.at} ms; updates so far: ${updates.length}`);
		assert.ok(slow, 'the slow add-on result arrived through onUpdate');
		assert.ok(slow.d.streams.some((s) => s.addonName === 'FastStreams'), 'updates carry every stream so far');
		assert.ok((slow.d.pendingAddons ?? 0) >= 1, 'the silent add-on is still pending');

		// 2. A newer details load (another title) stops the old listener.
		const before = updates.length;
		await core.loadMetaDetails('movie', 'tt2', 'tt2', () => {}).catch(() => undefined);
		console.log('[details] switched to another title; waiting for the silent add-on timeout window…');
		await new Promise((r) => setTimeout(r, 1000));
		assert.equal(updates.length, before, 'no updates for a title the user left');

		// 3. The silent add-on cannot fail a details screen: the final update reports it as failed.
		const finals: MetaDetails[] = [];
		const t1 = Date.now();
		await core.loadMetaDetails('movie', 'tt1', 'tt1', (d) => finals.push(d));
		await new Promise((r) => setTimeout(r, 27000));
		const last = finals.at(-1);
		console.log(`[details] after ${Date.now() - t1} ms: pending ${last?.pendingAddons} failed ${last?.failedAddons} streams ${last?.streams.length}`);
		assert.ok(last, 'a final update arrived');
		assert.equal(last.pendingAddons, 0, 'nothing pending after the timeout');
		assert.ok((last.failedAddons ?? 0) >= 1, 'the silent add-on counts as failed');
		assert.equal(last.streams.length, 2, 'fast and slow streams kept');

		// 4. Board: the slow catalog shows as loading first, then fills in.
		const boardUpdates: CatalogRow[][] = [];
		const tb = Date.now();
		const board = await core.loadBoard(20, (rows) => boardUpdates.push(rows));
		const mine = (rows: CatalogRow[]) => rows.filter((r) => r.addonName === 'MockMeta');
		console.log(`[board] ${boardUpdates.length} progressive update(s); final after ${Date.now() - tb} ms: ${mine(board).map((r) => `${r.id}:${r.items.length}`).join(' ')}`);
		assert.ok(boardUpdates.some((rows) => mine(rows).some((r) => r.id === 'fast' && !r.loading) && mine(rows).some((r) => r.id === 'slow' && r.loading)), 'fast row ready while slow row loads');
		assert.deepEqual(mine(board).map((r) => [r.id, r.items.length]), [['fast', 1], ['slow', 1]]);

		// 5. Search: the selected extra matches, results arrive.
		const results = await core.search('zom', 20, () => {});
		console.log(`[search] ${results.map((r) => `${r.addonName}/${r.id}:${r.items.map((i) => i.name).join(',')}`).join(' ')}`);
		assert.ok(results.some((r) => r.items.some((i) => i.name === 'Zombie Film')), 'search results came back');
		console.log('[progressive] PASS');
		process.exit(0);
	} finally {
		for (const s of servers) s.close();
	}
}

main().catch((err) => { console.error(err); process.exit(1); });
