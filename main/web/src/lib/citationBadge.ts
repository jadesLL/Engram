/**
 * 报告「引用角标」的共享逻辑：来源编号 → 标题、提示文案，以及把正文里的 `[1]` 变成可点的上标。
 *
 * 报告末章「来源与结论对照」由服务端生成，每条固定是：
 *   - [1] 标题；发布日期：2026-01-01；https://…；访问日期：2026-01-02
 * 正文里的 `[1]` 要能回溯到它，所以这里既负责把来源列表解析成编号 → 标题，
 * 也负责拼角标的可见文案与无障碍名称。
 *
 * 两种渲染路径各有一套装饰入口：
 *   - `decorateCitations`：吃我们自己那套 renderMarkdown 产出的 HTML 字符串（客户洞察页）
 *   - `decorateCitationsIn`：吃第三方渲染器（Vditor）已经产出的 DOM（阅读页 / 文件预览）
 * 两者共用 `parseSourceTitles` / `citationLabel`，行为保持一致。
 */

/** 服务端来源行：[编号] 标题；发布日期：…；url 或 path；访问日期：… */
const SOURCE_LINE_RE = /^\s*[-*+]\s*\[(\d{1,3})\]\s*(.+)$/;

/** 正文/来源里出现的引用编号：跳过代码块，也跳过 `[1](url)` 这类 Markdown 链接 */
const CITATION_SOURCE = '\\[(\\d{1,3})\\](?!\\()';
const CODE_BLOCK_RE = /(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/g;

/** 每次取一份新的正则实例：`exec` 循环会改 lastIndex，共用一个实例必然错位 */
function citationPattern(): RegExp {
  return new RegExp(CITATION_SOURCE, 'g');
}

/** DOM 路径下不进文本节点的标签：代码、行内代码、现成链接、角标自己 */
const SKIP_TAGS = new Set(['CODE', 'PRE', 'KBD', 'SAMP', 'A', 'SUP']);

/** 把来源章的 Markdown 解析成「编号 → 标题」（标题只取第一个分号之前那截） */
export function parseSourceTitles(markdown: string): Map<number, string> {
  const map = new Map<number, string>();
  if (!markdown) return map;
  for (const line of markdown.split('\n')) {
    const hit = SOURCE_LINE_RE.exec(line);
    if (!hit) continue;
    const title = hit[2].split(/[；;]/)[0].trim();
    if (title) map.set(Number(hit[1]), title);
  }
  return map;
}

/** 角标的可见文案：来源 [3]：2026 年技改预算纪要，点击回到来源章 */
export function citationLabel(num: string, title?: string): string {
  return `来源 [${num}]${title ? `：${title}` : '（报告里没有这一条）'}，点击查看来源章节`;
}

/**
 * 拼进 HTML 属性前只放行文本安全的那五个字符：
 * 报告的来源标题是外部内容（客户名、网页标题），不转义就能把 `<sup>` 的标签写坏。
 */
export function escapeHtmlAttr(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char,
  );
}

/** 造一个角标节点（两种装饰路径共用，保证属性与文案一致） */
function citationNode(num: string, titles: Map<number, string>): HTMLElement {
  const sup = document.createElement('sup');
  sup.className = 'cite';
  sup.setAttribute('role', 'button');
  sup.setAttribute('tabindex', '0');
  sup.dataset.cite = num;
  sup.setAttribute('aria-label', citationLabel(num, titles.get(Number(num))));
  sup.textContent = `[${num}]`;
  return sup;
}

/** 给一段正文 HTML 里的引用编号套上角标（代码块与 Markdown 链接里不动） */
export function decorateCitations(html: string, titles: Map<number, string> = new Map()): string {
  return html
    .split(CODE_BLOCK_RE)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(citationPattern(), (_all, num: string) => {
            const label = citationLabel(num, titles.get(Number(num)));
            return `<sup class="cite" role="button" tabindex="0" data-cite="${num}" aria-label="${escapeHtmlAttr(label)}">[${num}]</sup>`;
          }))
    .join('');
}

