import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorModelSync } from './editorModelSync.ts';

test('编辑器初始化期间切页：准备完成后只显示最后一页', () => {
  const applied: string[] = [];
  const sync = createEditorModelSync(value => applied.push(value));
  sync.update('a', '旧正文');
  sync.update('b', '中间正文');
  sync.update('c', '最新正文');
  assert.equal(sync.isCurrent(), false);
  assert.deepEqual(applied, []);
  sync.setEnvironment(true, true);
  assert.deepEqual(applied, ['最新正文']);
  assert.equal(sync.isCurrent(), true);
});

test('阅读态切页与外部更新：返回编辑时补最新正文，重复恢复不重渲染', () => {
  const applied: string[] = [];
  const sync = createEditorModelSync(value => applied.push(value));
  sync.update('a', '原正文');
  sync.setEnvironment(true, true);
  sync.setEnvironment(true, false);
  sync.update('b', '新页正文');
  sync.update('b', '提炼后的正文');
  assert.equal(sync.isCurrent(), false);
  assert.deepEqual(applied, ['原正文']);
  sync.setEnvironment(true, true);
  sync.setEnvironment(true, true);
  assert.deepEqual(applied, ['原正文', '提炼后的正文']);
});

test('两页正文相同时仍隔离撤销历史，同一页编辑不清历史', () => {
  const changed: boolean[] = [];
  const sync = createEditorModelSync((_value, pageChanged) => changed.push(pageChanged));
  sync.setEnvironment(true, true);
  sync.update('a', '正文');
  sync.update('a', '正文已修改');
  sync.update('b', '正文已修改');
  assert.deepEqual(changed, [true, false, true]);
});
