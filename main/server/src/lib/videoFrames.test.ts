import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatFrameTimestamp,
  hasFramePlaceholder,
  parseFramePlaceholders,
  parseFrameTimestamp,
  replaceFramePlaceholders,
} from './videoFrames.js';

test('parseFrameTimestamp：mm:ss 与 hh:mm:ss 都按秒返回', () => {
  assert.equal(parseFrameTimestamp('02:15'), 135);
  assert.equal(parseFrameTimestamp('0:52'), 52);
  assert.equal(parseFrameTimestamp('1:02:03'), 3723);
  assert.equal(parseFrameTimestamp('bad'), null);
  assert.equal(parseFrameTimestamp('1:99'), 159, '不合法分钟仍按数值解析，交给调用方校验');
});

test('formatFrameTimestamp：补零并对齐小时', () => {
  assert.equal(formatFrameTimestamp(0), '00:00');
  assert.equal(formatFrameTimestamp(135), '02:15');
  assert.equal(formatFrameTimestamp(3723), '1:02:03');
});

test('parseFramePlaceholders：识别 markdown 图片里的 frame:MM:SS', () => {
  const frames = parseFramePlaceholders([
    '# 标题',
    '![8 字线圈](frame:00:52)',
    '![游标示意](frame:02:10 "可选标题")',
    '![普通图](/media/id/a.jpg)',
  ].join('\n'));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].seconds, 52);
  assert.equal(frames[0].alt, '8 字线圈');
  assert.equal(frames[1].seconds, 130);
  assert.equal(hasFramePlaceholder('![x](frame:00:01)'), true);
  assert.equal(hasFramePlaceholder('![x](frame:bad)'), false);
});

test('replaceFramePlaceholders：命中换 URL，未命中删占位，不留下破图', () => {
  const source = '前文\n\n![线圈](frame:00:52)\n\n![芯片](frame:05:05)\n\n后文';
  const result = replaceFramePlaceholders(source, (frame) =>
    frame.seconds === 52 ? '/media/id/frame-00-52.jpg' : null
  );
  assert.equal(result.replaced, 1);
  assert.match(result.markdown, /!\[线圈\]\(\/media\/id\/frame-00-52\.jpg\)/);
  assert.equal(result.markdown.includes('frame:05:05'), false);
  assert.equal(result.markdown.includes('![芯片]'), false);
  assert.match(result.markdown, /前文/);
  assert.match(result.markdown, /后文/);
});

test('replaceFramePlaceholders：同一时间点出现多次按各自位置替换', () => {
  const source = '![A](frame:00:10)\n\n![B](frame:00:10)';
  const result = replaceFramePlaceholders(source, () => '/media/id/a.jpg');
  assert.equal(result.replaced, 2);
  assert.equal((result.markdown.match(/\/media\/id\/a\.jpg/g) || []).length, 2);
});
