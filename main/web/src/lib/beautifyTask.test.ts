import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBeautifySource, sameBeautifySource } from './beautifyTask.ts';

test('只忽略换行风格与首尾空白', () => {
  assert.equal(normalizeBeautifySource('a\r\nb\r\n'), 'a\nb');
  assert.equal(normalizeBeautifySource('  正文  '), '正文');
  assert.equal(sameBeautifySource('a\r\nb\r\n', '  a\nb  '), true);
});

test('正文任何实际变化都判定为「已被改过」', () => {
  assert.equal(sameBeautifySource('# 标题\n\n正文。', '# 标题\n\n正文！'), false);
  assert.equal(sameBeautifySource('# 标题\n\n正文。', '# 标题\n\n正文。\n\n新增一段。'), false);
  assert.equal(sameBeautifySource('# 标题\n\n正文。', '# 新标题\n\n正文。'), false);
});
