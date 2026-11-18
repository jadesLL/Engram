import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMarkdownOutline } from './outline.ts';

test('目录提取：只认 1–4 级 ATX 标题', () => {
  const items = extractMarkdownOutline([
    '# 一级',
    '## 二级',
    '### 三级',
    '#### 四级',
    '##### 五级不进目录',
    '#没有空格不算标题',
    '正文 # 不是标题',
  ].join('\n'));
  assert.deepEqual(items, [
    { level: 1, text: '一级' },
    { level: 2, text: '二级' },
    { level: 3, text: '三级' },
    { level: 4, text: '四级' },
  ]);
});

test('目录提取：跳过围栏代码块里的井号', () => {
  const items = extractMarkdownOutline([
    '# 真标题',
    '```md',
    '## 代码里的假标题',
    '```',
    '~~~',
    '### 另一个假标题',
    '~~~',
    '## 收尾标题',
  ].join('\n'));
  assert.deepEqual(items, [
    { level: 1, text: '真标题' },
    { level: 2, text: '收尾标题' },
  ]);
});

test('目录提取：去掉标题末尾的闭合井号并清理空白', () => {
  assert.deepEqual(extractMarkdownOutline('##  带空格标题   ##'), [
    { level: 2, text: '带空格标题' },
  ]);
});

test('目录提取：最多 40 条，避免超长文档撑爆面板', () => {
  const markdown = Array.from({ length: 60 }, (_, index) => `## 标题 ${index + 1}`).join('\n');
  const items = extractMarkdownOutline(markdown);
  assert.equal(items.length, 40);
  assert.equal(items[0].text, '标题 1');
  assert.equal(items[39].text, '标题 40');
});

test('目录提取：空文档与纯正文返回空数组', () => {
  assert.deepEqual(extractMarkdownOutline(''), []);
  assert.deepEqual(extractMarkdownOutline('只有正文，没有标题。'), []);
});