/**
 * 给第三方渲染器（Vditor）产出的 DOM 套上角标。
 *
 * 走 TreeWalker 只改文本节点：Vditor 的输出里代码块是 `<pre><code class="hljs">`、行内代码是
 * `<code>`、链接是 `<a>`，这些子树整棵跳过；数学公式等 `<svg>` 也不进。返回改了几处。
 */
export function decorateCitationsIn(root: HTMLElement, titles: Map<number, string> = new Map()): number {
  const targets: Array<{ node: Text; text: string }> = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue?.includes('[')) return NodeFilter.FILTER_REJECT;
      return citationPattern().test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    targets.push({ node: node as Text, text: node.nodeValue || '' });
  }

  let count = 0;
  for (const { node, text } of targets) {
    const fragment = document.createDocumentFragment();
    const pattern = citationPattern();
    let last = 0;
    let hit = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      fragment.append(text.slice(last, match.index));
      fragment.append(citationNode(match[1], titles));
      last = match.index + match[0].length;
      hit += 1;
    }
    if (!hit) continue;
    fragment.append(text.slice(last));
    node.replaceWith(fragment);
    count += hit;
  }
  return count;
}

/** 来源章里「[编号] 标题…」那一行；外层容器（li 里的 p 等）不算，只认文字直接挂在它下面的块 */
function isSourceRow(el: HTMLElement, prefix: string): boolean {
  if (el.querySelector('li, p, div, td')) return false;
  return (el.textContent || '').trim().startsWith(prefix);
}

/** 来源章里某一条来源对应的块级元素（Vditor 与自家渲染器都按前缀匹配） */
export function findSourceEntry(root: HTMLElement, num: string): HTMLElement | null {
  const prefix = `[${num}]`;
  for (const block of root.querySelectorAll<HTMLElement>('li, p, div, td')) {
    if (isSourceRow(block, prefix)) return block;
  }
  return null;
}

/** 每个元素上的高亮收起计时器：重复点时先清掉旧的，避免上一次的计时把这一次的高亮提前摘掉 */
const highlightTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function pulse(el: HTMLElement): void {
  const root = el.closest<HTMLElement>('.reading-content, .report-markdown, .fp-body') ?? document.body;
  // 只保留一处高亮：从来源回正文、再回来源时不留下两处同时亮着
  root.querySelectorAll('.cite-hot').forEach((other) => {
    if (other !== el) {
      const timer = highlightTimers.get(other as HTMLElement);
      if (timer) clearTimeout(timer);
      other.classList.remove('cite-hot');
    }
  });
  el.classList.remove('cite-hot');
  // 强制重排后再加类：连点同一处时也重新播一次动画
  void el.offsetWidth;
  el.classList.add('cite-hot');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  // 角标是 role=button 可聚焦；来源行不可聚焦，就只给出视觉高亮
  if (el.tabIndex >= 0) el.focus({ preventScroll: true });
  // 到点自己收起：调用方不必各自维护计时器（客户洞察页换章会整块重渲染，那里另有一套）
  const previous = highlightTimers.get(el);
  if (previous) clearTimeout(previous);
  highlightTimers.set(el, setTimeout(() => {
    el.classList.remove('cite-hot');
    highlightTimers.delete(el);
  }, 1900));
}

/** 正文按章懒渲染的入口（客户洞察页）用这个把「来源章在哪、含这个编号的是哪一章」告诉共享逻辑 */
export interface CitationHints {
  /** 让调用方切到来源章；返回 true 表示来源章已可见 */
  sources?: () => boolean;
  /** 让调用方切到含该编号的正文章（切完由调用方自己再定位） */
  locate?: (num: string) => void;
}

