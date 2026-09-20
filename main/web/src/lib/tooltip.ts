/**
 * 全局悬停提示（自建气泡，替代系统原生 title）。
 *
 * 单例气泡 + 全局状态，任何元素 hover/focus 即激活；与 Toast 一样走 Teleport 全局单例。
 *
 * 两套避让策略（共用「测量真实尺寸 / 主轴择向 / 副轴夹紧 / 箭头钉锚点」底座）：
 *  - avoid（默认）：气泡只贴着被说明对象的四周（间距固定 ANCHOR_GAP），对附近真实内容块做碰撞检测，
 *    按「压住被说明对象 > 被夹紧换位 > 遮挡面积 > 距离」逐边打分取最优；必要时换边或收窄气泡，
 *    但**不做外移、不画虚线引导线**——提示永远在对象旁边。
 *    显式指定的方向（placement）放得下就优先，只在「那一侧压住整块内容」时才让位给别的边。
 *  - cursor：气泡跟随鼠标（图谱/画布等大块可点区域），按光标到四边的剩余空间择象限，并躲开被说明对象。
 *
 * 位置计算在这里（纯几何 + 读 DOM），渲染与测量由 AppTooltip.vue 负责：
 * 内容变化后由组件调用 planTooltip(size) 得到落位方案，再 commitPlan() 写回状态。
 */

import { reactive } from 'vue';

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';
export type TooltipStrategy = 'avoid' | 'cursor';

/** 提示内容：字符串等价于「只有正文」；对象支持标题 / 正文 / 快捷键 / 补充说明 */
export type TooltipValue = string | TooltipOptions;

export interface TooltipOptions {
  title?: string;
  body?: string;
  /** 快捷键（渲染成 kbd 键帽） */
  kbd?: string;
  /** 补充说明（灰色小字，如「1.2 万字 · 3 张附表」） */
  meta?: string;
  /** 首选方向：那一侧放得下就优先（放不下才换边） */
  placement?: TooltipPlacement;
  strategy?: TooltipStrategy;
  /** 严格避让（默认取全局偏好）：true = 宁可换边也不压内容，false = 首选方向优先、允许轻微遮挡 */
  strict?: boolean;
  /** 聚光：压暗除被说明对象以外的内容（默认关） */
  spotlight?: boolean;
  /** 光标跟随的显式指针位置（画布节点等没有独立 DOM 的场景） */
  pointer?: { x: number; y: number };
  /** 显式锚点矩形（视口坐标）；画布节点用它替代元素矩形，避免把整块画布当成被说明对象。
   *  传函数则每帧重新取（力导向布局里节点会一直动） */
  anchorRect?: { left: number; top: number; width: number; height: number } | (() => { left: number; top: number; width: number; height: number });
  /** 延迟显示毫秒数（默认 SHOW_DELAY） */
  delay?: number;
}

export interface TooltipArrow {
  side: TooltipPlacement;
  /** 相对气泡左上角 */
  x: number;
  y: number;
}

export interface TooltipPlan {
  left: number;
  top: number;
  arrow: TooltipArrow | null;
  /** 越小越好；用于「同一提示的多种宽度」之间比较 */
  score: number;
  /** 落位后压住的内容块面积（px²，严格模式应为 0） */
  occluded: number;
  /** 越界像素 */
  overflow: number;
}

export interface TooltipState {
  visible: boolean;
  title: string;
  body: string;
  kbd: string;
  meta: string;
  /** 被说明对象的视口矩形 */
  anchor: { left: number; top: number; width: number; height: number };
  left: number;
  top: number;
  arrow: TooltipArrow | null;
  spotlight: boolean;
  strategy: TooltipStrategy;
  strict: boolean;
  /** 气泡实测尺寸（调试与验收用） */
  width: number;
  height: number;
}

