/**
 * 首页自定义看板：模块清单 + 布局的纯逻辑（本地可跑单测，不碰 DOM / 网络 / 存储）。
 *
 * 契约（2026-10-05 首页改造）：
 *  - 首页 = 一串**模块**（module）的顺序列表，每块有自己的 kind（类型）、id（实例标识）、
 *    span（在 6 列栅格上占几列）与 opts（类型自己的少量选项，如条数 / 折叠状态）；
 *  - 用户可以加、删、改、拖：拖拽只动顺序，其余都由 store 落盘重排（见 stores/homeBoard.ts）；
 *  - 归一化是**容错入口**：localStorage 可能被手改、服务端设置可能来自旧版本或被写坏，
 *    任何解析不出来或名字不认识的东西都在这里被丢掉，绝不把脏数据渲染进界面；
 *  - 布局为空（用户删光了）与「数据坏了」必须区分：前者是合法的空看板，后者回默认布局。
 */

import type { TaskCard } from './taskBoard.ts';

/** 6 列栅格：full=整行、half=半行、third=三分之一行（列宽由组件里的容器查询决定折几列） */
export const MODULE_SPANS = ['full', 'half', 'third'] as const;
export type ModuleSpan = (typeof MODULE_SPANS)[number];

export const MODULE_KINDS = [
  'capture',
  'shortcuts',
  'recent',
  'notes',
  'tasks',
  'stats',
  'sections',
  'sync',
] as const;
export type ModuleKind = (typeof MODULE_KINDS)[number];

export interface HomeModule {
  /** 实例标识：新增时由 uid() 生成，只用于 key / 拖拽定位，重排时保持不变 */
  id: string;
  kind: ModuleKind;
  /** 标题覆盖：空串 = 用类型自带标题 */
  title: string;
  span: ModuleSpan;
  /** 类型自己的选项（数量、是否展开等），写坏的一律忽略并回落默认 */
  opts: Record<string, string | number | boolean>;
}

export interface HomeBoard {
  version: number;
  modules: HomeModule[];
}

/** 布局结构版本：以后模块字段变了靠它做迁移 */
export const HOME_BOARD_VERSION = 1;
/** 布局落盘用的设置键（服务端 /api/settings 的 PUBLIC_SETTINGS 白名单同名） */
export const HOME_LAYOUT_SETTING = 'home_layout';
/** 断网 / 旧服务端时的本地回退键 */
export const HOME_LAYOUT_STORAGE_KEY = 'homeBoardLayout';
/** 单页模块数上限：拖出一屏都是卡片没有意义，也防手改出的超大数组拖慢渲染 */
export const MAX_MODULES = 24;

export interface ModuleMeta {
  kind: ModuleKind;
  title: string;
  hint: string;
  icon: string;
  span: ModuleSpan;
}

/**
 * 模块类型登记表：顺序即「添加模块」面板里的顺序。
 * hint 是给用户看的一句话——说明这块会显示什么，而不是复述标题。
 */
export const MODULE_META: ModuleMeta[] = [
  { kind: 'capture', title: '快速记灵感', hint: '三行输入框，写完直接落进灵感碎片', icon: 'lightbulb', span: 'full' },
  { kind: 'shortcuts', title: '快捷入口', hint: '新建页面、搜索、图谱、Agent 等常用动作', icon: 'play', span: 'full' },
  { kind: 'recent', title: '最近更新', hint: '最近改动过的页面与灵感', icon: 'refresh', span: 'half' },
  { kind: 'notes', title: '近期灵感', hint: '原始资料里最新记下的几条', icon: 'lightbulb', span: 'half' },
  { kind: 'tasks', title: '近期待办', hint: '任务看板里逾期与最近要做的几件', icon: 'board', span: 'half' },
  { kind: 'stats', title: '知识库概览', hint: '概念 / 实体 / 原始资料的数量条', icon: 'report', span: 'half' },
  { kind: 'sections', title: '分区导航', hint: '按 Wiki 目录与原始资料分类进入', icon: 'folder', span: 'half' },
  { kind: 'sync', title: '多端同步状态', hint: '同步中 / 已完成；没配置同步时不显示', icon: 'plug', span: 'third' },
];

