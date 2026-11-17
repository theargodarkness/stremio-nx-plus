/**
 * Canvas rendering for the UI model, in Stremio's look: a left rail, rows
 * of 2:3 poster cards with the focused card raised, a details page over the
 * title's backdrop, and the player's on-screen display. Every interactive
 * element is recorded as a hit rectangle so taps can be resolved.
 */
import type { HitTarget, Playback, Section, UiModel, Row } from './ui';
import { SECTIONS as ALL_SECTIONS, SECTION_TITLES, videoLabel } from './ui';

export const W = 1280;
export const H = 720;
const RAIL_W = 88;
const CONTENT_X = 104;
const CONTENT_W = W - CONTENT_X - 16;
const FOOTER_H = 44;
const CARD_W = 150;
const CARD_H = 225;
const CARD_GAP = 14;
const CARDS_PER_ROW = 7;
const ROW_PITCH = 322;
const CHIPS_PITCH = 72;

const COLOR = {
	bg: '#0f0d1f',
	panel: '#1a1730',
	panelHi: '#241f44',
	accent: '#7b5bf5',
	accentDim: '#3b3272',
	text: '#ffffff',
	muted: '#a5a1c2',
	dim: '#6b6789',
	error: '#ff7b7b',
	skeleton: '#211d3b',
};

/** Pill colours for stream badges: resolution, HDR, cache state and warnings stand out. */
function badgeColor(badge: string): string {
	if (/^(4K|\d+p)$/.test(badge)) return '#5b45c9';
	if (badge === 'HDR' || badge === 'DV') return '#a8641a';
	if (badge === 'Cached') return '#1f7a4f';
	if (badge === 'CAM' || badge === 'Not cached') return '#8a2f3c';
	return '#2f2a52';
}

export interface HitRect {
	x: number;
	y: number;
	w: number;
	h: number;
	target: HitTarget;
}

export type ImageKind = 'poster' | 'backdrop' | 'logo';
export interface Drawable {
	canvas: OffscreenCanvas;
	width: number;
	height: number;
}
export type ImageLookup = (url: string | undefined, kind: ImageKind) => Drawable | undefined;

/** The last recorded hit whose rectangle contains the point wins (drawn last = on top). */
export function hitTest(hits: HitRect[], x: number, y: number): HitTarget | undefined {
	for (let i = hits.length - 1; i >= 0; i--) {
		const r = hits[i];
		if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r.target;
	}
	return undefined;
}

export function drawUi(ctx: CanvasRenderingContext2D, ui: UiModel, image: ImageLookup): HitRect[] {
	const hits: HitRect[] = [];
	ctx.fillStyle = COLOR.bg;
	ctx.fillRect(0, 0, W, H);
	if (ui.screen === 'details') drawDetails(ctx, ui, image, hits);
	else drawSection(ctx, ui, image, hits);
	drawFooter(ctx, ui);
	if (ui.keyboard) {
		hits.length = 0; // the keyboard owns input while it is open
		drawKeyboardOverlay(ctx, ui);
	}
	return hits;
}

// ---- section screen ----

function drawSection(ctx: CanvasRenderingContext2D, ui: UiModel, image: ImageLookup, hits: HitRect[]): void {
	drawRail(ctx, ui, hits);
	if (ui.section === 'search') drawSearchBar(ctx, ui, hits);
	else {
		ctx.fillStyle = COLOR.text;
		ctx.font = 'bold 28px sans-serif';
		ctx.fillText(clip(ctx, ui.title(), CONTENT_W), CONTENT_X, 44);
	}
	if (ui.section === 'addons') { drawAddons(ctx, ui, hits); return; }
	if (ui.section === 'settings') { drawSettings(ctx, ui, hits); return; }

	const s = ui.current();
	if (s.rows.length === 0) {
		if (!ui.busy) {
			ctx.fillStyle = COLOR.muted;
			ctx.font = '20px sans-serif';
			const query = ui.section === 'search' ? s.query : undefined;
			ctx.fillText(ui.searching ? 'Searching…' : query ? `No results for “${query}”. Press Y to search again.` : ui.section === 'search' ? 'Search the catalogs of your add-ons: press Y or tap the search bar.' : 'Nothing here.', CONTENT_X, 120);
		}
		return;
	}
	// Keep the focused row on screen: it becomes the second row once past the first.
	let first = Math.max(0, s.row - 1);
	if (s.rows[first]?.kind === 'chips' && first > 0) first = Math.max(0, first - 1);
	let y = 76;
	for (let r = first; r < s.rows.length && y < H - FOOTER_H; r++) {
		const row = s.rows[r];
		const focusedRow = !ui.railFocused && r === s.row;
		if (row.kind === 'chips') {
			drawChips(ctx, row, r, focusedRow ? s.col : -1, y, hits);
			y += CHIPS_PITCH;
		} else {
			drawPosterRow(ctx, row, r, focusedRow ? s.col : -1, y, image, hits);
			y += ROW_PITCH;
		}
	}
}

function drawRail(ctx: CanvasRenderingContext2D, ui: UiModel, hits: HitRect[]): void {
	ctx.fillStyle = COLOR.panel;
	ctx.fillRect(0, 0, RAIL_W, H);
	ALL_SECTIONS.forEach((section: Section, i: number) => {
		const y = 84 + i * 96;
		const active = ui.section === section;
		const focused = ui.railFocused && ui.railIndex === i;
		if (focused || active) {
			ctx.fillStyle = focused ? COLOR.accent : COLOR.panelHi;
			roundRect(ctx, 16, y, 56, 56, 12);
		}
		drawRailIcon(ctx, section, 44, y + 28, focused || active ? COLOR.text : COLOR.dim);
		ctx.fillStyle = focused || active ? COLOR.text : COLOR.dim;
		ctx.font = '12px sans-serif';
		const label = SECTION_TITLES[section];
		ctx.fillText(label, 44 - ctx.measureText(label).width / 2, y + 74);
		hits.push({ x: 0, y: y - 8, w: RAIL_W, h: 92, target: { kind: 'rail', section } });
	});
}

