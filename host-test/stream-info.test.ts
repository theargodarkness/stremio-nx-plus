/**
 * Stream parsing, filters and sort orders on add-on style labels (invented
 * examples in the formats popular add-ons use: resolution in `name`, release
 * name, size and seeders in `title`, debrid cache markers in brackets).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StreamOption } from '../src/stremio/client';
import { filterStreams, formatSize, hiddenReason, parseKeywords, streamBadges, streamInfo, type StreamFilters } from '../src/stremio/stream-info';
import { DEFAULT_SETTINGS } from '../src/app/settings';

const opt = (stream: StreamOption['stream'], addonName = 'Example'): StreamOption => ({ addonName, addonUrl: `http://${addonName.toLowerCase()}/manifest.json`, stream });
const hash = (c: string) => c.repeat(40);
const OPEN: StreamFilters = { ...DEFAULT_SETTINGS, maxResolution: 0, hideHdr: false, hideDolbyVision: false, hideSoftwareCodecs: false, hideCam: false };

const uhd = opt({ name: 'Example\n4k DV | HDR', title: 'Some.Film.2024.2160p.WEB-DL.DV.HDR.H265-GRP\n👤 120 💾 18.4 GB ⚙️ SiteA', infoHash: hash('a') });
const fhd = opt({ name: 'Example\n1080p', title: 'Some.Film.2024.1080p.BluRay.x264-GRP\n👤 340 💾 9.1 GB ⚙️ SiteB', infoHash: hash('b') });
const hevc = opt({ name: 'Example\n1080p', title: 'Some.Film.2024.1080p.WEB.HEVC.10bit-GRP\n👤 55 💾 2.3 GB', infoHash: hash('c') });
const hd = opt({ name: 'Example\n720p', title: 'Some.Film.2024.720p.WEB.h264-GRP\n👤 12 💾 1.2 GB', infoHash: hash('d') });
const cached = opt({ name: '[RD+] Example\n1080p', title: 'Some.Film.2024.1080p.WEB-DL.DDP5.1.H.264\n💾 6.0 GB', url: 'https://debrid.example/dl/1' });
const uncached = opt({ name: '[RD download] Example\n1080p', title: 'Some.Film.2024.1080p.AMZN.WEB-DL\n💾 5.5 GB', url: 'https://debrid.example/dl/2' });
const av1 = opt({ name: 'Example\n1080p', title: 'Some.Film.2024.1080p.WEB.AV1.Opus\n💾 1.9 GB', infoHash: hash('e') });
const cam = opt({ name: 'Example\n720p', title: 'Some.Film.2024.HDCAM.x264\n👤 900 💾 1.1 GB', infoHash: hash('f') });
const ts = opt({ name: 'Example', title: 'Some.Film.2024.TS.1080p.x264\n💾 2.0 GB', infoHash: hash('9') });
const remux = opt({ name: 'Example\n1080p', title: 'Some.Film.2024.1080p.BluRay.REMUX.AVC.DTS-HD.MA\n💾 31.0 GB', infoHash: hash('8') });
const unknown = opt({ name: 'Mirror', url: 'https://cdn.example/video.mp4' }, 'Direct');
const hinted = opt({ name: 'Hinted', url: 'https://cdn.example/b.mkv', behaviorHints: { filename: 'Film.2160p.UHD.mkv', videoSize: 3 * 1024 ** 3 } }, 'Direct');

test('labels parse into resolution, HDR, codec, size, seeders and cache state', () => {
	const a = streamInfo(uhd.stream);
	assert.equal(a.resolution, 2160);
	assert.equal(a.dolbyVision, true);
	assert.equal(a.hdr, true);
	assert.equal(a.codec, 'hevc');
	assert.equal(a.seeders, 120);
	assert.equal(formatSize(a.sizeBytes!), '18.4 GB');
	assert.equal(a.kind, 'torrent');
	assert.equal(a.text, 'Some.Film.2024.2160p.WEB-DL.DV.HDR.H265-GRP');

	const b = streamInfo(hevc.stream);
	assert.equal(b.resolution, 1080);
	assert.equal(b.codec, 'hevc');
	assert.equal(b.tenBit, true);
	assert.equal(b.hdr, false);

	assert.equal(streamInfo(cached.stream).cached, true);
	assert.equal(streamInfo(uncached.stream).cached, false);
	assert.equal(streamInfo(fhd.stream).cached, undefined);
	assert.equal(streamInfo(av1.stream).codec, 'av1');
	assert.equal(streamInfo(cam.stream).cam, true);
	assert.equal(streamInfo(ts.stream).cam, true);
	assert.equal(streamInfo(fhd.stream).cam, false);
	assert.equal(streamInfo(remux.stream).remux, true);
	assert.equal(streamInfo(unknown.stream).resolution, 0);

	// behaviorHints win: filename resolution and exact byte size.
	const h = streamInfo(hinted.stream);
	assert.equal(h.resolution, 2160);
	assert.equal(h.sizeBytes, 3 * 1024 ** 3);
	assert.equal(h.text, 'Film.2160p.UHD.mkv');
});

test('words inside other words do not count', () => {
	assert.equal(streamInfo({ name: 'x', title: 'The.HDRip.Story.1080p.x264', infoHash: hash('1') }).hdr, false, 'HDRip is not HDR');
	assert.equal(streamInfo({ name: 'x', title: 'Film.DVDRip.XviD', infoHash: hash('2') }).dolbyVision, false, 'DVDRip is not Dolby Vision');
	assert.equal(streamInfo({ name: 'x', title: 'Film.1080p.WEB.x264.mp4.ts', infoHash: hash('3') }).cam, false, 'a .ts extension at the end is not a telesync');
	assert.equal(streamInfo({ name: 'x', title: '4Kids.Show.S01E01.720p', infoHash: hash('4') }).resolution, 720, '4Kids is not 4K');
	assert.equal(streamInfo({ name: 'x', title: 'Film.2023.1080p.HDR10+.HEVC', infoHash: hash('5') }).hdr, true, 'HDR10+ is HDR');
});

test('the list text drops emoji the system font cannot draw', () => {
	const info = streamInfo({ name: '⚡ Example', title: '🎬 Some Film (2024)\n💾 2 GB' , url: 'https://x.example/v.mp4' });
	assert.equal(info.text, 'Some Film (2024)');
	assert.deepEqual(streamBadges(streamInfo(uhd.stream)), ['4K', 'DV', 'HEVC', '18.4 GB', '120 seeds']);
	assert.deepEqual(streamBadges(streamInfo(cached.stream)), ['1080p', 'H.264', '6.0 GB', 'Cached']);
});

test('Switch defaults hide 4K, HDR/DV, AV1, 10-bit H.264 and CAM, keeping unknown resolutions', () => {
	const all = [uhd, fhd, hevc, hd, cached, uncached, av1, cam, ts, remux, unknown, hinted];
	const result = filterStreams(all, DEFAULT_SETTINGS);
	assert.deepEqual(result.rows.map((r) => r.option), [fhd, hevc, hd, cached, uncached, remux, unknown]);
	assert.equal(result.shown, 7);
	assert.equal(result.hidden, 5);
	const reasons = new Map(filterStreams(all, DEFAULT_SETTINGS, true).rows.filter((r) => r.hiddenBy).map((r) => [r.option, r.hiddenBy]));
	assert.equal(reasons.get(uhd), '4K');
	assert.equal(reasons.get(hinted), '4K');
	assert.equal(reasons.get(av1), 'AV1');
	assert.equal(reasons.get(cam), 'CAM/TS');
	assert.equal(reasons.get(ts), 'CAM/TS');
});

test('show-all keeps hidden streams after the shown ones, each with its reason', () => {
	const result = filterStreams([uhd, fhd], DEFAULT_SETTINGS, true);
	assert.deepEqual(result.rows.map((r) => [r.option, r.hiddenBy]), [[fhd, undefined], [uhd, '4K']]);
	assert.equal(result.shown, 1);
	assert.equal(result.hidden, 1);
});

test('each filter has its own reason', () => {
	const info = (o: StreamOption) => streamInfo(o.stream);
	assert.equal(hiddenReason(info(hd), { ...OPEN, maxResolution: 480 }), 'above 480p');
	assert.equal(hiddenReason(info(fhd), { ...OPEN, maxResolution: 720 }), 'above 720p');
	assert.equal(hiddenReason(info(hevc), { ...OPEN, hideHevc: true }), 'HEVC');
	assert.equal(hiddenReason(info(remux), { ...OPEN, hideRemux: true }), 'REMUX');
	assert.equal(hiddenReason(info(fhd), { ...OPEN, maxSizeGB: 8 }), 'over 8 GB');
	assert.equal(hiddenReason(info(unknown), { ...OPEN, maxSizeGB: 2 }), undefined, 'unknown size stays visible');
	assert.equal(hiddenReason(info(fhd), { ...OPEN, sources: 'http' }), 'P2P torrent');
	assert.equal(hiddenReason(info(cached), { ...OPEN, sources: 'torrent' }), 'not a torrent');
	assert.equal(hiddenReason(info(uncached), { ...OPEN, hideUncached: true }), 'not cached');
	assert.equal(hiddenReason(info(cached), { ...OPEN, hideUncached: true }), undefined);
	assert.equal(hiddenReason(info(uhd), { ...OPEN, hideDolbyVision: true }), 'Dolby Vision');
	assert.equal(hiddenReason(streamInfo({ name: 'x', title: 'Film.1080p.HDR10.x265', infoHash: hash('6') }), { ...OPEN, hideHdr: true }), 'HDR');
	assert.equal(hiddenReason(streamInfo({ name: 'x', title: 'Film.1080p.Hi10P.x264', infoHash: hash('7') }), { ...OPEN, hideSoftwareCodecs: true }), '10-bit H.264');
});

test('excluded words match whole tokens, case-insensitively', () => {
	assert.deepEqual(parseKeywords(' 3D, hindi ;HDTS,, 3d '), ['3d', 'hindi', 'hdts']);
	const filters = { ...OPEN, excludeKeywords: '3D, Hindi' };
	const sbs = opt({ name: 'x', title: 'Film.2024.3D.HSBS.1080p', infoHash: hash('a') });
	const max = opt({ name: 'x', title: 'Film.2024.1080p.3DS.Max.Edition', infoHash: hash('b') });
	const dub = opt({ name: 'x', title: 'Film.2024.1080p.HINDI.x264', infoHash: hash('c') });
	const result = filterStreams([sbs, max, dub], filters, true);
	assert.deepEqual(result.rows.map((r) => r.hiddenBy), [undefined, '"3d"', '"hindi"']);
	assert.equal(result.rows[0].option, max);
});

test('sort orders: quality, smallest first, most seeders; add-on order is stable', () => {
	const list = [hd, uncached, fhd, cached, hevc];
	const order = (sort: StreamFilters['sort']) => filterStreams(list, { ...OPEN, sort }).rows.map((r) => r.option);
	assert.deepEqual(order('addon'), list);
	assert.deepEqual(order('quality'), [cached, fhd, hevc, uncached, hd], '1080p first, cached before unknown before uncached, then seeders');
	assert.deepEqual(order('size'), [hd, hevc, uncached, cached, fhd]);
	assert.deepEqual(order('seeders'), [fhd, hevc, hd, cached, uncached]);
});

test('parsing is cached per stream object', () => {
	const stream = { name: 'x\n1080p', infoHash: hash('d') };
	assert.equal(streamInfo(stream), streamInfo(stream));
});
