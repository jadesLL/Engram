<template>
  <div ref="rootRef" class="graph-view" :class="{ 'g-dark': app.dark }">
    <canvas ref="canvasRef" class="g-canvas" :style="{ cursor }" />

    <!-- 顶部工具条 -->
    <div class="g-topbar">
      <div class="g-chip g-title">◉ 知识图谱</div>
      <div class="g-chip g-seg">
        <span :class="{ on: scope === 'global' }" @click="switchScope('global')">全局</span>
        <span v-if="pageId" :class="{ on: scope === 'page' }" @click="switchScope('page')">本页关联</span>
      </div>
      <button class="g-chip g-btn" v-tooltip="{ body: '铺满', meta: '把全部节点缩放到可见范围' }" @click="fit(true)">铺满</button>
      <button class="g-chip g-btn" v-tooltip="{ body: '重排', meta: '换一个随机种子重新跑力导向布局' }" @click="relayout">重排</button>
    </div>

    <!-- 设置面板 -->
    <div class="g-chip g-gear" v-tooltip="{ body: '图谱设置', meta: '过滤、分组、显示与力学参数' }" @click="panelOpen = !panelOpen">⚙</div>
    <div v-show="panelOpen" class="g-panel">
      <div class="g-sec">
        <input v-model="search" class="g-search" placeholder="搜索文件…" @input="draw()" />
      </div>
      <h3>过滤</h3>
      <div class="g-sec">
        <label class="g-row">原始资料<span class="g-sw"><input v-model="opt.raw" type="checkbox" /><i /></span></label>
        <label class="g-row">死链<span class="g-sw"><input v-model="opt.dead" type="checkbox" /><i /></span></label>
        <label class="g-row">孤儿节点<span class="g-sw"><input v-model="opt.orphans" type="checkbox" /><i /></span></label>
      </div>
      <h3>分组</h3>
      <div class="g-sec">
        <label v-for="g in groupList" :key="g.key" class="g-grow">
          <span class="g-dot" :style="{ background: g.color }" />{{ g.name }}
          <span class="g-sw"><input v-model="opt.showType[g.key]" type="checkbox" /><i /></span>
        </label>
      </div>
      <h3>显示</h3>
      <div class="g-sec">
        <label class="g-row">箭头<span class="g-sw"><input v-model="opt.arrows" type="checkbox" /><i /></span></label>
        <div class="g-row"><span>标签淡出阈值</span><output>{{ opt.fade }}</output></div>
        <input v-model.number="opt.fade" type="range" min="0" max="100" />
        <div class="g-row"><span>节点大小</span><output>{{ opt.nodeScale }}%</output></div>
        <input v-model.number="opt.nodeScale" type="range" min="40" max="180" />
        <div class="g-row"><span>连线粗细</span><output>{{ opt.linkScale }}%</output></div>
        <input v-model.number="opt.linkScale" type="range" min="40" max="260" />
      </div>
      <h3>力</h3>
      <div class="g-sec g-last">
        <div class="g-row"><span>中心力</span><output>{{ opt.cF }}</output></div>
        <input v-model.number="opt.cF" type="range" min="0" max="100" />
        <div class="g-row"><span>斥力</span><output>{{ opt.rF }}</output></div>
        <input v-model.number="opt.rF" type="range" min="0" max="100" />
        <div class="g-row"><span>连线力</span><output>{{ opt.lF }}</output></div>
        <input v-model.number="opt.lF" type="range" min="0" max="100" />
        <div class="g-row"><span>连线距离</span><output>{{ opt.lD }}</output></div>
        <input v-model.number="opt.lD" type="range" min="0" max="100" />
        <div class="g-reset" @click="resetSettings">恢复默认</div>
      </div>
    </div>

    <!-- 图例 -->
    <div class="g-chip g-legend">
      <span v-for="g in legendList" :key="g.key" class="g-legend-item" :class="{ off: legendOff(g.key) }">
        <i class="g-dot" :style="{ background: g.color }" />{{ g.name }}
      </span>
    </div>
    <div class="g-count">{{ countText }}</div>

    <!-- 状态浮层 -->
    <div v-if="loading" class="graph-state muted">
      <AppSpinner :size="16" /> 正在加载图谱…
    </div>
    <div v-else-if="loadError" class="graph-state">
      <p class="graph-error-text">{{ loadError }}</p>
      <button class="btn small" @click="load">重试</button>
    </div>
    <p v-else-if="empty" class="faint empty-hint">还没有图谱数据。写几篇带 [[双链]] 的页面后，图谱会自动生长。</p>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { useAppStore } from '../stores/app';