const META_BY_KIND: Record<ModuleKind, ModuleMeta> = Object.fromEntries(
  MODULE_META.map((meta) => [meta.kind, meta])
) as Record<ModuleKind, ModuleMeta>;

export function moduleMeta(kind: ModuleKind): ModuleMeta {
  return META_BY_KIND[kind];
}

export function isModuleKind(value: unknown): value is ModuleKind {
  return typeof value === 'string' && (MODULE_KINDS as readonly string[]).includes(value);
}

function isSpan(value: unknown): value is ModuleSpan {
  return typeof value === 'string' && (MODULE_SPANS as readonly string[]).includes(value);
}

/** 默认布局：与旧欢迎页的信息顺序一致（问候 → 速记 → 快捷入口 → 最近 / 待办 / 概览） */
export function defaultHomeBoard(): HomeBoard {
  return {
    version: HOME_BOARD_VERSION,
    modules: [
      { id: 'default-capture', kind: 'capture', title: '', span: 'full', opts: {} },
      { id: 'default-shortcuts', kind: 'shortcuts', title: '', span: 'full', opts: {} },
      { id: 'default-recent', kind: 'recent', title: '', span: 'half', opts: { limit: 6 } },
      { id: 'default-tasks', kind: 'tasks', title: '', span: 'half', opts: { limit: 3 } },
      { id: 'default-stats', kind: 'stats', title: '', span: 'half', opts: {} },
      { id: 'default-sync', kind: 'sync', title: '', span: 'third', opts: {} },
    ],
  };
}

/** 实例 id：时间戳 + 随机尾，保证同一会话内连点两次也不会撞 */
export function uid(prefix = 'm'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

const OPT_TEXT_MAX = 40;
const ID_MAX = 64;

/** 选项值只留字符串 / 有限数字 / 布尔：对象与数组直接丢掉，避免把任意结构带进渲染层 */
function normalizeOpts(raw: unknown, kind: ModuleKind): Record<string, string | number | boolean> {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, string | number | boolean> = {};
  const limit = kind === 'recent' || kind === 'notes' ? 12 : kind === 'tasks' ? 20 : 0;
  for (const [key, value] of Object.entries(source)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,23}$/.test(key)) continue;
    if (typeof value === 'string') {
      const text = value.trim().slice(0, OPT_TEXT_MAX);
      if (text) out[key] = text;
      continue;
    }
    if (typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  // 条数类选项收敛到 1..12：界面上的选择器只给几个档位，手改出的 999 不该真的渲染 999 行
  if (limit && (out.limit !== undefined || kind === 'recent' || kind === 'notes')) {
    const raw = Number(out.limit);
    out.limit = Number.isFinite(raw) ? Math.min(limit, Math.max(1, Math.round(raw))) : kind === 'tasks' ? 3 : 6;
  }
  return out;
}

function normalizeModule(raw: unknown): HomeModule | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (!isModuleKind(item.kind)) return null;
  const kind = item.kind;
  const rawId = typeof item.id === 'string' ? item.id.trim().slice(0, ID_MAX) : '';
  const rawTitle = typeof item.title === 'string' ? item.title.trim().replace(/\s+/g, ' ') : '';
  return {
    id: rawId || uid(),
    kind,
    title: rawTitle.slice(0, 24),
    span: isSpan(item.span) ? item.span : moduleMeta(kind).span,
    opts: normalizeOpts(item.opts, kind),
  };
}

/**
 * 任意来源（localStorage / 服务端设置 / 导入的 JSON）→ 合法布局。
 * 三档结果：解析不出来 → 默认布局；解析出来但模块全不合法 → 默认布局；合法的空数组 → 空看板。
 */
