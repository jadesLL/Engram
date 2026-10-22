import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTrailingEmptyTableRows } from './markdownTableCleanup.ts';

test('删掉表格尾部连续的全空数据行，保留表头、分隔行与正文', () => {
  const markdown = [
    '## 对比表格',
    '',
    '',
    '| 机型 | 速比 | 轮径 |',
    '| --- | --- | --- |',
    '| 同步轮 | 28/60 | 530 |',
    '| 直连 | 1 | 370 |',
    '|  |  |  |',
    '|        |       |      |',
    '',
    '## 参数配置',
  ].join('\n');
  const expected = [
    '## 对比表格',
    '',
    '',
    '| 机型 | 速比 | 轮径 |',
    '| --- | --- | --- |',
    '| 同步轮 | 28/60 | 530 |',
    '| 直连 | 1 | 370 |',
    '',
    '## 参数配置',
  ].join('\n');
  assert.equal(stripTrailingEmptyTableRows(markdown), expected);
  // 幂等：清理过的文档再跑一遍不会再变
  assert.equal(stripTrailingEmptyTableRows(expected), expected);
});

test('表格中间的全空数据行不删，只删尾部连续段', () => {
  const markdown = [
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '|   |   |',
    '| 3 | 4 |',
    '|   |   |',
    '|   |   |',
  ].join('\n');
  const expected = [
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '|   |   |',
    '| 3 | 4 |',
  ].join('\n');
  assert.equal(stripTrailingEmptyTableRows(markdown), expected);
});

test('没有表格的文本原样返回', () => {
  const markdown = [
    '# 标题',
    '',
    '普通段落，含 | 竖线但下一行不是分隔行，不是表格。',
    '',
    '- 列表项',
    '- 第二项',
    '',
  ].join('\n');
  assert.equal(stripTrailingEmptyTableRows(markdown), markdown);
  assert.equal(stripTrailingEmptyTableRows(''), '');
});

test('代码围栏里的表格样式文本不处理（含 4 个反引号的围栏）', () => {
  const fenced = [
    '说明：',
    '',
    '```md',
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '|  |  |',
    '```',
  ].join('\n');
  assert.equal(stripTrailingEmptyTableRows(fenced), fenced);

  // 4 个反引号的围栏里可以再出现 3 个反引号，整段同样跳过
  const nested = ['````md', '```', '| A | B |', '| --- | --- |', '|  |  |', '```', '````'].join('\n');
  assert.equal(stripTrailingEmptyTableRows(nested), nested);
});

test('同一文档多张表格各自清理尾部空行', () => {
  const markdown = [
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '|  |  |',
    '',
    '中间段落',
    '',
    '| C | D |',
    '| --- | --- |',
    '| 3 | 4 |',
    '|  |  |',
    '|  |  |',
    '',
    '结尾',
  ].join('\n');
  const expected = [
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '中间段落',
    '',
    '| C | D |',
    '| --- | --- |',
    '| 3 | 4 |',
    '',
    '结尾',
  ].join('\n');
  assert.equal(stripTrailingEmptyTableRows(markdown), expected);
});

test('CRLF 输入保持 CRLF，并清掉带行尾空白的空行', () => {
  const markdown = [
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '|   |   |   ',
    '|  |  |\t',
  ].join('\r\n');
  const expected = [
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
  ].join('\r\n');
  assert.equal(stripTrailingEmptyTableRows(markdown), expected);
});

test('全角空格（U+3000）单元格按空白处理，含文字的单元格保留', () => {
  const markdown = [
    '| 名称 | 数量 |',
    '| --- | --- |',
    '| 甲 | 3 |',
    '|　乙　| 4 |',
    '|　|　|',
    '| \u3000 |\t|',
  ].join('\n');
  const expected = [
    '| 名称 | 数量 |',
    '| --- | --- |',
    '| 甲 | 3 |',
    '|　乙　| 4 |',
  ].join('\n');
  assert.equal(stripTrailingEmptyTableRows(markdown), expected);
});

test('表格结束后的空行属于段落，不会当成表格数据行删除', () => {
  const markdown = ['| A | B |', '| --- | --- |', '| 1 | 2 |', '', '正文', ''].join('\n');
  assert.equal(stripTrailingEmptyTableRows(markdown), markdown);
});