import AppSpinner from '../components/ui/AppSpinner.vue';
import { notify } from '../lib/notify';
import { hideTooltip, showTooltip, updateTooltipPointer } from '../lib/tooltip';

const route = useRoute();
const router = useRouter();
const app = useAppStore();
const rootRef = ref<HTMLElement>();
const canvasRef = ref<HTMLCanvasElement>();

const scope = ref('global');
const empty = ref(false);
const loading = ref(false);
const loadError = ref('');
const pageId = ref((route.params.id as string) || '');

// ---------- 主题（跟随应用 light/dark/system 设置：app.dark 变化即重绘+切面板配色） ----------
const THEMES = {
  dark: {
    // UI 2.0 语义色板：同色相不同明度 + 少量对比色，替代原 GitHub 彩虹色板
    palette: { concept: '#5aa9e6', person: '#8ab6e2', customer: '#b3cfea', org: '#3aa79a', project: '#e08a4c', note: '#9b9a98', other: '#6e6c6a', doc: '#6f9ac0' } as Record<string, string>,
    ent: { person: '#8ab6e2', concept: '#5aa9e6', project: '#e08a4c', org: '#3aa79a', tech: '#6f9ac0' } as Record<string, string>,
    raw: '#6e7681', dead: '#f85149', nodeFill: '#2a2a30', fallback: '#8b949e',
    text: '201,209,221', deadText: '248,81,73',
    edge: 'rgba(139,148,158,0.20)', arrow: 'rgba(139,148,158,0.55)',
    // 关联高亮：强调色加粗，替代原来的「非关联压暗」
    edgeHot: 'rgba(90,169,230,0.85)', arrowHot: 'rgba(90,169,230,0.92)', focusRing: '#5aa9e6',
    bg0: '#232329', bg1: '#151518',
  },
  light: {
    palette: { concept: '#0f6cbd', person: '#5b8fc9', customer: '#8fb8de', org: '#0e7a6d', project: '#c55a11', note: '#8a8886', other: '#c9c7c4', doc: '#3a6ea5' } as Record<string, string>,
    ent: { person: '#5b8fc9', concept: '#0f6cbd', project: '#c55a11', org: '#0e7a6d', tech: '#3a6ea5' } as Record<string, string>,
    raw: '#9aa2af', dead: '#cf222e', nodeFill: '#ffffff', fallback: '#656d76',
    text: '55,65,81', deadText: '207,34,46',
    edge: 'rgba(101,109,118,0.28)', arrow: 'rgba(101,109,118,0.60)',
    edgeHot: 'rgba(15,108,189,0.82)', arrowHot: 'rgba(15,108,189,0.90)', focusRing: '#0f6cbd',
    bg0: '#fbfbfc', bg1: '#edeff3',
  },
};
const GROUP_NAMES: Record<string, string> = {
  concept: '概念', person: '人物', customer: '客户', org: '组织',
  project: '项目', note: '笔记', other: '其他', doc: '文档',
  entity: '实体', raw: '原始资料', dead: '死链',
};

interface GNode {
  id: string; label: string; group: string; raw: boolean; words: number;
  deg: number; r: number; x: number; y: number; vx: number; vy: number; sx: number; sy: number;
  sr: number;
}
interface GEdge { a: number; b: number; dashed: boolean; }

let nodes: GNode[] = [];
let edges: GEdge[] = [];

// ---------- 设置（localStorage 持久化，Obsidian 式记忆） ----------
const DEFAULTS = {
  raw: false, dead: true, orphans: true,
  showType: Object.fromEntries([...Object.keys(THEMES.dark.palette), 'entity'].map((k) => [k, true])) as Record<string, boolean>,
  arrows: false, fade: 60, nodeScale: 100, linkScale: 100,
  cF: 40, rF: 55, lF: 60, lD: 55,
};
const opt = reactive(loadSettings());
const panelOpen = ref(true);
const search = ref('');

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('engram.graph.settings') || '');
    return { ...DEFAULTS, ...saved, showType: { ...DEFAULTS.showType, ...(saved?.showType || {}) } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}
