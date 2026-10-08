import test from 'node:test';
import assert from 'node:assert/strict';
import { isHomeActionSubmitKey } from './homeAction.ts';
const enter = { key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
test('single-line Enter submits, multiline Enter stays a newline', () => {
  assert.equal(isHomeActionSubmitKey(enter, true), true);
  assert.equal(isHomeActionSubmitKey(enter, false), false);
  assert.equal(isHomeActionSubmitKey({ ...enter, ctrlKey: true }, false), true);
  assert.equal(isHomeActionSubmitKey({ ...enter, metaKey: true }, false), true);
});
test('IME confirmation and newline modifiers never submit a home card', () => {
  for (const singleLine of [true, false]) {
    for (const extra of [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }, { altKey: true }, { key: 'a' }]) {
      assert.equal(isHomeActionSubmitKey({ ...enter, ctrlKey: true, ...extra }, singleLine), false);
    }
  }
});
