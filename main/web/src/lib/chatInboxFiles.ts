import type { ChatInboxFile } from '../stores/chat';

/**
 * 对话里的收集箱附件：路径规整、合并去重、默认话术与消息 metadata 解析。
 *
 * ChatDrawer 只负责渲染与发请求；这些纯逻辑抽出来，单测不用挂 Vue 就能把
 * 「拖入/粘贴/挑选/发送/重放快照」几条路径过一遍。服务端 assistant/prompts.ts 的
 * normalizeInboxFiles 是同一口径的第二道过滤（前端清单只影响展示）。
 */

/** 一条消息最多带多少份收集箱文件（与服务端 normalizeInboxFiles 的上限一致） */
export const MAX_CHAT_INBOX_FILES = 20;

/** 统一成正斜杠、去掉首尾斜杠的 vault 相对路径 */
function normalizePath(path: unknown): string {
  return String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

/** 是否收集箱原件：必须在 收集箱/ 下，且不是 收集箱/转换结果/ 里的产物（产物不是待处理输入） */
export function isInboxOriginalPath(path: string): boolean {
  const rel = normalizePath(path);
  return rel.startsWith('收集箱/') && !rel.startsWith('收集箱/转换结果/');
}

/** 展示名：路径末段；没有文件名时退回整条路径 */
export function chatInboxFileName(path: string): string {
  const segments = normalizePath(path).split('/').filter(Boolean);
  return segments[segments.length - 1] || String(path || '') || '未命名文件';
}

/** 由路径造一条附件；路径不合法（非收集箱原件）返回 null */
export function chatInboxFileFromPath(
  path: string,
  source: 'upload' | 'inbox',
  name?: string
): ChatInboxFile | null {
  const rel = normalizePath(path);
  if (!isInboxOriginalPath(rel)) return null;
  const label = String(name ?? '').trim() || chatInboxFileName(rel);
  return { path: rel, name: label, source };
}

/** 合并附件：按 path 去重、保持先来后到，总数封顶 20 */
export function mergeChatInboxFiles(
  current: ChatInboxFile[] | null | undefined,
  incoming: ChatInboxFile[] | null | undefined
): ChatInboxFile[] {
  const result: ChatInboxFile[] = [];
  const seen = new Set<string>();
  for (const file of [...(current || []), ...(incoming || [])]) {
    if (!file || !isInboxOriginalPath(file.path) || seen.has(file.path)) continue;
    seen.add(file.path);
    result.push(file);
    if (result.length >= MAX_CHAT_INBOX_FILES) break;
  }
  return result;
}

/** 移除一条附件（按 path） */
export function removeChatInboxFile(current: ChatInboxFile[], path: string): ChatInboxFile[] {
  return current.filter((file) => file.path !== path);
}

/**
 * 从消息 metadata 还原附件（快照重放 / 多端同步 / 排队转正后仍要能画出当时附了什么）。
 * metadata 是历史数据，坏形状直接当没有，不抛错。
 */
export function chatInboxFilesFromMetadata(metadata: unknown): ChatInboxFile[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const raw = (metadata as { inboxFiles?: unknown }).inboxFiles;
  if (!Array.isArray(raw)) return [];
  const files: ChatInboxFile[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rel = normalizePath((item as { path?: unknown }).path);
    if (!isInboxOriginalPath(rel)) continue;
    const name = typeof (item as { name?: unknown }).name === 'string'
      ? (item as { name: string }).name.trim()
      : '';
    const source = (item as { source?: unknown }).source;
    files.push({
      path: rel,
      name: name || chatInboxFileName(rel),
      ...(source === 'upload' || source === 'inbox' ? { source } : {}),
    });
    if (files.length >= MAX_CHAT_INBOX_FILES) break;
  }
  return files;
}

/** 附件 chip 上的来源小字：刚上传 / 从收集箱挑选 */
export function chatInboxSourceLabel(file: ChatInboxFile): string {
  return file.source === 'inbox' ? '收集箱' : '新上传';
}

/**
 * 真正发出去的文字：用户写了就用自己的；只挂附件没写字时补一句默认任务话术，
 * 否则 Agent 只会看到一串路径、不知道该干什么。
 * 文件名单不再重复写进正文——输入区上方与消息里的附件 chip 已经列了；
 * Agent 侧看到的是上下文里的完整路径清单。
 */
export function composeChatInboxMessage(draft: string, files: ChatInboxFile[]): string {
  const text = String(draft ?? '').trim();
  if (text) return text;
  if (!files.length) return '';
  return `我从收集箱附上了 ${files.length} 份文件。请先读懂它们，给我 3–5 条要点总结；需要转成 Markdown 时按收集箱规范处理，产物留在收集箱，不要入库。`;
}

const PASTE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * 剪贴板里的截图通常没有文件名（Chrome 给的是 image.png，粘两次就撞名）。
 * 这里给「无文件名 / 通用 image.png」补一个按时间命名的文件名，其余保持原样。
 */
export function preparePastedFiles(files: File[], now: Date = new Date()): File[] {
  return files.map((file) => {
    const name = String(file.name || '').trim();
    if (name && !/^image\.(png|jpe?g|webp|gif)$/i.test(name) && name !== 'blob') return file;
    const ext = PASTE_EXT[file.type] || (name.split('.').pop() || 'png').toLowerCase();
    const pad = (value: number) => String(value).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-`
      + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return new File([file], `粘贴图片-${stamp}.${ext}`, {
      type: file.type || 'application/octet-stream',
      lastModified: file.lastModified,
    });
  });
}
