/**
 * 内置 Agent 对话用的 Markdown 渲染器（同步、零依赖）。
 *
 * 排版目标与 Wiki 阅读页对齐：标题、有序/无序列表（含嵌套与任务项）、表格、引用、
 * 分隔线、链接、双链、行内样式与代码块都要正常成块显示。刻意不复用阅读页那套
 * `Vditor.preview`：对话正文是流式逐帧重渲染的，异步 + DOM 注入的预览器在这里既慢又难管。
 *
 * 安全：原文 HTML 一律转义（不解析内联 HTML），链接走协议白名单，图片只放行站内路径。
 * 与标准 Markdown 的差异：段落内单个换行保留为 `<br>`（对话里逐行写法很常见，
 * 按标准合并成一行会把内容挤没）。
 */
import { wikiTargetFromHref, wikiUrl } from './wikiLinks.ts';

/** 链接协议白名单：站外 http(s)、mailto、站内绝对/相对路径、锚点（含 `#wiki/` 双链）。 */
const SAFE_HREF = /^(?:https?:\/\/|mailto:|\/|\.{0,2}\/|#)/i;
/** 图片只放行站内资源，站外一律降级成链接，避免离线环境里挂一堆破图。 */
const SAFE_IMAGE = /^(?:\/media\/|\.{0,2}\/)/i;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 纯文本片段：转义 + 段落内软换行 */
function escapeText(value: string): string {
  return escapeHtml(value).replace(/\n/g, '<br>');
}

/* ===================== 行内 ===================== */

const INLINE_SOURCE = [
  '(`+)([\\s\\S]*?)\\1', // 1,2 行内代码
  '!\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+"[^"]*")?\\)', // 3,4 图片
  '\\[\\[([^\\]|]+)(?:\\|([^\\]]*))?\\]\\]', // 5,6 双链 [[页面]] / [[页面|别名]]
  '\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+"[^"]*")?\\)', // 7,8 链接
  '\\*\\*([\\s\\S]+?)\\*\\*', // 9 粗体
  '__([\\s\\S]+?)__', // 10 粗体（下划线）
  '~~([\\s\\S]+?)~~', // 11 删除线
  '\\*([^*\\n]+)\\*', // 12 斜体
  '_([^_\\n]+)_', // 13 斜体（下划线，需人工判边界）
  '\\[S(\\d+)\\]', // 14 引用角标
].join('|');

const MAX_INLINE_DEPTH = 3;

/** 每个调用点各自持有正则实例：递归渲染时不能共用 lastIndex。 */
function inlinePattern(): RegExp {
  return new RegExp(INLINE_SOURCE, 'g');
}

function renderInline(source: string, depth = 0): string {
  if (depth > MAX_INLINE_DEPTH) return escapeText(source);
  const pattern = inlinePattern();
  let html = '';
  let last = 0;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    html += escapeText(source.slice(last, match.index));
    html += inlineToken(match, source, depth);
    last = match.index + match[0].length;
  }
  return html + escapeText(source.slice(last));
}

function inlineToken(match: RegExpExecArray, source: string, depth: number): string {
  const ticks = match[1];
  const code = match[2];
  const imageAlt = match[3];
  const imageSrc = match[4];
  const wikiTarget = match[5];
  const wikiLabel = match[6];
  const linkLabel = match[7];
  const linkHref = match[8];
  const bold = match[9];
  const boldAlt = match[10];
  const strike = match[11];
  const emphasis = match[12];
  const emphasisAlt = match[13];
  const citation = match[14];

  if (ticks !== undefined) return `<code class="md-code">${escapeHtml(code ?? '')}</code>`;
  if (imageAlt !== undefined) return imageToken(imageAlt, imageSrc ?? '');
  if (wikiTarget !== undefined) return wikiLinkToken(wikiTarget, wikiLabel);
  if (linkLabel !== undefined) return linkToken(linkLabel, linkHref ?? '', depth);
  if (bold !== undefined) return `<strong>${renderInline(bold, depth + 1)}</strong>`;
  if (boldAlt !== undefined) return `<strong>${renderInline(boldAlt, depth + 1)}</strong>`;
  if (strike !== undefined) return `<del class="md-del">${renderInline(strike, depth + 1)}</del>`;
  if (emphasis !== undefined) return `<em>${renderInline(emphasis, depth + 1)}</em>`;
  if (emphasisAlt !== undefined) {
    // `snake_case` 这类写法不该变斜体：下划线两侧是词字符时按原样输出
    const before = source[match.index - 1] ?? ' ';
    const after = source[match.index + match[0].length] ?? ' ';
    if (/[\w]/.test(before) || /[\w]/.test(after)) return escapeText(match[0]);
    return `<em>${renderInline(emphasisAlt, depth + 1)}</em>`;
  }
  if (citation !== undefined) return `<sup class="cite">[S${citation}]</sup>`;
  return escapeText(match[0]);
}