function saveSettings() {
  localStorage.setItem('engram.graph.settings', JSON.stringify({
    raw: opt.raw, dead: opt.dead, orphans: opt.orphans, showType: opt.showType,
    arrows: opt.arrows, fade: opt.fade, nodeScale: opt.nodeScale, linkScale: opt.linkScale,
    cF: opt.cF, rF: opt.rF, lF: opt.lF, lD: opt.lD,
  }));
}
function resetSettings() {
  Object.assign(opt, structuredClone(DEFAULTS));
  saveSettings();
  draw();
}

const th = computed(() => THEMES[app.dark ? 'dark' : 'light']);
const groupList = computed(() => [
  ...Object.keys(th.value.palette).map((k) => ({ key: k, name: GROUP_NAMES[k], color: th.value.palette[k] })),
  { key: 'entity', name: GROUP_NAMES.entity, color: th.value.fallback },
]);
const legendList = computed(() => [...groupList.value, { key: 'raw', name: GROUP_NAMES.raw, color: th.value.raw }]);
function legendOff(key: string) {
  if (key === 'raw') return !opt.raw;
  if (key === 'dead') return !opt.dead;
  return opt.showType[key] === false;
}

// ---------- 可见性与颜色 ----------
function normGroup(g: string) { return g.startsWith('entity-') ? 'entity' : g; }
function colorOf(n: GNode) {
  if (n.raw) return th.value.raw;
  const g = n.group;
  if (g === 'dead') return th.value.dead;
  if (g.startsWith('entity-')) return th.value.ent[g.slice(7)] || th.value.fallback;
  return th.value.palette[g] || th.value.fallback;
}
function visible(n: GNode) {
  if (n.raw && !opt.raw) return false;
  if (n.group === 'dead' && !opt.dead) return false;
  if (opt.showType[normGroup(n.group)] === false) return false;
  if (!opt.orphans && n.deg === 0) return false;
  const s = search.value.trim().toLowerCase();
  if (s && !n.label.toLowerCase().includes(s)) return false;
  return true;
}
const visibleNodes = () => nodes.filter(visible);

// ---------- 力导向布局（Obsidian 手感：开场弹开→收敛→静止，拖动重充能） ----------
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

function initPositions() {
  nodes.forEach((n, i) => {
    const a = (i / Math.max(1, nodes.length)) * Math.PI * 2;
    n.x = Math.cos(a) * 24 + rnd() * 8;
    n.y = Math.sin(a) * 24 + rnd() * 8;
    n.vx = n.vy = 0;
  });
}
function tick() {
  const REP = (opt.rF / 100) * 2800;
  const CTR = (opt.cF / 100) * 0.002;
  const L = 36 + (opt.lD / 100) * 80;
  const LK = (opt.lF / 100) * 0.004;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d2 = dx * dx + dy * dy + 30;
      const f = REP / d2, d = Math.sqrt(d2);
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
    }
  }
  for (const e of edges) {
    const a = nodes[e.a], b = nodes[e.b];
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - L) * LK;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
  }
  let ke = 0;
  for (const n of nodes) {
    if (n === dragNode) { n.vx = n.vy = 0; continue; }
    n.vx = (n.vx - n.x * CTR) * 0.86;
    n.vy = (n.vy - n.y * CTR) * 0.86;
    n.x += n.vx; n.y += n.vy;
    ke += n.vx * n.vx + n.vy * n.vy;
  }
  return ke;
}

// ---------- 渲染 ----------
const view = { x: 0, y: 0, s: 1 };
let W = 0, H = 0, dpr = 1;
let fitScale = 0;
let needFitOnce = false;
let raf = 0, simActive = false, frames = 0;
let hoverNode: GNode | null = null;
let dragNode: GNode | null = null;

function kick() {
  if (simActive) return;
  simActive = true;
  frames = 0;
  raf = requestAnimationFrame(step);
}
function step() {
  if (!canvasRef.value) { simActive = false; return; }
  const ke = tick();
  draw();
  if (dragNode || (ke > 0.6 && frames++ < 1200)) {
    raf = requestAnimationFrame(step);
  } else {
    simActive = false;
    if (needFitOnce) { needFitOnce = false; fit(false); }
  }
}