function drawRailIcon(ctx: CanvasRenderingContext2D, section: Section, cx: number, cy: number, color: string): void {
	ctx.strokeStyle = color;
	ctx.fillStyle = color;
	ctx.lineWidth = 2.5;
	ctx.beginPath();
	switch (section) {
		case 'settings':
			ctx.arc(cx, cy, 6, 0, Math.PI * 2);
			for (let k = 0; k < 8; k++) {
				const a = (k * Math.PI) / 4;
				ctx.moveTo(cx + Math.cos(a) * 9, cy + Math.sin(a) * 9);
				ctx.lineTo(cx + Math.cos(a) * 12.5, cy + Math.sin(a) * 12.5);
			}
			ctx.stroke();
			return;
		case 'addons':
			ctx.strokeRect(cx - 11, cy - 11, 22, 22);
			ctx.moveTo(cx - 5, cy); ctx.lineTo(cx + 5, cy);
			ctx.moveTo(cx, cy - 5); ctx.lineTo(cx, cy + 5);
			ctx.stroke();
			return;
		case 'home':
			ctx.moveTo(cx - 12, cy + 2);
			ctx.lineTo(cx, cy - 10);
			ctx.lineTo(cx + 12, cy + 2);
			ctx.moveTo(cx - 8, cy);
			ctx.lineTo(cx - 8, cy + 11);
			ctx.lineTo(cx + 8, cy + 11);
			ctx.lineTo(cx + 8, cy);
			ctx.stroke();
			return;
		case 'discover':
			ctx.arc(cx, cy, 11, 0, Math.PI * 2);
			ctx.stroke();
			ctx.beginPath();
			ctx.moveTo(cx + 5, cy - 5);
			ctx.lineTo(cx + 2, cy + 2);
			ctx.lineTo(cx - 5, cy + 5);
			ctx.lineTo(cx - 2, cy - 2);
			ctx.closePath();
			ctx.fill();
			return;
		case 'library':
			for (let i = -1; i <= 1; i++) ctx.fillRect(cx - 11, cy - 9 + i * 8, 22, 4);
			return;
		case 'search':
			ctx.arc(cx - 3, cy - 3, 8, 0, Math.PI * 2);
			ctx.stroke();
			ctx.beginPath();
			ctx.moveTo(cx + 3, cy + 3);
			ctx.lineTo(cx + 11, cy + 11);
			ctx.stroke();
			return;
	}
}

function drawPosterRow(ctx: CanvasRenderingContext2D, row: Row, rowIndex: number, focusedCol: number, y: number, image: ImageLookup, hits: HitRect[]): void {
	let top = y;
	if (row.title) {
		ctx.fillStyle = COLOR.text;
		ctx.font = 'bold 22px sans-serif';
		const title = clip(ctx, row.title, CONTENT_W - 220);
		ctx.fillText(title, CONTENT_X, y + 22);
		if (row.loading) {
			ctx.fillStyle = COLOR.dim;
			ctx.font = '16px sans-serif';
			ctx.fillText('loading…', CONTENT_X + measure(ctx, title, 'bold 22px sans-serif') + 14, y + 22);
		}
		top = y + 46;
	}
	if (row.loading && row.cards.length === 0) {
		// Placeholder cards keep the layout steady while the add-on answers.
		for (let i = 0; i < CARDS_PER_ROW; i++) {
			const x = CONTENT_X + i * (CARD_W + CARD_GAP);
			ctx.fillStyle = focusedCol >= 0 && i === 0 ? COLOR.panelHi : COLOR.skeleton;
			roundRect(ctx, x, top, CARD_W, CARD_H, 8);
			ctx.fillStyle = COLOR.skeleton;
			ctx.fillRect(x, top + CARD_H + 14, Math.round(CARD_W * (0.5 + ((i * 37) % 40) / 100)), 12);
		}
		return;
	}
	const n = row.cards.length;
	const anchor = focusedCol >= 0 ? focusedCol : 0;
	const first = Math.max(0, Math.min(anchor - 3, n - CARDS_PER_ROW));
	for (let i = first; i < Math.min(n, first + CARDS_PER_ROW); i++) {
		const card = row.cards[i];
		const x = CONTENT_X + (i - first) * (CARD_W + CARD_GAP);
		const focused = i === focusedCol;
		const scale = focused ? 1.08 : 1;
		const w = Math.round(CARD_W * scale);
		const h = Math.round(CARD_H * scale);
		const cx = x - Math.round((w - CARD_W) / 2);
		const cy = top - Math.round((h - CARD_H) / 2);
		if (focused) {
			ctx.fillStyle = COLOR.accent;
			roundRect(ctx, cx - 4, cy - 4, w + 8, h + 8, 10);
		}
		ctx.fillStyle = card.seeAll ? COLOR.panelHi : COLOR.panel;
		roundRect(ctx, cx, cy, w, h, 8);
		const img = card.seeAll ? undefined : image(card.meta.poster, 'poster');
		if (img && img.width > 0 && img.height > 0) {
			drawCover(ctx, img, cx, cy, w, h);
		} else {
			ctx.fillStyle = card.seeAll ? COLOR.text : COLOR.muted;
			ctx.font = card.seeAll ? 'bold 20px sans-serif' : '15px sans-serif';
			const lines = card.seeAll ? ['See all ›'] : wrap(ctx, card.meta.name, w - 20, 4);
			lines.forEach((line, li) => ctx.fillText(line, cx + (w - ctx.measureText(line).width) / 2, cy + h / 2 - (lines.length - 1) * 10 + li * 20));
		}
		if (card.meta.progress !== undefined && !card.seeAll) {
			ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
			ctx.fillRect(cx, cy + h - 8, w, 8);
			ctx.fillStyle = COLOR.accent;
			ctx.fillRect(cx, cy + h - 8, Math.round(w * card.meta.progress), 8);
		}
		ctx.fillStyle = focused ? COLOR.text : COLOR.muted;
		ctx.font = focused ? 'bold 16px sans-serif' : '16px sans-serif';
		ctx.fillText(clip(ctx, card.label, CARD_W), x, top + CARD_H + 26);
		hits.push({ x, y: top, w: CARD_W, h: CARD_H + 30, target: { kind: 'card', row: rowIndex, col: i } });
	}
	if (n > CARDS_PER_ROW) {
		ctx.fillStyle = COLOR.dim;
		ctx.font = '14px sans-serif';
		const pos = `${anchor + 1} / ${n}`;
		ctx.fillText(pos, CONTENT_X + CONTENT_W - ctx.measureText(pos).width, y + 22);
	}
}

