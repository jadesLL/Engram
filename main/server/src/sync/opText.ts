import path from 'node:path';

/**
 * 同步条目的「人话描述」：把一次同步拆成「哪个文件 + 做了什么增量」。
 *
 * 旧日志只有「推送 2 项变更：页面 2 · 872 B」这种汇总——用户看不出动了哪个文件、
 * 改了些什么，等于没有记录。这里统一产出条目摘要（新增/修改/删除/改名 + 行数增量 +
 * 体积变化），成员端批次、中枢端逐条、本机广播三处共用同一套措辞：
 *  修改页面「会议纪要」（+3 −1 行，1.2 KB → 1.3 KB）
 *  新增文件「原始资料/演示附件.bin」（1.2 MB）
 *
 * 纯函数、无 IO，方便单测钉住措辞与计数口径。
 */

export type SyncItemKind = 'page' | 'file' | 'delete' | 'move';
/** add=本端新增；update=覆盖已有；delete=删除；move=改名/移动；same=内容一致 */
export type SyncItemVerb = 'add' | 'update' | 'delete' | 'move' | 'same';

export interface SyncOpSummary {
  kind: SyncItemKind;
  verb: SyncItemVerb;
  /** brain 相对路径（文件条目即文件路径） */
  path: string;
  /** move 的原路径 */
  oldPath?: string;
  /** 页面标题（正文首个 H1，缺失时用文件名） */
  title?: string;
  /** 相对上一次同步版本新增/删除的行数（页面条目） */
  added?: number;
  removed?: number;
  beforeBytes?: number;
  afterBytes?: number;
}

/** 字节数转人话（结构化字段里仍保留原始字节数） */
export function formatBytes(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 「+3 −1 行」；只有增或只有删时不写多余的 0 */
export function formatLineDelta(added = 0, removed = 0): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`−${removed}`);
  if (!parts.length) return '内容顺序调整（行数不变）';
  return `${parts.join(' ')} 行`;
}

/** 页面标题：优先正文第一个 H1，其次文件名（用户认标题，不认路径） */
export function pageTitle(relPath: string, raw?: string | null): string {
  const heading = String(raw || '').match(/^\s{0,3}#\s+(.+?)\s*$/m);
  if (heading?.[1]) return heading[1].replace(/[#*`]/g, '').trim().slice(0, 60);
  const base = path.posix.basename(relPath || '').replace(/\.(md|markdown)$/i, '');
  return base || relPath;
}

/**
 * 行级增量计数。
 *
 * 先剪掉公共前后缀（编辑器里绝大多数改动只动中段），再对中段做 LCS；
 * 中段过大（>25 万格）时退回「行多重集」口径——只求给用户一个量级正确的
 * 「改了多少行」，不值得为此把主线程卡住。
 */
export function lineDiffCounts(before: string, after: string): { added: number; removed: number } {
  if (before === after) return { added: 0, removed: 0 };
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);
  if (!midA.length) return { added: midB.length, removed: 0 };
  if (!midB.length) return { added: 0, removed: midA.length };
  if (midA.length * midB.length <= 250_000) {
    const lcs = lcsLength(midA, midB);
    return { added: midB.length - lcs, removed: midA.length - lcs };
  }
  const counts = new Map<string, number>();
  for (const line of midA) counts.set(line, (counts.get(line) || 0) + 1);
  let added = 0;
  for (const line of midB) {
    const left = counts.get(line) || 0;
    if (left > 0) counts.set(line, left - 1);
    else added += 1;
  }
  let removed = 0;
  for (const left of counts.values()) removed += left;
  return { added, removed };
}

function lcsLength(a: string[], b: string[]): number {
  const prev = new Array<number>(b.length + 1).fill(0);
  const cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j];
  }
  return prev[b.length];
}

