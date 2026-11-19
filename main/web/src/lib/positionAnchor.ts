/**
 * 位置引用的纯逻辑：把编辑器里的 Markdown 与光标偏移换算成「块锚点」。
 *
 * 内置 Agent 的写入必须可复现，所以不送字符偏移（页面一保存/同步就变），而是送：
 *  - 光标所在块的 Markdown 原文（块内不跨空行，围栏代码块整体算一块）；
 *  - 同一原文在页面里第几次出现（occurrence）；
 *  - 标题路径与前后块纯文本摘录（给 Agent 理解上下文，也给服务端做二次校验）。
 *
 * 服务端 `assistant/positions.ts` 用同一套分块规则重新定位；两边规则一变都要同步测试。
 */

export interface MarkdownBlock {
  /** 块原文（保留行内 Markdown 记号） */
  text: string;
  /** 在 Markdown 文本里的起始偏移 */
  start: number;
  /** 结束偏移（不含块后的空行） */
  end: number;
}

export interface PositionAnchor {
  /** 光标所在块的 Markdown 原文（已 trim） */
  anchorText: string;
  /** 同一锚点原文在页面里第几次出现（1 起） */
  occurrence: number;
  /** 从一级标题到当前章节的标题路径 */
  headingPath: string[];
  /** 前一个块的纯文本摘录（最多 160 字） */
  before: string;
  /** 后一个块的纯文本摘录（最多 160 字） */
  after: string;
  /** 固定只支持插到块之后；留字段给后续扩展 */
  placement: 'after';
  /** 给 chip 的一行摘要（纯文本，最多 80 字） */
  preview: string;
}

/** 与 server/src/assistant/positions.ts 的 splitMarkdownBlocks 同步：围栏内的空行不分块 */
export function splitMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const text = String(markdown ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const blocks: MarkdownBlock[] = [];
  let buffer: string[] = [];
  let start = 0;
  let fence = false;
  let pos = 0;
  const flush = (end: number) => {
    if (!buffer.length) return;
    const body = buffer.join('\n');
    if (body.trim()) blocks.push({ text: body, start, end });
    buffer = [];
  };
  for (const line of lines) {
    const lineStart = pos;
    const lineEnd = lineStart + line.length;
    const fenceLine = /^\s*(```|~~~)/.test(line);
    if (!fence && !line.trim() && !fenceLine) {
      flush(lineStart);
    } else {
      if (!buffer.length && line.trim()) start = lineStart;
      buffer.push(line);
    }
    if (fenceLine) fence = !fence;
    pos = lineEnd + 1;
  }
  flush(Math.min(pos, text.length));
  return blocks;
}

/** 块 → 纯文本：只用于展示与前后文摘录，不参与锚点精确匹配 */
export function plainTextOfMarkdown(value: string): string {
  return String(value ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/^[ \t]*[-+*]\s+/gm, '')
    .replace(/[*_~`>#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从 0 到 index（含）的标题路径；同名标题按层级回退，只保留当前祖先链 */
function headingPathAt(blocks: MarkdownBlock[], index: number): string[] {
  const stack: Array<{ level: number; title: string }> = [];
  for (let i = 0; i <= index && i < blocks.length; i += 1) {
    const firstLine = blocks[i].text.trim().split('\n')[0] || '';
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(firstLine);
    if (!match) continue;
    const level = match[1].length;
    const title = plainTextOfMarkdown(match[2]);
    if (!title) continue;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title });
  }
  return stack.map((item) => item.title);
}

/**
 * 光标偏移 → 块锚点。
 * 偏移落在空行里时取前一个块（「在这一段之后写」），这是与用户直觉一致的一侧；
 * 在文首空行里没有前块则取第一个块。
 */
export function anchorAtOffset(markdown: string, offset: number): PositionAnchor | null {
  const blocks = splitMarkdownBlocks(markdown);
  if (!blocks.length) return null;
  const at = Math.max(0, Math.min(Number(offset) || 0, String(markdown ?? '').length));
  let index = -1;
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (at >= block.start && at <= block.end) {
      index = i;
      break;
    }
    if (block.end < at && (i === blocks.length - 1 || blocks[i + 1].start > at)) {
      index = i;
      break;
    }
  }
  // 偏移在文首空行里（第一块之前）时归到第一块；其余落空则归到最后一块
  if (index < 0) index = at < blocks[0].start ? 0 : blocks.length - 1;

  const block = blocks[index];
  const anchorText = block.text.trim();
  if (!anchorText) return null;
  const occurrence =
    blocks.slice(0, index + 1).filter((item) => item.text.trim() === anchorText).length;
  const before = plainTextOfMarkdown(blocks[index - 1]?.text || '').slice(-160);
  const after = plainTextOfMarkdown(blocks[index + 1]?.text || '').slice(0, 160);
  const preview = plainTextOfMarkdown(anchorText).slice(0, 80);
  return {
    anchorText,
    occurrence: Math.max(1, occurrence),
    headingPath: headingPathAt(blocks, index),
    before,
    after,
    placement: 'after',
    preview,
  };
}
