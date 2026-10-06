/**
 * 首页自定义看板：模块清单 + 布局的纯逻辑（本地可跑单测，不碰 DOM / 网络 / 存储）。
 *
 * 契约（2026-10-05 首页改造，2026-10-06 加「可调列数 + 更多模块」）：
 *  - 首页 = 一串**模块**（module）的顺序列表，每块有自己的 kind（类型）、id（实例标识）、
 *    span（占几格）与 opts（类型自己的少量选项，如条数 / 折叠状态）；
 *  - 整页栅格是**可配置列数**（HOME_BOARD_COLUMNS，2–5 列）：用户在编辑态里改，
 *    span 是**相对格数**，所以换列数时每块的相对宽窄不变（1 格 = 页宽的 1/N，4 列里 2 格 = 一半）；
 *  - 用户可以加、删、改、拖：拖拽只动顺序，其余都由 store 落盘重排（见 stores/homeBoard.ts）；
 *  - 归一化是**容错入口**：localStorage 可能被手改、服务端设置可能来自旧版本或被写坏，
 *    任何解析不出来或名字不认识的东西都在这里被丢掉，绝不把脏数据渲染进界面；
 *  - 布局为空（用户删光了）与「数据坏了」必须区分：前者是合法的空看板，后者回默认布局。
 */

import type { TaskCard } from './taskBoard.ts';

/** 整页可选的栅格列数（编辑态里切换） */
export const HOME_BOARD_COLUMNS = [2, 3, 4, 5] as const;
export type BoardColumns = (typeof HOME_BOARD_COLUMNS)[number];
export const DEFAULT_BOARD_COLUMNS: BoardColumns = 4;

/**
 * 模块占的**格数**：1 格 = 页宽的 1/列数。瀑布流里的实际含义分两档（见 lib/masonry.ts）：
 *  - 窄道：span 1–2 → 在「半宽车道」里并排（1 格 = 1/4 页、2 格 = 1/2 页）；
 *  - 整行：span = 整页列数 → 单独占一整行（看板快照、Agent 摘要这类要宽）；
 * 中间那些（3 格 / 4 格）在窄屏不会真的按 3/4 宽渲染，而是落进「最矮的那条车道」——瀑布流的本意。
 */
export const MODULE_SPANS = [1, 2, 3, 4, 5] as const;
export type ModuleSpan = (typeof MODULE_SPANS)[number];
/** 格数上限（= MODULE_SPANS 的最大值）：归一化与夹取都用它 */
const MAX_SPAN: ModuleSpan = 5;

/**
 * 「整行」在默认 4 列页面上的格数。登记表要在 defaultHomeBoard() 之前用到它，
 * 所以定为常量：换默认列数时只改这里与 DEFAULT_BOARD_COLUMNS 两处。
 */
const FULL_SPAN: ModuleSpan = 4;

export const MODULE_KINDS = [
  'capture',
  'shortcuts',
  'recent',
  'notes',
  'fresh',
  'tasks',
  'stats',
  'weekly',
  'tags',
  'sections',
  'roam',
  'system',
  'sync',
  // 2026-10-06 卡片库第二批（客户端就能算的那些）
  'ring',
  'heat',
  'inbox',
  'queue',
  'board',
  'activity',
  'digest',
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
  /** 整页栅格列数（2–5）；界面在窄屏会自动少排，但这里存的是用户选的值 */
  columns: BoardColumns;
  modules: HomeModule[];
}

/** 布局结构版本：以后模块字段变了靠它做迁移（v2 = 加入 columns 字段与相对格数 span） */
export const HOME_BOARD_VERSION = 2;
/** 布局落盘用的设置键（服务端 /api/settings 的 PUBLIC_SETTINGS 白名单同名） */
export const HOME_LAYOUT_SETTING = 'home_layout';
/** 断网 / 旧服务端时的本地回退键 */
export const HOME_LAYOUT_STORAGE_KEY = 'homeBoardLayout';
/** 单页模块数上限：拖出一屏都是卡片没有意义，也防手改出的超大数组拖慢渲染 */
export const MAX_MODULES = 32;

export interface ModuleMeta {
  kind: ModuleKind;
  title: string;
  hint: string;
  icon: string;
  /** 新增时的默认格数（相对格） */
  span: ModuleSpan;
}