export function summarizePageChange(target: string, before: string | null, after: string): SyncOpSummary {
  const added = before === null ? countLines(after) : lineDiffCounts(before, after).added;
  const removed = before === null ? 0 : lineDiffCounts(before, after).removed;
  return {
    kind: 'page',
    verb: before === null ? 'add' : before === after ? 'same' : 'update',
    path: target,
    title: pageTitle(target, after),
    added,
    removed,
    beforeBytes: before === null ? 0 : Buffer.byteLength(before, 'utf8'),
    afterBytes: Buffer.byteLength(after, 'utf8'),
  };
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').filter((line) => line.length > 0).length;
}

export function summarizeFileChange(target: string, beforeBytes: number, afterBytes: number): SyncOpSummary {
  return {
    kind: 'file',
    verb: beforeBytes > 0 ? 'update' : 'add',
    path: target,
    beforeBytes,
    afterBytes,
  };
}

export function summarizeDelete(target: string, beforeBytes: number, isPage: boolean): SyncOpSummary {
  return {
    kind: 'delete',
    verb: 'delete',
    path: target,
    title: isPage ? pageTitle(target) : undefined,
    beforeBytes,
  };
}

export function summarizeMove(oldPath: string, newPath: string): SyncOpSummary {
  return {
    kind: 'move',
    verb: 'move',
    path: newPath,
    oldPath,
    title: pageTitle(newPath),
  };
}

/** 条目的「主体」写法：页面用标题、文件用路径（用户认标题，不认 hash 路径） */
function subjectOf(item: SyncOpSummary): string {
  if (item.kind === 'file') return `文件「${item.path}」`;
  if (item.kind === 'delete' && !item.title) return `文件「${item.path}」`;
  return `页面「${item.title || pageTitle(item.path)}」`;
}

/** 条目 → 一行中文（列表里直接展示，用户不用展开也能看懂） */
export function describeOpSummary(item: SyncOpSummary): string {
  const name = subjectOf(item);
  switch (item.verb) {
    case 'add': {
      if (item.kind === 'file') return `新增文件「${item.path}」（${formatBytes(item.afterBytes)}）`;
      // 新建的空页面没有行增量可写，别硬凑一句「内容顺序调整」
      const delta = Number(item.added || 0) > 0 ? `${formatLineDelta(item.added, 0)}，` : '';
      return `新增${name}（${delta}${formatBytes(item.afterBytes)}）`;
    }
    case 'update':
      if (item.kind === 'file') {
        return `更新文件「${item.path}」（${formatBytes(item.beforeBytes)} → ${formatBytes(item.afterBytes)}）`;
      }
      return `修改${name}（${formatLineDelta(item.added, item.removed)}，${formatBytes(item.beforeBytes)} → ${formatBytes(item.afterBytes)}）`;
    case 'delete':
      return `删除${name}（删除前 ${formatBytes(item.beforeBytes)}）`;
    case 'move':
      return `改名「${pageTitle(item.oldPath || '')}」→「${pageTitle(item.path)}」（${item.oldPath} → ${item.path}）`;
    default:
      return `${name}内容无变化`;
  }
}

/** 批次 → 半句话列表：「新增页面「A」（+6 行）；修改页面「B」（+2 −1 行）；等 3 项」 */
export function describeOpList(items: SyncOpSummary[], limit = 3): string {
  const visible = items.slice(0, limit).map(describeOpSummary);
  const rest = items.length - visible.length;
  const head = visible.join('；');
  return rest > 0 ? `${head}；等 ${rest} 项` : head;
}

/** 条目是否值得写进同步记录：内部系统页（AIWorks/）不打扰用户，内容没变也不记 */
export function isNoteworthyOp(item: SyncOpSummary | null | undefined): item is SyncOpSummary {
  if (!item) return false;
  if (item.verb === 'same') return false;
  if (item.path.startsWith('AIWorks/')) return false;
  if (item.kind === 'move' && (item.oldPath || '').startsWith('AIWorks/')) return false;
  return true;
}