function draw() {
  const ctx = canvasRef.value?.getContext('2d');
  if (!ctx || !W) return;
  const bg = ctx.createRadialGradient(W / 2, H * 0.45, 80, W / 2, H * 0.45, Math.max(W, H) * 0.75);
  bg.addColorStop(0, th.value.bg0); bg.addColorStop(1, th.value.bg1);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.translate(view.x, view.y);
  ctx.scale(view.s, view.s);

  // 选择/hover 高亮：自身 + 一跳关联节点 + 相连连线一起强调；
  // 非关联元素保持原样（不压暗、不变灰），高亮只做加法
  let focusNode = -1;
  const focusSet = new Set<number>();
  const focusEdges = new Set<number>();
  if (hoverNode) {
    focusNode = nodes.indexOf(hoverNode);
    if (focusNode >= 0) {
      focusSet.add(focusNode);
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        if (e.a !== focusNode && e.b !== focusNode) continue;
        focusEdges.add(i);
        focusSet.add(e.a === focusNode ? e.b : e.a);
      }
    }
  }
  const scale = opt.nodeScale / 100;

  // 边：先铺普通边，关联边最后画，保证高亮压在最上层
  const baseW = (0.9 * opt.linkScale) / 100 / view.s;
  const drawEdge = (idx: number, hot: boolean) => {
    const e = edges[idx];
    const a = nodes[e.a], b = nodes[e.b];
    if (!visible(a) || !visible(b)) return;
    ctx.setLineDash(e.dashed ? [4, 4] : []);
    ctx.lineWidth = hot ? baseW * 2.2 : baseW;
    ctx.strokeStyle = hot ? th.value.edgeHot : th.value.edge;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    if (!opt.arrows) return;
    const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / d, uy = (b.y - a.y) / d;
    const bx = b.x - ux * (b.r * scale + 3), by = b.y - uy * (b.r * scale + 3);
    const s = (hot ? 6.8 : 5.5) / view.s;
    ctx.fillStyle = hot ? th.value.arrowHot : th.value.arrow;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - ux * s - uy * s * 0.5, by - uy * s + ux * s * 0.5);
    ctx.lineTo(bx - ux * s + uy * s * 0.5, by - uy * s - ux * s * 0.5);
    ctx.closePath();
    ctx.fill();
  };
  for (let i = 0; i < edges.length; i++) if (!focusEdges.has(i)) drawEdge(i, false);
  for (const i of focusEdges) drawEdge(i, true);
  ctx.setLineDash([]);

  // 节点：页面实心圆、实体空心环、死链红色空心；关联节点加描边光环（纯描边，不用阴影泛光）
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!visible(n)) continue;
    const hot = i === focusNode;
    const near = !hot && focusSet.has(i);
    const col = colorOf(n);
    const r = n.r * scale * (hot ? 1.12 : 1);
    const ring = n.group.startsWith('entity-');
    if (ring || n.group === 'dead') {
      ctx.fillStyle = th.value.nodeFill;
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 7); ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.4 / view.s;
      ctx.stroke();
    } else {
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 7); ctx.fill();
    }
    if (hot || near) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + (hot ? 4 : 3) / view.s, 0, 7);
      ctx.strokeStyle = th.value.focusRing;
      ctx.lineWidth = (hot ? 2.4 : 1.6) / view.s;
      ctx.stroke();
    }
    n.sx = n.x * view.s + view.x;
    n.sy = n.y * view.s + view.y;
    n.sr = r * view.s;
  }

  // 标签（屏幕空间）：透明度 = 节点重要度 × 缩放淡出阈值；关联节点标签始终清晰
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textAlign = 'center';
  ctx.font = '11px "Segoe UI","Microsoft YaHei",sans-serif';
  const k = 0.25 + 0.5 * (opt.fade / 100);
  const zoomFactor = fitScale ? view.s / fitScale : 1;
  const zoomAlpha = Math.max(0, Math.min(1, (zoomFactor - 0.5 * k) / 0.5));
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!visible(n)) continue;
    let a = (0.3 + Math.min(0.55, (n.r - 3) * 0.06)) * (0.4 + (opt.fade / 100) * 1.1) * zoomAlpha;
    if (n.raw) a *= 0.55;
    if (focusSet.has(i)) a = 0.98;
    if (a <= 0.02) continue;
    ctx.fillStyle = n.group === 'dead' ? `rgba(${th.value.deadText},${a})` : `rgba(${th.value.text},${a})`;
    ctx.fillText(n.label, n.sx, n.sy + n.sr + 13);
  }
}

// nodes/edges 是普通数组，用 dataVersion 通知 computed 重算；opt 面板变化需重绘画布
const dataVersion = ref(0);
watch(opt, () => { saveSettings(); draw(); }, { deep: true });
watch(() => app.dark, () => draw());

