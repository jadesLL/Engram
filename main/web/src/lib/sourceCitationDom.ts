import {
  parseSourceCitation,
  sourceCitationLine,
  type SourceCitation,
} from './sourceCitation.ts';

/**
 * 把阅读页 / 导出稿里的「出处」引用块换成折叠字段表。
 *
 * DOM 层做两件事：按 `<br>` / 段落边界 / 文本换行拆行（Node 环境没有 innerText，
 * 而且导出时 DOM 还是离屏的，innerText 不可靠），再按字段行重建内容——
 * 链接节点原样保留，不把 URL 退化成纯文本。
 */

export type SourceCitationMode = 'reading' | 'export';

interface CitationRow {
  label: string;
  content: DocumentFragment;
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE']);
const CHEVRON =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">' +
  '<path d="M3.5 6l4.5 4.5L12.5 6" stroke="currentColor" stroke-width="1.4"' +
  ' stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * 就地替换 root 里的出处引用块，返回替换数量。
 * reading：折叠成一行（原生 details，无 JS 依赖）；export：静态字段表，始终展开。
 */
export function promoteSourceCitations(
  root: ParentNode,
  mode: SourceCitationMode = 'reading'
): number {
  let promoted = 0;
  for (const quote of Array.from(root.querySelectorAll('blockquote'))) {
    const lines = splitBlockquoteLines(quote as HTMLElement);
    if (lines.length < 2) continue;
    const text = lines.map((line) => line.textContent || '').join('\n');
    const parsed = parseSourceCitation(text);
    if (!parsed) continue;
    const rows = citationRows(lines);
    if (rows.length < 2) continue;
    quote.replaceWith(
      mode === 'export' ? renderExportCitation(parsed, rows) : renderReadingCitation(parsed, rows)
    );
    promoted += 1;
  }
  return promoted;
}

/**
 * 拆行规则：
 *  - `<br>`、块级元素边界、文本里的 `\n` 都算换行；
 *  - 行内元素整体克隆，避免把链接拆散。
 */
function splitBlockquoteLines(blockquote: HTMLElement): DocumentFragment[] {
  const lines: DocumentFragment[] = [];
  let current = document.createDocumentFragment();

  const flush = () => {
    if (!current.childNodes.length) return;
    lines.push(current);
    current = document.createDocumentFragment();
  };

  const append = (node: Node) => {
    if (node.nodeType === 3) {
      const parts = (node.nodeValue || '').split('\n');
      parts.forEach((part, index) => {
        if (index > 0) flush();
        if (part) current.append(document.createTextNode(part));
      });
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as HTMLElement;
    if (element.tagName === 'BR') {
      flush();
      return;
    }
    if (BLOCK_TAGS.has(element.tagName)) {
      flush();
      for (const child of Array.from(element.childNodes)) append(child);
      flush();
      return;
    }
    current.append(element.cloneNode(true));
  };

  for (const child of Array.from(blockquote.childNodes)) append(child);
  flush();
  return lines;
}

function citationRows(lines: DocumentFragment[]): CitationRow[] {
  const rows: CitationRow[] = [];
  for (const line of lines) {
    if (!(line.textContent || '').trim()) continue;
    const parsed = sourceCitationLine(line.textContent || '');
    if (parsed) {
      stripPrefix(line, parsed.prefixLength);
      rows.push({ label: parsed.label, content: line });
      continue;
    }
    if (!rows.length) continue;
    /* 值被软换行拆开：并回上一行的 dd，保留一个 <br> 的视觉断行 */
    const previous = rows[rows.length - 1].content;
    previous.append(document.createElement('br'));
    previous.append(...Array.from(line.childNodes));
  }
  return rows;
}

/** 从行首剥掉「标签：」，保留后面的链接等节点。 */
function stripPrefix(fragment: DocumentFragment, length: number): void {
  let remaining = length;
  const walker = document.createTreeWalker(fragment, 4 /* NodeFilter.SHOW_TEXT */);
  while (remaining > 0) {
    const node = walker.nextNode() as Text | null;
    if (!node) break;
    const take = Math.min(remaining, node.data.length);
    node.data = node.data.slice(take);
    remaining -= take;
  }
  const trimmer = document.createTreeWalker(fragment, 4);
  let node = trimmer.nextNode() as Text | null;
  while (node) {
    if (node.data) {
      node.data = node.data.replace(/^[\s：:]+/, '');
      break;
    }
    node = trimmer.nextNode() as Text | null;
  }
}

function renderReadingCitation(parsed: SourceCitation, rows: CitationRow[]): HTMLElement {
  const details = document.createElement('details');
  details.className = 'cite-fold';

  const summary = document.createElement('summary');
  summary.className = 'cite-summary';
  const tag = document.createElement('span');
  tag.className = 'cite-tag';
  tag.textContent = '出处';
  const title = document.createElement('span');
  title.className = 'cite-title';
  title.textContent = parsed.title || '来源信息';
  summary.append(tag, title);
  if (parsed.meta) {
    const meta = document.createElement('span');
    meta.className = 'cite-meta';
    meta.textContent = parsed.meta;
    summary.append(meta);
  }
  const chevron = document.createElement('span');
  chevron.className = 'cite-chevron';
  chevron.innerHTML = CHEVRON;
  summary.append(chevron);

  const body = document.createElement('div');
  body.className = 'cite-body';
  body.append(renderRows(rows, 'cite-dl', 'cite-row'));
  details.append(summary, body);
  return details;
}

function renderExportCitation(parsed: SourceCitation, rows: CitationRow[]): HTMLElement {
  const box = document.createElement('div');
  box.className = 'xe-cite';

  const head = document.createElement('div');
  head.className = 'xe-cite-head';
  const tag = document.createElement('span');
  tag.className = 'xe-cite-tag';
  tag.textContent = '出处';
  const title = document.createElement('span');
  title.className = 'xe-cite-title';
  title.textContent = parsed.title || '来源信息';
  head.append(tag, title);
  if (parsed.meta) {
    const meta = document.createElement('span');
    meta.className = 'xe-cite-meta';
    meta.textContent = parsed.meta;
    head.append(meta);
  }

  box.append(head, renderRows(rows, 'xe-cite-dl', 'xe-cite-row'));
  return box;
}

function renderRows(rows: CitationRow[], listClass: string, rowClass: string): HTMLElement {
  const dl = document.createElement('dl');
  dl.className = listClass;
  for (const row of rows) {
    const wrap = document.createElement('div');
    wrap.className = rowClass;
    const dt = document.createElement('dt');
    dt.textContent = row.label;
    const dd = document.createElement('dd');
    dd.append(row.content);
    wrap.append(dt, dd);
    dl.append(wrap);
  }
  return dl;
}
