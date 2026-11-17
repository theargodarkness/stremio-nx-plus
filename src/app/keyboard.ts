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
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			kb.removeEventListener('submit', onSubmit);
			kb.removeEventListener('geometrychange', onGeometry);
			kb.removeEventListener('change', onChange);
			kb.removeEventListener('cursormove', onChange);
			onOpen(false);
			resolve(value);
		};
		const onSubmit = () => finish(kb.value);
		const report = () => onInput?.(kb.value, kb.cursorIndex ?? kb.value.length, kb.boundingRect.height);
		const onChange = () => { if (!settled) report(); };
		const onGeometry = () => {
			// Hidden: a dismissal, unless the `submit` that follows OK arrives in this same dispatch.
			if (kb.boundingRect.height === 0) void Promise.resolve().then(() => finish(null));
		};
		kb.addEventListener('submit', onSubmit);
		kb.addEventListener('change', onChange);
		kb.addEventListener('cursormove', onChange);
		kb.okButtonText = title.slice(0, 8);
		kb.maxLength = 120;
		kb.value = initial;
		onOpen(true);
		try {
			kb.show(); // dispatches its own geometry event synchronously
			log(`keyboard shown: ${JSON.stringify(kb.boundingRect)}`);
			kb.addEventListener('geometrychange', onGeometry); // a zero rect from here on = hidden
			report(); // initial text and the keyboard's height for the layout
		} catch (err) {
			log(`keyboard failed: ${err instanceof Error ? err.message : String(err)}`);
			finish(null);
		}
	});
}