export const tooltipState = reactive<TooltipState>({
  visible: false,
  title: '',
  body: '',
  kbd: '',
  meta: '',
  anchor: { left: 0, top: 0, width: 0, height: 0 },
  left: 0,
  top: 0,
  arrow: null,
  spotlight: false,
  strategy: 'avoid',
  strict: true,
  width: 0,
  height: 0,
});

const VIEWPORT_PADDING = 8;
/** 气泡与被说明对象的固定间距：只在四周避让，不外移 */
const ANCHOR_GAP = 8;
const CURSOR_OFFSET = 16;
const CURSOR_MAX_OFFSET = 64;
/**
 * 悬停后延迟多久弹提示（毫秒）：0.6 秒——扫过一排按钮不会一路弹气泡，
 * 停在某个按钮上时又不用等太久。键盘 focus 与图谱节点的光标跟随提示不受它约束（立即显示）。
 */
const SHOW_DELAY = 600;
/** 参与碰撞检测的内容块上限（按距锚点远近截断，控制单次 hover 的计算量） */
const MAX_OBSTACLES = 60;
/**
 * 显式指定方向的加权：那一侧放得下（不压对象、不被夹紧）时优先。
 * 取 4000 —— 比「压住一整块内容」（12000）小，比相邻按钮那种轻微遮挡（几千以内）大：
 * 图标栏提示能稳定贴右侧，而正上方被顶栏压满时仍然会乖乖换到下方。
 */
const PREFERRED_BONUS = 4000;

let currentAnchor: HTMLElement | null = null;
let currentOptions: TooltipOptions = {};
let showTimer: ReturnType<typeof setTimeout> | null = null;
/** 光标跟随策略：鼠标移动过就置脏，由组件在下一帧重排后消费 */
let pointerDirty = false;

/* ── 全局偏好（外观设置里可切，存 localStorage）───────────────── */
const STRICT_KEY = 'tooltipStrict';

function readStrictPreference(): boolean {
  try {
    return localStorage.getItem(STRICT_KEY) !== 'off';
  } catch {
    return true;
  }
}

let strictPreference = readStrictPreference();

export function getTooltipStrict(): boolean {
  return strictPreference;
}

export function setTooltipStrict(on: boolean): void {
  strictPreference = on;
  try {
    localStorage.setItem(STRICT_KEY, on ? 'on' : 'off');
  } catch {
    /* 隐私模式下写不进去：本次会话内仍然生效 */
  }
}

/* ── 几何工具 ───────────────────────────────────────────────── */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 视口坐标矩形（左/上/右/下） */
export interface TooltipBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type Box = TooltipBox;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** 桌面端 titleBarOverlay 是不透明原生色条、永远盖在 web 内容上，顶部安全区从标题栏下缘起算（main.css --win-titlebar-h） */
function desktopTitlebarHeight(): number {
  if (!document.documentElement.classList.contains('desktop-frame')) return 0;
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--win-titlebar-h'));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function viewport(): Box {
  return { left: 0, top: desktopTitlebarHeight(), right: window.innerWidth, bottom: window.innerHeight };
}

function toBox(r: Rect): Box {
  return { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height };
}

function inflate(r: Box, n: number): Box {
  return { left: r.left - n, top: r.top - n, right: r.right + n, bottom: r.bottom + n };
}

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

function overflowPx(r: Box, v: Box): number {
  return Math.max(0, v.left + VIEWPORT_PADDING - r.left)
    + Math.max(0, r.right - (v.right - VIEWPORT_PADDING))
    + Math.max(0, v.top + VIEWPORT_PADDING - r.top)
    + Math.max(0, r.bottom - (v.bottom - VIEWPORT_PADDING));
}

function clampBox(r: Box, v: Box): Box {
  const w = r.right - r.left;
  const h = r.bottom - r.top;
  const left = clamp(r.left, v.left + VIEWPORT_PADDING, Math.max(v.left + VIEWPORT_PADDING, v.right - VIEWPORT_PADDING - w));
  const top = clamp(r.top, v.top + VIEWPORT_PADDING, Math.max(v.top + VIEWPORT_PADDING, v.bottom - VIEWPORT_PADDING - h));
  return { left, top, right: left + w, bottom: top + h };
}