const countText = computed(() => {
  void dataVersion.value;
  if (!nodes.length) return '';
  const ve = edges.filter((e) => visible(nodes[e.a]) && visible(nodes[e.b])).length;
  return `${visibleNodes().length} 节点 · ${ve} 连接`;
});

// ---------- 视图操作 ----------
function canvasSize() {
  const cv = canvasRef.value, root = rootRef.value;
  if (!cv || !root) return;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = root.getBoundingClientRect();
  W = rect.width; H = rect.height;
  cv.width = W * dpr; cv.height = H * dpr;
  cv.style.width = `${W}px`; cv.style.height = `${H}px`;
}

function fitBounds() {
  const vn = visibleNodes();
  if (!vn.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of vn) {
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y);
  }
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: Math.max(80, x1 - x0), h: Math.max(80, y1 - y0) };
}
function fitTarget() {
  const b = fitBounds();
  if (!b) return null;
  const s = Math.min(1.6, Math.min(W / (b.w + 160), H / (b.h + 160)));
  return { x: W / 2 - b.cx * s, y: H / 2 - b.cy * s, s };
}
let fitAnim = 0;
function fit(animated: boolean) {
  const t = fitTarget();
  if (!t) return;
  cancelAnimationFrame(fitAnim);
  if (!animated) {
    Object.assign(view, t);
    fitScale = view.s || 1;
    draw();
    return;
  }
  const from = { ...view };
  const t0 = performance.now();
  const ease = (u: number) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);
  const anim = (now: number) => {
    const p = Math.min(1, (now - t0) / 400);
    const e = ease(p);
    view.x = from.x + (t.x - from.x) * e;
    view.y = from.y + (t.y - from.y) * e;
    view.s = from.s + (t.s - from.s) * e;
    draw();
    if (p < 1) fitAnim = requestAnimationFrame(anim);
    else fitScale = view.s || 1;
  };
  fitAnim = requestAnimationFrame(anim);
}
function relayout() {
  // 每次换随机种子：重排必须产生不同的布局，而不是回放同一场大爆炸
  seed = Math.floor(Math.random() * 2147483647);
  initPositions();
  // 节点回到世界原点炸开，视图跟着回中心，避免用户盯着原来的空白区域等收敛
  view.x = W / 2; view.y = H / 2; view.s = 1;
  needFitOnce = true;
  kick();
}

// ---------- 交互：悬停聚焦 / 拖节点 / 平移 / 缩放 / 单击跳页 / 双击局部 ----------
let pointerDown: { x: number; y: number; viewX: number; viewY: number } | null = null;
let moved = false;
let pendingClick: { timer: number; node: GNode } | null = null;
const cursor = ref('grab');

function hitTest(mx: number, my: number): GNode | null {
  const wx = (mx - view.x) / view.s, wy = (my - view.y) / view.s;
  const scale = opt.nodeScale / 100;
  let best: GNode | null = null, bd = Infinity;
  for (const n of nodes) {
    if (!visible(n)) continue;
    const d = Math.hypot(n.x - wx, n.y - wy);
    if (d < n.r * scale + 5 && d < bd) { bd = d; best = n; }
  }
  return best;
}

/**
 * 节点的屏幕矩形：画布节点没有独立 DOM，用它当「被说明对象」交给提示引擎，
 * 这样气泡既不会压住节点本身，也不会把整块画布当成锚点。
 */
function nodeScreenRect(node: GNode): { left: number; top: number; width: number; height: number } {
  const rect = canvasRef.value!.getBoundingClientRect();
  const scale = opt.nodeScale / 100;
  const radius = Math.max(6, node.r * scale * view.s);
  const cx = rect.left + view.x + node.x * view.s;
  const cy = rect.top + view.y + node.y * view.s;
  // 节点下方还会画标签，按标签宽度一起留出空间
  const width = Math.max(radius * 2, Math.min(220, node.label.length * 12 * Math.min(1.4, view.s)));
  return { left: cx - width / 2, top: cy - radius, width, height: radius * 2 + 22 };
}

function nodeTipContent(node: GNode) {
  const kind = node.raw ? GROUP_NAMES.raw : GROUP_NAMES[normGroup(node.group)] || '节点';
  const facts = [kind];
  if (node.deg) facts.push(`${node.deg} 条关联`);
  if (node.words) facts.push(`${node.words} 字`);
  return {
    title: node.label,
    body: facts.join(' · '),
    meta: '单击打开 · 双击看本页关联',
  };
}

