/**
 * Remembered audio and subtitle languages: what the user picked last is
 * selected again on the next video that has it ("off" for no subtitles).
 */
import type { KeyValueStore } from '../shims';

export interface TrackPrefs { audio?: string; subtitles?: string }
export interface LanguageTrack { id: string; language?: string; selected: boolean; enabled: boolean }

const KEY = 'stremio-nx:track-prefs';

export function loadTrackPrefs(storage: KeyValueStore): TrackPrefs {
	try {
		const v = JSON.parse(storage.getItem(KEY) ?? '{}') as Record<string, unknown>;
		return { audio: typeof v.audio === 'string' ? v.audio : undefined, subtitles: typeof v.subtitles === 'string' ? v.subtitles : undefined };
	} catch { return {}; }
}

export function saveTrackPrefs(storage: KeyValueStore, prefs: TrackPrefs): void {
	try { storage.setItem(KEY, JSON.stringify(prefs)); } catch { /* keep the in-memory value */ }
}

/** "eng", "en", "en-US" and "English" name one language. */
export function sameLanguage(a: string | undefined, b: string | undefined): boolean {
	const norm = (s: string) => s.trim().toLowerCase().split(/[-_]/)[0];
	if (!a || !b) return false;
	const x = norm(a), y = norm(b);
	if (x === y) return true;
	const two = (s: string) => ALIASES[s] ?? s;
	return two(x) === two(y);
}

// ISO 639-2 codes and names whose two-letter code is not their first two letters, plus the common ones.
const ALIASES: Record<string, string> = {
	eng: 'en', english: 'en', spa: 'es', spanish: 'es', fre: 'fr', fra: 'fr', french: 'fr', ger: 'de', deu: 'de', german: 'de',
	ita: 'it', italian: 'it', por: 'pt', portuguese: 'pt', rus: 'ru', russian: 'ru', jpn: 'ja', japanese: 'ja', kor: 'ko', korean: 'ko',
	chi: 'zh', zho: 'zh', chinese: 'zh', ara: 'ar', arabic: 'ar', hin: 'hi', hindi: 'hi', dut: 'nl', nld: 'nl', dutch: 'nl',
	pol: 'pl', polish: 'pl', tur: 'tr', turkish: 'tr', swe: 'sv', swedish: 'sv', dan: 'da', danish: 'da', nor: 'no', nob: 'no',
	fin: 'fi', finnish: 'fi', gre: 'el', ell: 'el', greek: 'el', heb: 'he', hebrew: 'he', cze: 'cs', ces: 'cs', czech: 'cs',
	hun: 'hu', hungarian: 'hu', rum: 'ro', ron: 'ro', romanian: 'ro', ukr: 'uk', ukrainian: 'uk', vie: 'vi', vietnamese: 'vi',
	tha: 'th', thai: 'th', ind: 'id', indonesian: 'id',
};

/** The track to switch to for a remembered language, or undefined when nothing needs to change. */
export function preferredTrack<T extends LanguageTrack>(rows: T[], language: string | undefined): T | undefined {
	if (!language) return undefined;
	if (language === 'off') {
		const off = rows.find((r) => r.id === 'off');
		return off && !off.selected ? off : undefined;
	}
	const matches = rows.filter((r) => r.enabled && sameLanguage(r.language, language));
	if (matches.length === 0 || matches.some((r) => r.selected)) return undefined;
	return matches[0];
}
