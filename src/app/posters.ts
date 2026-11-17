/**
 * Poster, backdrop and logo images for the UI as small thumbnails. Addon
 * posters can be full-size IMDb images (24 MB decoded each); the runtime
 * decodes at native size, so each image is fetched, decoded, drawn into an
 * offscreen canvas at display size and the full decode is closed at once.
 * Only the thumbnails stay cached (an LRU by count; ~200 KB per poster).
 *
 * Cheaper loads: URLs of image CDNs with size parameters (IMDb, TMDB,
 * metahub) are rewritten to a size close to the thumbnail, so the Switch
 * downloads and decodes a fraction of the bytes. The queue serves the most
 * recently wanted image first (what is on screen now, not rows scrolled
 * past), drops requests nobody has looked at for a while, and retries
 * failures after a pause instead of leaving a blank card for good.
 */
export type ImageKind = 'poster' | 'backdrop' | 'logo';

export interface Thumbnail {
	canvas: OffscreenCanvas;
	width: number;
	height: number;
}

type Entry = { state: 'queued' | 'loading' | 'ready' | 'failed'; thumb?: Thumbnail; wantedAt: number; failedAt?: number };

const MAX_CONCURRENT = 4;
/** Queued requests not drawn for this long are dropped (re-queued if they show up again). */
const STALE_MS = 8000;
const RETRY_FAILED_MS = 30000;
const FETCH_TIMEOUT_MS = 15000;
const SIZE: Record<ImageKind, { w: number; h: number; cover: boolean }> = {
	poster: { w: 180, h: 270, cover: true },
	backdrop: { w: 1280, h: 400, cover: true },
	logo: { w: 420, h: 140, cover: false },
};
const TMDB_SIZE: Record<ImageKind, string> = { poster: 'w342', backdrop: 'w1280', logo: 'w500' };
const IMDB_WIDTH: Record<ImageKind, number> = { poster: 300, backdrop: 1280, logo: 500 };

/** A smaller variant of a known image CDN URL, or the URL unchanged. */
export function sizedImageUrl(url: string, kind: ImageKind): string {
	let u: URL;
	try { u = new URL(url); } catch { return url; }
	const host = u.hostname.toLowerCase();
	if (host === 'image.tmdb.org') {
		// /t/p/<size>/<file>
		const m = /^\/t\/p\/[^/]+\/(.+)$/.exec(u.pathname);
		if (m) { u.pathname = `/t/p/${TMDB_SIZE[kind]}/${m[1]}`; return u.href; }
		return url;
	}
	if (host === 'm.media-amazon.com' || host.endsWith('.media-imdb.com') || host === 'images-na.ssl-images-amazon.com') {
		// <id>._V1_<modifiers>.jpg -> <id>._V1_SX<w>.jpg (IMDb serves any width on request)
		const m = /^(.*\._V1_)[^/]*?(\.(?:jpe?g|png|webp))$/i.exec(u.pathname);
		if (m) { u.pathname = `${m[1]}SX${IMDB_WIDTH[kind]}${m[2]}`; return u.href; }
		return url;
	}
	if (host === 'images.metahub.space') {
		// /<poster|background|logo>/<small|medium|large>/<id>/img: large is several times the thumbnail.
		const m = /^\/(poster|background|logo)\/large\/(.+)$/.exec(u.pathname);
		if (m) { u.pathname = `/${m[1]}/medium/${m[2]}`; return u.href; }
	}
	return url;
}

export class ThumbnailCache {
	#entries = new Map<string, Entry>();
	#queue = new Map<string, { url: string; kind: ImageKind }>();
	#inflight = 0;
	#onChange: () => void;
	#max: number;
	#now: () => number;

	constructor(onChange: () => void, max = 200, now: () => number = () => performance.now()) {
		this.#onChange = onChange;
		this.#max = max;
		this.#now = now;
	}