function drawChips(ctx: CanvasRenderingContext2D, row: Row, rowIndex: number, focusedCol: number, y: number, hits: HitRect[]): void {
	ctx.font = '18px sans-serif';
	const widths = row.cards.map((c) => Math.round(ctx.measureText(c.label).width) + 32);
	let focusedRight = 0;
	let acc = 0;
	for (let i = 0; i <= Math.max(0, focusedCol); i++) {
		acc += widths[i] + 10;
		if (i === focusedCol) focusedRight = acc;
	}
	const offset = Math.max(0, focusedRight - CONTENT_W);
	let x = CONTENT_X - offset;
	row.cards.forEach((card, i) => {
		const w = widths[i];
		if (x + w > CONTENT_X && x < CONTENT_X + CONTENT_W) {
			const focused = i === focusedCol;
			ctx.fillStyle = focused ? COLOR.accent : COLOR.panel;
			roundRect(ctx, x, y + 12, w, 40, 20);
			ctx.fillStyle = focused ? COLOR.text : COLOR.muted;
			ctx.fillText(card.label, x + 16, y + 39);
			hits.push({ x, y: y + 12, w, h: 40, target: { kind: 'card', row: rowIndex, col: i } });
		}
		x += w + 10;
	});
}

// ---- details screen ----

function drawDetails(ctx: CanvasRenderingContext2D, ui: UiModel, image: ImageLookup, hits: HitRect[]): void {
	const d = ui.details;
	if (!d) return;
	if (d.mode === 'streams') { drawStreamsDetails(ctx, ui, image, hits); return; }
	const backdrop = image(d.meta.background, 'backdrop');
	if (backdrop && backdrop.width > 0) drawCover(ctx, backdrop, 0, 0, W, 400);
	ctx.fillStyle = 'rgba(15, 13, 31, 0.6)';
	ctx.fillRect(0, 0, W, 400);
	ctx.fillStyle = 'rgba(15, 13, 31, 0.85)';
	ctx.fillRect(0, 330, W, 70);

	// Back button.
	ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
	roundRect(ctx, 24, 20, 96, 36, 18);
	ctx.fillStyle = COLOR.text;
	ctx.font = '18px sans-serif';
	ctx.fillText('‹  Back', 44, 45);
	hits.push({ x: 16, y: 12, w: 112, h: 52, target: { kind: 'back' } });

	const logo = image(d.meta.logo, 'logo');
	if (logo && logo.width > 0 && logo.height > 0) {
		ctx.drawImage(logo.canvas, CONTENT_X, 90, logo.width, logo.height);
	} else {
		ctx.fillStyle = COLOR.text;
		ctx.font = 'bold 44px sans-serif';
		wrap(ctx, d.meta.name, 760, 2).forEach((line, i) => ctx.fillText(line, CONTENT_X, 130 + i * 50));
	}
	const imdb = d.meta.links?.find((l) => l.category === 'imdb')?.name;
	const metaLine = [d.meta.releaseInfo, d.meta.runtime, imdb ? `IMDb ${imdb}` : undefined, d.meta.type].filter(Boolean).join('  ·  ');
	ctx.fillStyle = COLOR.muted;
	ctx.font = '18px sans-serif';
	ctx.fillText(clip(ctx, metaLine, 760), CONTENT_X, 262);
	if (d.meta.description) {
		ctx.fillStyle = '#d6d3ea';
		ctx.font = '17px sans-serif';
		wrap(ctx, d.meta.description, 900, 3).forEach((line, i) => ctx.fillText(line, CONTENT_X, 294 + i * 23));
	}

	// The list: episodes or streams.
	const rows = ui.listRows();
	ctx.fillStyle = COLOR.text;
	ctx.font = 'bold 20px sans-serif';
	ctx.fillText(d.mode === 'episodes' ? 'Episodes' : 'Streams', CONTENT_X, 428);
	const ROW_H = 46;
	const top = 444;
	const visible = Math.floor((H - FOOTER_H - top) / ROW_H);
	const first = Math.max(0, Math.min(d.cursor - Math.floor(visible / 2), rows.length - visible));
	if (rows.length === 0 && !ui.busy) {
		ctx.fillStyle = COLOR.muted;
		ctx.font = '18px sans-serif';
		ctx.fillText('No streams from your addons for this title.', CONTENT_X, top + 30);
	}
	for (let i = first; i < Math.min(rows.length, first + visible); i++) {
		const y = top + (i - first) * ROW_H;
		const row = rows[i];
		const focused = i === d.cursor;
		if (focused) {
			ctx.fillStyle = row.enabled ? COLOR.accent : COLOR.accentDim;
			roundRect(ctx, CONTENT_X - 12, y, CONTENT_W + 4, ROW_H - 6, 8);
		}
		const detailW = row.detail ? 300 : 0;
		ctx.fillStyle = row.enabled ? COLOR.text : COLOR.dim;
		ctx.font = '20px sans-serif';
		ctx.fillText(clip(ctx, row.label, CONTENT_W - 40 - detailW), CONTENT_X, y + 28);
		if (row.detail) {
			ctx.fillStyle = focused ? '#e6e0ff' : COLOR.muted;
			ctx.font = '16px sans-serif';
			const text = clip(ctx, row.detail, detailW);
			ctx.fillText(text, CONTENT_X + CONTENT_W - 16 - ctx.measureText(text).width, y + 27);
		}
		hits.push({ x: CONTENT_X - 12, y, w: CONTENT_W + 4, h: ROW_H, target: { kind: 'listRow', index: i } });
	}
}

/**
 * Streams: a compact header (more room for the list), the filter status line
 * with the "show hidden" toggle, and two-line rows: quality pills and the
 * source on top, the release name below.
 */
