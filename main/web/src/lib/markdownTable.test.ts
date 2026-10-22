import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cellStartOffset,
  columnAtChar,
  findTableBlocks,
  insertColumn,
  insertRow,
  parseTableBlock,
  removeColumn,
  removeRow,
  replaceTableBlock,
  rowCellRanges,
  serializeTable,
  splitTableRow,
  tablePrefix,
  tableRowCount,
  visualRowOfLine,
} from './markdownTable.ts';

const SIMPLE = ['| 名称 | 数量 |', '| --- | ---: |', '| 甲 | 3 |', '| 乙 | 4 |'];

test('解析基础表格：表头、对齐方式与数据行', () => {
  const block = parseTableBlock(SIMPLE, 0);
  assert.ok(block);
  assert.equal(block.startLine, 0);
  assert.equal(block.lineCount, 4);
  assert.deepEqual(block.table.header, ['名称', '数量']);
  assert.deepEqual(block.table.aligns, ['none', 'right']);
  assert.deepEqual(block.table.rows, [['甲', '3'], ['乙', '4']]);
  assert.equal(tableRowCount(block.table), 3);
});

test('单元格里的转义竖线与行内代码竖线不算列分隔符', () => {
  assert.deepEqual(splitTableRow('| a \\| b | c |'), ['a \\| b', 'c']);
  assert.deepEqual(splitTableRow('| `x|y` | z |'), ['`x|y`', 'z']);
  assert.deepEqual(splitTableRow('a | b'), ['a', 'b']);
});

test('不是表格的文本不会被误判', () => {
  assert.equal(parseTableBlock(['普通段落', '| --- |'], 0), null);
  assert.equal(parseTableBlock(['| a | b |', '| -- |'], 0), null);
  assert.equal(tablePrefix('普通段落'), null);
  assert.deepEqual(
    findTableBlocks('段首\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n段尾').map((block) => block.startLine),
    [2],
  );
});

test('围栏代码块里的管道表不算表格', () => {
  const markdown = ['```md', '| a | b |', '| --- | --- |', '```', '', '| c | d |', '| --- | --- |'].join('\n');
  const blocks = findTableBlocks(markdown);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].startLine, 5);
});

test('引用块里的表格带上 > 前缀解析与重建', () => {
  const lines = ['> | a | b |', '> | --- | --- |', '> | 1 | 2 |'];
  const block = parseTableBlock(lines, 0);
  assert.ok(block);
  assert.equal(block.table.prefix, '> ');
  assert.deepEqual(block.table.rows, [['1', '2']]);
  assert.deepEqual(serializeTable(block.table), ['> | a | b |', '> | --- | --- |', '> | 1 | 2 |']);
});

test('插入行：表头上方/下方都落到第一条数据行，数据行按位置插入', () => {
  const table = parseTableBlock(SIMPLE, 0)!.table;
  const aboveHeader = insertRow(table, 0, 'before');
  assert.deepEqual(aboveHeader.rows[0], ['', '']);
  assert.deepEqual(aboveHeader.rows[1], ['甲', '3']);
  const belowHeader = insertRow(table, 0, 'after');
  assert.deepEqual(belowHeader.rows[0], ['', '']);
  const belowFirst = insertRow(table, 1, 'after');
  assert.deepEqual(belowFirst.rows, [['甲', '3'], ['', ''], ['乙', '4']]);
  const aboveFirst = insertRow(table, 1, 'before');
  assert.deepEqual(aboveFirst.rows, [['', ''], ['甲', '3'], ['乙', '4']]);
  const belowLast = insertRow(table, 2, 'after');
  assert.deepEqual(belowLast.rows, [['甲', '3'], ['乙', '4'], ['', '']]);
});

test('删除行：表头行删不掉，数据行按位置删', () => {
  const table = parseTableBlock(SIMPLE, 0)!.table;
  assert.equal(removeRow(table, 0), table);
  assert.deepEqual(removeRow(table, 1)!.rows, [['乙', '4']]);
  assert.deepEqual(removeRow(table, 2)!.rows, [['甲', '3']]);
  const headerOnly = parseTableBlock(['| a | b |', '| --- | --- |'], 0)!.table;
  assert.equal(removeRow(headerOnly, 0), null);
});

test('插入列：沿用参照列的对齐方式，每行同步补空单元格', () => {
  const table = parseTableBlock(SIMPLE, 0)!.table;
  const left = insertColumn(table, 1, 'before');
  assert.deepEqual(left.header, ['名称', '', '数量']);
  assert.deepEqual(left.aligns, ['none', 'right', 'right']);
  assert.deepEqual(left.rows, [['甲', '', '3'], ['乙', '', '4']]);
  const rightOfFirst = insertColumn(table, 0, 'after');
  assert.deepEqual(rightOfFirst.header, ['名称', '', '数量']);
  assert.deepEqual(rightOfFirst.aligns, ['none', 'none', 'right']);
  const append = insertColumn(table, 1, 'after');
  assert.deepEqual(append.header, ['名称', '数量', '']);
});

test('删除列：剩最后一列时返回 null（整表删除）', () => {
  const table = parseTableBlock(SIMPLE, 0)!.table;
  const removed = removeColumn(table, 1)!;
  assert.deepEqual(removed.header, ['名称']);
  assert.deepEqual(removed.aligns, ['none']);
  assert.deepEqual(removed.rows, [['甲'], ['乙']]);
  assert.equal(removeColumn(removed, 0), null);
});

test('重建：单元格首尾空白归一，空表头用两个空格占位', () => {
  const table = insertRow(parseTableBlock(SIMPLE, 0)!.table, 1, 'after');
  assert.deepEqual(serializeTable(table), [
    '| 名称 | 数量 |',
    '| --- | ---: |',
    '| 甲 | 3 |',
    '|  |  |',
    '| 乙 | 4 |',
  ]);
});

test('回写全文：替换表格块，删表时不留下重复空行', () => {
  const markdown = ['开头', '', ...SIMPLE, '', '结尾'].join('\n');
  const block = findTableBlocks(markdown)[0];
  const table = insertRow(block.table, 2, 'after');
  const replaced = replaceTableBlock(markdown, block, table);
  assert.equal(
    replaced,
    ['开头', '', ...serializeTable(table), '', '结尾'].join('\n'),
  );
  const removed = replaceTableBlock(markdown, block, null);
  assert.equal(removed, ['开头', '', '结尾'].join('\n'));
});

test('光标定位：列号、视觉行号与目标单元格起点', () => {
  const block = parseTableBlock(SIMPLE, 0)!;
  const row = block.table.rows[0];
  const start = cellStartOffset(block.table, 1, 1);
  const line = serializeTable(block.table)[2];
  assert.equal(columnAtChar(block, line, start), 1);
  assert.equal(columnAtChar(block, line, 0), 0);
  assert.equal(visualRowOfLine(block, 0), 0);
  assert.equal(visualRowOfLine(block, 1), 0);
  assert.equal(visualRowOfLine(block, 3), 2);
  assert.deepEqual(row, ['甲', '3']);
});

test('行内单元格区间：覆盖空格与缺失尾竖线的写法', () => {
  assert.deepEqual(rowCellRanges('| a | b |'), [{ start: 2, end: 3 }, { start: 6, end: 7 }]);
  assert.deepEqual(rowCellRanges('a | b'), [{ start: 0, end: 1 }, { start: 4, end: 5 }]);
  assert.equal(rowCellRanges('没有竖线'), null);
});