test('保留列对齐分隔行，表格在文末且没有换行也能清理', () => {
  const markdown = ['| 名称 | 数量 |', '| :--- | ---: |', '| 甲 | 3 |', '|  |  |'].join('\n');
  const expected = ['| 名称 | 数量 |', '| :--- | ---: |', '| 甲 | 3 |'].join('\n');
  assert.equal(stripTrailingEmptyTableRows(markdown), expected);
});

test('只有表头与分隔行的空表格保留结构，不删表头/分隔行', () => {
  const markdown = ['| A | B |', '| --- | --- |', '|  |  |'].join('\n');
  const expected = ['| A | B |', '| --- | --- |'].join('\n');
  assert.equal(stripTrailingEmptyTableRows(markdown), expected);
});

test('列数与分隔行不一致时不当表格处理', () => {
  const markdown = ['A | B', '--- | --- | ---', '|  |  |'].join('\n');
  assert.equal(stripTrailingEmptyTableRows(markdown), markdown);
});

test('转义竖线不算分隔符，含内容的行不删', () => {
  const markdown = ['| A | B |', '| --- | --- |', '| 1 | 2 |', '| \\| | \\| |'].join('\n');
  assert.equal(stripTrailingEmptyTableRows(markdown), markdown);
});

test('表格后紧跟没有竖线的正文时，只清表格自身尾部', () => {
  const markdown = ['| A | B |', '| --- | --- |', '| 1 | 2 |', '|  |  |', '正文段落'].join('\n');
  const expected = ['| A | B |', '| --- | --- |', '| 1 | 2 |', '正文段落'].join('\n');
  assert.equal(stripTrailingEmptyTableRows(markdown), expected);
});

test('真实页面片段：对比表格尾部的全空行被删除，其余原样', () => {
  const markdown = [
    '## 对比表格',
    '',
    '',
    '| 机型   | 速比  | 轮径 | 织网速度 n/s | 峰值扭矩% | 稳定运行 |',
    '| ------ | ----- | ---- | ------------ | --------- | -------- |',
    '| 同步轮 | 28/60 | 530  | 90           | 200       | ✓       |',
    '| 直连   | 1     | 308  | 140          | 210       | ✓       |',
    '| 直连   | 1     | 370  | 140          | 230       | ✓       |',
    '| 直连   | 1     | 370  | 150          | 260       | ✕       |',
    '|        |       |      |              |           |          |',
    '',
    '## 参数配置',
    '',
    '',
    '| 参数号 | 参数名称                 | 设定值 |',
    '| ------ | ------------------------ | ------ |',
    '| P0-07  | 第一惯量比               | 800    |',
  ].join('\n');
  const expected = markdown.replace(
    '|        |       |      |              |           |          |\n',
    '',
  );
  assert.equal(stripTrailingEmptyTableRows(markdown), expected);
});

/* 版式没法用单测跑，按源码锁住「表格只有顶、底两条线」这个结论：容器再画下边框、
   或 Vditor 的 table margin-bottom 没归零，双重线/空白条带就会回来。 */
test('阅读态表格描边只有顶、底两条线（容器不再画下边框，table margin 归零）', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(
    path.resolve(here, '..', 'components', 'ReadingPreview.vue'),
    'utf8',
  );
  const wrapper = source.match(/\.reading-content :deep\(\.reading-table-scroll\) \{([^}]*)\}/);
  assert.ok(wrapper, 'ReadingPreview.vue 里找不到 .reading-table-scroll 样式');
  assert.match(wrapper[1], /border-top: 1px solid var\(--border\)/, '表格容器没有顶边：表格顶部失去收口线');
  assert.doesNotMatch(wrapper[1], /border-bottom/, '表格容器又画了下边框：末行线与容器线会叠成用户报的「双线」');

  const table = source.match(/\.reading-content :deep\(table\) \{([^}]*)\}/);
  assert.ok(table, 'ReadingPreview.vue 里找不到 .reading-content :deep(table) 样式');
  assert.match(table[1], /margin: 0;/, 'Vditor 的 table margin-bottom 没归零：末行线与底边之间会留出空白带');
  assert.match(table[1], /min-width: min\(620px, 100%\)/, '表格最小宽度的原有收敛规则被改掉了');
});