/**
 * 模块类型登记表：顺序即「添加模块」面板里的顺序。
 * hint 是给用户看的一句话——说明这块会显示什么，而不是复述标题。
 * span 默认值按「新增时的观感」给：宽卡（速记 / 快捷入口 / 看板快照 / 摘要）给整行，
 * 半宽卡给 2，其余小卡给 1——加到页面上就能直接用，不用先调宽度。
 */
export const MODULE_META: ModuleMeta[] = [
  { kind: 'capture', title: '快速记灵感', hint: '三行输入框，写完直接落进灵感碎片', icon: 'lightbulb', span: FULL_SPAN },
  { kind: 'shortcuts', title: '快捷入口', hint: '新建页面、搜索、图谱、Agent 等常用动作', icon: 'play', span: FULL_SPAN },
  { kind: 'recent', title: '最近更新', hint: '最近改动过的页面与灵感', icon: 'refresh', span: 2 },
  { kind: 'notes', title: '近期灵感', hint: '原始资料里最新记下的几条', icon: 'lightbulb', span: 1 },
  { kind: 'fresh', title: '本周新增', hint: '最近 7 天新写出来的页面', icon: 'plus', span: 1 },
  { kind: 'tasks', title: '近期待办', hint: '任务看板里逾期与最近要做的几件', icon: 'board', span: 2 },
  { kind: 'stats', title: '知识库概览', hint: '概念 / 实体 / 原始资料的数量与知识库规模', icon: 'report', span: 1 },
  { kind: 'weekly', title: '本周动态', hint: '一周里新增与改动的字数分布', icon: 'activity', span: 1 },
  { kind: 'tags', title: '常用标签', hint: '库里出现最多的标签，点一个去搜', icon: 'hash', span: 1 },
  { kind: 'sections', title: '分区导航', hint: '按 Wiki 目录与原始资料分类进入', icon: 'folder', span: 1 },
  { kind: 'roam', title: '随机漫游', hint: '随手翻到一篇，看看以前写过什么', icon: 'compass', span: 1 },
  { kind: 'system', title: '运行状态', hint: '版本、运行形态、队列与同步一句话说完', icon: 'server', span: 1 },
  { kind: 'sync', title: '多端同步状态', hint: '同步中 / 已完成的通道与进度', icon: 'plug', span: 1 },
  { kind: 'ring', title: '库占比', hint: '概念 / 实体 / 资料 的占比环 + 总数', icon: 'graph', span: 1 },
  { kind: 'heat', title: '近 8 周', hint: '按天统计改动热度，一眼看出最近勤不勤', icon: 'activity', span: 1 },
  { kind: 'inbox', title: '收集箱', hint: '待整理的原始件与转换进度', icon: 'inbox', span: 1 },
  { kind: 'queue', title: '等待提炼', hint: '刚落盘还没进 Wiki 的资料与灵感', icon: 'merge', span: 1 },
  { kind: 'board', title: '看板快照', hint: '任务看板三列各几条，点开进看板', icon: 'board', span: FULL_SPAN },
  { kind: 'activity', title: '最近改动', hint: '最近动过的页面，按时间倒着排', icon: 'restore', span: 1 },
  { kind: 'digest', title: 'Agent 摘要', hint: '用一句话说清最近值得看什么', icon: 'ai', span: FULL_SPAN },
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

/** 是不是合法的整页列数 */
export function isBoardColumns(value: unknown): value is BoardColumns {
  return typeof value === 'number' && (HOME_BOARD_COLUMNS as readonly number[]).includes(value);
}

/** 任意输入 → 合法列数（缺省 / 非法回默认 4 列） */
export function normalizeColumns(value: unknown): BoardColumns {
  const raw = Number(value);
  return isBoardColumns(raw) ? raw : DEFAULT_BOARD_COLUMNS;
}

/** 相对格数：合法的 1/2/3，其它一律回落到该类型的默认格数 */
function isSpan(value: unknown): value is ModuleSpan {
  return typeof value === 'number' && (MODULE_SPANS as readonly number[]).includes(value);
}

/** 把格数夹到「1..不超过整页列数」：4 列的页面上不存在占 5 格的东西 */
export function clampSpan(span: number, columns: BoardColumns): ModuleSpan {
  const max = Math.max(1, Math.min(MAX_SPAN, columns));
  const raw = Number.isFinite(span) ? Math.round(span) : 1;
  return Math.max(1, Math.min(max, raw)) as ModuleSpan;
}

/**
 * 某一列数下可选的宽度档：1 格 = 1/列数，到列数那一档叫「整行」。
 * 标签按**页宽比例**给（4 列给 1/4 · 1/2 · 3/4 · 整行），所以用户看到的和实际宽度对得上；
 * 列数是 2 时只有两档（1 格 / 整行），不会画一排没区别的按钮。
 */
export function spanOptionsFor(columns: BoardColumns): Array<{ value: ModuleSpan; label: string; hint: string }> {
  const out: Array<{ value: ModuleSpan; label: string; hint: string }> = [];
  for (const span of MODULE_SPANS) {
    if (span > columns) continue;
    if (span >= columns) {
      out.push({ value: span, label: '整行', hint: '单独占一整行（宽卡用这档）' });
      continue;
    }
    // 1/2 与 1/4 直接写成分数（比 50% / 25% 好读），其余照百分比
    const label = span === 1 ? `1/${columns}` : span * 2 === columns ? '1/2' : `${Math.round((span / columns) * 100)}%`;
    out.push({ value: span, label, hint: `占页宽的 ${Math.round((span / columns) * 100)}%（${columns} 列里的 ${span} 格）` });
  }
  return out;
}

/** 默认布局：旧欢迎页的信息顺序（问候 → 速记 → 快捷入口 → 最近 / 待办 / 概览），4 列 */
export function defaultHomeBoard(): HomeBoard {
  return {
    version: HOME_BOARD_VERSION,
    columns: DEFAULT_BOARD_COLUMNS,
    modules: [
      // 两张宽卡占整行（4 格），其余半宽：瀑布流里就是「整行 + 两两并排」的观感
      { id: 'default-capture', kind: 'capture', title: '', span: FULL_SPAN, opts: {} },
      { id: 'default-shortcuts', kind: 'shortcuts', title: '', span: FULL_SPAN, opts: {} },
      { id: 'default-recent', kind: 'recent', title: '', span: 2, opts: { limit: 6 } },
      { id: 'default-tasks', kind: 'tasks', title: '', span: 2, opts: { limit: 3 } },
      { id: 'default-stats', kind: 'stats', title: '', span: 2, opts: {} },
      { id: 'default-sync', kind: 'sync', title: '', span: 2, opts: {} },
    ],
  };
}

/** 实例 id：时间戳 + 随机尾，保证同一会话内连点两次也不会撞 */
export function uid(prefix = 'm'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

const OPT_TEXT_MAX = 40;
const ID_MAX = 64;

/** 列表类模块的条数上限（未列出的 = 这个模块没有「显示几条」这项） */
const LIMIT_KINDS: Partial<Record<ModuleKind, number>> = {
  recent: 12,
  notes: 12,
  fresh: 12,
  tasks: 20,
  // 「近 8 周」的 stepper 调的是周数：4–12 周
  heat: 12,
};
/** 列表类模块的默认条数 */
export const DEFAULT_LIMIT: Partial<Record<ModuleKind, number>> = {
  recent: 6,
  notes: 4,
  fresh: 5,
  tasks: 3,
  heat: 8,
};
/** 条数下限（heat 的周数至少要 4 周，少于 4 周看不出节奏） */
export const MIN_LIMIT: Partial<Record<ModuleKind, number>> = {
  heat: 4,
};

/** 选项值只留字符串 / 有限数字 / 布尔：对象与数组直接丢掉，避免把任意结构带进渲染层 */
function normalizeOpts(raw: unknown, kind: ModuleKind): Record<string, string | number | boolean> {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, string | number | boolean> = {};
  const limit = LIMIT_KINDS[kind];
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
  // 条数类选项收敛到 1..上限：界面上的选择器只给几个档位，手改出的 999 不该真的渲染 999 行
  if (limit && (out.limit !== undefined || DEFAULT_LIMIT[kind] !== undefined)) {
    const raw = Number(out.limit);
    const min = MIN_LIMIT[kind] || 1;
    out.limit = Number.isFinite(raw) ? Math.min(limit, Math.max(min, Math.round(raw))) : (DEFAULT_LIMIT[kind] || 6);
  }
  return out;
}

/**
 * v1 的 span 是字符串（full / half / third，对着当时写死的 3 列），v2 改成相对格数。
 * 迁移表：full→3 格、half→2 格、third→1 格；列数按 v1 的 4 列语义补默认值。
 */
const LEGACY_SPAN: Record<string, ModuleSpan> = { full: 3, half: 2, third: 1 };

function normalizeModule(raw: unknown, columns: BoardColumns): HomeModule | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (!isModuleKind(item.kind)) return null;
  const kind = item.kind;
  const rawId = typeof item.id === 'string' ? item.id.trim().slice(0, ID_MAX) : '';
  const rawTitle = typeof item.title === 'string' ? item.title.trim().replace(/\s+/g, ' ') : '';
  const meta = moduleMeta(kind);
  const legacy = typeof item.span === 'string' ? LEGACY_SPAN[item.span] : undefined;
  const span = isSpan(item.span) ? item.span : legacy ?? meta.span;
  return {
    id: rawId || uid(),
    kind,
    title: rawTitle.slice(0, 24),
    span: clampSpan(span, columns),
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

  const columns = normalizeColumns(source.columns);
  const seen = new Set<string>();
  const modules: HomeModule[] = [];
  for (const item of source.modules) {
    const module = normalizeModule(item, columns);
    if (!module) continue;
    // 重复 id 会让拖拽定位错位：后一个改成新 id，宁可丢「它是谁」也不丢「它存在」
    if (seen.has(module.id)) module.id = uid();
    seen.add(module.id);
    modules.push(module);
    if (modules.length >= MAX_MODULES) break;
  }
  const version = Number(source.version);
  return {
    version: Number.isFinite(version) && version > 0 ? version : HOME_BOARD_VERSION,
    columns,
    modules,
  };
}

/** 布局 → 落盘的 JSON 字符串（服务端与 localStorage 共用同一份文本） */
export function serializeHomeBoard(board: HomeBoard): string {
  return JSON.stringify({ version: HOME_BOARD_VERSION, columns: board.columns, modules: board.modules });
}

/** 换整页列数：把所有模块的格数夹到新列数以内（5 列的页里没有 6 格的东西） */
export function setColumns(board: HomeBoard, columns: BoardColumns): HomeBoard {
  const next = normalizeColumns(columns);
  if (next === board.columns) return board;
  return {
    ...board,
    columns: next,
    modules: board.modules.map((module) => ({ ...module, span: clampSpan(module.span, next) })),
  };
}

/** 添加一块：追加到末尾并返回新布局（不改原对象） */
export function addModule(board: HomeBoard, kind: ModuleKind, id: string = uid()): HomeBoard {
  if (board.modules.length >= MAX_MODULES) return board;
  const meta = moduleMeta(kind);
  const module: HomeModule = {
    id,
    kind,
    title: '',
    span: clampSpan(meta.span, board.columns),
    opts: normalizeOpts({}, kind),
  };
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
            // 先夹再判：patch.span 可能是任意数（手改的 JSON），交给 clampSpan 收敛到 1..列数
            span: patch.span === undefined ? module.span : clampSpan(Number(patch.span), board.columns),
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

/* ===== 2026-10-06 新增模块的数据口径（都是纯函数，给数据就能算） ===== */

/** 页面的时间戳字段容错：坏值 / 缺省返回 0（排序时自然垫到最后） */
export function pageTime(page: any, field: 'created_at' | 'updated_at' = 'created_at'): number {
  const raw = page?.[field];
  const at = raw ? new Date(String(raw)).getTime() : NaN;
  return Number.isFinite(at) ? at : 0;
}

/** 「本周新增」：最近 days 天里**创建**的页面（归档页不算，灵感碎片算） */
export function freshPagesOf(pages: any[], days = 7, now: number = Date.now()): any[] {
  const since = now - days * 86_400_000;
  return (pages || [])
    .filter((p) => {
      const path = String(p?.path || '');
      if (path.startsWith('Wiki/归档/')) return false;
      if (!path.startsWith('Wiki/') && !path.startsWith('原始资料/灵感碎片/')) return false;
      const at = pageTime(p, 'created_at');
      return at > 0 && at >= since && at <= now;
    })
    .sort((left, right) => pageTime(right, 'created_at') - pageTime(left, 'created_at'));
}

/** 「随机漫游」的候选池：Wiki 非归档页 + 灵感碎片（与「最近更新」同一口径，但不排序） */
export function roamPool(pages: any[]): any[] {
  return recentPagesOf(pages);
}

/** 从候选池里挑一个（avoidId 用于「换一个」时避开当前这篇；池子只有一篇时只好还它） */
export function pickRoamPage(pages: any[], avoidId = '', random: () => number = Math.random): any | null {
  const pool = roamPool(pages);
  if (!pool.length) return null;
  const candidates = pool.length > 1 && avoidId ? pool.filter((p) => String(p?.id) !== avoidId) : pool;
  const list = candidates.length ? candidates : pool;
  const index = Math.min(list.length - 1, Math.max(0, Math.floor(random() * list.length)));
  return list[index];
}

/** 「本周动态」行：一类页面的新增 / 改动字数 */
export interface WeeklyStat {
  key: string;
  label: string;
  created: number;
  updated: number;
  words: number;
}

/** 「本周动态」统计：最近 days 天里新增 / 改动的页面数与字数，按 Wiki 分区归类 */
export function weeklyStats(pages: any[], days = 7, now: number = Date.now()): WeeklyStat[] {
  const groups: Array<{ key: string; label: string; match: (path: string) => boolean }> = [
    { key: 'concept', label: '概念', match: (p) => p.startsWith('Wiki/概念/') },
    { key: 'entity', label: '实体', match: (p) => p.startsWith('Wiki/实体/') },
    { key: 'note', label: '其它页面', match: (p) => p.startsWith('Wiki/') && !p.startsWith('Wiki/归档/') },
    { key: 'idea', label: '灵感碎片', match: (p) => p.startsWith('原始资料/灵感碎片/') },
  ];
  const since = now - days * 86_400_000;
  const counters = groups.map((group) => ({
    key: group.key,
    label: group.label,
    created: 0,
    updated: 0,
    words: 0,
  }));
  for (const page of pages || []) {
    const path = String(page?.path || '');
    if (path.startsWith('Wiki/归档/')) continue;
    const created = pageTime(page, 'created_at');
    const updated = pageTime(page, 'updated_at');
    if (created < since && updated < since) continue;
    const index = groups.findIndex((group) => group.match(path));
    if (index < 0) continue;
    const row = counters[index];
    if (created >= since) row.created += 1;
    if (updated >= since) row.updated += 1;
    row.words += Math.max(0, Number(page?.word_count) || 0);
  }
  return counters.filter((row) => row.created || row.updated);
}

/** 标签计数（「常用标签」用）：wiki 页的 tags 字段是 JSON 数组，坏值当没有 */
export function tagCounts(pages: any[], limit = 12): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const page of pages || []) {
    if (!String(page?.path || '').startsWith('Wiki/') || String(page?.path || '').startsWith('Wiki/归档/')) continue;
    let tags: unknown = page?.tags;
    if (typeof tags === 'string') {
      try {
        tags = JSON.parse(tags);
      } catch {
        continue;
      }
    }
    if (!Array.isArray(tags)) continue;
    for (const tag of tags) {
      const text = String(tag || '').trim();
      if (!text) continue;
      counts.set(text, (counts.get(text) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag, 'zh-Hans-CN'))
    .slice(0, Math.max(1, limit));
}

/* ===== 2026-10-06 卡片库第二批（客户端就能算） ===== */

/** 「库占比」：三类页面的数量与占比（环里放最多的那一类） */
export interface RatioRow {
  key: string;
  label: string;
  value: number;
  ratio: number;
}

export function ratioRows(pages: any[], files: number): { rows: RatioRow[]; total: number } {
  const counts = kbCounts(pages, files);
  const rows: RatioRow[] = [
    { key: 'concept', label: '概念', value: counts.concepts, ratio: 0 },
    { key: 'entity', label: '实体', value: counts.entities, ratio: 0 },
    { key: 'file', label: '资料', value: counts.files, ratio: 0 },
  ];
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  for (const row of rows) row.ratio = total > 0 ? row.value / total : 0;
  return { rows, total };
}

/** 「近 8 周」热力格：按天统计「有改动的页面数」，返回 weeks×7 的格子（周日开头，与日历观感一致） */
export interface HeatCell {
  /** YYYY-MM-DD（本地日） */
  date: string;
  count: number;
  /** 0–4 档，供组件上色 */
  level: 0 | 1 | 2 | 3 | 4;
  /** 今天以后的格子：不画（未来没有「改动」这回事） */
  future: boolean;
}

export function heatmapDayCounts(pages: any[], weeks = 8, now: number = Date.now()): HeatCell[] {
  const span = Math.min(12, Math.max(4, Math.round(weeks) || 8));
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  // 对齐到本周日：最后一格是「本周日」，往前铺 7×weeks 天
  const end = new Date(today);
  end.setDate(end.getDate() + (6 - today.getDay()));
  const start = new Date(end);
  start.setDate(start.getDate() - (span * 7 - 1));

  const byDay = new Map<string, number>();
  for (const page of pages || []) {
    const at = pageTime(page, 'updated_at');
    if (!at) continue;
    const day = new Date(at);
    day.setHours(0, 0, 0, 0);
    if (day < start || day > end) continue;
    const key = isoDay(day);
    byDay.set(key, (byDay.get(key) || 0) + 1);
  }

  const counts = [...byDay.values()];
  const max = counts.length ? Math.max(...counts) : 0;
  const levelOf = (value: number): 0 | 1 | 2 | 3 | 4 => {
    if (!value || !max) return 0;
    const ratio = value / max;
    if (ratio > 0.75) return 4;
    if (ratio > 0.5) return 3;
    if (ratio > 0.25) return 2;
    return 1;
  };

  const cells: HeatCell[] = [];
  for (let at = new Date(start); at <= end; at.setDate(at.getDate() + 1)) {
    const key = isoDay(at);
    const count = byDay.get(key) || 0;
    cells.push({ date: key, count, level: levelOf(count), future: at > today });
  }
  return cells;
}

/** 本地日的 YYYY-MM-DD */
function isoDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 「等待提炼」：最近改动过、但还没被引用的原始资料与灵感（数据口径与旧版「最近更新」一致） */
export function pendingDistillOf(pages: any[], limit = 4): any[] {
  return (pages || [])
    .filter((page) => String(page?.path || '').startsWith('原始资料/'))
    .filter((page) => !String(page?.path || '').startsWith('原始资料/对话/'))
    .slice(0, Math.max(1, limit));
}

/** 「Agent 摘要」里的一句人话：近 7 天哪块动得最多 */
export function busiestSection(pages: any[], days = 7, now: number = Date.now()): { label: string; count: number } | null {
  const rows = weeklyStats(pages, days, now);
  if (!rows.length) return null;
  const top = [...rows].sort((left, right) => right.updated + right.created - (left.updated + left.created))[0];
  return { label: top.label, count: top.updated + top.created };
}

/** 「Agent 摘要」：把库存量、近 7 天动静与待办拼成一句话（不调模型，纯本地拼） */
export function homeDigest(input: {
  pages: any[];
  files: number;
  taskCount: number;
  inboxPending: number;
  days?: number;
  now?: number;
}): string[] {
  const days = input.days ?? 7;
  const now = input.now ?? Date.now();
  const pages = input.pages || [];
  const fresh = freshPagesOf(pages, days, now).length;
  const weekly = weeklyStats(pages, days, now);
  const changed = weekly.reduce((sum, row) => sum + row.updated, 0);
  const busiest = busiestSection(pages, days, now);
  const lines: string[] = [];

  if (fresh || changed) {
    const parts: string[] = [];
    if (fresh) parts.push(`新增 ${fresh} 篇`);
    if (changed) parts.push(`改动 ${changed} 篇`);
    lines.push(`近 ${days} 天${parts.join('、')}${busiest ? `，${busiest.label}动得最多（${busiest.count} 次）` : ''}。`);
  } else {
    lines.push(`近 ${days} 天库里没有新的改动。`);
  }

  if (input.taskCount) lines.push(`看板上还有 ${input.taskCount} 件待办，逾期与最近要做的排在前面。`);
  if (input.inboxPending) lines.push(`收集箱里 ${input.inboxPending} 份原件还没整理。`);
  if (!input.taskCount && !input.inboxPending) lines.push(`待办与收集箱都清空了。`);
  return lines;
}

