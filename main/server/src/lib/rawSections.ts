/**
 * 「原始资料」的二级分类——全库唯一来源。
 *
 * 一级目录固定是 `原始资料/`，其下三个二级目录固定为 **文档 / 对话 / 灵感碎片**：
 *  - 文档：成文的完整文件（会议纪要、调研报告、复盘、年报、教程、攻略、业绩表…）
 *  - 对话：与 Agent 的对话沉积（save_chat 写入，可按项目再分子目录）
 *  - 灵感碎片：随手记（零散条目、想法、待办）
 *
 * 历史遗留：二级分类上线前落在 `原始资料/` 根目录的文件按「文档」对待
 * （列表里归入文档分组、不改动用户磁盘上的文件）。
 *
 * 判定必须只从这里取：目录常量（config）、文件列表与上传/新建（routes/files）、
 * 收集箱入库（pipeline/inboxConvert）、对话沉积（lib/chat）、
 * Agent 写入规范（pipeline/rawMaterial、mcp/server）、目录树顺序（lib/vault）。
 * 避免把 '文档' 字面量散落到各处——漏一处就是分类不一致。
 */

/** 一级目录：原始资料 */
export const RAW_ROOT = '原始资料';
/** 二级目录：文档（成文的完整文件，也是新资料的默认落点） */
export const RAW_DOC_DIR = `${RAW_ROOT}/文档`;
/** 二级目录：对话（save_chat 专用） */
export const RAW_CHAT_DIR = `${RAW_ROOT}/对话`;
/** 二级目录：灵感碎片（随手记） */
export const RAW_IDEA_DIR = `${RAW_ROOT}/灵感碎片`;

export type RawSectionKey = 'doc' | 'chat' | 'idea';

export interface RawSection {
  key: RawSectionKey;
  /** vault 相对目录，如 原始资料/文档 */
  dir: string;
  /** 二级目录名，也是侧栏分组名 */
  label: string;
  /** 分组说明（侧栏 tooltip / 文档用） */
  hint: string;
}

/** 二级分类定义，顺序即侧栏与目录树的固定展示顺序 */
export const RAW_SECTIONS: readonly RawSection[] = [
  {
    key: 'doc',
    dir: RAW_DOC_DIR,
    label: '文档',
    hint: '成文的完整文件：会议纪要、调研报告、复盘、年报、教程、攻略、业绩表…',
  },
  {
    key: 'chat',
    dir: RAW_CHAT_DIR,
    label: '对话',
    hint: '与 Agent 的对话沉积（save_chat 写入，可按项目分目录）',
  },
  {
    key: 'idea',
    dir: RAW_IDEA_DIR,
    label: '灵感碎片',
    hint: '随手记：零散条目、想法、待办',
  },
] as const;

/** 三个二级目录名（目录树固定顺序用） */
export const RAW_SECTION_NAMES: readonly string[] = RAW_SECTIONS.map((s) => s.label);

/** 二级目录路径列表（固定目录预置、上传白名单用） */
export const RAW_SECTION_DIRS: readonly string[] = RAW_SECTIONS.map((s) => s.dir);

/** 新资料（上传 / 拖入 / 新建 / 收集箱入库 / Agent 保存）的默认二级目录 */
export const DEFAULT_RAW_DIR = RAW_DOC_DIR;

/** 统一成正斜杠、去掉首尾斜杠 */
function normalize(rel: string | null | undefined): string {
  return String(rel ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

/** 是否位于原始资料（含一级目录自身） */
export function isRawPath(rel: string | null | undefined): boolean {
  const p = normalize(rel);
  return p === RAW_ROOT || p.startsWith(`${RAW_ROOT}/`);
}

/** 是否对话沉积路径（save_chat 专用，Agent 不得写入） */
export function isRawChatPath(rel: string | null | undefined): boolean {
  const p = normalize(rel);
  return p === RAW_CHAT_DIR || p.startsWith(`${RAW_CHAT_DIR}/`);
}

/** 按 key 取二级分类定义 */
export function rawSectionByKey(key: string): RawSection | undefined {
  return RAW_SECTIONS.find((s) => s.key === key);
}

/** 是否二级目录本身（上传 / 新建落点校验用） */
export function isRawSectionDir(dir: string | null | undefined): boolean {
  return RAW_SECTION_DIRS.includes(normalize(dir));
}

/**
 * 路径 → 二级分类 key。
 * 根目录下的历史资料视作「文档」；不在三个二级目录内（如 assets 子目录、未知目录）返回 null。
 */
export function rawSectionOf(rel: string | null | undefined): RawSectionKey | null {
  const p = normalize(rel);
  if (!p.startsWith(`${RAW_ROOT}/`)) return null;
  const rest = p.slice(RAW_ROOT.length + 1);
  const head = rest.split('/')[0];
  const hit = RAW_SECTIONS.find((s) => s.label === head);
  if (hit) return hit.key;
  // 根目录直接挂着的文件（历史遗留）→ 文档
  return rest.includes('/') ? null : 'doc';
}