function onPointerDown(ev: PointerEvent) {
  canvasRef.value?.setPointerCapture(ev.pointerId);
  const rect = canvasRef.value!.getBoundingClientRect();
  const hit = hitTest(ev.clientX - rect.left, ev.clientY - rect.top);
  pointerDown = { x: ev.clientX, y: ev.clientY, viewX: view.x, viewY: view.y };
  moved = false;
  if (hit) { dragNode = hit; kick(); }
  cursor.value = 'grabbing';
}
function onPointerMove(ev: PointerEvent) {
  const rect = canvasRef.value!.getBoundingClientRect();
  const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
  if (pointerDown) {
    const dx = ev.clientX - pointerDown.x, dy = ev.clientY - pointerDown.y;
    if (Math.hypot(dx, dy) > 4) moved = true;
    if (dragNode) {
      dragNode.x = (mx - view.x) / view.s;
      dragNode.y = (my - view.y) / view.s;
    } else {
      view.x = pointerDown.viewX + dx;
      view.y = pointerDown.viewY + dy;
    }
    draw();
    return;
  }
  const hit = hitTest(mx, my);
  if (hit !== hoverNode) {
    hoverNode = hit;
    if (!simActive) draw();
    // 画布节点没有独立 DOM，提示走「光标跟随」策略，用节点矩形当被说明对象
    if (hit) {
      showTooltip(canvasRef.value!, nodeTipContent(hit), {
        strategy: 'cursor',
        // 力导向布局里节点会一直动，用函数形式让提示每帧跟着节点走
        anchorRect: () => nodeScreenRect(hit),
        pointer: { x: ev.clientX, y: ev.clientY },
        delay: 0,
      });
    } else {
      hideTooltip();
    }
  } else if (hit) {
    updateTooltipPointer(ev.clientX, ev.clientY);
  }
  cursor.value = hit ? 'pointer' : 'grab';
}
function onPointerUp(ev: PointerEvent) {
  if (!pointerDown) return;
  pointerDown = null;
  dragNode = null;
  cursor.value = 'grab';
  if (moved) return;
  const rect = canvasRef.value!.getBoundingClientRect();
  const hit = hitTest(ev.clientX - rect.left, ev.clientY - rect.top);
  if (!hit) return;
  // 单击跳页、双击切本页关联：单击延迟 260ms 以区分双击
  if (pendingClick) {
    const same = pendingClick.node === hit;
    clearTimeout(pendingClick.timer);
    pendingClick = null;
    if (same) {
      if (!hit.id.includes(':')) {
        pageId.value = hit.id;
        scope.value = 'page';
        load();
      }
      return;
    }
  }
  const node = hit;
  pendingClick = {
    node,
    timer: window.setTimeout(() => {
      pendingClick = null;
      if (!node.id.startsWith('dead:') && !node.id.startsWith('ent:')) {
        router.push(`/page/${node.id}`);
      }
    }, 260),
  };
}
function onWheel(ev: WheelEvent) {
  ev.preventDefault();
  cancelAnimationFrame(fitAnim);
  const k = Math.exp(-ev.deltaY * 0.0012);
  const ns = Math.min(4, Math.max(0.25, view.s * k));
  view.x = ev.clientX - (ev.clientX - view.x) * (ns / view.s);
  view.y = ev.clientY - (ev.clientY - view.y) * (ns / view.s);
  view.s = ns;
  draw();
}

