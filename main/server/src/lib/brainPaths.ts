/**
 * 「收集箱」的路径约定与分类——全库唯一来源。
 *
 * 收集箱是拖入文件的暂存区：内容**不属于知识库**，在用户确认「入库」之前
 * 不建 pages 行、不写 FTS、不参与检索、不可被 Agent 引用，也不在文件树里出现。
 * 入库（搬到 原始资料/）之后才成为正式来源。
 *
 * 判定必须只从这里取：目录常量、扫描（vault）、同步分类（routes/sync、sync/client）、
 * 检索权重（retrieval/hybrid）、通用文件接口（routes/files）都引用本模块，
 * 避免把 '收集箱' 字面量散落到各处——漏一处就是隔离被破。
 */

/** 收集箱根目录（brain 下的 vault 相对路径） */
export const INBOX_DIR = '收集箱';

/** 语义转换产物目录（与原件同区，因此同样不参与检索） */
export const INBOX_DERIVED_DIR = `${INBOX_DIR}/转换结果`;

/** 统一成正斜杠、去掉首尾斜杠的 vault 相对路径 */
export function normalizeBrainRel(rel: string | null | undefined): string {
  return String(rel ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

/** 是否位于收集箱内（含收集箱目录自身） */
export function isInboxPath(rel: string | null | undefined): boolean {
  const normalized = normalizeBrainRel(rel);
  return normalized === INBOX_DIR || normalized.startsWith(`${INBOX_DIR}/`);
}

/** 是否收集箱里的转换产物 */
export function isInboxDerivedPath(rel: string | null | undefined): boolean {
  const normalized = normalizeBrainRel(rel);
  return normalized === INBOX_DERIVED_DIR || normalized.startsWith(`${INBOX_DERIVED_DIR}/`);
}

/**
 * 同步层的条目分类。
 *
 * brain 下的 `.md` 默认按页面同步（对端会写 pages 行并做三方合并），
 * 但收集箱里的 `.md`（原件或转换产物）**必须**按普通文件同步，
 * 否则箱内内容会在各端被登记成知识库页面并被检索到。
 */
export function classifyBrainEntry(rel: string | null | undefined): 'page' | 'file' {
  const normalized = normalizeBrainRel(rel);
  if (isInboxPath(normalized)) return 'file';
  return normalized.toLowerCase().endsWith('.md') ? 'page' : 'file';
}

/** 去掉扩展名的文件名（收集箱条目的展示名/产物名共用） */
export function stemOf(rel: string): string {
  const normalized = normalizeBrainRel(rel);
  const base = normalized.split('/').pop() || normalized;
  return base.replace(/\.[^.]+$/, '') || base;
}

/**
 * 原件路径 → 语义转换产物路径。
 *
 * 产物一律平铺在 INBOX_DERIVED_DIR 下（子目录只用于组织原件，不跟着产物走），
 * 因此同名原件需要由调用方做去重（`uniqueDerivedPath`）。
 */
export function inboxDerivedPath(rel: string, suffix = ''): string {
  return `${INBOX_DERIVED_DIR}/${stemOf(rel)}${suffix}.md`;
}

/** 产物路径存在时追加序号：`名.md` → `名 (2).md`，最多尝试 99 次 */
export function uniqueDerivedPath(rel: string, exists: (candidate: string) => boolean): string {
  for (let i = 1; i <= 99; i += 1) {
    const candidate = inboxDerivedPath(rel, i === 1 ? '' : ` (${i})`);
    if (!exists(candidate)) return candidate;
  }
  return inboxDerivedPath(rel, ` (${Date.now()})`);
}

/**
 * 通用文件接口的拒绝文案；返回 null 表示放行。
 * 收集箱条目只走 `routes/inbox.ts` 的专用接口：不支持内置浏览（预览/取内容），
 * 也不允许经通用上传接口写入。
 */
export function inboxAccessError(rel: string | null | undefined, action = '访问'): string | null {
  return isInboxPath(rel) ? `收集箱内容不支持${action}，请使用收集箱接口` : null;
}
