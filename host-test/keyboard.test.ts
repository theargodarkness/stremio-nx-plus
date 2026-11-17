/**
 * The keyboard prompt against a fake that dispatches events exactly like the
 * runtime's virtual-keyboard.ts: show() -> geometrychange; OK -> onHide()
 * (zero rect + geometrychange) THEN submit; cancel -> onHide() only.
 * Also the input resync that swallows the button which closed the keyboard.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promptKeyboard } from '../src/app/keyboard';
import { Input } from '../src/app/input';

class FakeKeyboard extends EventTarget {
	value = '';
	cursorIndex = 0;
	maxLength?: number;
	okButtonText?: string;
	boundingRect = { x: 0, y: 0, width: 0, height: 0 };
	show() {
		this.boundingRect = { x: 0, y: 400, width: 1280, height: 320 };
		this.dispatchEvent(new Event('geometrychange'));
	}
	#hide() {
		this.boundingRect = { x: 0, y: 0, width: 0, height: 0 };
		this.dispatchEvent(new Event('geometrychange'));
	}
	/** The runtime's onSubmit: value, onHide (geometrychange), then submit, all synchronous. */
	submit(text: string) {
		this.value = text;
		this.#hide();
		this.dispatchEvent(new Event('submit'));
	}
	/** The runtime's onChange: new text and caret, then a `change` event. */
	type(text: string, cursor = text.length) {
		this.value = text;
		this.cursorIndex = cursor;
		this.dispatchEvent(new Event('change'));
	}
	/** The runtime's onCancel: onHide only. */
	cancel() {
		this.#hide();
	}
}

test('OK returns the typed text even though the runtime reports the hide first', async () => {
	const kb = new FakeKeyboard();
	const opened: boolean[] = [];
	const result = promptKeyboard(kb, 'Search', '', (open) => opened.push(open));
	assert.deepEqual(opened, [true]);
	assert.equal(kb.okButtonText, 'Search');
	kb.submit('the harbor');
	assert.equal(await result, 'the harbor');
	assert.deepEqual(opened, [true, false]);
});

test('cancel resolves null, once, and the listeners are removed', async () => {
	const kb = new FakeKeyboard();
	const opened: boolean[] = [];
	const result = promptKeyboard(kb, 'Search', 'old', (open) => opened.push(open));
	assert.equal(kb.value, 'old', 'starts with the previous query');
	kb.cancel();
	assert.equal(await result, null);
	assert.deepEqual(opened, [true, false]);
	kb.submit('late'); // a stray event after settling changes nothing
	assert.deepEqual(opened, [true, false]);
});

test('a second prompt after the first works (search, then search again)', async () => {
	const kb = new FakeKeyboard();
	const first = promptKeyboard(kb, 'Search', '', () => {});
	kb.submit('one');
	assert.equal(await first, 'one');
	const second = promptKeyboard(kb, 'Search', 'one', () => {});
	kb.submit('two');
	assert.equal(await second, 'two');
});

test('a keyboard that fails to open resolves null instead of hanging', async () => {
	const kb = new FakeKeyboard();
	kb.show = () => { throw new Error('applet busy'); };
	const logs: string[] = [];
	assert.equal(await promptKeyboard(kb, 'Search', '', () => {}, (m) => logs.push(m)), null);
	assert.match(logs[0], /applet busy/);
});

test('long OK labels are cut to the 8 characters the keyboard allows', async () => {
	const kb = new FakeKeyboard();
	const result = promptKeyboard(kb, 'Install add-on', '', () => {});
	assert.equal(kb.okButtonText, 'Install ');
	kb.cancel();
	await result;
});

test('a button still held when the keyboard closes does not count as a press', () => {
	const held = new Set<number>();
	const g = globalThis as Record<string, unknown>;
	const saved = g.navigator;
	Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { getGamepads: () => [{ buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: held.has(i) })) }] } });
	try {
		const input = new Input();
		input.poll(0);
		held.add(1); // A pressed on the keyboard's OK key, still down when it closes
		input.sync(100);
		input.poll(116);
		assert.equal(input.pressed('a'), false, 'the confirming A is swallowed');
		held.delete(1);
		input.poll(132);
		held.add(1);
		input.poll(148);
		assert.equal(input.pressed('a'), true, 'the next real press counts');
	} finally {
		Object.defineProperty(globalThis, 'navigator', { configurable: true, value: saved });
	}
});

test('typed text, caret moves and the keyboard height reach the UI as they happen', async () => {
	const kb = new FakeKeyboard();
	const seen: [string, number, number][] = [];
	const result = promptKeyboard(kb, 'Search', '', () => {}, () => {}, (text, cursor, height) => seen.push([text, cursor, height]));
	assert.deepEqual(seen[0], ['', 0, 320], 'initial text and keyboard height right after show()');
	kb.type('har');
	kb.type('harb');
	kb.cursorIndex = 2;
	kb.dispatchEvent(new Event('cursormove'));
	assert.deepEqual(seen.slice(1), [['har', 3, 320], ['harb', 4, 320], ['harb', 2, 320]]);
	kb.submit('harbor');
	assert.equal(await result, 'harbor');
	const count = seen.length;
	kb.type('after close');
	assert.equal(seen.length, count, 'no input reports once the prompt has settled');
});
