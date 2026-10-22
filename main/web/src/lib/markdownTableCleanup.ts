/**
 * 阅读态（沉浸阅读）渲染前的 GFM 表格尾部清理。
 *
 * 起因（用户报障）：真实页面的表格末尾多出一行全空单元格（形如
 * `|        |       |      |`，表格工具保存时常见的残留）。Vditor 会把它原样渲染成一行
 * 带内边距的空 `<tr>`，读者看到表格底部多出一条空白条带；再叠加阅读态的表格描边，就成了
 * 「末行线下面隔一截又一条线」的表格底部「双线」。空行不承载任何信息，渲染前删掉即可。
 *
 * 只做这一件事，边界写清楚：
 * - 只认 GFM 表格：表头行 + 与表头列数一致的 `---` / `:---:` 分隔行。单独一行带竖线的
 *   正文（没有分隔行）不碰，避免把普通段落当表格。
 * - 只删「表格末尾连续」的全空数据行：表格中间的全空数据行保留（可能是有意排版），
 *   表格结束后的空行属于 Markdown 段落、不属于表格，也不碰。
 * - 代码围栏（``` / ~~~，含 4 个以上反引号的围栏）整体跳过，防止把示例里的
 *   「| | |」误删。
 * - 逐行扫描、保留原文件的换行风格（LF / CRLF）与行尾空白，不重排、不格式化其余内容。
 * - 单元格空白判定用 `String#trim`：半角空格、制表符、全角空格（U+3000）都算空。全角空格
 *   在 Vditor 里显示为一个不可见空格，视觉上与空单元格相同，所以也按空处理。
 */

type Fence = {
  char: '`' | '~';
  length: number;
};

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
/** 分隔行单元格：`---`、`:---`、`---:`、`:---:`（GFM 的列对齐写法） */
const DELIMITER_CELL_RE = /^:?-+:?$/;

/** `text[index - 1]` 起的连续反斜杠是否为奇数个（奇数表示该字符被转义） */
function isEscapedAt(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/**
 * 拆一行表格：返回单元格文本与「是否含未转义竖线」；空行返回 null。
 * 首尾管道按 GFM 允许省略，`\|` 是单元格内的转义竖线、不参与拆分。
 */
function splitRow(line: string): { cells: string[]; hasPipe: boolean } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const startsWithPipe = trimmed.startsWith('|');
  const endsWithPipe = trimmed.endsWith('|') && !isEscapedAt(trimmed, trimmed.length - 1);
  let body = trimmed;
  if (startsWithPipe) body = body.slice(1);
  if (endsWithPipe) body = body.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  let hasPipe = startsWithPipe || endsWithPipe;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '\\' && index + 1 < body.length) {
      current += char + body[index + 1];
      index += 1;
      continue;
    }
    if (char === '|') {
      cells.push(current);
      current = '';
      hasPipe = true;
      continue;
    }
    current += char;
  }
  cells.push(current);
  return { cells, hasPipe };
}

/** 表头行（或任意数据行）的列数；没有未转义竖线的行不是表格行，返回 0 */
function tableColumns(line: string): number {
  const row = splitRow(line);
  return row && row.hasPipe ? row.cells.length : 0;
}

/** 分隔行：每个单元格都是 `---` / `:---:` 这类对齐写法，且列数与表头一致 */
function isDelimiterRow(line: string, columns: number): boolean {
  const row = splitRow(line);
  if (!row || !row.hasPipe || row.cells.length !== columns) return false;
  return row.cells.every((cell) => DELIMITER_CELL_RE.test(cell.trim()));
}

/** 表格数据行：非空、含未转义竖线（表格遇到空行或没有竖线的行就结束了） */
function isTableRow(line: string): boolean {
  const row = splitRow(line);
  return Boolean(row && row.hasPipe);
}

/** 全空数据行：含未转义竖线，且每个单元格 trim 后都是空 */
function isBlankTableRow(line: string): boolean {
  const row = splitRow(line);
  return Boolean(row && row.hasPipe && row.cells.every((cell) => cell.trim() === ''));
}

/** 代码围栏起始行；反引号围栏的 info string 里再出现反引号则不算围栏（CommonMark 规则） */
function fenceOpen(line: string): Fence | null {
  const match = FENCE_OPEN_RE.exec(line);
  if (!match) return null;
  const marker = match[1];
  if (marker[0] === '`' && match[2].includes('`')) return null;
  return { char: marker[0] as Fence['char'], length: marker.length };
}

/** 代码围栏结束行：同一种字符、长度不短于起始围栏，且后面只有空白 */
function fenceClose(line: string, fence: Fence): boolean {
  const match = FENCE_CLOSE_RE.exec(line);
  if (!match) return false;
  return match[1][0] === fence.char && match[1].length >= fence.length;
}

/**
 * 删除 Markdown 里每个 GFM 表格末尾连续的全空数据行。
 *
 * 只有真的删了行才返回新字符串；没有可删内容时原样返回入参（调用方可以按引用判断是否变化）。
 * 保留表头行与分隔行；表格中间的全空数据行、代码围栏内容、表格外的内容一律不动。
 */
export function stripTrailingEmptyTableRows(markdown: string): string {
  // 没有竖线就不可能有表格，直接短路（阅读正文动辄十几万字）
  if (!markdown.includes('|')) return markdown;

  // 按「行 + 行尾」切开，删行时连行尾一起丢，拼回去就还是原来的换行风格
  const segments = markdown.split(/(\r\n|\n|\r)/);
  const lines: (string | null)[] = [];
  const endings: string[] = [];
  for (let index = 0; index < segments.length; index += 2) {
    lines.push(segments[index]);
    endings.push(index + 1 < segments.length ? segments[index + 1] : '');
  }

  let fence: Fence | null = null;
  let changed = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    if (fence) {
      if (fenceClose(line, fence)) fence = null;
      index += 1;
      continue;
    }
    const opened = fenceOpen(line);
    if (opened) {
      fence = opened;
      index += 1;
      continue;
    }
    const columns = tableColumns(line);
    const delimiter = index + 1 < lines.length ? (lines[index + 1] as string) : null;
    if (columns > 0 && delimiter !== null && isDelimiterRow(delimiter, columns)) {
      // 收集整张表格的数据行（遇到空行或没有竖线的行即表格结束），再从下往上删全空行
      let end = index + 2;
      while (end < lines.length && isTableRow(lines[end] as string)) end += 1;
      for (let cursor = end - 1; cursor >= index + 2; cursor -= 1) {
        if (!isBlankTableRow(lines[cursor] as string)) break;
        lines[cursor] = null;
        changed = true;
      }
      index = end;
      continue;
    }
    index += 1;
  }

  if (!changed) return markdown;

  let cleaned = '';
  for (let cursor = 0; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line === null) continue;
    cleaned += line + endings[cursor];
  }
  // 删的是文件末尾的行时，上一行原本「行中」的换行会变成文件末尾换行。原文件本来没有
  // 末尾换行就不凭空添一个：把行尾风格（含末尾是否有换行）原样保留。
  if (!/(?:\r\n|\n|\r)$/.test(markdown)) cleaned = cleaned.replace(/(?:\r\n|\n|\r)$/, '');
  return cleaned;
}
