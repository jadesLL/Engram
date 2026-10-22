/**
 * Markdown 表格的「结构编辑」：解析管道表、增删行列、重建源码，以及把光标落到目标单元格。
 *
 * 为什么单独抽出来：编辑页是 Vditor 的「即时渲染（ir）」与「源码（sv）」两态，
 * Vditor 自带的表格面板只在被隐藏的 wysiwyg 模式里出现（见 index.js 的 table popover
 * 只往 vditor.wysiwyg.popover 里塞按钮），所以「增删行列」要自己实现：
 *  - ir 模式下表格是真实 DOM 表，增删行列直接改 DOM，再让 Vditor 归一化回 Markdown；
 *  - sv 模式下表格是一段源码文本，只能改文本再回写（setValue）。
 * 两条路径共用的「源码 ↔ 行列」逻辑都在这里，保持纯函数，node --test 可直接跑。
 *
 * 约定：
 *  - 「行号」按视觉行计：0 是表头行，1..n 是数据行（分隔行 |---| 不算一行）；
 *  - 「列号」按单元格计，0 起；
 *  - 单元格内容保留原始内联 Markdown（转义的 \| 原样保留），只去掉首尾空白；
 *  - 整张表被删掉时（最后一列被删、只剩表头时删行）返回 null，怎么收尾交给调用方。
 */

export type TableAlign = 'none' | 'left' | 'center' | 'right';

/** 编辑页表格工具条上的六种动作（行/列各三种） */
export type TableEditAction =
  | 'row-above'
  | 'row-below'
  | 'row-remove'
  | 'col-left'
  | 'col-right'
  | 'col-remove';

export interface MarkdownTable {
  /** 每行第一个竖线之前的前缀（引用块 > 、缩进），重建时原样带回 */
  prefix: string;
  header: string[];
  aligns: TableAlign[];
  /** 数据行（不含表头行） */
  rows: string[][];
}

export interface TableBlock {
  /** 在全文里的起始行号（0 起，含） */
  startLine: number;
  /** 占用的行数：表头行 + 分隔行 + 数据行 */
  lineCount: number;
  table: MarkdownTable;
}

/** 单元格内容在「去掉前缀后的行文本」里的区间（已去掉首尾空白） */
export interface CellRange {
  start: number;
  end: number;
}

const DELIMITER_CELL_RE = /^:?-+:?$/;
const PREFIX_ONLY_RE = /^[\s>]*$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * 行内「未转义、且不在行内代码里」的竖线位置。
 * 表格单元格里允许写 \| 或 `a|b`，它们都不是列分隔符。
 */
function pipeIndexes(text: string): number[] {
  const indexes: number[] = [];
  let ticks = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === '`') {
      let run = 1;
      while (text[index + run] === '`') run++;
      if (ticks === 0) {
        ticks = run;
      } else if (ticks === run) {
        ticks = 0;
      }
      index += run - 1;
      continue;
    }
    if (char === '|' && ticks === 0) indexes.push(index);
  }
  return indexes;
}

/** 表格行（已去掉前缀）里各单元格内容的区间；不是表格行时返回 null */
export function rowCellRanges(text: string): CellRange[] | null {
  const pipes = pipeIndexes(text);
  if (pipes.length === 0) return null;
  const leading = text.slice(0, pipes[0]).trim() === '';
  const lastPipe = pipes[pipes.length - 1];
  const trailing = text.slice(lastPipe + 1).trim() === '';
  const startBound = leading ? pipes[0] + 1 : 0;
  const endBound = trailing ? lastPipe : text.length;
  const separators = pipes.filter((position) => position >= startBound && position < endBound);
  const ranges: CellRange[] = [];
  let start = startBound;
  for (const separator of [...separators, endBound]) {
    let contentStart = start;
    let contentEnd = separator;
    while (contentStart < contentEnd && /\s/.test(text[contentStart])) contentStart++;
    while (contentEnd > contentStart && /\s/.test(text[contentEnd - 1])) contentEnd--;
    ranges.push({ start: contentStart, end: contentEnd });
    start = separator + 1;
  }
  return ranges;
}

/** 拆一行表格单元格（保留单元格内的原始内联 Markdown） */
export function splitTableRow(line: string, prefix = ''): string[] {
  const text = line.startsWith(prefix) ? line.slice(prefix.length) : line;
  const ranges = rowCellRanges(text);
  if (!ranges) return [];
  return ranges.map((range) => text.slice(range.start, range.end));
}

/** 首个竖线之前允许出现的前缀（引用块 > 、缩进）；不是表格行时返回 null */
export function tablePrefix(line: string): string | null {
  const pipes = pipeIndexes(line);
  if (pipes.length === 0) return null;
  const prefix = line.slice(0, pipes[0]);
  return PREFIX_ONLY_RE.test(prefix) ? prefix : null;
}

