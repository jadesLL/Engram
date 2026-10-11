/**
 * 输入法组字判定：Enter 提交类入口共用这一份判定（中文输入法的 Enter 是确认候选词，
 * 不拦就会提交半截拼音）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isComposingKey } from './ime.ts';

test('组字中的 Enter 一律不放行', () => {
  assert.equal(isComposingKey({ isComposing: true }), true);
  assert.equal(isComposingKey({ keyCode: 229 }), true);
  assert.equal(isComposingKey({ isComposing: true, keyCode: 13 }), true);
});

test('正常按键与缺省的浏览器事件对象不算组字', () => {
  assert.equal(isComposingKey({ isComposing: false, keyCode: 13 }), false);
  assert.equal(isComposingKey(undefined), false);
  assert.equal(isComposingKey(null), false);
});
