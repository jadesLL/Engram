import { api } from '../api';

/**
 * 编辑页「就地 AI」的前端契约。
 *
 * 服务端一次请求只做一次补全（`POST /api/editor/ai`）：插入 / 改写 / 接写返回一段
 * Markdown，全文美化返回整理后的完整正文。结果由编辑器就地应用，保存仍走既有通道。
 */

export type EditorAiTask = 'insert' | 'rewrite' | 'continue' | 'beautify';

export interface EditorAiRequest {
  task: EditorAiTask;
  instruction?: string;
  title?: string;
  /** 全文美化：整篇正文（含编辑器里的占位链接） */
  document?: string;
  /** 改写 / 接写：选中的文字 */
  selection?: string;
  /** 插入点之前的正文（前端截断） */
  before?: string;
  /** 插入点之后的正文（前端截断） */
  after?: string;
}

export interface EditorAiResponse {
  text: string;
  model?: string;
  chunks?: number;
}

export async function requestEditorAi(
  payload: EditorAiRequest,
  signal?: AbortSignal,
): Promise<EditorAiResponse> {
  const { data } = await api.post<EditorAiResponse>('/api/editor/ai', payload, { signal });
  if (!data || typeof data.text !== 'string') {
    throw new Error('AI 没有返回内容');
  }
  return data;
}

/** 中断（用户关掉对话框 / 点了取消）不是错误，调用方据此静默收尾 */
export function isEditorAiAbort(error: any): boolean {
  return error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError' || error?.name === 'AbortError';
}

/** 从 axios 错误里取一句人话 */
export function editorAiErrorMessage(error: any): string {
  const detail = error?.response?.data?.error || error?.response?.data?.message;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (error?.code === 'ECONNABORTED') return '请求超时了，请重试或缩短要求';
  return error?.message || 'AI 请求失败，请稍后重试';
}