/** 元素是否可见且靠近锚点（碰撞检测只关心这一片） */
function isNearbyVisible(el: HTMLElement, near: Box): boolean {
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  return !(r.right < near.left || r.left > near.right || r.bottom < near.top || r.top > near.bottom);
}

/**
 * 内容块判定：碰撞检测的「障碍物」应该是行/卡片/按钮这类会被挡住的实体，
 * 而不是整块面板容器（挡住面板背景没有意义，还会把气泡赶到很远）。
 */
function isContentBlock(el: HTMLElement, rect: DOMRect): boolean {
  if (el.children.length === 0) {
    return (el.textContent || '').trim().length > 0
      || el.matches('img,svg,canvas,input,textarea,select,button,a');
  }
  return rect.height <= 80 && el.children.length <= 8;
}

function distanceTo(r: Box, x: number, y: number): number {
  const dx = Math.max(r.left - x, 0, x - r.right);
  const dy = Math.max(r.top - y, 0, y - r.bottom);
  return Math.hypot(dx, dy);
}

/** 收集锚点附近的内容块：锚点自身与祖先/后代不算，最多取最近的 MAX_OBSTACLES 个 */
function collectObstacles(anchorRect: Box): { el: HTMLElement; rect: Box }[] {
  const near = inflate(anchorRect, 340);
  const found = new Map<HTMLElement, Box>();

  const consider = (el: Element | null) => {
    if (!el || !(el instanceof HTMLElement)) return;
    if (el === currentAnchor || (currentAnchor && el.contains(currentAnchor))) return;
    if (found.has(el)) return;
    if (el.closest('[data-tip-ignore]')) return;
    if (!isNearbyVisible(el, near)) return;
    const rect = el.getBoundingClientRect();
    if (!isContentBlock(el, rect)) return;
    found.set(el, toBox({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }));
  };

  // 1) 锚点往上三层内的兄弟节点：覆盖列表行、工具条按钮、表格单元格这类最常被压住的内容
  let parent: HTMLElement | null = currentAnchor ? currentAnchor.parentElement : null;
  for (let depth = 0; depth < 3 && parent; depth++) {
    for (const child of Array.from(parent.children)) consider(child);
    parent = parent.parentElement;
  }
  // 2) 显式标记的避让区（复杂布局留口子）与常驻 chrome（编辑页的悬浮顶栏 / 底部状态栏）
  document.querySelectorAll('[data-tip-avoid], [data-tip-chrome]').forEach(consider);

  const list = Array.from(found.entries()).map(([el, rect]) => ({ el, rect }));
  if (list.length <= MAX_OBSTACLES) return list;
  const cx = (anchorRect.left + anchorRect.right) / 2;
  const cy = (anchorRect.top + anchorRect.bottom) / 2;
  return list
    .sort((a, b) => distanceTo(a.rect, cx, cy) - distanceTo(b.rect, cx, cy))
    .slice(0, MAX_OBSTACLES);
}

/** 同一次落位里的两次宽度尝试复用同一份障碍物（锚点没动就不必重扫） */
let obstacleCache: { key: string; list: { el: HTMLElement; rect: Box }[] } | null = null;

function collectObstaclesCached(anchorRect: Box): { el: HTMLElement; rect: Box }[] {
  const key = `${anchorRect.left.toFixed(1)},${anchorRect.top.toFixed(1)},${anchorRect.right.toFixed(1)},${anchorRect.bottom.toFixed(1)}`;
  if (obstacleCache && obstacleCache.key === key) return obstacleCache.list;
  const list = collectObstacles(anchorRect);
  obstacleCache = { key, list };
  return list;
}

function clearObstacleCache(): void {
  obstacleCache = null;
}