/**
 * 报告里「正文角标 ↔ 来源条目」的双向跳转。
 *
 * 共享一份实现，三个入口（客户洞察页、Wiki 阅读页、文件预览）行为一致：
 *   - 点正文角标 `[n]`：落到来源章第 n 条来源，并短暂高亮
 *   - 点来源行 `/ 点已高亮那条来源`：回到正文里最近的那处 `[n]`
 *
 * 各入口的正文渲染器不同（自家 renderMarkdown / Vditor），但产出的 `sup.cite`、
 * 以及来源行的文本形态一致，所以这里只依赖 DOM 约定。
 * 返回 true 表示事件已处理（调用方不要再当链接跳转）。
 */
export function handleCitationEvent(
  root: HTMLElement | null | undefined,
  event: Event,
  hints: CitationHints = {},
): boolean {
  if (!root) return false;
  const target = event.target;
  if (!(target instanceof Element)) return false;

  // ① 正文角标：跳到对应那条来源
  const cite = target.closest<HTMLElement>('sup.cite[data-cite]');
  if (cite) {
    if (event.type === 'keydown') {
      const key = (event as KeyboardEvent).key;
      if (key !== 'Enter' && key !== ' ') return false;
      event.preventDefault();
    }
    const num = cite.dataset.cite || '';
    // 入口若把正文按章懒渲染，来源章可能还没画出来：让调用方先切过去，
    // 切章是异步的，等下一帧 DOM 和布局就绪再定位
    let entry = findSourceEntry(root, num);
    if (!entry && hints.sources?.()) entry = findSourceEntry(root, num);
    if (!entry && hints.sources) {
      const host = root;
      requestAnimationFrame(() => {
        const late = findSourceEntry(host, num);
        if (late) pulse(late);
      });
    } else if (entry) {
      pulse(entry);
    }
    return true; // 报告里没有这一条也吞掉事件，别落回链接跳转
  }

  // ② 回到正文：只认「来源行」与「刚被高亮过的那一条」，正文普通段落不参与
  const row = target.closest<HTMLElement>('li, p, td');
  if (!row || !root.contains(row)) return false;
  const text = (row.textContent || '').trim();
  const num = (/^\[(\d{1,3})\]/.exec(text) || [])[1] || '';
  if (!num && !row.classList.contains('cite-hot')) return false;
  // 来源行是自己这一行的锚点（Vditor 把裸链接渲染成 <a>）时照旧打开原始来源；
  // 点这一行的空白处才是「回到正文」。判据：锚点覆盖了整行才让位。
  const anchor = target.closest('a[href]');
  const rowText = (row.textContent || '').trim();
  if (anchor && (anchor.textContent || '').trim().length >= rowText.length - 2) return false;

  if (num) {
    // 正文可能按章懒渲染：当前 DOM 里没有这一处，就交给调用方切到含它的那一章。
    // 切章后 Vue 提交 DOM、浏览器重排都还没发生，所以推迟两帧再定位（点击时的这一次先让位）。
    if (!root.querySelector(`sup.cite[data-cite="${num}"]`)) {
      hints.locate?.(num);
      if (hints.locate) {
        const host = root;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const late = [...host.querySelectorAll<HTMLElement>('sup.cite[data-cite]')].find((el) => el.dataset.cite === num);
          if (late) pulse(late);
        }));
      }
      return true;
    }
  }

  const hits = [...root.querySelectorAll<HTMLElement>('sup.cite[data-cite]')];
  if (!hits.length) return false;
  // 同一条来源在正文里出现多次时，回到离这条来源最近、且在它之前的那一处
  const rowTop = row.getBoundingClientRect().top;
  const before = hits.filter((el) => el.dataset.cite === num && el.getBoundingClientRect().top < rowTop);
  const back = num ? (before[before.length - 1] ?? hits.find((el) => el.dataset.cite === num) ?? null) : null;
  const current = hits.find((el) => el.classList.contains('cite-hot'));
  pulse(back ?? current ?? hits[0]);
  return true;
}