// ---------- 数据加载 ----------
async function load() {
  const params: any = { scope: scope.value };
  if (scope.value === 'page') {
    if (!pageId.value) { scope.value = 'global'; }
    else { params.id = pageId.value; params.depth = 2; }
  }
  loading.value = true;
  loadError.value = '';
  let data: any;
  try {
    ({ data } = await api.get('/api/graph', { params }));
  } catch (error: any) {
    loadError.value = error?.response?.data?.error || error?.message || '图谱加载失败';
    notify.error(loadError.value);
    loading.value = false;
    return;
  }
  loading.value = false;
  empty.value = data.nodes.length === 0;
  if (empty.value) { nodes = []; edges = []; dataVersion.value++; draw(); return; }

  // 节点大小 = 被引用数（入度）+ 字数体量；原始资料/死链相关边画虚线
  const index = new Map<string, number>();
  nodes = data.nodes.map((n: any) => ({
    id: n.id, label: n.label, group: n.group, raw: !!n.raw, words: n.words || 0,
    deg: 0, r: 4, x: 0, y: 0, vx: 0, vy: 0, sx: 0, sy: 0, sr: 0,
  }));
  nodes.forEach((n, i) => index.set(n.id, i));
  edges = data.edges
    .filter((e: any) => index.has(e.from) && index.has(e.to))
    .map((e: any) => {
      const a = index.get(e.from)!;
      const b = index.get(e.to)!;
      nodes[b].deg++;
      return { a, b, dashed: nodes[a].raw || nodes[b].raw || nodes[b].group === 'dead' };
    });
  for (const n of nodes) {
    const w = n.deg * 6 + Math.log2(n.words + 1) + 2;
    n.r = Math.min(15, 3 + Math.sqrt(w) * 1.15);
  }
  dataVersion.value++;

  canvasSize();
  view.x = W / 2; view.y = H / 2; view.s = 1;
  fitScale = 0;
  hoverNode = null;
  hideTooltip();
  initPositions();
  needFitOnce = true;
  kick();
}

function switchScope(s: string) {
  if (scope.value === s) return;
  scope.value = s;
  load();
}

watch(() => route.params.id, (id) => {
  if (id) {
    pageId.value = id as string;
    scope.value = 'page';
    load();
  }
});
watch(opt, saveSettings);

let ro: ResizeObserver | null = null;

onMounted(() => {
  if (pageId.value) scope.value = 'page';
  canvasSize();
  const cv = canvasRef.value!;
  cv.addEventListener('pointerdown', onPointerDown);
  cv.addEventListener('pointermove', onPointerMove);
  cv.addEventListener('pointerup', onPointerUp);
  cv.addEventListener('wheel', onWheel, { passive: false });
  cv.addEventListener('pointerleave', () => {
    hideTooltip();
    if (!pointerDown && hoverNode) { hoverNode = null; if (!simActive) draw(); }
  });
  ro = new ResizeObserver(() => { canvasSize(); draw(); });
  ro.observe(rootRef.value!);
  load();
});
onUnmounted(() => {
  cancelAnimationFrame(raf);
  cancelAnimationFrame(fitAnim);
  ro?.disconnect();
  hideTooltip();
});
</script>

<style scoped>
.graph-view {
  --g-bg: #f4f3f1;
  --g-chip-bg: rgba(255, 255, 255, 0.94);
  --g-chip-border: rgba(31, 30, 29, 0.08);
  --g-shadow: 0 10px 34px rgba(31, 30, 29, 0.10);
  --g-strong: #1f1e1d;
  --g-panel-text: #454340;
  --g-muted: #5f5d5b;
  --g-faint: #91908e;
  --g-count: #9aa3af;
  --g-seg-on-bg: rgba(15, 108, 189, 0.12);
  --g-field-bg: rgba(31, 30, 29, 0.04);
  --g-field-border: rgba(31, 30, 29, 0.08);
  --g-sw-off: #d1d5db;
  --g-sw-knob: #ffffff;
  --g-track: rgba(31, 30, 29, 0.05);
  --g-accent: #0f6cbd;
  --g-danger: #cf222e;
  height: 100%; position: relative; overflow: hidden; background: var(--g-bg);
}
.graph-view.g-dark {
  --g-bg: #151518;
  --g-chip-bg: rgba(28, 28, 35, 0.9);
  --g-chip-border: rgba(255, 255, 255, 0.08);
  --g-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  --g-strong: #e6e9f0;
  --g-panel-text: #c3cad6;
  --g-muted: #8b93a5;
  --g-faint: #767f90;
  --g-count: #5d6572;
  --g-seg-on-bg: rgba(90, 169, 230, 0.22);
  --g-field-bg: rgba(255, 255, 255, 0.06);
  --g-field-border: rgba(255, 255, 255, 0.08);
  --g-sw-off: #3a3f4b;
  --g-sw-knob: #aab2c0;
  --g-track: rgba(255, 255, 255, 0.05);
  --g-accent: #5aa9e6;
  --g-danger: #f85149;
}
.g-canvas { position: absolute; inset: 0; touch-action: none; }