/* ── 方向与箭头 ─────────────────────────────────────────────── */
function sideOrder(preferred?: TooltipPlacement): TooltipPlacement[] {
  const base: TooltipPlacement[] = ['top', 'bottom', 'right', 'left'];
  return preferred && base.includes(preferred) ? [preferred, ...base.filter((s) => s !== preferred)] : base;
}

function sideBox(
  side: TooltipPlacement,
  a: Box,
  w: number,
  h: number,
  gap: number,
  align: 'center' | 'start' | 'end' = 'center',
): Box {
  const along = (start: number, len: number, size: number) =>
    align === 'start' ? start : align === 'end' ? start + len - size : start + len / 2 - size / 2;
  if (side === 'top' || side === 'bottom') {
    const left = along(a.left, a.right - a.left, w);
    const top = side === 'top' ? a.top - gap - h : a.bottom + gap;
    return { left, top, right: left + w, bottom: top + h };
  }
  const top = along(a.top, a.bottom - a.top, h);
  const left = side === 'left' ? a.left - gap - w : a.right + gap;
  return { left, top, right: left + w, bottom: top + h };
}

/** 箭头钉在被说明对象中心；超出气泡可容纳范围则收起 */
function arrowFor(side: TooltipPlacement, box: Box, a: Box, w: number, h: number): TooltipArrow | null {
  const ax = (a.left + a.right) / 2 - box.left;
  const ay = (a.top + a.bottom) / 2 - box.top;
  if (side === 'top' || side === 'bottom') {
    if (ax < 14 || ax > w - 14) return null;
    return { side: side === 'top' ? 'bottom' : 'top', x: ax, y: side === 'top' ? h : 0 };
  }
  if (ay < 14 || ay > h - 14) return null;
  return { side: side === 'left' ? 'right' : 'left', x: side === 'left' ? w : 0, y: ay };
}

/* ── 策略一：内容避让（默认，只在四周）──────────────────────── */
interface Candidate {
  side: TooltipPlacement;
  align: 'center' | 'start' | 'end';
  box: Box;
  score: number;
}

export interface AvoidPlanInput {
  /** 视口矩形（桌面端顶边从原生标题栏下缘起算） */
  view: Box;
  /** 障碍物（附近真实内容块） */
  obstacles: Box[];
  /** 严格避让：遮挡扣分拉满，宁可换边；false = 首选方向优先，允许轻微遮挡 */
  strict: boolean;
  /** 显式指定的首选方向 */
  preferred?: TooltipPlacement;
}

/**
 * 四周择位（纯几何，便于单测）：气泡固定贴被说明对象四周 ANCHOR_GAP，不越界、不外移，
 * 按「压住被说明对象 > 该方向放不下被夹紧 > 遮挡内容面积 > 距离 > 方向/对齐顺序」取最优。
 * 显式指定的方向放得下（不压对象、不被夹紧）就优先，只有那一侧压住整块内容时才会换边。
 */