function drawStreamsDetails(ctx: CanvasRenderingContext2D, ui: UiModel, image: ImageLookup, hits: HitRect[]): void {
	const d = ui.details!;
	const HEADER_H = 262;
	const backdrop = image(d.meta.background, 'backdrop');
	if (backdrop && backdrop.width > 0) drawCover(ctx, backdrop, 0, 0, W, HEADER_H);
	ctx.fillStyle = 'rgba(15, 13, 31, 0.68)';
	ctx.fillRect(0, 0, W, HEADER_H);
	ctx.fillStyle = COLOR.bg;
	ctx.fillRect(0, HEADER_H, W, H - HEADER_H);

	ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
	roundRect(ctx, 24, 20, 96, 36, 18);
	ctx.fillStyle = COLOR.text;
	ctx.font = '18px sans-serif';
	ctx.fillText('‹  Back', 44, 45);
	hits.push({ x: 16, y: 12, w: 112, h: 52, target: { kind: 'back' } });

	const logo = image(d.meta.logo, 'logo');
	if (logo && logo.width > 0 && logo.height > 0) {
		const scale = Math.min(1, 380 / logo.width, 96 / logo.height);
		ctx.drawImage(logo.canvas, CONTENT_X, 70, Math.round(logo.width * scale), Math.round(logo.height * scale));
	} else {
		ctx.fillStyle = COLOR.text;
		ctx.font = 'bold 38px sans-serif';
		ctx.fillText(clip(ctx, d.meta.name, 900), CONTENT_X, 124);
	}
	const video = d.videos.find((v) => v.id === d.videoId);
	const imdb = d.meta.links?.find((l) => l.category === 'imdb')?.name;
	const metaLine = [video ? videoLabel(video) : undefined, d.meta.releaseInfo, d.meta.runtime, imdb ? `IMDb ${imdb}` : undefined].filter(Boolean).join('  ·  ');
	ctx.fillStyle = COLOR.muted;
	ctx.font = '18px sans-serif';
	ctx.fillText(clip(ctx, metaLine, 1000), CONTENT_X, 190);
	if (d.meta.description) {
		ctx.fillStyle = '#d6d3ea';
		ctx.font = '16px sans-serif';
		wrap(ctx, d.meta.description, 1000, 2).forEach((line, i) => ctx.fillText(line, CONTENT_X, 218 + i * 21));
	}

	// Status line: counts, hidden streams, add-ons still answering.
	const view = ui.streamView();
	ctx.fillStyle = COLOR.text;
	ctx.font = 'bold 20px sans-serif';
	ctx.fillText('Streams', CONTENT_X, HEADER_H + 30);
	ctx.fillStyle = COLOR.muted;
	ctx.font = '16px sans-serif';
	ctx.fillText(clip(ctx, ui.streamsHeader(), 760), CONTENT_X + 96, HEADER_H + 29);
	if (view.hidden > 0) {
		const label = d.showAll ? 'X  Hide filtered' : `X  Show ${view.hidden} hidden`;
		ctx.font = 'bold 15px sans-serif';
		const w = Math.round(measure(ctx, label)) + 28;
		const x = CONTENT_X + CONTENT_W - w - 8;
		ctx.fillStyle = d.showAll ? COLOR.accent : COLOR.panelHi;
		roundRect(ctx, x, HEADER_H + 10, w, 28, 14);
		ctx.fillStyle = COLOR.text;
		ctx.fillText(label, x + 14, HEADER_H + 29);
		hits.push({ x: x - 6, y: HEADER_H + 2, w: w + 12, h: 44, target: { kind: 'toggleHidden' } });
	}

	const rows = ui.listRows();
	const ROW_H = 62;
	const top = HEADER_H + 48;
	const visible = Math.floor((H - FOOTER_H - top) / ROW_H);
	const first = Math.max(0, Math.min(d.cursor - Math.floor(visible / 2), rows.length - visible));
	if (rows.length === 0 && !ui.busy) {
		ctx.fillStyle = COLOR.muted;
		ctx.font = '18px sans-serif';
		const empty = d.pendingAddons ? 'Waiting for your add-ons to answer…'
			: view.hidden > 0 ? `All ${view.hidden} streams are hidden by your filters. Press X to show them, or change Settings.`
				: 'No streams from your add-ons for this title.';
		ctx.fillText(clip(ctx, empty, CONTENT_W), CONTENT_X, top + 30);
	}
	for (let i = first; i < Math.min(rows.length, first + visible); i++) {
		const y = top + (i - first) * ROW_H;
		const row = rows[i];
		const focused = i === d.cursor;
		if (focused) {
			ctx.fillStyle = row.enabled ? COLOR.accent : COLOR.accentDim;
			roundRect(ctx, CONTENT_X - 12, y, CONTENT_W + 4, ROW_H - 6, 8);
		}
		ctx.globalAlpha = row.dimmed && !focused ? 0.5 : 1;
		let x = CONTENT_X;
		ctx.font = 'bold 13px sans-serif';
		for (const badge of row.badges ?? []) {
			const w = Math.round(measure(ctx, badge)) + 16;
			if (x + w > CONTENT_X + CONTENT_W - 330) break;
			ctx.fillStyle = badgeColor(badge);
			roundRect(ctx, x, y + 7, w, 21, 10);
			ctx.fillStyle = COLOR.text;
			ctx.fillText(badge, x + 8, y + 22);
			x += w + 6;
		}
		if (row.detail) {
			ctx.fillStyle = row.dimmed ? '#ffb4a8' : focused ? '#e6e0ff' : COLOR.muted;
			ctx.font = '15px sans-serif';
			const text = clip(ctx, row.detail, 320);
			ctx.fillText(text, CONTENT_X + CONTENT_W - 16 - measure(ctx, text), y + 23);
		}
		ctx.fillStyle = row.enabled ? (focused ? COLOR.text : '#dcd8f0') : COLOR.dim;
		ctx.font = '17px sans-serif';
		ctx.fillText(clip(ctx, row.label, CONTENT_W - 24), CONTENT_X, y + 47);
		ctx.globalAlpha = 1;
		hits.push({ x: CONTENT_X - 12, y, w: CONTENT_W + 4, h: ROW_H, target: { kind: 'listRow', index: i } });
	}
}

