/**
 * 首页看板的纯逻辑：模块注册、坐标布局、旧数据迁移及真实数据统计。
 * 栅格列数由 homeGrid.GRID_COLS 决定（2026-10-08 起 12 列），位置由用户选择；
 * 拖动碰撞让位，只有手动整理才消除留白。
 * 合法的空看板保持为空，读取时只修复坏值、重复 id 和重叠。
 */

import type { TaskCard } from './taskBoard.ts';
import {
  GRID_COLS,
  GRID_MAX_ROWS,
  autoArrange,
  clampH,
  clampW,
  compact,
  findFreeSpot,
  intersects,
  normalizePlace,
  placeItem,
  type GridPlace,
} from './homeGrid.ts';

/**
 * 整页栅格：固定 GRID_COLS 列（2026-10-07「手机桌面」模式）。
 *
 * 与上一版瀑布流的区别：位置由**用户**决定（拖动改起点、缩放改宽高），不再由算法推导。
 * 老数据（v2 的 columns + span 相对格数）在读取时迁移成栅格坐标，原样保留用户的意思。
 */
export type BoardColumns = typeof GRID_COLS;
export const HOME_BOARD_COLUMNS = [GRID_COLS] as const;
export const DEFAULT_BOARD_COLUMNS: BoardColumns = GRID_COLS;

/** 卡片默认格数（列 × 行）与可选范围都由 homeGrid 定义，这里只放各模块的默认观感 */
export const MODULE_SPANS = [2, 3, 4, 6, 8, 12] as const;
export type ModuleSpan = (typeof MODULE_SPANS)[number];

/**
 * 模块占的**格数**（12 列栅格上的列数）：4 格 = 1/3 页、6 格 = 半页、8 格 = 2/3、12 格 = 整行。
 * 高度另算（w × h 才是一张卡的大小），见 ModuleMeta.h。
 */
const DEFAULT_WIDE = 12;
const DEFAULT_HALF = 6;
const DEFAULT_THIRD = 4;

/**
 * 「整行」在默认布局里的格数：登记表在 defaultHomeBoard() 之前用到它，
 * 所以定为常量（换栅格列数时只改这里与 GRID_COLS 两处）。
 */
const FULL_SPAN: ModuleSpan = DEFAULT_WIDE;

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
  /** 栅格位置（v3 起）：col/row 起点 + w/h 跨几列几行 */
  col: number;
  row: number;
  /** 宽度（格）：1..GRID_COLS。拖把手可以拖出中间值，所以是 number 不是档位联合 */
  w: number;
  /** 高度（行）：1..12 */
  h: number;
  /** 类型自己的选项（数量、是否展开等），写坏的一律忽略并回落默认 */
  opts: Record<string, string | number | boolean>;
}

export interface HomeBoard {
  version: number;
  /** 整页栅格列数：v3 起固定（见 homeGrid.GRID_COLS，2026-10-08 起 12 列）；保留字段是为了读得懂旧数据 */
  columns: number;
  modules: HomeModule[];
}

/**
 * v2：相对宽度；v3：坐标；v4：保留留白、首次补热力卡；
 * v5（2026-10-08）：栅格 6 列 → 12 列。v5 之前的坐标与格数都是 6 列口径，
 * 读取时统一 ×2（col/w/h 一起），视觉大小不变、只是格数变细。
 */
export const HOME_BOARD_VERSION = 5;
/** v5 之前每行/每列对应的格数：迁移时统一按这个倍数换算 */
const LEGACY_GRID_SCALE = 2;
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
  /** 新增时的默认宽度（12 列栅格上的格数） */
  w: ModuleSpan;
  /** 新增时的默认高度（行数） */
  h: number;
}

/**
 * 模块类型登记表：顺序即「添加模块」面板里的顺序。
 * hint 是给用户看的一句话——说明这块会显示什么，而不是复述标题。
 * 默认 w/h 按「加到页面上就能直接用」给：宽卡整行、统计卡三分之一、列表卡半页 + 高一点。
 * 12 列栅格下一格约 75px（板宽上限 1120px 时），所以这里的 h 是「1 格 = 一行 75px」的行数。
 */
