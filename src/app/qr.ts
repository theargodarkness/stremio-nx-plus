/** QR codes for links the user opens on a phone: a matrix of dark modules. */
import qrcode from 'qrcode-generator';

const cache = new Map<string, boolean[][]>();

/** The QR code of `text` (error correction M), one boolean per module, without the quiet zone. */
export function qrMatrix(text: string): boolean[][] {
	const hit = cache.get(text);
	if (hit) return hit;
	const qr = qrcode(0, 'M'); // type 0: the smallest version that fits
	qr.addData(text);
	qr.make();
	const n = qr.getModuleCount();
	const rows = Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => qr.isDark(y, x)));
	if (cache.size > 8) cache.clear();
	cache.set(text, rows);
	return rows;
}