// ---- search bar and keyboard overlay ----

function drawMagnifier(ctx: CanvasRenderingContext2D, cx: number, cy: number, color: string): void {
	ctx.strokeStyle = color;
	ctx.lineWidth = 2.5;
	ctx.beginPath();
	ctx.arc(cx - 2, cy - 2, 8, 0, Math.PI * 2);
	ctx.moveTo(cx + 4, cy + 4);
	ctx.lineTo(cx + 10, cy + 10);
	ctx.stroke();
}

/**
 * A text field: the text scrolls so the caret stays visible; the caret is a
 * bar at `cursor` (or no caret when `cursor` is undefined).
 */
function drawTextField(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, text: string, placeholder: string, cursor: number | undefined, focused: boolean, icon: boolean): void {
	ctx.fillStyle = focused ? '#2b2550' : COLOR.panel;
	roundRect(ctx, x, y, w, h, h / 2);
	if (focused) {
		ctx.strokeStyle = COLOR.accent;
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.roundRect(x + 1, y + 1, w - 2, h - 2, h / 2 - 1);
		ctx.stroke();
	}
	let left = x + 22;
	if (icon) { drawMagnifier(ctx, x + 30, y + h / 2, focused ? COLOR.text : COLOR.muted); left = x + 56; }
	const right = x + w - 22;
	const baseline = y + h / 2 + 8;
	ctx.font = '22px sans-serif';
	if (!text) {
		ctx.fillStyle = COLOR.dim;
		ctx.fillText(clip(ctx, placeholder, right - left), left, baseline);
		if (cursor !== undefined) { ctx.fillStyle = COLOR.text; ctx.fillRect(left, y + 12, 2, h - 24); }
		return;
	}
	// Scroll: show the end of a long text, keeping the caret in view.
	const max = right - left;
	const caret = cursor ?? text.length;
	let start = 0;
	while (start < caret && ctx.measureText(text.slice(start, caret)).width > max - 12) start++;
	let shown = text.slice(start);
	while (shown.length > 0 && ctx.measureText(shown).width > max) shown = shown.slice(0, -1);
	ctx.fillStyle = COLOR.text;
	ctx.fillText(shown, left, baseline);
	if (cursor !== undefined) {
		const cx = left + ctx.measureText(text.slice(start, caret)).width;
		ctx.fillRect(Math.round(cx) + 1, y + 12, 2, h - 24);
	}
}

/** The search bar at the top of the Search section (tap or Y opens the keyboard). */
function drawSearchBar(ctx: CanvasRenderingContext2D, ui: UiModel, hits: HitRect[]): void {
	const s = ui.current();
	const typing = ui.keyboard?.kind === 'search';
	drawTextField(ctx, CONTENT_X, 14, CONTENT_W, 52, typing ? ui.keyboard!.text : s.query ?? '', 'Search movies and series', typing ? ui.keyboard!.cursor : undefined, typing, true);
	if (!typing) {
		ctx.fillStyle = COLOR.panelHi;
		roundRect(ctx, CONTENT_X + CONTENT_W - 50, 26, 30, 28, 14);
		ctx.fillStyle = COLOR.text;
		ctx.font = 'bold 16px sans-serif';
		ctx.fillText('Y', CONTENT_X + CONTENT_W - 40, 46);
	}
	hits.push({ x: CONTENT_X, y: 10, w: CONTENT_W, h: 60, target: { kind: 'searchBar' } });
}

/**
 * Drawn while a keyboard prompt is open: the inline keyboard covers the
 * bottom of the screen and has no text field, so the field (with caret)
 * goes at the top, over a dimmed screen. Search also lists the matches
 * found so far between the field and the keyboard.
 */
function drawKeyboardOverlay(ctx: CanvasRenderingContext2D, ui: UiModel): void {
	const k = ui.keyboard!;
	const keyboardTop = H - (k.height > 0 ? Math.min(k.height, H - 200) : 380);
	if (k.kind === 'search') {
		// Opaque: a clean list of matches, the field exactly where the search bar sits.
		ctx.fillStyle = COLOR.bg;
		ctx.fillRect(0, 0, W, H);
		const x = CONTENT_X, w = CONTENT_W;
		drawTextField(ctx, x, 14, w, 52, k.text, k.placeholder ?? 'Search', k.cursor, true, true);
		const lineH = 36;
		const top = 84;
		const room = Math.max(0, Math.floor((keyboardTop - top - 14) / lineH));
		const matches = ui.searchMatches(room);
		ctx.font = '17px sans-serif';
		ctx.fillStyle = COLOR.muted;
		const status = k.text.trim().length < 2 ? 'Type at least 2 letters. Results appear as you type; OK shows them all.'
			: ui.searching && matches.length === 0 ? 'Searching…'
				: matches.length === 0 ? (ui.sections.search.query === k.text.trim() ? 'No matches.' : '')
					: '';
		if (status) ctx.fillText(status, x + 22, top + 22);
		matches.forEach((m, i) => {
			const y = top + i * lineH;
			if (i % 2 === 0) { ctx.fillStyle = COLOR.panel; roundRect(ctx, x, y, w, lineH - 4, 8); }
			ctx.fillStyle = COLOR.text;
			ctx.font = '20px sans-serif';
			const name = clip(ctx, m.name, w - 200);
			ctx.fillText(name, x + 22, y + 24);
			ctx.fillStyle = COLOR.muted;
			ctx.font = '16px sans-serif';
			ctx.fillText(m.type === 'series' ? 'Series' : m.type === 'movie' ? 'Movie' : m.type, x + 36 + measure(ctx, name, '20px sans-serif'), y + 24);
		});
		return;
	}
	ctx.fillStyle = COLOR.bg;
	ctx.fillRect(0, 0, W, H);
	const x = CONTENT_X, w = CONTENT_W;
	ctx.fillStyle = COLOR.text;
	ctx.font = 'bold 24px sans-serif';
	ctx.fillText(clip(ctx, k.label, w), x, 52);
	drawTextField(ctx, x, 70, w, 58, k.text, k.placeholder ?? '', k.cursor, true, false);
}

