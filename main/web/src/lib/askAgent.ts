import type { ChatContext } from '../stores/chat';

/**
 * 「在 Agent 中提问」的界面上下文：把选中文字连同所在位置（文件预览或页面）打包给聊天抽屉。
 *
 * 服务端 `assistant/prompts.ts` 已支持 `selection` / `currentFile` / `currentPage` 三项，
 * 并把它当作不可信线索拼进任务文本；这里只负责把界面现状翻译成同一份契约。
 */

/** 一条选中片段：原文 + 出处标签（文件路径或《页面标题》），供输入框上方的片段列表逐条查看 */
export interface SelectionExcerpt {
  id: string;
  text: string;
  source: string;
}

export interface SelectionLocation {
  /** 当前位置的路由，供 Agent 判断「在哪个界面选中的」 */
  route?: string;
  /** 文件预览态：原始资料相对路径 */
  filePath?: string;
  /** 页面态：当前页面的 id / 标题 / 路径 */
  page?: { id?: string; title?: string; path?: string };
}

export function buildSelectionContext(location: SelectionLocation): ChatContext {
  const context: ChatContext = {};
  if (location.route) context.route = location.route;

  // 文件预览态没有页面（EditorView 里两者互斥），文件优先；页面只在没有文件时补位
  const filePath = (location.filePath || '').trim();
  if (filePath) {
    context.currentFile = { path: filePath, name: filePath.split('/').pop() || filePath };
  } else if (location.page?.id || location.page?.title) {
    context.currentPage = {
      id: location.page.id,
      title: location.page.title,
      path: location.page.path,
    };
  }
  return context;
}

/**
 * 把片段列表拼成送给 Agent 的 selection 文本。
 * 单条直接用原文（出处已由 currentFile / currentPage 交代）；多条逐条带「片段 N · 出处」标签，
 * 这样跨文件累积的多段选中在 Agent 那边仍能分清各自来自哪里。
 */
export function composeSelectionText(
  items: Array<Pick<SelectionExcerpt, 'text' | 'source'>>,
): string {
  const parts = (items || [])
    .map((item) => ({ text: (item?.text || '').trim(), source: (item?.source || '').trim() }))
    .filter((item) => item.text);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0].text;
  return parts
    .map((item, index) => `【片段 ${index + 1}${item.source ? ` · ${item.source}` : ''}】\n${item.text}`)
    .join('\n\n');
}
