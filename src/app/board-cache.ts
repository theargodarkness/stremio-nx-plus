/**
 * The home board from the last launch, so its rows show at once while the
 * add-ons are asked again. Only rows the core still lists are filled from
 * the cache (an add-on removed since then leaves nothing behind), and fresh
 * results replace cached ones as they arrive.
 */
import type { KeyValueStore } from '../shims';
import type { CatalogRow, MetaPreview } from '../stremio/client';

const KEY = 'stremio-nx:board-cache';
const MAX_ITEMS = 24;
const MAX_ROWS = 12;

type Cached = { key: string; items: MetaPreview[] }[];

const keyOf = (r: CatalogRow) => `${r.addonId}/${r.type}/${r.id}`;

export function saveBoardCache(storage: KeyValueStore, rows: CatalogRow[]): void {
	const data: Cached = rows.filter((r) => !r.loading && r.items.length > 0).slice(0, MAX_ROWS).map((r) => ({
		key: keyOf(r),
		items: r.items.slice(0, MAX_ITEMS).map(({ id, type, name, poster }) => ({ id, type, name, poster })),
	}));
	try { storage.setItem(KEY, JSON.stringify(data)); } catch { /* storage full: no cache next time */ }
}

export function loadBoardCache(storage: KeyValueStore): Map<string, MetaPreview[]> {
	const out = new Map<string, MetaPreview[]>();
	try {
		const data = JSON.parse(storage.getItem(KEY) ?? '[]') as Cached;
		if (!Array.isArray(data)) return out;
		for (const row of data) {
			if (typeof row?.key !== 'string' || !Array.isArray(row.items)) continue;
			const items = row.items.filter((i) => i && typeof i.id === 'string' && typeof i.type === 'string' && typeof i.name === 'string');
			if (items.length > 0) out.set(row.key, items);
		}
	} catch { /* unreadable cache: start without one */ }
	return out;
}

/** Rows still loading get last launch's items, so they can be browsed meanwhile. */
export function fillFromCache(rows: CatalogRow[], cache: Map<string, MetaPreview[]>): CatalogRow[] {
	if (cache.size === 0) return rows;
	return rows.map((r) => {
		const items = r.loading ? cache.get(keyOf(r)) : undefined;
		return items ? { ...r, items, loading: undefined } : r;
	});
}