// ---- settings ----

function drawSettings(ctx: CanvasRenderingContext2D, ui: UiModel, hits: HitRect[]): void {
	const rows = ui.settingRows();
	ctx.fillStyle = COLOR.muted;
	ctx.font = '17px sans-serif';
	ctx.fillText('Stream filters apply to every title. On a stream list, X shows what they hide.', CONTENT_X, 78);
	const ROW_H = 46;
	const top = 96;
	const helpTop = H - FOOTER_H - 62;
	const visible = Math.floor((helpTop - 10 - top) / ROW_H);
	const first = Math.max(0, Math.min(ui.settingsCursor - Math.floor(visible / 2), rows.length - visible));
	for (let i = first; i < Math.min(rows.length, first + visible); i++) {
		const row = rows[i];
		const y = top + (i - first) * ROW_H;
		const focused = !ui.railFocused && i === ui.settingsCursor;
		ctx.fillStyle = focused ? COLOR.accent : COLOR.panel;
		roundRect(ctx, CONTENT_X, y, CONTENT_W, ROW_H - 6, 8);
		ctx.fillStyle = COLOR.text;
		ctx.font = '19px sans-serif';
		ctx.fillText(row.label, CONTENT_X + 16, y + 27);
		const right = CONTENT_X + CONTENT_W - 16;
		if (row.kind === 'choice') {
			ctx.font = 'bold 18px sans-serif';
			const value = row.value;
			const vw = measure(ctx, value);
			ctx.fillStyle = focused ? COLOR.text : COLOR.muted;
			ctx.fillText(value, right - 26 - vw, y + 27);
			ctx.fillText('‹', right - 46 - vw, y + 27);
			ctx.fillText('›', right - 10, y + 27);
			hits.push({ x: right - 70 - vw, y, w: 40, h: ROW_H - 6, target: { kind: 'settingStep', index: i, step: -1 } });
			hits.push({ x: right - 30, y, w: 40, h: ROW_H - 6, target: { kind: 'settingStep', index: i, step: 1 } });
			hits.push({ x: CONTENT_X, y, w: CONTENT_W - 92 - vw, h: ROW_H - 6, target: { kind: 'settingRow', index: i } });
		} else {
			ctx.font = row.kind === 'text' ? '18px sans-serif' : 'bold 16px sans-serif';
			const value = row.kind === 'text' ? clip(ctx, row.value, 520) : (ui.resetConfirm ? 'Press A again' : 'A');
			ctx.fillStyle = focused ? COLOR.text : COLOR.muted;
			ctx.fillText(value, right - measure(ctx, value), y + 27);
			hits.push({ x: CONTENT_X, y, w: CONTENT_W, h: ROW_H - 6, target: { kind: 'settingRow', index: i } });
		}
	}
	const help = rows[ui.settingsCursor]?.help ?? '';
	ctx.fillStyle = '#d6d3ea';
	ctx.font = '16px sans-serif';
	wrap(ctx, help, CONTENT_W, 2).forEach((line, i) => ctx.fillText(line, CONTENT_X, helpTop + 20 + i * 22));
}

// ---- player on-screen display ----

export function drawOsd(ctx: CanvasRenderingContext2D, ui: UiModel, playback: Playback | null, hits: HitRect[]): void {
	hits.push({ x: 0, y: 0, w: W, h: H, target: { kind: 'video' } });
	if (!ui.osd.visible) return;
	ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
	ctx.fillRect(0, H - 130, W, 130);
	ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
	roundRect(ctx, 24, 20, 96, 36, 18);
	ctx.fillStyle = COLOR.text;
	ctx.font = '18px sans-serif';
	ctx.fillText('‹  Back', 44, 45);
	hits.push({ x: 16, y: 12, w: 112, h: 52, target: { kind: 'osdBack' } });
	ctx.font = '18px sans-serif';
	ctx.fillText('Audio', W - 246, 45);
	ctx.fillText('Subtitles (Y)', W - 150, 45);
	hits.push({ x: W - 270, y: 12, w: 110, h: 52, target: { kind: 'tracks', tab: 'audio' } });
	hits.push({ x: W - 160, y: 12, w: 152, h: 52, target: { kind: 'tracks', tab: 'subtitles' } });

	ctx.fillStyle = COLOR.text;
	ctx.font = 'bold 22px sans-serif';
	ctx.fillText(clip(ctx, ui.title(), 800), CONTENT_X + 56, H - 92);

	const time = playback?.time ?? 0;
	const duration = playback?.duration ?? 0;
	const target = ui.osd.scrubTarget;
	const shown = target ?? time;
	const timeText = `${fmtTime(shown)}${duration > 0 ? ` / ${fmtTime(duration)}` : ''}`;
	ctx.fillStyle = target !== undefined ? COLOR.accent : COLOR.muted;
	ctx.font = '18px sans-serif';
	ctx.fillText(timeText, CONTENT_X + CONTENT_W - ctx.measureText(timeText).width, H - 92);

	// Play/pause control.
	const bx = CONTENT_X;
	const by = H - 112;
	ctx.fillStyle = COLOR.text;
	if (playback?.paused) {
		ctx.beginPath();
		ctx.moveTo(bx + 6, by + 2);
		ctx.lineTo(bx + 28, by + 14);
		ctx.lineTo(bx + 6, by + 26);
		ctx.closePath();
		ctx.fill();
	} else {
		ctx.fillRect(bx + 6, by + 2, 7, 24);
		ctx.fillRect(bx + 19, by + 2, 7, 24);
	}
	hits.push({ x: bx - 12, y: by - 12, w: 56, h: 52, target: { kind: 'osdPause' } });

	// Progress bar.
	const barX = CONTENT_X;
	const barW = CONTENT_W;
	const barY = H - 60;
	ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
	roundRect(ctx, barX, barY, barW, 8, 4);
	if (duration > 0) {
		ctx.fillStyle = COLOR.accent;
		roundRect(ctx, barX, barY, Math.max(8, Math.round((Math.min(time, duration) / duration) * barW)), 8, 4);
		if (target !== undefined) {
			const tx = barX + Math.round((Math.min(target, duration) / duration) * barW);
			ctx.fillStyle = COLOR.text;
			ctx.fillRect(tx - 2, barY - 8, 4, 24);
			const delta = target - time;
			const label = `${delta >= 0 ? '+' : '−'}${fmtTime(Math.abs(delta))}`;
			ctx.font = 'bold 16px sans-serif';
			ctx.fillText(label, Math.min(W - 80, Math.max(CONTENT_X, tx - ctx.measureText(label).width / 2)), barY - 14);
		}
	}
	// A generous strip around the bar takes seek taps.
	for (let i = 0; i < 40; i++) {
		hits.push({ x: barX + (i * barW) / 40, y: barY - 24, w: barW / 40, h: 56, target: { kind: 'osdSeek', fraction: (i + 0.5) / 40 } });
	}
	if (playback?.buffering) {
		ctx.fillStyle = COLOR.accent;
		ctx.font = 'bold 16px sans-serif';
		ctx.fillText(`Buffering… ${(playback.aheadMiB ?? 0).toFixed(1)} MiB ready`, CONTENT_X + 56, H - 20);
	} else if (playback?.paused) {
		ctx.fillStyle = COLOR.muted;
		ctx.font = '16px sans-serif';
		ctx.fillText('Paused', CONTENT_X + 56, H - 20);
	} else if (playback?.notice) {
		ctx.fillStyle = '#ffcf8a';
		ctx.font = '16px sans-serif';
		ctx.fillText(clip(ctx, playback.notice, CONTENT_W - 56), CONTENT_X + 56, H - 20);
	}
	if (ui.mediaMenu) drawTracks(ctx, ui, hits);
}