	get(url: string | undefined, kind: ImageKind): Thumbnail | undefined {
		if (!url) return undefined;
		const key = `${kind}:${url}`;
		const now = this.#now();
		const entry = this.#entries.get(key);
		if (entry) {
			this.#entries.delete(key); // refresh recency
			this.#entries.set(key, entry);
			entry.wantedAt = now;
			if (entry.state === 'ready') return entry.thumb;
			if (entry.state === 'failed' && now - (entry.failedAt ?? 0) >= RETRY_FAILED_MS) {
				entry.state = 'queued';
				this.#queue.set(key, { url, kind });
				this.#pump();
			}
			return undefined;
		}
		this.#entries.set(key, { state: 'queued', wantedAt: now });
		this.#queue.set(key, { url, kind });
		this.#pump();
		this.#evict();
		return undefined;
	}

	/** Requests waiting for a free slot (for tests and diagnostics). */
	get queued(): number {
		return this.#queue.size;
	}

	#pump(): void {
		const now = this.#now();
		while (this.#inflight < MAX_CONCURRENT && this.#queue.size > 0) {
			// Newest wanted first; forget what has scrolled away.
			let bestKey: string | undefined;
			let bestAt = -Infinity;
			for (const key of this.#queue.keys()) {
				const entry = this.#entries.get(key);
				if (!entry || entry.state !== 'queued') { this.#queue.delete(key); continue; }
				if (now - entry.wantedAt > STALE_MS) { this.#queue.delete(key); this.#entries.delete(key); continue; }
				if (entry.wantedAt > bestAt) { bestAt = entry.wantedAt; bestKey = key; }
			}
			if (bestKey === undefined) return;
			const { url, kind } = this.#queue.get(bestKey)!;
			this.#queue.delete(bestKey);
			const key = bestKey;
			this.#entries.get(key)!.state = 'loading';
			this.#inflight++;
			void this.#load(url, kind).then(
				(thumb) => this.#done(key, thumb),
				() => this.#done(key, undefined),
			);
		}
	}

	async #load(url: string, kind: ImageKind): Promise<Thumbnail> {
		// A stalled server must not hold one of the few slots forever.
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		let blob: Blob;
		try {
			const sized = sizedImageUrl(url, kind);
			let res = await fetch(sized, { signal: controller.signal });
			// A CDN that rejects the size variant still has the original.
			if (!res.ok && sized !== url) res = await fetch(url, { signal: controller.signal });
			if (!res.ok) throw new Error(`image ${res.status}`);
			blob = await res.blob();
		} finally {
			clearTimeout(timer);
		}
		const bitmap = await createImageBitmap(blob);
		try {
			const box = SIZE[kind];
			const scale = box.cover ? Math.max(box.w / bitmap.width, box.h / bitmap.height) : Math.min(box.w / bitmap.width, box.h / bitmap.height, 1.5);
			const w = box.cover ? box.w : Math.max(1, Math.round(bitmap.width * scale));
			const h = box.cover ? box.h : Math.max(1, Math.round(bitmap.height * scale));
			const canvas = new OffscreenCanvas(w, h);
			const ctx = canvas.getContext('2d')!;
			if (box.cover) {
				const sw = Math.round(w / scale);
				const sh = Math.round(h / scale);
				ctx.drawImage(bitmap, Math.round((bitmap.width - sw) / 2), Math.round((bitmap.height - sh) / 2), sw, sh, 0, 0, w, h);
			} else {
				ctx.drawImage(bitmap, 0, 0, w, h);
			}
			return { canvas, width: w, height: h };
		} finally {
			bitmap.close(); // the full-size decode goes now, not at the next GC
		}
	}

	#done(key: string, thumb: Thumbnail | undefined): void {
		this.#inflight--;
		const entry = this.#entries.get(key);
		if (entry) {
			entry.state = thumb ? 'ready' : 'failed';
			entry.thumb = thumb;
			if (!thumb) entry.failedAt = this.#now();
		}
		this.#onChange();
		this.#pump();
	}

	#evict(): void {
		while (this.#entries.size > this.#max) {
			const oldest = this.#entries.keys().next().value;
			if (oldest === undefined) break;
			this.#entries.delete(oldest);
			this.#queue.delete(oldest);
		}
	}
}
