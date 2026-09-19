import type { ChatContext } from '../stores/chat';

/**
 * 「在 Agent 中提问」的界面上下文：把选中文字连同所在位置（文件预览或页面）打包给聊天抽屉。
 *
 * 服务端 `assistant/prompts.ts` 已支持 `selection` / `currentFile` / `currentPage` 三项，
 * 并把它当作不可信线索拼进任务文本；这里只负责把界面现状翻译成同一份契约。
 */
export interface SelectionLocation {
  /** 当前位置的路由，供 Agent 判断「在哪个界面选中的」 */
  route?: string;
  /** 用户选中的文字（原样，裁剪交给这里统一做） */
  selection: string;
  /** 文件预览态：原始资料相对路径 */
  filePath?: string;
  /** 页面态：当前页面的 id / 标题 / 路径 */
  page?: { id?: string; title?: string; path?: string };
}

export function buildSelectionContext(location: SelectionLocation): ChatContext {
  const context: ChatContext = {};
  if (location.route) context.route = location.route;

  const selection = (location.selection || '').trim();
  if (selection) context.selection = selection;

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