export function pickAvoidPlan(anchor: Box, size: { width: number; height: number }, input: AvoidPlanInput): TooltipPlan {
  const a = anchor;
  const w = Math.max(1, Math.ceil(size.width));
  const h = Math.max(1, Math.ceil(size.height));
  const keepOut = inflate(a, 4);
  const area = Math.max(1, w * h);
  const aligns: Candidate['align'][] = ['center', 'start', 'end'];
  const candidates: Candidate[] = [];
  const occlusionWeight = input.strict ? 12000 : 1200;

  sideOrder(input.preferred).forEach((side, si) => {
    aligns.forEach((align, ai) => {
      const raw = sideBox(side, a, w, h, ANCHOR_GAP, align);
      const box = clampBox(raw, input.view);
      // 压住被说明对象是硬伤；主轴被夹紧说明这个方向本来放不下，同样让位给别的方向
      const hard = overlapArea(box, keepOut);
      const mainShift = side === 'top' || side === 'bottom'
        ? Math.abs(box.top - raw.top)
        : Math.abs(box.left - raw.left);
      let occ = 0;
      for (const ob of input.obstacles) occ += overlapArea(box, ob);
      const cx = (box.left + box.right) / 2;
      const cy = (box.top + box.bottom) / 2;
      const dist = Math.hypot(cx - (a.left + a.right) / 2, cy - (a.top + a.bottom) / 2);
      // 显式指定的方向只要放得下就优先（图标栏提示固定贴右侧这类诉求，不该被遮挡打分拉走）
      const preferredClean = side === input.preferred && hard === 0 && mainShift === 0;
      candidates.push({
        side,
        align,
        box,
        score: (hard > 0 ? 1e6 + hard : 0)
          + mainShift * 8
          + (occ / area) * occlusionWeight
          + dist * 0.5
          + si * 6
          + ai * 3
          - (preferredClean ? PREFERRED_BONUS : 0),
      });
    });
  });

  candidates.sort((x, y) => x.score - y.score);
  const best = candidates[0];
  let occluded = 0;
  for (const ob of input.obstacles) occluded += overlapArea(best.box, ob);
  return {
    left: best.box.left,
    top: best.box.top,
    arrow: arrowFor(best.side, best.box, a, w, h),
    score: best.score,
    occluded,
    overflow: overflowPx(best.box, input.view),
  };
}

function planAvoid(a: Box, w: number, h: number, strict: boolean, preferred?: TooltipPlacement): TooltipPlan {
  return pickAvoidPlan(
    a,
    { width: w, height: h },
    {
      view: viewport(),
      obstacles: collectObstaclesCached(a).map((ob) => ob.rect),
      strict,
      preferred,
    },
  );
}

/* ── 策略二：光标跟随（图谱 / 画布）──────────────────────────── */
function planCursor(a: Box, w: number, h: number, pointer?: { x: number; y: number }): TooltipPlan {
  const view = viewport();
  const p = pointer ?? { x: (a.left + a.right) / 2, y: (a.top + a.bottom) / 2 };
  const keepOut = inflate(a, 4);
  const quads = [
    { sx: 1, sy: 1, pr: 0 },
    { sx: -1, sy: 1, pr: 2 },
    { sx: 1, sy: -1, pr: 4 },
    { sx: -1, sy: -1, pr: 6 },
  ];
  let best: { box: Box; score: number; overflow: number } | null = null;
  for (const q of quads) {
    // 偏移不够就临时加大（最多 CURSOR_MAX_OFFSET），先把被说明对象让开
    const needX = q.sx > 0 ? keepOut.right - p.x + 1 : p.x - keepOut.left + 1;
    const needY = q.sy > 0 ? keepOut.bottom - p.y + 1 : p.y - keepOut.top + 1;
    const offX = Math.min(Math.max(CURSOR_OFFSET, needX), CURSOR_MAX_OFFSET);
    const offY = Math.min(Math.max(CURSOR_OFFSET, needY), CURSOR_MAX_OFFSET);
    const left = q.sx > 0 ? p.x + offX : p.x - offX - w;
    const top = q.sy > 0 ? p.y + offY : p.y - offY - h;
    const box = clampBox({ left, top, right: left + w, bottom: top + h }, view);
    const over = overlapArea(box, keepOut);
    const of = overflowPx(box, view);
    const score = over * 1000 + of * 40 + q.pr;
    if (!best || score < best.score) best = { box, score, overflow: of };
  }
  const chosen = best as { box: Box; score: number; overflow: number };
  return {
    left: chosen.box.left,
    top: chosen.box.top,
    arrow: null,
    score: chosen.score,
    occluded: 0,
    overflow: chosen.overflow,
  };
}

/* ── 对外：落位方案 ─────────────────────────────────────────── */
/** 用气泡实测尺寸算落位（AppTooltip 渲染后调用；同一提示可用不同宽度多次调用取更优） */
export function planTooltip(size: { width: number; height: number }): TooltipPlan {
  const a = toBox(tooltipState.anchor);
  const w = Math.max(1, Math.ceil(size.width));
  const h = Math.max(1, Math.ceil(size.height));
  return tooltipState.strategy === 'cursor'
    ? planCursor(a, w, h, currentOptions.pointer)
    : planAvoid(a, w, h, tooltipState.strict, currentOptions.placement);
}

