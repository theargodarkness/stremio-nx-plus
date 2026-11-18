/**
 * The console's software keyboard as a promise: the typed text on OK, null
 * when dismissed.
 *
 * The runtime reports OK as two synchronous events: it first hides the
 * keyboard (a `geometrychange` with a zero rect) and only then dispatches
 * `submit`. Treating the zero rect as a dismissal right away resolved every
 * OK as "cancelled", so search never ran. A zero rect therefore only counts
 * as a dismissal once the current event dispatch has finished without a
 * `submit` (checked in a microtask).
 */
/**
 * The console's keyboard needs a moment between closing and opening again:
 * shown in the same frame it was confirmed in, it comes up without accepting
 * input. Closing is a handshake with the keyboard applet that only advances
 * while the runtime's per-frame keyboard update runs, so that update must
 * NOT be stopped in between (the runtime leaves it running after OK or
 * cancel; calling hide() there cancelled it and left the next keyboard
 * visible but deaf). Flows that need two entries should open the second
 * keyboard on a button press of its own rather than chaining prompts.
 */
export const keyboardTiming = { reopenGapMs: 700 };
let lastClosedAt = Number.NEGATIVE_INFINITY;

export interface KeyboardLike {
	value: string;
	cursorIndex?: number;
	maxLength?: number;
	okButtonText?: string;
	boundingRect: { height: number };
	show(): void;
	addEventListener(type: string, cb: () => void): void;
	removeEventListener(type: string, cb: () => void): void;
}

/**
 * `onInput` receives the text, caret and keyboard height whenever they change:
 * the inline keyboard draws no text field, so the app has to.
 */
export function promptKeyboard(kb: KeyboardLike, title: string, initial: string, onOpen: (open: boolean) => void, log: (msg: string) => void = () => {},
	onInput?: (text: string, cursor: number, height: number) => void): Promise<string | null> {
	return new Promise((resolve) => {
		let settled = false;
		let events = 0;
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			kb.removeEventListener('submit', onSubmit);
			kb.removeEventListener('geometrychange', onGeometry);
			kb.removeEventListener('change', onChange);
			kb.removeEventListener('cursormove', onChange);
			clearTimeout(opening);
			if (shown) lastClosedAt = Date.now();
			// Never the text: only what happened, to diagnose a keyboard that does not respond.
			if (shown) log(`keyboard closed: ${value === null ? 'dismissed' : 'confirmed'} after ${events} input event${events === 1 ? '' : 's'}`);
			onOpen(false);
			resolve(value);
		};
		const onSubmit = () => finish(kb.value);
		const report = () => onInput?.(kb.value, kb.cursorIndex ?? kb.value.length, kb.boundingRect.height);
		const onChange = () => { if (!settled) { events++; report(); } };
		const onGeometry = () => {
			// Hidden: a dismissal, unless the `submit` that follows OK arrives in this same dispatch.
			if (kb.boundingRect.height === 0) void Promise.resolve().then(() => finish(null));
		};
		let shown = false;
		let opening: ReturnType<typeof setTimeout> | undefined;
		const open = () => {
			if (settled) return;
			try {
				kb.addEventListener('submit', onSubmit);
				kb.addEventListener('change', onChange);
				kb.addEventListener('cursormove', onChange);
				kb.okButtonText = title.slice(0, 8);
				kb.maxLength = 120;
				kb.value = initial;
				shown = true;
				kb.show(); // dispatches its own geometry event synchronously
				log(`keyboard shown: ${JSON.stringify(kb.boundingRect)}`);
				kb.addEventListener('geometrychange', onGeometry); // a zero rect from here on = hidden
				report(); // initial text and the keyboard's height for the layout
			} catch (err) {
				log(`keyboard failed: ${err instanceof Error ? err.message : String(err)}`);
				finish(null);
			}
		};
		// Input belongs to the prompt from now on, also while waiting to reopen.
		onOpen(true);
		const wait = keyboardTiming.reopenGapMs - (Date.now() - lastClosedAt);
		if (wait > 0) opening = setTimeout(open, wait);
		else open();
	});
}
