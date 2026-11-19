import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anchorAtOffset,
  plainTextOfMarkdown,
  splitMarkdownBlocks,
} from './positionAnchor.ts';

const PAGE = [
  '# 项目规划',
  '',
  '## 一、背景',
  '',
  '第一段背景。',
  '',
  '## 二、里程碑',
  '',
  '第一版在周五前发出，先让产品过一遍交互。',
  '',
  '下周一收集反馈，确认是否进入第二阶段。',
  '',
  '## 三、风险与预案',
  '',
  '检索延迟可能上升。',
].join('\n');

test('分块：空行分块，围栏代码块里的空行不算分块', () => {
  const blocks = splitMarkdownBlocks(PAGE);
  assert.deepEqual(
    blocks.map((block) => block.text.trim()),
    [
      '# 项目规划',
      '## 一、背景',
      '第一段背景。',
      '## 二、里程碑',
      '第一版在周五前发出，先让产品过一遍交互。',
      '下周一收集反馈，确认是否进入第二阶段。',
      '## 三、风险与预案',
      '检索延迟可能上升。',
    ],
  );

  const fenced = ['```ts', 'const a = 1;', '', 'const b = 2;', '```'].join('\n');
  const fencedBlocks = splitMarkdownBlocks(fenced);
  assert.equal(fencedBlocks.length, 1, '围栏内的空行不能把代码块切成两块');
  assert.match(fencedBlocks[0].text, /const b = 2/);
});

test('光标落在段落里：锚到该块，标题路径取祖先链，前后文各取相邻块', () => {
  const offset = PAGE.indexOf('下周一收集反馈');
  const anchor = anchorAtOffset(PAGE, offset);
  assert.ok(anchor);
  assert.equal(anchor.anchorText, '下周一收集反馈，确认是否进入第二阶段。');
  assert.equal(anchor.occurrence, 1);
  assert.deepEqual(anchor.headingPath, ['项目规划', '二、里程碑']);
  assert.equal(anchor.before, '第一版在周五前发出，先让产品过一遍交互。');
  assert.equal(anchor.after, '三、风险与预案');
  assert.equal(anchor.placement, 'after');
  assert.equal(anchor.preview, '下周一收集反馈，确认是否进入第二阶段。');
});

test('光标落在空行：归到前一个块（「在这一段之后写」）', () => {
  const blank = PAGE.indexOf('\n\n## 三、风险');
  const anchor = anchorAtOffset(PAGE, blank);
  assert.ok(anchor);
  assert.equal(anchor.anchorText, '下周一收集反馈，确认是否进入第二阶段。');
});

test('重复段落按 occurrence 区分前一次/后一次', () => {
  const markdown = ['# T', '', '同一段。', '', '中间段。', '', '同一段。', '', '结尾。'].join('\n');
  const first = anchorAtOffset(markdown, markdown.indexOf('同一段。'));
  const second = anchorAtOffset(markdown, markdown.lastIndexOf('同一段。'));
  assert.equal(first?.occurrence, 1);
  assert.equal(second?.occurrence, 2);
});

test('文首空行没有前块：取第一个块，before 为空', () => {
  const markdown = ['', '# 标题', '', '正文。'].join('\n');
  const anchor = anchorAtOffset(markdown, 0);
  assert.ok(anchor);
  assert.equal(anchor.anchorText, '# 标题');
  assert.equal(anchor.before, '');
  assert.equal(anchor.after, '正文。');
});

test('CRLF 与纯文本摘录：Windows 换行也能分块，双链/链接/列表记号被抹掉', () => {
  const markdown = ['# T', '', '- [[目标页面|别名]] 与 [链接](https://x)', '', '下一段。'].join('\r\n');
  const anchor = anchorAtOffset(markdown, markdown.indexOf('目标页面'));
  assert.ok(anchor);
  assert.equal(anchor.anchorText, '- [[目标页面|别名]] 与 [链接](https://x)');
  assert.equal(anchor.after, '下一段。');
  assert.equal(anchor.before, 'T');
  assert.equal(plainTextOfMarkdown('**加粗** 和 `代码`'), '加粗 和 代码');
  assert.equal(plainTextOfMarkdown('[[页面|别名]]'), '页面');
});

test('空文档没有锚点', () => {
  assert.equal(anchorAtOffset('', 0), null);
  assert.equal(anchorAtOffset('\n\n\n', 1), null);
});