function imageToken(alt: string, src: string): string {
  if (SAFE_IMAGE.test(src)) {
    return `<img class="md-img" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy">`;
  }
  if (SAFE_HREF.test(src)) {
    return `<a class="md-link" href="${escapeHtml(src)}" target="_blank" rel="noopener noreferrer">${escapeHtml(alt || src)}</a>`;
  }
  return escapeHtml(`![${alt}](${src})`);
}

function wikiLinkToken(target: string, label?: string): string {
  const clean = target.trim();
  if (!clean) return escapeHtml(`[[${target}]]`);
  const text = (label ?? '').trim() || clean;
  return `<a class="md-wikilink" href="${escapeHtml(wikiUrl(clean))}" data-wiki="${escapeHtml(clean)}">${escapeHtml(text)}</a>`;
}

function linkToken(label: string, href: string, depth: number): string {
  if (!SAFE_HREF.test(href)) return `${escapeHtml(label)}（${escapeHtml(href)}）`;
  // 站内双链（Wiki 阅读页那套 `[标题](#wiki/xxx)` 写法）也交给抽屉的点击处理器
  if (href.startsWith('#wiki/')) {
    const target = wikiTargetFromHref(href) ?? '';
    return `<a class="md-wikilink" href="${escapeHtml(href)}" data-wiki="${escapeHtml(target)}">${renderInline(label, depth + 1)}</a>`;
  }
  return `<a class="md-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${renderInline(label, depth + 1)}</a>`;
}

/* ===================== 块级 ===================== */

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;
const DIVIDER_CELL_RE = /^:?-+:?$/;

interface Block {
  html: string;
  next: number;
}

interface ListItem {
  task: boolean | null;
  text: string;
  /** 嵌套子列表的 HTML：必须在正文行内渲染之后拼接，否则会被一起转义 */
  extra: string;
}

function indentWidth(value: string): number {
  return value.replace(/\t/g, '    ').length;
}

/** 表格行：含竖线的行 */
function isTableRow(line: string): boolean {
  return line.includes('|');
}

function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\\' && text[index + 1] === '|') {
      current += '|';
      index++;
      continue;
    }
    if (char === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function isTableDivider(line: string, columns: number): boolean {
  if (!line.includes('-')) return false;
  const cells = splitRow(line);
  return cells.length === columns && cells.every((cell) => DIVIDER_CELL_RE.test(cell.replace(/\s+/g, '')));
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index] ?? '';
  const divider = lines[index + 1] ?? '';
  if (!isTableRow(header)) return false;
  return isTableDivider(divider, splitRow(header).length);
}

function alignmentOf(cell: string): string {
  const value = cell.replace(/\s+/g, '');
  const left = value.startsWith(':');
  const right = value.endsWith(':');
  if (left && right) return ' class="md-align-center"';
  if (right) return ' class="md-align-right"';
  if (left) return ' class="md-align-left"';
  return '';
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  if (!line.trim()) return true;
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    LIST_RE.test(line) ||
    isTableStart(lines, index)
  );
}

function readFence(lines: string[], start: number, fence: RegExpExecArray): Block {
  const marker = fence[1][0];
  const length = fence[1].length;
  const language = (fence[2] || '').trim();
  const close = new RegExp(`^ {0,3}\\${marker}{${length},}\\s*$`);
  const body: string[] = [];
  let index = start + 1;
  for (; index < lines.length; index++) {
    if (close.test(lines[index])) {
      index++;
      break;
    }
    body.push(lines[index]);
  }
  // 流式输出里代码块常常还没写到收尾围栏：剩下的内容按代码块渲染，别掉成普通段落
  const languageAttr = language ? ` class="language-${escapeHtml(language)}"` : '';
  return {
    html: `<pre class="md-pre"><code${languageAttr}>${escapeHtml(body.join('\n'))}</code></pre>`,
    next: index,
  };
}

function readQuote(lines: string[], start: number): Block {
  const inner: string[] = [];
  let index = start;
  while (index < lines.length) {
    const match = QUOTE_RE.exec(lines[index]);
    if (match) {
      inner.push(match[1]);
      index++;
      continue;
    }
    // 引用块里漏写 `>` 的续行按引用内容接上（Markdown 容忍写法）
    if (lines[index].trim() && inner.length && !startsBlock(lines, index)) {
      inner.push(lines[index].trim());
      index++;
      continue;
    }
    break;
  }
  return { html: `<blockquote class="md-quote">${renderBlocks(inner)}</blockquote>`, next: index };
}

