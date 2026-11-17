/**
 * Controller input for the UI: edge-detected button presses from the first
 * gamepad (nx.js exposes the Switch pad with the standard mapping), with
 * auto-repeat for the d-pad while held.
 */
export type Button = 'a' | 'b' | 'x' | 'y' | 'l' | 'r' | 'up' | 'down' | 'left' | 'right' | 'plus' | 'minus';

const INDEX: Record<Button, number> = { b: 0, a: 1, y: 2, x: 3, l: 4, r: 5, minus: 8, plus: 9, up: 12, down: 13, left: 14, right: 15 };
const REPEATING: Button[] = ['up', 'down', 'left', 'right'];
const REPEAT_DELAY_MS = 400;
const REPEAT_EVERY_MS = 110;

export class Input {
	#down = new Set<Button>();
	#pressed = new Set<Button>();
	#heldSince = new Map<Button, number>();
	#lastRepeat = new Map<Button, number>();

	/** Sample the pad once per frame; `pressed()` then reports this frame's presses. */
	poll(now: number): void {
		this.#pressed.clear();
		const pad = navigator.getGamepads()[0];
		for (const name of Object.keys(INDEX) as Button[]) {
			const isDown = !!pad?.buttons[INDEX[name]]?.pressed;
			const wasDown = this.#down.has(name);
			if (isDown && !wasDown) {
				this.#down.add(name);
				this.#pressed.add(name);
				this.#heldSince.set(name, now);
				this.#lastRepeat.set(name, now);
			} else if (!isDown && wasDown) {
				this.#down.delete(name);
			} else if (isDown && REPEATING.includes(name)) {
				const held = now - (this.#heldSince.get(name) ?? now);
				if (held >= REPEAT_DELAY_MS && now - (this.#lastRepeat.get(name) ?? 0) >= REPEAT_EVERY_MS) {
					this.#lastRepeat.set(name, now);
					this.#pressed.add(name);
				}
			}
		}
	}

	pressed(button: Button): boolean {
		return this.#pressed.has(button);
	}

	/**
	 * Adopt the pad's current state without reporting presses: buttons still
	 * held (the A or + that confirmed the keyboard) must be released before
	 * they count, or they would act on the screen behind the keyboard.
	 */
	sync(now: number): void {
		this.#pressed.clear();
		this.#down.clear();
		const pad = navigator.getGamepads()[0];
		for (const name of Object.keys(INDEX) as Button[]) {
			if (!pad?.buttons[INDEX[name]]?.pressed) continue;
			this.#down.add(name);
			this.#heldSince.set(name, now);
			this.#lastRepeat.set(name, now);
		}
	}
}