.g-chip {
  background: var(--g-chip-bg);
  backdrop-filter: blur(14px);
  border: 1px solid var(--g-chip-border);
  box-shadow: var(--g-shadow);
}
.g-topbar {
  position: absolute; top: 16px; left: 16px;
  display: flex; gap: 10px; align-items: center; z-index: 5;
  flex-wrap: wrap;
}
.g-title { border-radius: 10px; padding: 8px 14px; color: var(--g-strong); font-size: 13.5px; font-weight: 600; }
.g-seg { display: flex; border-radius: 10px; overflow: hidden; }
.g-seg span { padding: 8px 14px; font-size: 12.5px; color: var(--g-muted); cursor: pointer; user-select: none; }
.g-seg span.on { background: var(--g-seg-on-bg); color: var(--g-strong); }
.g-btn { border-radius: 10px; padding: 8px 14px; font-size: 12.5px; color: var(--g-muted); cursor: pointer; user-select: none; }
.g-btn:hover { color: var(--g-strong); }

.g-gear {
  position: absolute; top: 16px; right: 16px; width: 36px; height: 36px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  color: var(--g-muted); font-size: 15px; cursor: pointer; z-index: 6; user-select: none;
}
.g-panel {
  position: absolute; top: 62px; right: 16px; width: 270px;
  border-radius: 14px; color: var(--g-panel-text); font-size: 12.5px; z-index: 5;
  max-height: calc(100% - 80px); overflow: auto;
  background: var(--g-chip-bg);
  backdrop-filter: blur(14px);
  border: 1px solid var(--g-chip-border);
  box-shadow: var(--g-shadow);
}
.g-panel h3 { margin: 0; padding: 12px 16px 4px; font-size: 10.5px; letter-spacing: 0.14em; color: var(--g-faint); font-weight: 600; }
.g-sec { padding: 4px 16px 12px; border-bottom: 1px solid var(--g-chip-border); }
.g-sec.g-last { border-bottom: none; padding-bottom: 16px; }
.g-search {
  width: 100%; box-sizing: border-box; margin-top: 8px;
  background: var(--g-field-bg); border: 1px solid var(--g-field-border);
  border-radius: 8px; padding: 7px 10px; color: var(--g-strong); font-size: 12px; outline: none;
}
.g-row { display: flex; justify-content: space-between; align-items: center; padding: 5px 0; gap: 8px; }
.g-row output { color: var(--g-muted); font-size: 11.5px; min-width: 32px; text-align: right; }
.g-grow { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.g-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; flex: none; }
.g-sw { position: relative; width: 32px; height: 18px; flex: none; margin-left: auto; }
.g-sw input { opacity: 0; width: 0; height: 0; position: absolute; }
.g-sw i { position: absolute; inset: 0; background: var(--g-sw-off); border-radius: 99px; transition: 0.18s; cursor: pointer; }
.g-sw i:after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--g-sw-knob); transition: 0.18s; }
.g-sw input:checked + i { background: var(--g-accent); }
.g-sw input:checked + i:after { transform: translateX(14px); background: #fff; }
.g-panel input[type='range'] { width: 100%; accent-color: var(--g-accent); height: 18px; margin: 0 0 6px; }
.g-reset { margin-top: 8px; text-align: center; color: var(--g-muted); font-size: 11.5px; cursor: pointer; padding: 6px; border-radius: 8px; background: var(--g-field-bg); }
.g-reset:hover { color: var(--g-strong); }

.g-legend {
  position: absolute; left: 16px; bottom: 16px;
  display: flex; gap: 12px; padding: 9px 14px; border-radius: 10px;
  color: var(--g-muted); font-size: 11.5px; z-index: 4; flex-wrap: wrap; max-width: 70vw;
}
.g-legend-item { display: flex; align-items: center; gap: 6px; }
.g-legend-item.off { opacity: 0.35; text-decoration: line-through; }
.g-count { position: absolute; bottom: 16px; right: 16px; color: var(--g-count); font-size: 12px; z-index: 4; }

.graph-state {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  display: flex; flex-direction: column; align-items: center; gap: 10px; z-index: 3;
}
.graph-state:has(.app-spinner) { flex-direction: row; }
.graph-state.muted { color: var(--g-muted); }
.graph-error-text { margin: 0; color: var(--g-danger); }
.empty-hint {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  text-align: center; color: var(--g-muted); z-index: 3; margin: 0; padding: 0 20px;
}

@media (max-width: 768px) {
  .g-panel { width: calc(100vw - 32px); right: 16px; }
}
</style>