function drawAddons(ctx: CanvasRenderingContext2D, ui: UiModel, hits: HitRect[]): void {
	const setup = ui.addonSetup();
	ctx.font = '20px sans-serif';
	ctx.fillStyle = COLOR.muted;
	ctx.fillText('Install directly with Y, or use a phone/computer on the same Wi-Fi:', CONTENT_X, 94);
	ctx.fillStyle = COLOR.text;
	ctx.font = 'bold 24px sans-serif';
	ctx.fillText(setup.url, CONTENT_X, 134);
	ctx.fillText(`Pairing code: ${setup.code}`, CONTENT_X, 171);
	ctx.font = '18px sans-serif';
	ctx.fillStyle = COLOR.muted;
	ctx.fillText('Configure the add-on on its website, then paste its install link into the setup page.', CONTENT_X, 208);
	ctx.fillStyle = COLOR.accent;
	roundRect(ctx, W - 256, 118, 228, 55, 10);
	ctx.fillStyle = COLOR.text;
	ctx.fillText('Y  Install from link', W - 232, 152);
	hits.push({ x: W - 256, y: 118, w: 228, h: 55, target: { kind: 'addonInstall' } });
	const addons = ui.addons(), first = Math.max(0, ui.addonCursor - 4);
	if (!addons.length) ctx.fillText('No installed add-ons.', CONTENT_X, 282);
	for (let i = first; i < Math.min(addons.length, first + 6); i++) {
		const addon = addons[i], y = 242 + (i - first) * 66;
		ctx.fillStyle = !ui.railFocused && i === ui.addonCursor ? COLOR.accentDim : COLOR.panel;
		roundRect(ctx, CONTENT_X, y, CONTENT_W, 58, 8);
		ctx.fillStyle = COLOR.text; ctx.font = '20px sans-serif';
		ctx.fillText(clip(ctx, addon.manifest.name, CONTENT_W - 220), CONTENT_X + 16, y + 25);
		ctx.fillStyle = COLOR.muted; ctx.font = '15px sans-serif';
		ctx.fillText(clip(ctx, `${addon.manifest.version} · ${addon.manifest.id}`, CONTENT_W - 220), CONTENT_X + 16, y + 46);
		ctx.fillText(addon.flags?.protected ? 'Built-in' : ui.addonConfirm === addon.transportUrl ? 'A confirm removal' : 'A remove', W - 196, y + 34);
		hits.push({ x: CONTENT_X, y, w: CONTENT_W, h: 58, target: { kind: 'addonRow', index: i } });
	}
}

function drawTracks(ctx: CanvasRenderingContext2D, ui: UiModel, hits: HitRect[]): void {
	const menu = ui.mediaMenu!;
	ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(0, 0, W, H);
	ctx.fillStyle = COLOR.panel; roundRect(ctx, 180, 76, 920, 568, 16);
	for (const [tab, label, x] of [['audio', 'Audio', 212], ['subtitles', 'Subtitles', 462]] as const) {
		ctx.fillStyle = menu.kind === tab ? COLOR.accent : COLOR.panelHi;
		roundRect(ctx, x, 94, 232, 48, 8);
		ctx.font = 'bold 22px sans-serif'; ctx.fillStyle = COLOR.text; ctx.fillText(label, x + 20, 125);
		hits.push({ x, y: 94, w: 232, h: 48, target: { kind: 'tracks', tab } });
	}
	ctx.font = '18px sans-serif'; ctx.fillText('B  Close', 974, 125);
	hits.push({ x: 946, y: 94, w: 134, h: 48, target: { kind: 'closeTracks' } });
	const rows = ui.trackRows(), first = Math.max(0, menu.cursor - 6);
	if (!rows.length) { ctx.fillStyle = COLOR.muted; ctx.fillText('No audio tracks available.', 212, 196); }
	for (let i = first; i < Math.min(rows.length, first + 8); i++) {
		const row = rows[i], y = 156 + (i - first) * 43;
		ctx.fillStyle = i === menu.cursor ? COLOR.accentDim : COLOR.panel;
		roundRect(ctx, 202, y, 876, 40, 6);
		ctx.fillStyle = row.enabled ? COLOR.text : COLOR.dim; ctx.font = '19px sans-serif';
		ctx.fillText(clip(ctx, `${row.selected ? '✓ ' : ''}${row.label}`, 840), 216, y + 27);
		hits.push({ x: 202, y, w: 876, h: 40, target: { kind: 'trackRow', index: i } });
	}
	if (menu.kind === 'subtitles') {
		ctx.fillStyle = COLOR.text; ctx.font = '19px sans-serif';
		const delay = ui.subtitleDelay();
		ctx.fillText(`Subtitle delay: ${delay >= 0 ? '+' : ''}${delay.toFixed(1)} s`, 260, 548);
		ctx.fillText('−', 222, 548); ctx.fillText('+', 612, 548);
		hits.push({ x: 202, y: 514, w: 52, h: 50, target: { kind: 'subtitleDelay', delta: -.5 } });
		hits.push({ x: 592, y: 514, w: 52, h: 50, target: { kind: 'subtitleDelay', delta: .5 } });
	}
	ctx.fillStyle = COLOR.muted; ctx.font = '17px sans-serif';
	ctx.fillText(clip(ctx, ui.trackBusy ? 'Loading track…' : ui.trackNotice(), 862), 212, 586);
	ctx.fillText('L/R tabs   ↑↓ choose   A select   ◀▶ subtitle delay   B close', 212, 622);
}

