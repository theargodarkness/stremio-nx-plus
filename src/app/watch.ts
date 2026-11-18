/**
 * Watch progress: tells the core where playback is so it can keep the resume
 * point, watched episodes and Continue Watching. Time is reported every few
 * seconds (each report crosses into the WASM core), pause changes at once,
 * and a final position when playback stops or ends.
 */
export interface WatchSink {
	playerTime(timeMs: number, durationMs: number): void;
	playerPaused(paused: boolean): void;
	playerEnded(): void;
	unloadPlayer(): void;
}

export interface WatchPosition { time: number; duration: number; paused: boolean }

export class WatchReporter {
	#sink: WatchSink;
	#position: () => WatchPosition | null;
	#timer?: ReturnType<typeof setInterval>;
	#paused = false;
	#lastTime = -1;
	#done = false;

	constructor(sink: WatchSink, position: () => WatchPosition | null, intervalMs = 5000) {
		this.#sink = sink;
		this.#position = position;
		this.#guard(() => sink.playerPaused(false));
		this.#timer = setInterval(() => this.tick(), intervalMs);
	}

	/** Report the position if it moved, and a pause or resume since the last tick. */
	tick(): void {
		if (this.#done) return;
		const p = this.#position();
		if (!p) return;
		if (p.paused !== this.#paused) {
			this.#paused = p.paused;
			this.#guard(() => this.#sink.playerPaused(p.paused));
		}
		this.#report(p);
	}

	/** The video played to its end. */
	ended(): void {
		if (this.#done) return;
		const p = this.#position();
		if (p && p.duration > 0) this.#report({ ...p, time: p.duration });
		this.#guard(() => this.#sink.playerEnded());
		this.#finish();
	}

	/** Playback was stopped: store where. */
	stop(): void {
		if (this.#done) return;
		const p = this.#position();
		if (p) this.#report(p);
		this.#finish();
	}

	#report(p: WatchPosition): void {
		if (!(p.duration > 0) || Math.abs(p.time - this.#lastTime) < 0.5) return;
		this.#lastTime = p.time;
		this.#guard(() => this.#sink.playerTime(p.time * 1000, p.duration * 1000));
	}

	#finish(): void {
		this.#done = true;
		clearInterval(this.#timer);
		this.#guard(() => this.#sink.unloadPlayer());
	}

	/** Bookkeeping must never interrupt playback. */
	#guard(fn: () => void): void {
		try { fn(); } catch { /* the core rejected an action: playback goes on */ }
	}
}

/**
 * Where to resume, in seconds, or 0 to start from the beginning: not for the
 * first half minute, and not when the video was all but finished.
 */
export function resumePoint(resumeMs: number, durationSeconds: number): number {
	const at = resumeMs / 1000;
	if (!(at >= 30) || !(durationSeconds > 0)) return 0;
	if (at > durationSeconds * 0.95 || durationSeconds - at < 60) return 0;
	return Math.floor(at);
}
