/**
 * 客户洞察报告里「引用角标」的纯逻辑：来源编号 → 标题与提示文案。
 *
 * 报告末章「来源与结论对照」由服务端生成，每条固定是：
 *   - [1] 标题；发布日期：2026-01-01；https://…；访问日期：2026-01-02
 * 正文里的 `[1]` 要能回溯到它，所以这里既负责把来源列表解析成编号 → 标题，
 * 也负责拼角标的可见文案与无障碍名称。抽成纯函数是为了能单测：组件那份没有 DOM 可挂。
 *
 * 注意：组件里的 `plain()` 会把 `[1]` 就地抹成 `1`（右栏速览要的是干净句子），
 * 这里要留 `[编号]` 才能对上正文角标，两者不可互相复用。
 */

/** 服务端来源行：[编号] 标题；发布日期：…；url 或 path；访问日期：… */
const SOURCE_LINE_RE = /^\s*[-*+]\s*\[(\d{1,3})\]\s*(.+)$/;

/** 正文/来源里出现的引用编号：跳过代码块，也跳过 `[1](url)` 这类 Markdown 链接 */
const CITATION_RE = /\[(\d{1,3})\](?!\()/g;
const CODE_BLOCK_RE = /(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/g;

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

/** 给一段正文 HTML 里的引用编号套上角标（代码块与 Markdown 链接里不动） */
export function decorateCitations(html: string, titles: Map<number, string> = new Map()): string {
  return html
    .split(CODE_BLOCK_RE)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(CITATION_RE, (_all, num: string) => {
            const label = citationLabel(num, titles.get(Number(num)));
            return `<sup class="cite" role="button" tabindex="0" data-cite="${num}" aria-label="${escapeHtmlAttr(label)}">[${num}]</sup>`;
          }))
    .join('');
}