export function normalizeHomeBoard(raw: unknown): HomeBoard {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return defaultHomeBoard();
    try {
      parsed = JSON.parse(text);
    } catch {
      return defaultHomeBoard();
    }
  }
  // 裸数组不是布局（旧版存过的话也没有兼容包袱）：当成坏数据，连「合法的空看板」都不算
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaultHomeBoard();
  const source = parsed as Record<string, unknown>;
  if (!Array.isArray(source.modules)) return defaultHomeBoard();

  const seen = new Set<string>();
  const modules: HomeModule[] = [];
  for (const item of source.modules) {
    const module = normalizeModule(item);
    if (!module) continue;
    // 重复 id 会让拖拽定位错位：后一个改成新 id，宁可丢「它是谁」也不丢「它存在」
    if (seen.has(module.id)) module.id = uid();
    seen.add(module.id);
    modules.push(module);
    if (modules.length >= MAX_MODULES) break;
  }
  const version = Number(source.version);
  return { version: Number.isFinite(version) && version > 0 ? version : HOME_BOARD_VERSION, modules };
}

/** 布局 → 落盘的 JSON 字符串（服务端与 localStorage 共用同一份文本） */
export function serializeHomeBoard(board: HomeBoard): string {
  return JSON.stringify({ version: HOME_BOARD_VERSION, modules: board.modules });
}

/** 添加一块：追加到末尾并返回新布局（不改原对象） */
export function addModule(board: HomeBoard, kind: ModuleKind, id: string = uid()): HomeBoard {
  if (board.modules.length >= MAX_MODULES) return board;
  const meta = moduleMeta(kind);
  const module: HomeModule = { id, kind, title: '', span: meta.span, opts: normalizeOpts({}, kind) };
  return { ...board, modules: [...board.modules, module] };
}

export function removeModule(board: HomeBoard, id: string): HomeBoard {
  return { ...board, modules: board.modules.filter((module) => module.id !== id) };
}

export function updateModule(board: HomeBoard, id: string, patch: Partial<Omit<HomeModule, 'id' | 'kind'>>): HomeBoard {
  return {
    ...board,
    modules: board.modules.map((module) =>
      module.id === id
        ? {
            ...module,
            title: patch.title === undefined ? module.title : String(patch.title).trim().slice(0, 24),
            span: patch.span && isSpan(patch.span) ? patch.span : module.span,
            opts: patch.opts === undefined ? module.opts : normalizeOpts(patch.opts, module.kind),
          }
        : module
    ),
  };
}

/**
 * 把 toIndex 处的模块移到 fromIndex。越界索引一律夹到合法区间；
 * fromIndex === toIndex 时原样返回（拖动没越格不该产生一次写盘）。
 */
export function reorderModules(board: HomeBoard, fromIndex: number, toIndex: number): HomeBoard {
  const count = board.modules.length;
  if (count < 2) return board;
  const from = Math.min(count - 1, Math.max(0, fromIndex));
  const to = Math.min(count - 1, Math.max(0, toIndex));
  if (from === to) return board;
  const modules = [...board.modules];
  const [moved] = modules.splice(from, 1);
  modules.splice(to, 0, moved);
  return { ...board, modules };
}

/** 按 id 移动（拖拽层拿到的是 id，不是下标） */
export function reorderModuleById(board: HomeBoard, id: string, toIndex: number): HomeBoard {
  const from = board.modules.findIndex((module) => module.id === id);
  if (from < 0) return board;
  return reorderModules(board, from, toIndex);
}

/**
 * 拖拽落点 → 目标下标。
 *
 * 约定与界面一致：dropBefore 表示「插到 target 这一格之前」。往下拖时（源在目标前面），
 * 目标自身会因为先被拔掉而前移一格，所以插到它「之后」等于插到原下标处，插到它「之前」要减一。
 * 返回的已经是 splice 用的最终下标，调用方直接 reorderModules 即可。
 */