export const MODULE_META: ModuleMeta[] = [
  { kind: 'capture', title: '快速记灵感', hint: 'A 紧凑单行 / B 多行书写，一格高也能直接输入', icon: 'lightbulb', w: DEFAULT_THIRD, h: 4 },
  { kind: 'shortcuts', title: '快捷入口', hint: '新建页面、搜索、图谱、Agent 等常用动作', icon: 'play', w: DEFAULT_HALF, h: 2 },
  { kind: 'recent', title: '最近更新', hint: '最近改动过的页面与灵感', icon: 'refresh', w: DEFAULT_HALF, h: 10 },
  { kind: 'notes', title: '近期灵感', hint: '原始资料里最新记下的几条', icon: 'lightbulb', w: DEFAULT_HALF, h: 8 },
  { kind: 'fresh', title: '本周新增', hint: '最近 7 天新写出来的页面', icon: 'plus', w: DEFAULT_HALF, h: 8 },
  { kind: 'tasks', title: '近期待办', hint: '任务看板里逾期与最近要做的几件', icon: 'board', w: DEFAULT_HALF, h: 8 },
  { kind: 'stats', title: '知识库概览', hint: '概念 / 实体 / 原始资料的数量与知识库规模', icon: 'report', w: DEFAULT_THIRD, h: 8 },
  { kind: 'weekly', title: '本周动态', hint: '一周里新增与改动的字数分布', icon: 'activity', w: DEFAULT_THIRD, h: 6 },
  { kind: 'tags', title: '常用标签', hint: '库里出现最多的标签，点一个去搜', icon: 'hash', w: DEFAULT_THIRD, h: 6 },
  { kind: 'sections', title: '分区导航', hint: '按 Wiki 目录与原始资料分类进入', icon: 'folder', w: DEFAULT_THIRD, h: 6 },
  { kind: 'roam', title: '随机漫游', hint: '随手翻到一篇，看看以前写过什么', icon: 'compass', w: DEFAULT_THIRD, h: 6 },
  { kind: 'system', title: '运行状态', hint: '版本、运行形态、队列与同步一句话说完', icon: 'server', w: DEFAULT_HALF, h: 6 },
  { kind: 'sync', title: '多端同步状态', hint: '同步中 / 已完成的通道与进度', icon: 'plug', w: DEFAULT_HALF, h: 6 },
  { kind: 'ring', title: '库占比', hint: '概念 / 实体 / 资料 的占比环 + 总数', icon: 'graph', w: DEFAULT_THIRD, h: 8 },
  { kind: 'heat', title: '知识热力', hint: '近 4–12 周页面最近改动的日期分布', icon: 'activity', w: DEFAULT_THIRD, h: 4 },
  { kind: 'inbox', title: '收集箱', hint: '待整理的原始件与转换进度', icon: 'inbox', w: DEFAULT_THIRD, h: 6 },
  { kind: 'queue', title: '等待提炼', hint: '尚未提炼的真实资料清单，包含文档、对话与灵感', icon: 'merge', w: DEFAULT_HALF, h: 6 },
  { kind: 'board', title: '看板快照', hint: '任务看板三列各几条，点开进看板', icon: 'board', w: FULL_SPAN, h: 6 },
  { kind: 'activity', title: '最近改动', hint: '最近动过的页面，按时间倒着排', icon: 'restore', w: DEFAULT_HALF, h: 8 },
  { kind: 'digest', title: 'Agent 摘要', hint: '用一句话说清最近值得看什么', icon: 'ai', w: DEFAULT_HALF, h: 6 },
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

/** 是不是合法的整页列数（v3 起固定 GRID_COLS 列，旧值一律读成它） */
export function isBoardColumns(value: unknown): value is BoardColumns {
  return Number(value) === GRID_COLS;
}

/** 任意输入 → 合法列数（旧数据的 2/3/4/5/6 也会归一到当前列数） */
export function normalizeColumns(_value?: unknown): BoardColumns {
  return DEFAULT_BOARD_COLUMNS;
}

/**
 * 宽度档：12 列栅格上是 2 / 3 / 4 / 6 / 8 / 12 格（`1/6` · `1/4` · `1/3` · `1/2` · `2/3` · `整行`）。
 * 标签给的是**页宽比例**，与卡片实际宽度一一对应；拖动缩放时这些只是快捷键。
 */
export function spanOptionsFor(_columns: BoardColumns = DEFAULT_BOARD_COLUMNS): Array<{ value: ModuleSpan; label: string; hint: string }> {
  return MODULE_SPANS.map((span) => {
    const hint = `占页宽的 ${Math.round((span / GRID_COLS) * 100)}%（${GRID_COLS} 列里的 ${span} 格）`;
    if (span >= GRID_COLS) return { value: span, label: '整行', hint: '占满一整行（宽卡用这档）' };
    // 能约成「几分之一」的写成分数（1/3、1/2），约不尽的写几分之几（8/12 而不是 2/3）
    const divisor = GRID_COLS / span;
    const label = Number.isInteger(divisor) ? `1/${divisor}` : `${span}/${GRID_COLS}`;
    return { value: span, label, hint };
  });
}

/** 高度档：按行给 2–12 行（拖右下角可以任意调，这里是键盘/菜单的快捷档） */
export const HEIGHT_STEPS = [2, 3, 4, 6, 8, 12] as const;

/**
 * 默认工作台：概览、速记、待办分列；灵感和热力格居中，快捷入口用横条、同步用 1×1 小磁贴。
 * 坐标与格数都是 12 列栅格下的值（一格约 75px，1×1 就是手机图标大小）。
 */
export function defaultHomeBoard(): HomeBoard {
  const items: Array<{ id: string; kind: ModuleKind; place: GridPlace; opts?: Record<string, number> }> = [
    { id: 'default-stats', kind: 'stats', place: { col: 0, row: 0, w: 4, h: 4 } },
    { id: 'default-capture', kind: 'capture', place: { col: 4, row: 0, w: 4, h: 4 } },
    { id: 'default-tasks', kind: 'tasks', place: { col: 8, row: 0, w: 4, h: 4 }, opts: { limit: 5 } },
    { id: 'default-notes', kind: 'notes', place: { col: 0, row: 4, w: 4, h: 4 }, opts: { limit: 4 } },
    { id: 'default-heat', kind: 'heat', place: { col: 4, row: 4, w: 4, h: 4 }, opts: { limit: 8 } },
    { id: 'default-recent', kind: 'recent', place: { col: 8, row: 4, w: 4, h: 4 }, opts: { limit: 6 } },
    { id: 'default-shortcuts', kind: 'shortcuts', place: { col: 0, row: 8, w: 11, h: 1 } },
    { id: 'default-sync', kind: 'sync', place: { col: 11, row: 8, w: 1, h: 1 } },
    { id: 'default-activity', kind: 'activity', place: { col: 0, row: 9, w: 6, h: 4 } },
    { id: 'default-digest', kind: 'digest', place: { col: 6, row: 9, w: 6, h: 4 } },
  ];
  return {
    version: HOME_BOARD_VERSION,
    columns: DEFAULT_BOARD_COLUMNS,
    modules: items.map((item) => {
      const place = normalizePlace(item.place);
      return {
        id: item.id,
        kind: item.kind,
        title: '',
        ...place,
        w: clampW(place.w) ,
        opts: item.opts || {},
      };
    }),
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
 * 旧数据的宽度迁移表。
 * v1 的 span 是字符串（full / half / third，对着当时写死的 3 列），v2 是相对格数（1–5）。
 * 这里给的是**6 列口径**的格数：full → 整行 6、half → 半页 3、third → 三分之一 2，
 * v2 的数字格数按「原列数 4」换算成 6 列（1→2、2→3、3→5、4→6、5→6）；
 * 若是 v5 之前的整条布局，调用方还会统一再 ×2 换到 12 列。
 * 注意 v3 起宽度不再限定在档位里（用户拖把手可以拖出 5 格这种中间值），
 * 所以类型是 number，只有「新建模块」时才用 MODULE_SPANS 里的档位。
 */
const LEGACY_SPAN: Record<string, number> = { full: 6, half: 3, third: 2 };
const LEGACY_NUMBER_SPAN: Record<number, number> = { 1: 2, 2: 3, 3: 5, 4: 6, 5: 6 };

function normalizeModule(raw: unknown, others: HomeModule[], scale = 1): HomeModule | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (!isModuleKind(item.kind)) return null;
  const kind = item.kind;
  const rawId = typeof item.id === 'string' ? item.id.trim().slice(0, ID_MAX) : '';
  const rawTitle = typeof item.title === 'string' ? item.title.trim().replace(/\s+/g, ' ') : '';
  const meta = moduleMeta(kind);

  // 宽高：v3 直接读 w/h；v2 只有相对格数 span（也可能更早是字符串 full/half/third）或啥都没有。
  // 存过的值按旧栅格口径换算（scale），没存过的用当前默认值（已经是新口径，不再换算）。
  const asString = typeof item.span === 'string' ? LEGACY_SPAN[item.span] : undefined;
  const asNumber = typeof item.span === 'number' ? LEGACY_NUMBER_SPAN[Math.round(item.span)] : undefined;
  const storedW = Number.isFinite(Number(item.w)) ? Number(item.w) : asString ?? asNumber;
  const storedH = Number.isFinite(Number(item.h)) ? Number(item.h) : undefined;
  const zoom = (value: number | undefined, fallback: number) => Math.round((value ?? fallback) * (value === undefined ? 1 : scale));
  const w = clampW(zoom(storedW, meta.w));
  const h = clampH(zoom(storedH, meta.h));

  // 位置：保留坐标和留白；无坐标的旧数据放到第一个空位。
  let place: GridPlace;
  if (typeof item.col === 'number' || typeof item.row === 'number') {
    const col = Number.isFinite(Number(item.col)) ? Number(item.col) : 0;
    const row = Number.isFinite(Number(item.row)) ? Number(item.row) : 0;
    place = normalizePlace({ col: Math.round(col * scale), row: Math.round(row * scale), w, h });
  } else {
    const occupied = others.map((other) => ({ col: other.col, row: other.row, w: other.w, h: other.h }));
    place = findFreeSpot(occupied, w, h) || { col: 0, row: GRID_MAX_ROWS, w, h };
  }

  return {
    id: rawId || uid(),
    kind,
    title: rawTitle.slice(0, 24),
    ...place,
    w: clampW(place.w) ,
    h: clampH(place.h),
    opts: normalizeOpts(item.opts, kind),
  };
}

/**
 * 任意来源（localStorage / 服务端设置 / 导入的 JSON）→ 合法布局。
 * 三档结果：解析不出来 → 默认布局；解析出来但模块全不合法 → 默认布局；合法的空数组 → 空看板。
 * 顺带保证两件事（v3 起是硬要求）：**不重叠**、**不越界**。
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
  // v5 之前的布局存的是 6 列口径的坐标与格数：整条布局统一 ×2 换成 12 列，视觉大小保持不变。
  const storedVersion = Number.isFinite(Number(source.version)) ? Number(source.version) : 0;
  const scale = storedVersion < HOME_BOARD_VERSION ? LEGACY_GRID_SCALE : 1;
  const seen = new Set<string>();
  const modules: HomeModule[] = [];
  for (const item of source.modules) {
    const module = normalizeModule(item, modules, scale);
    if (!module) continue;
    // 重复 id 会让拖拽定位错位：后一个改成新 id，宁可丢「它是谁」也不丢「它存在」
    if (seen.has(module.id)) module.id = uid();
    seen.add(module.id);
    // 仅修复重叠，合法位置（包括用户刻意留白）必须原样保留。
    while (modules.some((other) => intersects(module, other))) {
      module.row = Math.max(...modules.filter((other) => intersects(module, other)).map((other) => other.row + other.h));
    }
    modules.push(module);
    if (modules.length >= MAX_MODULES) break;
  }
  // v3 首次升级时补一张热力卡，不改已有坐标；v4 删除后不会再次补回。
  if (source.version === 3 && modules.length && modules.length < MAX_MODULES && !modules.some((m) => m.kind === 'heat')) {
    const spot = findFreeSpot(modules, 4, 4)!;
    modules.push({ id: uid('heat'), kind: 'heat', title: '', ...spot, opts: { limit: 8 } });
  }
  return {
    version: HOME_BOARD_VERSION,
    columns,
    modules,
  };
}

/**
 * 整理一版布局：先按行序排（保证数组顺序与视觉顺序一致），再紧凑收拢空洞。
 * 仅供用户主动点击「紧凑」使用；读盘、删除、缩放不自动执行。
 */
export function packModules(modules: HomeModule[]): HomeModule[] {
  const ordered = [...modules].sort((left, right) => left.row - right.row || left.col - right.col);
  const compacted = compact(ordered.map((module) => ({ col: module.col, row: module.row, w: module.w, h: module.h })));
  return ordered.map((module, index) => ({
    ...module,
    col: compacted[index].col,
    row: compacted[index].row,
    w: clampW(compacted[index].w) ,
    h: clampH(compacted[index].h),
  }));
}

/** 布局 → 落盘的 JSON 字符串（服务端与 localStorage 共用同一份文本） */
export function serializeHomeBoard(board: HomeBoard): string {
  return JSON.stringify({ version: HOME_BOARD_VERSION, columns: board.columns, modules: board.modules });
}

/**
 * 换整页列数：v3 起栅格列数固定（见 homeGrid.GRID_COLS），这个函数保留成恒等（旧调用点不用改）。
 */
export function setColumns(board: HomeBoard, _columns?: BoardColumns): HomeBoard {
  return board;
}

/** 添加一块：找一个空位放进去（不改原对象） */
export function addModule(board: HomeBoard, kind: ModuleKind, id: string = uid()): HomeBoard {
  if (board.modules.length >= MAX_MODULES) return board;
  const meta = moduleMeta(kind);
  const occupied = board.modules.map((module) => ({ col: module.col, row: module.row, w: module.w, h: module.h }));
  const spot = findFreeSpot(occupied, meta.w, meta.h) || { col: 0, row: 0, w: meta.w, h: meta.h };
  const module: HomeModule = {
    id,
    kind,
    title: '',
    ...normalizePlace(spot),
    w: clampW(meta.w) ,
    opts: normalizeOpts({}, kind),
  };
  return { ...board, modules: [...board.modules, module] };
}

export function removeModule(board: HomeBoard, id: string): HomeBoard {
  const left = board.modules.filter((module) => module.id !== id);
  return { ...board, modules: left };
}

export function updateModule(board: HomeBoard, id: string, patch: Partial<Omit<HomeModule, 'id' | 'kind'>>): HomeBoard {
  return {
    ...board,
    modules: board.modules.map((module) =>
      module.id === id
        ? {
            ...module,
            title: patch.title === undefined ? module.title : String(patch.title).trim().slice(0, 24),
            opts: patch.opts === undefined ? module.opts : normalizeOpts(patch.opts, module.kind),
          }
        : module
    ),
  };
}

/**
 * 把某张卡挪到栅格位置（拖动用）：占位冲突时让位，返回新布局。
 * 与 homeGrid.placeItem 同一套规则，只是把结果写回 HomeModule 数组。
 */
export function moveModuleTo(board: HomeBoard, id: string, place: GridPlace): HomeBoard {
  const index = board.modules.findIndex((module) => module.id === id);
  if (index < 0) return board;
  const wanted = normalizePlace(place);
  const current = board.modules[index];
  if (current.col === wanted.col && current.row === wanted.row && current.w === wanted.w && current.h === wanted.h) {
    return board;
  }
  const places = placeItem(
    board.modules.map((module) => ({ col: module.col, row: module.row, w: module.w, h: module.h })),
    index,
    wanted
  );
  return {
    ...board,
    modules: board.modules.map((module, at) => ({
      ...module,
      col: places[at].col,
      row: places[at].row,
      w: clampW(places[at].w) ,
      h: clampH(places[at].h),
    })),
  };
}

/** 手动紧凑：所有卡片往上收，消掉空洞。日常拖动、删除、读盘不自动执行。 */
export function compactBoard(board: HomeBoard): HomeBoard {
  const packed = packModules(board.modules);
  const changed = packed.some((module, index) => module.row !== board.modules[index]?.row || module.col !== board.modules[index]?.col);
  return changed ? { ...board, modules: packed } : board;
}

/** 一键排整齐：按数组顺序顺次铺满（宽度保留，位置重排） */
export function autoArrangeBoard(board: HomeBoard): HomeBoard {
  const places = autoArrange(board.modules.map((module) => ({ w: module.w, h: module.h })));
  const modules = board.modules.map((module, index) => ({
    ...module,
    col: places[index].col,
    row: places[index].row,
    w: clampW(places[index].w) ,
    h: clampH(places[index].h),
  }));
  return { ...board, modules: packModules(modules) };
}

/**
 * 键盘挪位：把第 index 块按 (dx, dy) 平移几格（越界 / 撞到别人时由 placeItem 让位）。
 * 拖动是鼠标/手指入口，方向键是等价入口（触屏与键盘用户不必拖）。
 */
export function moveModuleBy(board: HomeBoard, index: number, dx: number, dy: number): HomeBoard {
  const module = board.modules[index];
  if (!module) return board;
  return moveModuleTo(board, module.id, {
    col: module.col + dx,
    row: module.row + dy,
    w: module.w,
    h: module.h,
  });
}

/** 键盘缩放：按 (dw, dh) 改宽高（同样受栅格与碰撞约束） */
export function resizeModuleBy(board: HomeBoard, index: number, dw: number, dh: number): HomeBoard {
  const module = board.modules[index];
  if (!module) return board;
  return moveModuleTo(board, module.id, {
    col: module.col,
    row: module.row,
    w: module.w + dw,
    h: module.h + dh,
  });
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

/** 「今日已记」：本地时区今天创建的灵感碎片条数（速记卡片头部计数用；缺 created_at 回看 updated_at） */
export function todayIdeasCount(pages: any[], now: number = Date.now()): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const from = start.getTime();
  return ideaPagesOf(pages).filter((p) => {
    const at = pageTime(p, 'created_at') || pageTime(p, 'updated_at');
    return at >= from && at <= now;
  }).length;
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

/** 「等待提炼」只接收 /api/files/list 返回的真实账本标记；未查询状态的页面不能充当待办。 */
export function pendingDistillOf(files: any[], limit = 4): any[] {
  return (files || [])
    .filter((file) => String(file?.path || '').startsWith('原始资料/') && file.distilled === false)
    .slice(0, Math.max(1, limit));
}

/** Markdown 可直接读；其余文件等自动提取文本就绪后再提炼。 */
export function pendingDistillLabel(file: any): string {
  if (typeof file?.readable === 'boolean') return file.readable ? '等待提炼' : '等待文本提取';
  const ext = String(file?.ext || String(file?.path || '').split('.').pop() || '').toLowerCase();
  return ['md', 'markdown'].includes(ext) || ['completed', 'partial', '已索引'].includes(file?.extractionStatus)
    ? '等待提炼' : '等待文本提取';
}

export function rawMaterialRoute(file: any): string {
  return file?.pageId ? `/page/${encodeURIComponent(file.pageId)}` : `/page?file=${encodeURIComponent(file?.path || '')}`;
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