export function drawSubtitles(ctx: CanvasRenderingContext2D, text: string, raised: boolean): void {
	if (!text) return;
	ctx.font = '28px sans-serif';
	const lines = text.split('\n').flatMap(line => wrap(ctx, line, W - 160, 4)).slice(0, 4);
	const bottom = raised ? H - 166 : H - 48;
	for (let i = 0; i < lines.length; i++) {
		const width = ctx.measureText(lines[i]).width, y = bottom - (lines.length - 1 - i) * 35;
		ctx.fillStyle = 'rgba(0,0,0,0.78)'; ctx.fillRect((W - width) / 2 - 8, y - 28, width + 16, 35);
		ctx.fillStyle = COLOR.text; ctx.fillText(lines[i], (W - width) / 2, y);
	}
}

// ---- footer + helpers ----

function drawFooter(ctx: CanvasRenderingContext2D, ui: UiModel): void {
	ctx.fillStyle = COLOR.panel;
	ctx.fillRect(RAIL_W, H - FOOTER_H, W - RAIL_W, FOOTER_H);
	ctx.fillStyle = ui.message.startsWith('Failed') ? COLOR.error : COLOR.muted;
	ctx.font = '17px sans-serif';
	ctx.fillText(clip(ctx, ui.message || ui.hint(), CONTENT_W), CONTENT_X, H - 16);
}

function drawCover(ctx: CanvasRenderingContext2D, img: Drawable, x: number, y: number, w: number, h: number): void {
	// Scale to cover the box, cropping the overflow, centered.
	const scale = Math.max(w / img.width, h / img.height);
	const sw = Math.round(w / scale);
	const sh = Math.round(h / scale);
	const sx = Math.round((img.width - sw) / 2);
	const sy = Math.round((img.height - sh) / 2);
	ctx.drawImage(img.canvas, sx, sy, sw, sh, x, y, w, h);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
	const rr = Math.min(r, w / 2, h / 2);
	ctx.beginPath();
	ctx.moveTo(x + rr, y);
	ctx.lineTo(x + w - rr, y);
	ctx.arc(x + w - rr, y + rr, rr, -Math.PI / 2, 0);
	ctx.lineTo(x + w, y + h - rr);
	ctx.arc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2);
	ctx.lineTo(x + rr, y + h);
	ctx.arc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI);
	ctx.lineTo(x, y + rr);
	ctx.arc(x + rr, y + rr, rr, Math.PI, (3 * Math.PI) / 2);
	ctx.closePath();
	ctx.fill();
}

export function fmtTime(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

// Text layout cache. A redraw re-lays out the same strings (titles, descriptions,
// stream names) and each clip is a binary search of measureText calls into
// native code, so results are memoized per font and width. Bounded: cleared
// wholesale when full, which costs one slower frame.
const TEXT_CACHE_MAX = 6000;
const widths = new Map<string, number>();
const layouts = new Map<string, string | string[]>();

/** Cached `measureText(text).width` in the current (or given) font. */
export function measure(ctx: CanvasRenderingContext2D, text: string, font = ctx.font): number {
	const key = `${font}\u0000${text}`;
	let w = widths.get(key);
	if (w === undefined) {
		if (widths.size >= TEXT_CACHE_MAX) widths.clear();
		const previous = ctx.font;
		if (font !== previous) ctx.font = font;
		w = ctx.measureText(text).width;
		if (font !== previous) ctx.font = previous;
		widths.set(key, w);
	}
	return w;
}

function remember<T extends string | string[]>(key: string, compute: () => T): T {
	const hit = layouts.get(key);
	if (hit !== undefined) return hit as T;
	if (layouts.size >= TEXT_CACHE_MAX) layouts.clear();
	const value = compute();
	layouts.set(key, value);
	return value;
}

/** Greedy word wrap into at most `maxLines` lines; the last line is clipped with an ellipsis. */
export function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
	return remember(`w\u0000${ctx.font}\u0000${maxWidth}\u0000${maxLines}\u0000${text}`, () => wrapUncached(ctx, text, maxWidth, maxLines));
}

function wrapUncached(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
	const words = text.replace(/\s+/g, ' ').trim().split(' ');
	const lines: string[] = [];
	let line = '';
	for (const word of words) {
		const candidate = line ? `${line} ${word}` : word;
		if (ctx.measureText(candidate).width <= maxWidth || !line) {
			// (uncached on purpose: candidates are one-off strings that would only churn the width cache)
			line = candidate;
			continue;
		}
		lines.push(line);
		line = word;
		if (lines.length === maxLines) return lines.slice(0, maxLines - 1).concat(clip(ctx, `${lines[maxLines - 1]} ${word}`, maxWidth));
	}
	if (line) lines.push(line);
	return lines.slice(0, maxLines).map((l, i, arr) => (i === arr.length - 1 ? clip(ctx, l, maxWidth) : l));
}

export function clip(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
	return remember(`c\u0000${ctx.font}\u0000${maxWidth}\u0000${text}`, () => clipUncached(ctx, text, maxWidth));
}

function clipUncached(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
	if (ctx.measureText(text).width <= maxWidth) return text;
	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid;
		else hi = mid - 1;
	}
	return `${text.slice(0, lo)}…`;
}