export function dropTargetIndex(fromIndex: number, targetIndex: number, dropBefore: boolean): number {
  if (dropBefore) return fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
  return fromIndex < targetIndex ? targetIndex : targetIndex + 1;
}

/** 键盘排序：把第 index 块左移 / 右移一格（在首尾时原样返回） */
export function moveModuleBy(board: HomeBoard, index: number, delta: number): HomeBoard {
  return reorderModules(board, index, index + delta);
}

/** 「最近更新」的候选：Wiki 非归档页 + 灵感碎片（接口已按更新时间倒序） */
export function recentPagesOf(pages: any[]): any[] {
  return (pages || []).filter(
    (p) => (String(p?.path || '').startsWith('Wiki/') && !String(p?.path || '').startsWith('Wiki/归档/'))
      || String(p?.path || '').startsWith('原始资料/灵感碎片/')
  );
}

/** 「近期灵感」：只取灵感碎片 */
export function ideaPagesOf(pages: any[]): any[] {
  return (pages || []).filter((p) => String(p?.path || '').startsWith('原始资料/灵感碎片/'));
}

/** 知识库概览的三类计数 */
export function kbCounts(pages: any[], files: number): { concepts: number; entities: number; files: number } {
  const list = pages || [];
  return {
    concepts: list.filter((p) => String(p?.path || '').startsWith('Wiki/概念/')).length,
    entities: list.filter((p) => String(p?.path || '').startsWith('Wiki/实体/')).length,
    files: Number(files) || 0,
  };
}

/** 分区导航：Wiki 顶层目录 + 原始资料二级目录的计数（原始资料三个固定二级目录没有的就不列） */
export interface SectionEntry {
  key: string;
  label: string;
  path: string;
  count: number;
}

export function sectionEntries(pages: any[], rawFiles: string[]): SectionEntry[] {
  const countUnder = (prefix: string) => (pages || []).filter((p) => String(p?.path || '').startsWith(prefix)).length;
  const entries: SectionEntry[] = [
    { key: 'concept', label: '概念', path: 'Wiki/概念', count: countUnder('Wiki/概念/') },
    { key: 'entity', label: '实体', path: 'Wiki/实体', count: countUnder('Wiki/实体/') },
    { key: 'project', label: '项目', path: 'Wiki/项目', count: countUnder('Wiki/项目/') },
    { key: 'archive', label: '归档', path: 'Wiki/归档', count: countUnder('Wiki/归档/') },
  ];
  const rawDirs: Array<[string, string]> = [
    ['doc', '原始资料/文档'],
    ['idea', '原始资料/灵感碎片'],
  ];
  for (const [key, dir] of rawDirs) {
    const count = (rawFiles || []).filter((path) => String(path || '').startsWith(`${dir}/`)).length;
    if (count > 0) entries.push({ key, label: dir.split('/').pop() as string, path: dir, count });
  }
  return entries;
}

/**
 * 「近期待办」要显示的前几条：逾期最优先，再按窗口内的日期顺序，周期与待定垫后。
 * 与旧欢迎页同一口径（`overdue → day → periodic → later`）。
 */
export function upcomingTasks(
  dayBuckets: Array<{ bucket: string; cards: TaskCard[] }>,
  limit: number
): TaskCard[] {
  const pick = (bucket: string) => dayBuckets.filter((b) => b.bucket === bucket).flatMap((b) => b.cards);
  const ordered = [...pick('overdue'), ...pick('day'), ...pick('periodic'), ...pick('later')];
  const max = Math.max(1, Math.min(20, Math.round(limit) || 3));
  return ordered.slice(0, max);
}

/** 选项里的条数：缺省 / 非法回落 fallback，并夹到 1..max */
export function limitOf(opts: Record<string, unknown> | undefined, fallback: number, max: number): number {
  const raw = Number(opts?.limit);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.round(raw)));
}
