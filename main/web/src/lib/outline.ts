/**
 * 编辑页目录：从 Markdown 源文提取小标题（1–4 级）。
 *
 * 和渲染后的 DOM 目录（沉浸阅读按 h1–h6 扫）分开：编辑态正文还在 Vditor 里，
 * 目录列表直接读当前 content，能随输入即时更新，也不必等编辑器渲染完成。
 * 围栏代码块里的 `#` 不算标题；最多取 40 条，避免超长文档把面板撑爆。
 */
export type OutlineItem = {
  level: number;
  text: string;
};

const FENCE_RE = /^\s*(?:`{3,}|~{3,})/;
const HEADING_RE = /^(#{1,4})\s+(.+?)\s*#*\s*$/;

export function extractMarkdownOutline(markdown: string, maxItems = 40): OutlineItem[] {
  const items: OutlineItem[] = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (FENCE_RE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = HEADING_RE.exec(line);
    if (match) items.push({ level: match[1].length, text: match[2].trim() });
    if (items.length >= maxItems) break;
  }
  return items;
}