/** 写回落位结果（气泡位置 / 箭头 / 实测尺寸） */
export function commitPlan(plan: TooltipPlan, size: { width: number; height: number }): void {
  tooltipState.left = plan.left;
  tooltipState.top = plan.top;
  tooltipState.arrow = plan.arrow;
  tooltipState.width = Math.ceil(size.width);
  tooltipState.height = Math.ceil(size.height);
}

function normalizeValue(value: TooltipValue): TooltipOptions {
  return typeof value === 'string' ? { body: value } : value;
}

function readAnchorRect(): void {
  const source = currentOptions.anchorRect;
  const rect = typeof source === 'function' ? source() : (source ?? (currentAnchor ? currentAnchor.getBoundingClientRect() : null));
  if (!rect) return;
  const cur = tooltipState.anchor;
  // 逐帧调用，值没变就不写回，避免触发无谓的组件更新
  if (cur.left === rect.left && cur.top === rect.top && cur.width === rect.width && cur.height === rect.height) return;
  tooltipState.anchor = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/** 光标跟随：记录最新指针位置（组件在下一帧消费脏标记后重排） */
export function updateTooltipPointer(x: number, y: number): void {
  if (!tooltipState.visible || tooltipState.strategy !== 'cursor') return;
  currentOptions.pointer = { x, y };
  pointerDirty = true;
}

/** 指针是否移动过（读取即清除） */
export function consumePointerDirty(): boolean {
  if (!pointerDirty) return false;
  pointerDirty = false;
  return true;
}

/**
 * 显示提示。
 * @param anchor 被说明元素（画布节点可传画布元素，并用 options.anchorRect 给节点矩形）
 */
export function showTooltip(anchor: HTMLElement, value: TooltipValue, options: TooltipOptions = {}, immediate = false): void {
  const opts: TooltipOptions = { ...normalizeValue(value), ...options };
  if (!opts.body && !opts.title) return;
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  currentAnchor = anchor;
  currentOptions = opts;

  const doShow = () => {
    if (currentAnchor !== anchor || !anchor.isConnected) return;
    clearObstacleCache();
    tooltipState.title = opts.title ?? '';
    tooltipState.body = opts.body ?? '';
    tooltipState.kbd = opts.kbd ?? '';
    tooltipState.meta = opts.meta ?? '';
    tooltipState.strategy = opts.strategy ?? 'avoid';
    tooltipState.strict = opts.strict ?? strictPreference;
    tooltipState.spotlight = Boolean(opts.spotlight);
    readAnchorRect();
    tooltipState.visible = true;
    // 位置由 AppTooltip 渲染测量后回填
  };

  const delay = opts.delay ?? SHOW_DELAY;
  if (immediate || delay <= 0) doShow();
  else showTimer = setTimeout(doShow, delay);
}

/** 内容/布局变化后重新读取锚点矩形（AppTooltip 会重新测量并落位） */
export function refreshTooltip(): void {
  if (!tooltipState.visible) return;
  readAnchorRect();
}

export function hideTooltip(anchor?: HTMLElement): void {
  if (anchor && currentAnchor !== anchor) return;
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  currentAnchor = null;
  currentOptions = {};
  pointerDirty = false;
  clearObstacleCache();
  tooltipState.visible = false;
  tooltipState.arrow = null;
  tooltipState.spotlight = false;
}

/** 当前激活的锚点（供组件判断是否由自己触发） */
export function tooltipAnchor(): HTMLElement | null {
  return currentAnchor;
}

/** 元素是否被截断（用于智能折叠，仅截断时显示 tooltip） */
export function isTruncated(el: HTMLElement): boolean {
  // 水平或垂直任一方向溢出即视为截断
  return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
}