function parseAlign(cell: string): TableAlign {
  const value = cell.replace(/\s+/g, '');
  const left = value.startsWith(':');
  const right = value.endsWith(':');
  if (left && right) return 'center';
  if (left) return 'left';
  if (right) return 'right';
  return 'none';
}

function renderAlign(align: TableAlign): string {
  switch (align) {
    case 'center':
      return ':---:';
    case 'left':
      return ':---';
    case 'right':
      return '---:';
    default:
      return '---';
  }
}

function isDelimiterRow(cells: string[] | null, columns: number): boolean {
  if (!cells || cells.length !== columns) return false;
  return cells.every((cell) => DELIMITER_CELL_RE.test(cell.replace(/\s+/g, '')));
}

/** 从 start 行开始解析一张表格；不是表格开头时返回 null */
export function parseTableBlock(lines: string[], start: number): TableBlock | null {
  const headerLine = lines[start];
  const delimiterLine = lines[start + 1];
  if (headerLine === undefined || delimiterLine === undefined) return null;
  const prefix = tablePrefix(headerLine);
  if (prefix === null) return null;
  const headerText = headerLine.slice(prefix.length);
  const headerRanges = rowCellRanges(headerText);
  if (!headerRanges || headerRanges.length === 0) return null;
  const header = headerRanges.map((range) => headerText.slice(range.start, range.end));
  const delimiterCells = splitTableRow(delimiterLine, prefix);
  if (!isDelimiterRow(delimiterCells, header.length)) return null;

  const rows: string[][] = [];
  let index = start + 2;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (!line.startsWith(prefix)) break;
    const text = line.slice(prefix.length);
    const ranges = rowCellRanges(text);
    if (!ranges) break;
    rows.push(ranges.map((range) => text.slice(range.start, range.end)));
  }
  return {
    startLine: start,
    lineCount: index - start,
    table: { prefix, header, aligns: delimiterCells.map(parseAlign), rows },
  };
}

/** 全文里的所有管道表（跳过围栏代码块） */
export function findTableBlocks(markdown: string): TableBlock[] {
  const lines = markdown.split('\n');
  const blocks: TableBlock[] = [];
  let fence: string | null = null;
  let index = 0;
  while (index < lines.length) {
    const fenceMatch = FENCE_RE.exec(lines[index]);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      index++;
      continue;
    }
    if (fence) {
      index++;
      continue;
    }
    const block = parseTableBlock(lines, index);
    if (block) {
      blocks.push(block);
      index += block.lineCount;
      continue;
    }
    index++;
  }
  return blocks;
}

export function tableColumnCount(table: MarkdownTable): number {
  return table.header.length;
}

/** 视觉行数：表头算一行，数据行依次累加 */
export function tableRowCount(table: MarkdownTable): number {
  return table.rows.length + 1;
}

function padCells(cells: string[], count: number): string[] {
  const next = cells.slice(0, count);
  while (next.length < count) next.push('');
  return next;
}

function padAligns(aligns: TableAlign[], count: number): TableAlign[] {
  const next = aligns.slice(0, count);
  while (next.length < count) next.push('none');
  return next;
}

function withRows(table: MarkdownTable, rows: string[][]): MarkdownTable {
  return { ...table, rows };
}

/**
 * 插入一行。at 是视觉行号（0 = 表头）：
 *  - 表头行的上方没有「更上面的行」，insertRow(table, 0, 'before') 落到第一条数据行；
 *  - 表头行的下方同样是第一条数据行。
 * 新行单元格留空，列数对齐表头。
 */
export function insertRow(table: MarkdownTable, at: number, side: 'before' | 'after'): MarkdownTable {
  const width = tableColumnCount(table);
  const rows = table.rows.map((row) => padCells(row, width));
  const newRow = Array.from({ length: width }, () => '');
  let index: number;
  if (at <= 0) {
    index = 0;
  } else if (side === 'before') {
    index = Math.min(at - 1, rows.length);
  } else {
    index = Math.min(at, rows.length);
  }
  rows.splice(index, 0, newRow);
  return withRows(table, rows);
}

/**
 * 删除一行。表头行删不掉：只有表头（没有数据行）时删行等于删整张表，返回 null；
 * 否则原样返回，由调用方把按钮置灰。
 */
export function removeRow(table: MarkdownTable, at: number): MarkdownTable | null {
  if (at <= 0) return table.rows.length === 0 ? null : table;
  const width = tableColumnCount(table);
  const rows = table.rows.map((row) => padCells(row, width));
  if (at - 1 >= rows.length) return table;
  rows.splice(at - 1, 1);
  return withRows(table, rows);
}