function readTable(lines: string[], start: number): Block {
  const header = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map(alignmentOf);
  const rows: string[][] = [];
  let index = start + 2;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || !isTableRow(line)) break;
    rows.push(splitRow(line));
  }
  const head = header
    .map((value, column) => `<th${aligns[column] || ''}>${renderInline(value)}</th>`)
    .join('');
  const body = rows
    .map((row) => {
      const cells = header
        .map((_, column) => `<td${aligns[column] || ''}>${renderInline(row[column] ?? '')}</td>`)
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  return {
    html: `<div class="md-table-scroll"><table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
    next: index,
  };
}

function readList(lines: string[], start: number): Block {
  const first = LIST_RE.exec(lines[start]) as RegExpExecArray;
  const ordered = !/^[-*+]$/.test(first[2]);
  const startNumber = ordered ? Number.parseInt(first[2], 10) || 1 : 1;
  const baseIndent = indentWidth(first[1]);
  const items: ListItem[] = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      // 松散列表：空行后还是同一层列表项，就还算同一张列表
      const nextMatch = LIST_RE.exec(lines[index + 1] ?? '');
      if (nextMatch && indentWidth(nextMatch[1]) >= baseIndent) {
        index++;
        continue;
      }
      break;
    }
    const match = LIST_RE.exec(line);
    if (!match) {
      const rawIndent = indentWidth(/^\s*/.exec(line)?.[0] ?? '');
      if (items.length && rawIndent >= baseIndent + 2) {
        items[items.length - 1].text += `\n${line.trim()}`;
        index++;
        continue;
      }
      break;
    }
    const lineIndent = indentWidth(match[1]);
    if (lineIndent < baseIndent) break;
    if (lineIndent > baseIndent) {
      if (!items.length) break;
      const nested = readList(lines, index);
      items[items.length - 1].extra += nested.html;
      index = nested.next;
      continue;
    }
    if (!/^[-*+]$/.test(match[2]) !== ordered) break; // 同层换了列表类型：留给外层当新块
    let text = match[4];
    let task: boolean | null = null;
    const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(text);
    if (taskMatch) {
      task = taskMatch[1].toLowerCase() === 'x';
      text = taskMatch[2];
    }
    items.push({ task, text, extra: '' });
    index++;
    // 列表项的软换行续行：缩进比标记更深、又不是新的列表项
    while (index < lines.length) {
      const raw = lines[index];
      if (!raw.trim() || LIST_RE.test(raw)) break;
      const rawIndent = indentWidth(/^\s*/.exec(raw)?.[0] ?? '');
      if (rawIndent < baseIndent + 2) break;
      items[items.length - 1].text += `\n${raw.trim()}`;
      index++;
    }
  }

  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && startNumber !== 1 ? ` start="${startNumber}"` : '';
  const body = items
    .map((item) => {
      if (item.task === null) return `<li>${renderInline(item.text)}${item.extra}</li>`;
      const box = `<span class="md-task${item.task ? ' on' : ''}" aria-hidden="true"></span>`;
      return `<li class="md-task-item">${box}${renderInline(item.text)}${item.extra}</li>`;
    })
    .join('');
  return { html: `<${tag}${startAttr} class="md-list">${body}</${tag}>`, next: index };
}

function renderBlocks(lines: string[]): string {
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const block = readFence(lines, index, fence);
      out.push(block.html);
      index = block.next;
      continue;
    }
    if (HR_RE.test(line)) {
      out.push('<hr class="md-hr">');
      index++;
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      // 转录区自带标题层级：Markdown 的 # 映射成 h2，往下依次到 h6 封顶
      const level = Math.min(6, heading[1].length + 1);
      out.push(`<h${level} class="md-heading">${renderInline(heading[2])}</h${level}>`);
      index++;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const block = readQuote(lines, index);
      out.push(block.html);
      index = block.next;
      continue;
    }
    if (isTableStart(lines, index)) {
      const block = readTable(lines, index);
      out.push(block.html);
      index = block.next;
      continue;
    }
    if (LIST_RE.test(line)) {
      const block = readList(lines, index);
      out.push(block.html);
      index = block.next;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && !startsBlock(lines, index)) {
      paragraph.push(lines[index].trim());
      index++;
    }
    if (!paragraph.length) {
      // 兜底：绝不空转（任何新块规则漏判时也只是原样输出一行）
      paragraph.push(line.trim());
      index++;
    }
    out.push(`<p class="md-p">${renderInline(paragraph.join('\n'))}</p>`);
  }
  return out.join('');
}

/**
 * 渲染结果缓存：抽屉里整条转录会在每个流式增量上重渲一遍，同一段文案不必重复解析。
 * 纯函数无副作用，缓存键就是原文，按插入顺序 FIFO 截断（转录自带滚动，不需要更聪明的淘汰）。
 */
const RENDER_CACHE_LIMIT = 64;
const renderCache = new Map<string, string>();

/** 渲染内置 Agent 对话里的 Markdown 片段（助手正文、用户消息、子代理产出共用）。 */
export function renderMarkdown(source: string): string {
  if (!source) return '';
  const cached = renderCache.get(source);
  if (cached !== undefined) return cached;
  const html = renderBlocks(source.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
  renderCache.set(source, html);
  if (renderCache.size > RENDER_CACHE_LIMIT) {
    const oldest = renderCache.keys().next().value;
    if (oldest !== undefined) renderCache.delete(oldest);
  }
  return html;
}