/** 插入一列；新列沿用参照列的对齐方式，空单元格 */
export function insertColumn(table: MarkdownTable, at: number, side: 'before' | 'after'): MarkdownTable {
  const width = tableColumnCount(table);
  const column = Math.max(0, Math.min(at, width - 1));
  const index = side === 'before' ? column : column + 1;
  const align = padAligns(table.aligns, width)[column] ?? 'none';
  const header = padCells(table.header, width);
  header.splice(index, 0, '');
  const aligns = padAligns(table.aligns, width);
  aligns.splice(index, 0, align);
  const rows = table.rows.map((row) => {
    const cells = padCells(row, width);
    cells.splice(index, 0, '');
    return cells;
  });
  return { ...table, header, aligns, rows };
}

/** 删除一列；只剩最后一列时整张表一起删掉，返回 null */
export function removeColumn(table: MarkdownTable, at: number): MarkdownTable | null {
  const width = tableColumnCount(table);
  if (width <= 1) return null;
  const column = Math.max(0, Math.min(at, width - 1));
  const header = padCells(table.header, width);
  header.splice(column, 1);
  const aligns = padAligns(table.aligns, width);
  aligns.splice(column, 1);
  const rows = table.rows.map((row) => {
    const cells = padCells(row, width);
    cells.splice(column, 1);
    return cells;
  });
  return { ...table, header, aligns, rows };
}

function formatRow(cells: string[], prefix: string): string {
  return `${prefix}| ${cells.map((cell) => cell.trim()).join(' | ')} |`;
}

/** 重建整张表的源码行（前缀、分隔行与对齐方式都会带回） */
export function serializeTable(table: MarkdownTable): string[] {
  const width = tableColumnCount(table);
  const header = padCells(table.header, width);
  const aligns = padAligns(table.aligns, width);
  return [
    formatRow(header, table.prefix),
    formatRow(aligns.map(renderAlign), table.prefix),
    ...table.rows.map((row) => formatRow(padCells(row, width), table.prefix)),
  ];
}

/**
 * 用新表格替换原文里的表格块；table 为 null 时整块删掉。
 * 删表后不留多余空行（原文表格前后各一空行，删掉后会把重复空行并成一个）。
 */
export function replaceTableBlock(markdown: string, block: TableBlock, table: MarkdownTable | null): string {
  const lines = markdown.split('\n');
  lines.splice(block.startLine, block.lineCount, ...(table ? serializeTable(table) : []));
  if (!table) {
    // 表格上下本来各有一个空行，删除后会连成两个：收成一个
    const blankBefore = block.startLine - 1;
    if (blankBefore >= 0 && blankBefore + 1 < lines.length) {
      const isBlank = (value: string) => value.trim() === '';
      if (isBlank(lines[blankBefore]) && isBlank(lines[blankBefore + 1])) {
        lines.splice(blankBefore + 1, 1);
      }
    }
  }
  return lines.join('\n');
}

/** 光标所在行对应的视觉行号：分隔行（第 2 行）按表头处理 */
export function visualRowOfLine(block: TableBlock, lineIndex: number): number {
  return Math.max(0, lineIndex - 1);
}

/**
 * 行内字符位置所在的列号（charOffset 是含前缀的整行偏移）。
 * 落在两个单元格之间（例如光标停在竖线上）时按左侧单元格算。
 */
export function columnIndexAt(line: string, charOffset: number, prefix = ''): number {
  const text = line.startsWith(prefix) ? line.slice(prefix.length) : line;
  const offset = Math.max(0, Math.min(charOffset - prefix.length, text.length));
  const ranges = rowCellRanges(text);
  if (!ranges) return 0;
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index];
    if (offset >= range.start && offset <= range.end) return index;
  }
  return offset <= 0 ? 0 : ranges.length - 1;
}

/** columnIndexAt 的表格版：前缀从表格块里取 */
export function columnAtChar(block: TableBlock, line: string, charOffset: number): number {
  return columnIndexAt(line, charOffset, block.table.prefix);
}

/** 目标单元格内容起点在「去掉前缀的那一行」里的字符偏移，用于回写光标 */
export function cellStartOffset(table: MarkdownTable, row: number, column: number): number {
  const lines = serializeTable(table);
  const lineIndex = row <= 0 ? 0 : Math.min(row + 1, lines.length - 1);
  const line = lines[lineIndex];
  const text = line.startsWith(table.prefix) ? line.slice(table.prefix.length) : line;
  const ranges = rowCellRanges(text);
  if (!ranges || ranges.length === 0) return 0;
  return ranges[Math.max(0, Math.min(column, ranges.length - 1))].start;
}
