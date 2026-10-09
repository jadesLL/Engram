<template>
  <div ref="rootRef" class="graph-view" :class="{ dark: app.dark }">
    <!-- 顶栏：模式 + 搜索 + 已选条件 -->
    <div class="gv-top">
      <div class="gv-brand">
        <Icon name="graph" :size="16" />
        <b>知识图谱</b>
      </div>
      <div class="gv-seg">
        <button
          v-for="m in modes"
          :key="m.key"
          :class="{ on: mode === m.key }"
          v-tooltip="{ body: m.name, meta: m.meta }"
          @click="switchMode(m.key)"
        >{{ m.name }}</button>
      </div>
      <div class="gv-search">
        <Icon name="search" :size="15" />
        <input v-model="filters.q" aria-label="搜索页面或标签" placeholder="搜索页面 / 标签…" spellcheck="false" @input="onSearchInput" />
      </div>
      <div class="gv-chips">
        <span v-for="c in activeChips" :key="c.key" class="gv-chip">
          {{ c.label }}
          <button title="移除" @click="c.remove()">×</button>
        </span>
      </div>
      <div class="gv-actions">
        <button class="gv-tool" :class="{ on: facetsOpen }" aria-label="筛选面板" :aria-expanded="facetsOpen" v-tooltip="{ body: '筛选面板', meta: '按类型、标签、更新时间、规模筛选' }" @click="facetsOpen = !facetsOpen">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 6h16M7 12h10M10 18h4" /></svg>
          筛选
        </button>
        <button class="gv-icon" aria-label="重新布局" v-tooltip="{ body: '重排', meta: '换一个随机种子重新跑布局' }" @click="relayout">
          <Icon name="refresh" :size="15" />
        </button>
        <button class="gv-tool" :class="{ on: detailOpen }" :aria-expanded="detailOpen" @click="detailOpen = !detailOpen">概览</button>
      </div>
    </div>

    <div class="gv-main">
      <!-- 左：业务维度筛选 -->
      <aside class="gv-facets" :class="{ hidden: !facetsOpen }">
        <div class="gv-panel-head"><b>筛选页面</b><button @click="resetFilters">重置</button></div>
        <div class="gv-fgroup">
          <h4>类型 <button @click="clearFacet('types')">清空</button></h4>
          <button
            v-for="t in typeFacets"
            :key="t.key"
            class="gv-frow"
            :class="{ on: filters.types.includes(t.key) }"
            @click="toggleFacet('types', t.key)"
          >
            <i class="dot" :style="{ background: t.color }" />
            <span class="nm">{{ t.name }}</span>
            <span class="ct">{{ t.count }}</span>
          </button>
        </div>

        <div v-for="g in tagFacets" :key="g.name" class="gv-fgroup">
          <h4>{{ g.name }} <button @click="clearFacet('tags')">清空</button></h4>
          <button
            v-for="t in g.items"
            :key="t.name"
            class="gv-frow"
            :class="{ on: filters.tags.includes(t.name) }"
            @click="toggleFacet('tags', t.name)"
          >
            <span class="nm">{{ t.name }}</span>
            <span class="ct">{{ t.count }}</span>
          </button>
        </div>

        <div class="gv-fgroup">
          <h4>更新时间 <button @click="clearFacet('time')">全部</button></h4>
          <div class="gv-range">
            <div class="lbl"><span>{{ dateLabels[0] }}</span><span>{{ dateLabels[1] }}</span></div>
            <input v-model.number="rangeFrom" type="range" min="0" max="100" @input="onRange('from')" />
            <input v-model.number="rangeTo" type="range" min="0" max="100" @input="onRange('to')" />
          </div>
        </div>

        <div class="gv-fgroup">
          <h4>规模 <button @click="clearFacet('size')">清空</button></h4>
          <div class="gv-range">
            <div class="lbl"><span>字数 ≥ <b>{{ filters.minWords }}</b></span><span>关联 ≥ <b>{{ filters.minDeg }}</b></span></div>
            <input v-model.number="wordSlider" type="range" min="0" max="100" @input="onSize('words')" />
            <input v-model.number="degSlider" type="range" min="0" max="100" @input="onSize('deg')" />
          </div>
        </div>

        <div class="gv-fgroup">
          <h4>其他</h4>
          <label class="gv-frow switch">
            <span class="nm">原始资料</span>
            <span class="gv-sw"><input v-model="filters.showRaw" type="checkbox" @change="applyFilter()" /><i /></span>
          </label>
          <label class="gv-frow switch">
            <span class="nm">死链</span>
            <span class="gv-sw"><input v-model="filters.showDead" type="checkbox" @change="applyFilter()" /><i /></span>
          </label>
        </div>
      </aside>

      <!-- 中：画布（双层 canvas：底层静态图，上层只画 hover/选中） -->
      <div ref="stageRef" class="gv-stage">
        <canvas ref="baseRef" class="gv-canvas" aria-label="知识图谱画布：拖动平移或移动节点，滚轮缩放" :style="{ cursor }" />
        <canvas ref="overRef" class="gv-canvas over" />

        <div class="gv-tip" v-if="tip" :style="{ left: tip.x + 'px', top: tip.y + 'px' }">
          <div class="t"><i :style="{ background: tip.color }" />{{ tip.title }}</div>
          <div class="m">
            <span>{{ tip.kind }}</span>
            <span v-if="tip.deg">{{ tip.deg }} 关联</span>
            <span v-if="tip.words">{{ tip.words }} 字</span>
            <span v-if="tip.updatedAt">{{ tip.updatedAt }}</span>
          </div>
          <div v-if="tip.tags.length" class="g">{{ tip.tags.slice(0, 5).join(' · ') }}</div>
        </div>

        <div class="gv-stats">
          <span class="gv-status-dot" :class="{ busy: layoutHint === '布局中' }" />
          <span><b>{{ visibleNodes.length }}</b> 页 · <b>{{ visibleEdges.length }}</b> 关系</span>
          <span v-if="layoutHint" class="gv-layout-state">{{ layoutHint }}</span>
        </div>
        <div class="gv-help">拖动平移 · 滚轮缩放 · 点击查看关联</div>

        <div class="gv-hud">
          <button
            class="gv-icon gv-tweaks-toggle"
            :class="{ on: tweaksOpen }"
            aria-label="布局参数" :aria-expanded="tweaksOpen"
            v-tooltip="{ body: '布局参数', meta: '节点大小、连线粗细、斥力与引力' }"
            @click="tweaksOpen = !tweaksOpen"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8M15 4.5v5M9 14.5v5" /></svg>
          </button>
          <button class="gv-icon" aria-label="缩小图谱" @click="zoomBy(1 / 1.25)">−</button>
          <output class="gv-zoom">{{ zoomPercent }}%</output>
          <button class="gv-icon" aria-label="放大图谱" @click="zoomBy(1.25)">+</button>
          <button class="gv-icon" aria-label="适应画布" v-tooltip="{ body: '铺满', meta: '把全部节点缩放到可见范围' }" @click="fit()">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" /></svg>
          </button>
          <button class="gv-icon" :class="{ on: pinned }" :aria-label="pinned ? '取消固定布局' : '固定布局'" :aria-pressed="pinned" v-tooltip="{ body: pinned ? '取消固定' : '固定布局', meta: '停住力导向计算' }" @click="togglePin()">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 3v8M8 7l4-4 4 4M6 21h12" /></svg>
          </button>
        </div>

        <!-- 布局参数（旧图谱设置面板的那几档：显示 + 力） -->
        <div v-if="tweaksOpen" ref="tweakRef" class="gv-tweaks">
          <h4>显示</h4>
          <div class="gv-trow"><span>节点大小</span><output>{{ opt.nodeScale }}%</output></div>
          <input v-model.number="opt.nodeScale" aria-label="节点大小" type="range" min="40" max="180" />
          <div class="gv-trow"><span>连线粗细</span><output>{{ opt.linkScale }}%</output></div>
          <input v-model.number="opt.linkScale" aria-label="连线粗细" type="range" min="40" max="260" />
          <h4>力</h4>
          <div class="gv-trow"><span>中心力</span><output>{{ opt.cF }}</output></div>
          <input v-model.number="opt.cF" aria-label="中心力" type="range" min="0" max="100" />
          <div class="gv-trow"><span>斥力</span><output>{{ opt.rF }}</output></div>
          <input v-model.number="opt.rF" aria-label="斥力" type="range" min="0" max="100" />
          <div class="gv-trow"><span>连线力</span><output>{{ opt.lF }}</output></div>
          <input v-model.number="opt.lF" aria-label="连线力" type="range" min="0" max="100" />
          <div class="gv-trow"><span>连线距离</span><output>{{ opt.lD }}</output></div>
          <input v-model.number="opt.lD" aria-label="连线距离" type="range" min="0" max="100" />
          <button class="gv-treset" @click="resetTweaks()">恢复默认</button>
        </div>

        <div v-if="loading" class="gv-state"><AppSpinner :size="16" /> 正在加载图谱…</div>
        <div v-else-if="loadError" class="gv-state error">
          <p>{{ loadError }}</p>
          <button class="gv-btn" @click="load">重试</button>
        </div>
        <p v-else-if="!rawNodes.length" class="gv-state faint">还没有图谱数据。写几篇带 [[双链]] 的页面后，图谱会自动生长。</p>
        <div v-else-if="!visibleNodes.length" class="gv-state empty">
          <Icon name="graph" :size="32" />
          <strong>没有符合条件的页面</strong>
          <span>{{ mode === 'business' ? '业务视图只显示客户、人物、组织与项目。' : '试试减少筛选条件，继续探索页面之间的联系。' }}</span>
          <button class="gv-btn" @click="mode === 'business' ? switchMode('all') : resetFilters()">{{ mode === 'business' ? '查看全库图谱' : '清空筛选' }}</button>
        </div>
      </div>

      <!-- 右：聚合 / 选中详情 -->
      <aside class="gv-detail" :class="{ hidden: !detailOpen }">
        <div class="gv-panel-head"><b>{{ selected ? '页面详情' : '图谱概览' }}</b><button v-if="selected" aria-label="返回图谱概览" @click="selected = null">返回概览</button><button v-else aria-label="收起图谱概览" @click="detailOpen = false">收起</button></div>
        <template v-if="selected">
          <div class="gv-kind">{{ typeName(selected.group) }}<span v-if="selected.updatedAt"> · 更新于 {{ selected.updatedAt }}</span></div>
          <h3>{{ selected.label }}</h3>
          <div class="gv-nums">
            <div><b>{{ selected.deg }}</b>关联</div>
            <div><b>{{ selected.words }}</b>字数</div>
            <div><b>{{ selected.inDeg }}</b>被引用</div>
          </div>
          <div v-if="selected.tags.length" class="gv-tagbox">
            <button v-for="t in selected.tags" :key="t" class="gv-tag" @click="toggleFacet('tags', t)">{{ t }}</button>
          </div>
          <div class="gv-btnrow">
            <button class="gv-btn" @click="openSelected">打开页面</button>
            <button class="gv-btn" v-if="canFocusSelected" @click="focusSelected">以它为中心</button>
          </div>
          <h5>关联页面（{{ selectedRels.length }}）</h5>
          <div class="gv-rel">
            <button v-for="r in selectedRels.slice(0, 30)" :key="r.id" @click="selectNode(r)">
              <i :style="{ background: colorOf(r) }" /><span>{{ r.label }}</span><em>{{ r.rel }}</em>
            </button>
          </div>
        </template>

        <template v-else>
          <div class="gv-kind">当前筛选</div>
          <h3>{{ visibleNodes.length }} 页 · {{ visibleEdges.length }} 关系</h3>
          <div class="gv-nums">
            <div v-for="t in overviewTypes" :key="t.key">
              <b>{{ t.count }}</b><span><i :style="{ background: t.color }" />{{ t.name }}</span>
            </div>
          </div>
          <h5>标签分布</h5>
          <div class="gv-tagbox">
            <button v-for="t in topTags" :key="t.name" class="gv-tag" @click="toggleFacet('tags', t.name)">{{ t.name }} <b>{{ t.count }}</b></button>
            <span v-if="!topTags.length" class="faint">暂无标签</span>
          </div>
          <h5>最近更新</h5>
          <div class="gv-rel">
            <button v-for="n in recentNodes" :key="n.id" @click="selectNode(n)">
              <i :style="{ background: colorOf(n) }" /><span>{{ n.label }}</span><em>{{ n.updatedAt }}</em>
            </button>
          </div>
        </template>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef, reactive, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { useAppStore } from '../stores/app';
import AppSpinner from '../components/ui/AppSpinner.vue';
import Icon from '../components/Icon.vue';
import { notify } from '../lib/notify';
import { createGraphFrame } from '../lib/graphFrame';
import { createGraphClock, stepGraphForces, type ForceLink } from '../lib/graphPhysics';
import { acceptGraphLabel, type GraphLabelBox } from '../lib/graphLabels';

/* ────────────────────────── 常量 ────────────────────────── */

interface ApiNode { id: string; label: string; group: string; raw: boolean; words: number; tags?: string[]; updatedAt?: string }
interface ApiEdge { from: string; to: string; label?: string }

interface GNode {
  id: string; label: string; group: string; raw: boolean; words: number; tags: string[]; updatedAt: string;
  deg: number; inDeg: number; r: number; x: number; y: number; vx: number; vy: number; fixed: boolean;
}
/** 右栏「关联页面」列表项：邻居节点 + 合并后的关系名 */
type RelItem = GNode & { rel: string };

const TYPE_NAME: Record<string, string> = {
  customer: '客户', concept: '概念', person: '人物', org: '组织', project: '项目',
  doc: '文档', note: '笔记', other: '其他', dead: '死链', raw: '原始资料',
};
/** 组色沿用 UI 2.0 语义色板（与知识库其余界面一致），深色下一套更亮的 */
const TYPE_COLOR: Record<string, [string, string]> = {
  customer: ['#b4761f', '#e0a44c'],
  concept: ['#0f6cbd', '#5aa9e6'],
  person: ['#0e7a6d', '#4fb9a6'],
  org: ['#7b5ac4', '#a48ce0'],
  project: ['#c55a11', '#e08a4c'],
  doc: ['#3a6ea5', '#6f9ac0'],
  note: ['#8a8886', '#9b9a98'],
  other: ['#9a9794', '#8a8886'],
  dead: ['#c42b1c', '#f85149'],
};
/** 业务标签分组：按你的知识库实际标签归类，未归类的进「其他标签」 */
const TAG_GROUPS: { name: string; tags: string[] }[] = [
  { name: '区域', tags: ['京津区', '天津', '北京', '华北', '华北大区', '廊坊', '河北', '天津组', '北京组'] },
  { name: '客户等级', tags: ['A级', 'B级试点', '目标客户', '渠道商', '重点客户'] },
  { name: '分组', tags: ['经理一班', '区域经理', '销售', '技术支持'] },
  { name: '行业', tags: ['半导体', '金属加工', '物流', 'AGV', 'PLC', '汽车', '新能源', '机器人'] },
];
const BUSINESS_TYPES = ['customer', 'person', 'org', 'project'];
const FILTER_KEY = 'engram.graph.filters';

/** 拖动时保持温和的牵引，松手后冷却并自然收敛。 */
const P = { alphaDecay: 0.025, dragAlpha: 0.25, settleAlpha: 0.004, settleSpeed: 0.035 };
/** 外观与力学档位，沿用现有设置与用户保存的值。 */
const OPT_KEY = 'engram.graph.options';
const OPT_DEFAULTS = { nodeScale: 100, linkScale: 100, cF: 65, rF: 50, lF: 60, lD: 40 };

/* ────────────────────────── 状态 ────────────────────────── */

const route = useRoute();
const router = useRouter();
const app = useAppStore();

const rootRef = ref<HTMLElement>();
const stageRef = ref<HTMLElement>();
const baseRef = ref<HTMLCanvasElement>();
const overRef = ref<HTMLCanvasElement>();

const loading = ref(false);
const loadError = ref('');
const pageId = ref((route.params.id as string) || '');
const mode = ref<'business' | 'all' | 'local'>('business');
/** 手机上筛选面板默认收起：一进来就盖住图（原 GraphView 的移动端守护，重写后继续保持） */
const facetsOpen = ref(window.innerWidth > 768);
const detailOpen = ref(window.innerWidth > 768);
const zoomPercent = ref(100);
const pinned = ref(false);

const modes = computed(() => [
  { key: 'business' as const, name: '业务视图', meta: '只看客户 / 人物 / 组织 / 项目' },
  { key: 'all' as const, name: '全库', meta: '包含概念、笔记、文档' },
  ...(pageId.value || selected.value || mode.value === 'local'
    ? [{ key: 'local' as const, name: '本页关联', meta: '以当前页面（或选中节点）为中心的邻居图' }]
    : []),
]);

const filters = reactive({
  q: '', types: [] as string[], tags: [] as string[],
  from: 0, to: 1, minWords: 0, minDeg: 0,
  showRaw: false, showDead: false,
});
const rangeFrom = ref(0);
const rangeTo = ref(100);
const wordSlider = ref(0);
const degSlider = ref(0);

/** 图谱外观与力学档位（localStorage 记忆，沿用旧设置面板的档位与文案） */
const opt = reactive({ ...OPT_DEFAULTS });
const tweaksOpen = ref(false);
const tweakRef = ref<HTMLElement>();
function saveOptions() {
  try { localStorage.setItem(OPT_KEY, JSON.stringify({ ...opt })); } catch { /* 隐私模式忽略 */ }
}
function loadOptions() {
  try {
    const raw = JSON.parse(localStorage.getItem(OPT_KEY) || '{}') as Record<string, unknown>;
    for (const key of Object.keys(OPT_DEFAULTS) as (keyof typeof OPT_DEFAULTS)[]) {
      const v = Number(raw[key]);
      if (Number.isFinite(v)) opt[key] = v;
    }
  } catch { /* 忽略坏数据 */ }
}
function resetTweaks() { Object.assign(opt, OPT_DEFAULTS); }
/** 点面板/按钮之外的地方收起参数面板（浮层不该一直挂着挡图） */
function onDocPointerDown(ev: PointerEvent) {
  if (!tweaksOpen.value) return;
  const target = ev.target as HTMLElement | null;
  if (tweakRef.value?.contains(ev.target as Node)) return;
  if (target?.closest?.('.gv-tweaks-toggle')) return;
  tweaksOpen.value = false;
}

const selected = shallowRef<GNode | null>(null);
const tip = ref<{ x: number; y: number; title: string; kind: string; color: string; deg: number; words: number; tags: string[]; updatedAt: string } | null>(null);
const cursor = ref('grab');
const layoutHint = ref('');
const version = ref(0); // 数据版本，用于驱动 computed

/* ────────────────────────── 数据 ────────────────────────── */

let rawNodes: GNode[] = [];
let rawEdges: { a: number; b: number; rel: string }[] = [];
const nodeIndex = new Map<string, number>();
const adj: { i: number; rel: string }[][] = [];
let dateMinNum = 0;
let dateMaxNum = 0;

function dateNum(d: string) { return d ? Number(d.replace(/-/g, '')) : 0; }
const colorOf = (n: GNode) => (TYPE_COLOR[n.group] || TYPE_COLOR.other)[app.dark ? 1 : 0];
const typeName = (g: string) => TYPE_NAME[g] || TYPE_NAME[g.replace(/^entity-/, '')] || '节点';

/** 「本页关联」的中心：优先路由里的页面，其次当前选中的节点 */
function localId() { return pageId.value || selected.value?.id || ''; }

async function load() {
  loading.value = true;
  loadError.value = '';
  const center = mode.value === 'local' ? localId() : '';
  const params: Record<string, unknown> = { scope: center ? 'page' : 'global' };
  if (center) { params.id = center; params.depth = 2; }
  let data: { nodes: ApiNode[]; edges: ApiEdge[] };
  try {
    ({ data } = await api.get('/api/graph', { params }));
  } catch (error: any) {
    loadError.value = error?.response?.data?.error || error?.message || '图谱加载失败';
    notify.error(loadError.value);
    loading.value = false;
    return;
  }
  loading.value = false;

  const nodes: GNode[] = (data.nodes || []).map((n) => ({
    id: n.id, label: n.label, group: n.group, raw: !!n.raw, words: n.words || 0,
    tags: n.tags || [], updatedAt: n.updatedAt || '',
    deg: 0, inDeg: 0, r: 4, x: 0, y: 0, vx: 0, vy: 0, fixed: false,
  }));
  const index = new Map<string, number>();
  nodes.forEach((n, i) => index.set(n.id, i));
  const edges: { a: number; b: number; rel: string }[] = [];
  for (const e of data.edges || []) {
    const a = index.get(e.from); const b = index.get(e.to);
    if (a == null || b == null || a === b) continue;
    edges.push({ a, b, rel: e.label || '' });
    nodes[b].inDeg++;
    nodes[a].deg++; nodes[b].deg++;
  }

  rawNodes = nodes;
  rawEdges = edges;
  nodeIndex.clear();
  index.forEach((v, k) => nodeIndex.set(k, v));
  adj.length = 0;
  for (let i = 0; i < nodes.length; i++) adj.push([]);
  for (const e of edges) { adj[e.a].push({ i: e.b, rel: e.rel }); adj[e.b].push({ i: e.a, rel: e.rel }); }

  const dates = nodes.map((n) => n.updatedAt).filter(Boolean).sort();
  dateMinNum = dateNum(dates[0] || '');
  dateMaxNum = dateNum(dates[dates.length - 1] || '') || dateMinNum + 1;

  version.value++;
  posCache.clear();
  userAdjusted = false;
  selected.value = null;
  applyFilter();
  layoutHint.value = '';
}

/* ────────────────────────── 筛选 ────────────────────────── */

function passFilter(n: GNode) {
  if (!filters.showRaw && n.raw) return false;
  if (n.group === 'dead' && !filters.showDead) return false;
  if (mode.value === 'business' && !BUSINESS_TYPES.includes(n.group)) return false;
  if (filters.types.length && !filters.types.includes(n.group)) return false;
  if (filters.tags.length && !n.tags.some((t) => filters.tags.includes(t))) return false;
  if (filters.from > 0 || filters.to < 1) {
    const dn = dateNum(n.updatedAt);
    if (!dn) return false;
    const lo = dateMinNum + (dateMaxNum - dateMinNum) * filters.from;
    const hi = dateMinNum + (dateMaxNum - dateMinNum) * filters.to;
    if (dn < lo || dn > hi) return false;
  }
  if (filters.minWords && n.words < filters.minWords) return false;
  if (filters.minDeg && n.deg < filters.minDeg) return false;
  if (filters.q) {
    const q = filters.q.trim().toLowerCase();
    if (q && !(n.label.toLowerCase().includes(q) || n.tags.some((t) => t.toLowerCase().includes(q)))) return false;
  }
  return true;
}

let visible: GNode[] = [];
let visibleIds = new Set<string>();
let visibleLinks: { a: number; b: number; rel: string }[] = [];
const visibleNodes = computed(() => { void version.value; return visible; });
const visibleEdges = computed(() => { void version.value; return visibleLinks; });

/** 左侧筛选面板的候选项：类型计数（按当前「原始资料/死链」开关），标签按业务分组 */
const typeFacets = computed(() => {
  void version.value;
  const pool = rawNodes.filter((n) => {
    if (!filters.showRaw && n.raw) return false;
    if (n.group === 'dead' && !filters.showDead) return false;
    return mode.value !== 'business' || BUSINESS_TYPES.includes(n.group);
  });
  const count = new Map<string, number>();
  for (const n of pool) count.set(n.group, (count.get(n.group) || 0) + 1);
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, c]) => ({ key, name: typeName(key), count: c, color: (TYPE_COLOR[key] || TYPE_COLOR.other)[app.dark ? 1 : 0] }));
});

const tagFacets = computed(() => {
  void version.value;
  const pool = rawNodes.filter((n) => !n.raw && (mode.value !== 'business' || BUSINESS_TYPES.includes(n.group)));
  const count = new Map<string, number>();
  for (const n of pool) for (const t of n.tags) count.set(t, (count.get(t) || 0) + 1);
  const used = new Set<string>();
  const groups = TAG_GROUPS.map((g) => {
    const items = g.tags
      .filter((t) => count.has(t))
      .map((t) => { used.add(t); return { name: t, count: count.get(t)! }; })
      .sort((a, b) => b.count - a.count);
    return { name: g.name, items };
  }).filter((g) => g.items.length);
  const rest = [...count.entries()]
    .filter(([t]) => !used.has(t))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, c]) => ({ name, count: c }));
  if (rest.length) groups.push({ name: '其他标签', items: rest });
  return groups;
});

const dateLabels = computed(() => {
  void version.value;
  const fmt = (num: number) => (num ? `${String(num).slice(0, 4)}-${String(num).slice(4, 6)}-${String(num).slice(6, 8)}` : '—');
  const lo = dateMinNum + (dateMaxNum - dateMinNum) * filters.from;
  const hi = dateMinNum + (dateMaxNum - dateMinNum) * filters.to;
  return [fmt(Math.round(lo)), fmt(Math.round(hi))];
});

const activeChips = computed(() => {
  const chips: { key: string; label: string; remove: () => void }[] = [];
  for (const t of filters.tags) chips.push({ key: 'tag:' + t, label: t, remove: () => toggleFacet('tags', t) });
  for (const t of filters.types) chips.push({ key: 'type:' + t, label: typeName(t), remove: () => toggleFacet('types', t) });
  if (filters.q) chips.push({ key: 'q', label: '搜索：' + filters.q, remove: () => { filters.q = ''; applyFilter(); } });
  if (filters.from > 0 || filters.to < 1) chips.push({ key: 'time', label: `更新 ${dateLabels.value[0]} ~ ${dateLabels.value[1]}`, remove: () => clearFacet('time') });
  if (filters.minWords) chips.push({ key: 'w', label: `字数 ≥ ${filters.minWords}`, remove: () => { filters.minWords = 0; wordSlider.value = 0; applyFilter(); } });
  if (filters.minDeg) chips.push({ key: 'd', label: `关联 ≥ ${filters.minDeg}`, remove: () => { filters.minDeg = 0; degSlider.value = 0; applyFilter(); } });
  return chips;
});

const typeCount = computed(() => {
  void version.value; // visible 是普通数组，靠 version 触发重算
  const c: Record<string, number> = {};
  for (const n of visible) c[n.group] = (c[n.group] || 0) + 1;
  return c;
});
const overviewTypes = computed(() => Object.entries(typeCount.value)
  .sort((a, b) => b[1] - a[1])
  .map(([key, count]) => ({ key, count, name: typeName(key), color: (TYPE_COLOR[key] || TYPE_COLOR.other)[app.dark ? 1 : 0] })));
const topTags = computed(() => {
  void version.value;
  const c = new Map<string, number>();
  for (const n of visible) for (const t of n.tags) c.set(t, (c.get(t) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => ({ name, count }));
});
const recentNodes = computed(() => {
  void version.value;
  return visible.slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 8);
});

const selectedRels = computed<RelItem[]>(() => {
  void version.value;
  const cur = selected.value;
  if (!cur) return [];
  const idx = nodeIndex.get(cur.id);
  if (idx == null) return [];
  const merged = new Map<string, { node: GNode; rels: string[] }>();
  for (const a of adj[idx]) {
    const n = rawNodes[a.i];
    const hit = merged.get(n.id);
    if (hit) { if (a.rel && !hit.rels.includes(a.rel)) hit.rels.push(a.rel); }
    else merged.set(n.id, { node: n, rels: a.rel ? [a.rel] : [] });
  }
  return [...merged.values()]
    .sort((p, q) => q.node.deg - p.node.deg)
    .map((m) => ({ ...m.node, rel: m.rels.join(' · ') }));
});
/** 「以它为中心」只管挪视图，跟节点是不是知识库页面无关（死链/实体节点也能居中看） */
const canFocusSelected = computed(() => !!selected.value);

function toggleFacet(kind: 'types' | 'tags', value: string) {
  const arr = kind === 'types' ? filters.types : filters.tags;
  const i = arr.indexOf(value);
  if (i >= 0) arr.splice(i, 1); else arr.push(value);
  applyFilter();
}
function clearFacet(kind: 'types' | 'tags' | 'time' | 'size') {
  if (kind === 'types') filters.types = [];
  if (kind === 'tags') filters.tags = [];
  if (kind === 'time') { filters.from = 0; filters.to = 1; rangeFrom.value = 0; rangeTo.value = 100; }
  if (kind === 'size') { filters.minWords = 0; filters.minDeg = 0; wordSlider.value = 0; degSlider.value = 0; }
  applyFilter();
}
function resetFilters() {
  Object.assign(filters, { q: '', types: [], tags: [], from: 0, to: 1, minWords: 0, minDeg: 0, showRaw: false, showDead: false });
  rangeFrom.value = 0; rangeTo.value = 100; wordSlider.value = 0; degSlider.value = 0;
  applyFilter();
}
function onRange(which: 'from' | 'to') {
  filters.from = rangeFrom.value / 100;
  filters.to = rangeTo.value / 100;
  if (filters.from > filters.to) {
    if (which === 'from') { filters.to = filters.from; rangeTo.value = rangeFrom.value; }
    else { filters.from = filters.to; rangeFrom.value = rangeTo.value; }
  }
  scheduleFilter();
}
function onSize(which: 'words' | 'deg') {
  if (which === 'words') filters.minWords = Math.round((maxWords() * wordSlider.value) / 100);
  else filters.minDeg = Math.round((maxDeg() * degSlider.value) / 100);
  scheduleFilter();
}
const maxWords = () => rawNodes.reduce((m, n) => Math.max(m, n.words), 1);
const maxDeg = () => rawNodes.reduce((m, n) => Math.max(m, n.deg), 1);

let searchTimer = 0;
function onSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => applyFilter(), 180);
}
let filterTimer = 0;
function scheduleFilter() {
  clearTimeout(filterTimer);
  filterTimer = window.setTimeout(() => applyFilter(), 140);
}

function saveFilters() {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify({
      q: filters.q, types: filters.types, tags: filters.tags, from: filters.from, to: filters.to,
      minWords: filters.minWords, minDeg: filters.minDeg, showRaw: filters.showRaw, showDead: filters.showDead,
      mode: mode.value,
    }));
  } catch { /* 隐私模式忽略 */ }
}
function restoreFilters() {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTER_KEY) || '{}');
    Object.assign(filters, {
      q: raw.q || '', types: raw.types || [], tags: raw.tags || [],
      from: raw.from ?? 0, to: raw.to ?? 1, minWords: raw.minWords || 0, minDeg: raw.minDeg || 0,
      showRaw: !!raw.showRaw, showDead: !!raw.showDead,
    });
    if (raw.mode && !pageId.value) mode.value = raw.mode === 'all' ? 'all' : 'business';
    rangeFrom.value = Math.round(filters.from * 100);
    rangeTo.value = Math.round(filters.to * 100);
  } catch { /* 忽略坏数据 */ }
}

/* ────────────────────────── 力导向布局 ────────────────────────── */

const posCache = new Map<string, { x: number; y: number }>();
let alpha = 1;
let settled = true;
let simActive = false;
let forceLinks: ForceLink[] = [];
const physicsClock = createGraphClock(() => { if (simActive) tick(); });
let seed = 20260929;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

function setLayoutHint() {
  layoutHint.value = pinned.value ? '已固定' : settled ? '布局稳定' : '布局中';
}

/**
 * 面板档位 → 力学参数：默认档（斥力 50 / 连线力 60 / 连线距离 40 / 中心力 65）
 * 保留现有滑块含义；积分器内部处理阻尼、碰撞和度数归一化。
 */
function derivePhysics() {
  return {
    repulsion: 300 + opt.rF * 24,
    linkDist: 40 + opt.lD * 1.6,
    spring: opt.lF * 0.003,
    gravity: opt.cF * 0.0004,
  };
}
let PH = derivePhysics();
function syncPhysics() { PH = derivePhysics(); }

function applyFilter() {
  saveFilters();
  const keep = rawNodes.filter(passFilter);
  visible = keep;
  const visSet = new Set(keep.map((n) => n.id));
  visibleIds = visSet;
  labelPlan = [];
  visibleLinks = rawEdges.filter((e) => visSet.has(rawNodes[e.a].id) && visSet.has(rawNodes[e.b].id));

  forceLinks = visibleLinks.map((l) => ({ a: rawNodes[l.a], b: rawNodes[l.b] }));

  // 半径：字数 + 关联数，开方压缩（避免大小差异被拉成极端）
  const mw = Math.max(1, ...keep.map((n) => n.words));
  const md = Math.max(1, ...keep.map((n) => n.deg));
  for (const n of keep) {
    n.r = 4 + Math.sqrt(n.words / mw) * 8 + Math.sqrt(n.deg / md) * 4;
  }

  // 位置：优先沿用上一次坐标；新出现的节点落在已有邻居附近（保留心智地图）
  for (const n of keep) {
    if (n.vx == null || Number.isNaN(n.vx)) { n.vx = 0; n.vy = 0; }
    if (Number.isNaN(n.x) || Number.isNaN(n.y)) { n.x = 0; n.y = 0; }
    const cached = posCache.get(n.id);
    if (cached && Number.isFinite(cached.x) && Number.isFinite(cached.y)) { n.x = cached.x; n.y = cached.y; continue; }
    const idx = nodeIndex.get(n.id);
    const nb = idx == null ? [] : adj[idx].map((a) => rawNodes[a.i]).filter((m) => visSet.has(m.id) && Number.isFinite(m.x) && !Number.isNaN(m.x));
    if (nb.length) {
      const a = nb[Math.floor(rnd() * nb.length)];
      n.x = a.x + (rnd() - 0.5) * 60;
      n.y = a.y + (rnd() - 0.5) * 60;
    } else {
      const ang = rnd() * Math.PI * 2;
      const rad = 60 + rnd() * 200;
      n.x = Math.cos(ang) * rad;
      n.y = Math.sin(ang) * rad;
    }
  }

  selected.value = selected.value && visSet.has(selected.value.id) ? rawNodes[nodeIndex.get(selected.value.id)!] : null;
  alpha = pinned.value ? 0 : 1; settled = pinned.value;
  userAdjusted = false; // 换了筛选条件：让视图重新居中
  version.value++;
  run();
  scheduleFit();
}

function tick() {
  if (!visible.length) { settled = true; return; }
  const draggingNode = !!drag?.node && drag.moved;
  const maxSpeed = stepGraphForces(visible, forceLinks, PH, alpha);
  alpha += ((draggingNode ? P.dragAlpha : 0) - alpha) * P.alphaDecay;
  settled = !draggingNode && alpha <= P.settleAlpha && maxSpeed < P.settleSpeed;
  if (settled) for (const n of visible) { n.vx = 0; n.vy = 0; }
  for (const n of visible) posCache.set(n.id, { x: n.x, y: n.y });
}

function run() {
  if (!simActive) physicsClock.reset();
  simActive = !pinned.value && !settled;
  setLayoutHint();
  paintFrame.schedule(settled);
}

function relayout() {
  pinned.value = false;
  seed = Math.floor(Math.random() * 4294967296);
  posCache.clear();
  for (const n of visible) { n.x = 0; n.y = 0; n.vx = 0; n.vy = 0; }
  alpha = pinned.value ? 0 : 1; settled = pinned.value;
  run();
  scheduleFit();
}

function togglePin() {
  pinned.value = !pinned.value;
  if (pinned.value) {
    for (const n of visible) { n.vx = 0; n.vy = 0; }
    alpha = 0;
    simActive = false;
    settled = true;
    setLayoutHint();
    paintFrame.schedule(true);
  } else {
    alpha = 0.4;
    settled = false;
    run();
  }
}

/* ────────────────────────── 画布渲染 ────────────────────────── */

let W = 0;
let H = 0;
let dpr = 1;
/** 用户是否手动调整过视图（自己平移/缩放过之后，收敛时不再自动重新居中） */
let userAdjusted = false;
const view = { x: 0, y: 0, s: 1 };
let bctx: CanvasRenderingContext2D | null = null;
let octx: CanvasRenderingContext2D | null = null;
let hover: GNode | null = null;
const paintFrame = createGraphFrame((labels) => {
  // Physics and paint share the same frame so hit testing sees exactly the positions on screen.
  if (simActive) {
    physicsClock.advance(performance.now());
    if (settled) {
      simActive = false;
      labels = true;
      if (!userAdjusted) fit();
      setLayoutHint();
    }
  }
  if (labels) planLabels();
  zoomPercent.value = Math.round(view.s * 100);
  drawBase();
  drawOver();
  if (simActive) paintFrame.schedule();
});
let fitTimer = 0;
let labelTimer = 0;
function scheduleFit() {
  clearTimeout(fitTimer);
  fitTimer = window.setTimeout(() => { if (!userAdjusted) fit(); }, 320);
}
function scheduleLabels() {
  clearTimeout(labelTimer);
  labelTimer = window.setTimeout(() => paintFrame.schedule(true), 100);
}

/** 画布需要具体颜色，不能直接用 CSS 变量；从根元素的令牌读，主题切换时刷新（画布底色与 App 背景保持一致） */
function cssVar(el: HTMLElement | undefined, name: string, fallback: string) {
  const v = el ? getComputedStyle(el).getPropertyValue(name).trim() : '';
  return v || fallback;
}
let palette = {
  bg: '#ffffff', edge: 'rgba(20,20,25,.10)', edgeHot: '#0f6cbd',
  label: 'rgba(23,24,27,.66)', labelHot: '#17181B',
  /** 选中/悬停：亮色实心（focus）与关联节点提亮（tint），不再用描边圈 */
  focus: '#0f6cbd', tint: 'rgba(255,255,255,.42)',
};
function refreshPalette() {
  const dark = app.dark;
  palette = {
    bg: cssVar(rootRef.value, '--bg', dark ? '#0e0f12' : '#ffffff'),
    edge: dark ? 'rgba(255,255,255,.15)' : 'rgba(31,30,29,.14)',
    edgeHot: cssVar(rootRef.value, '--accent', '#2b5ce6'),
    label: dark ? 'rgba(241,242,244,.72)' : 'rgba(23,24,27,.66)',
    labelHot: dark ? '#FFFFFF' : '#17181B',
    focus: cssVar(rootRef.value, '--accent', '#2b5ce6'),
    tint: dark ? 'rgba(255,255,255,.24)' : 'rgba(255,255,255,.42)',
  };
}
const theme = () => palette;

function resize() {
  const stage = stageRef.value;
  if (!stage) return;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = stage.getBoundingClientRect();
  W = Math.max(1, Math.round(rect.width));
  H = Math.max(1, Math.round(rect.height));
  for (const cv of [baseRef.value, overRef.value]) {
    if (!cv) continue;
    cv.style.width = `${W}px`;
    cv.style.height = `${H}px`;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
  }
  bctx = baseRef.value?.getContext('2d') || null;
  octx = overRef.value?.getContext('2d') || null;
}

/** 标签布局：在屏幕空间规划一次，存成「相对节点的像素偏移」——平移缩放不需要重排文字 */
let labelPlan: { n: GNode; text: string; fs: number; bold: boolean; dx: number; dy: number }[] = [];
function planLabels() {
  if (!bctx) return;
  labelPlan = [];
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const nodeBoxes = visible.map((n) => {
    const r = nodeScreenR(n.r) + 2;
    return { n, x: n.x * view.s + view.x - r, y: n.y * view.s + view.y - r, w: r * 2, h: r * 2 };
  });
  const intersect = (a: typeof placed[0], b: typeof placed[0]) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const order = visible.slice().sort((a, b) => b.deg - a.deg || b.words - a.words);
  const budget = view.s > 1.6 ? 60 : view.s > 1.0 ? 34 : 22;
  for (const n of order) {
    if (labelPlan.length >= budget) break;
    const text = n.label.length > 18 ? `${n.label.slice(0, 17)}…` : n.label;
    const fs = n.deg > 12 ? 13 : 12;
    const bold = n.deg > 12;
    bctx.font = `${bold ? 600 : 400} ${fs}px "Segoe UI","Microsoft YaHei",system-ui,sans-serif`;
    const tw = bctx.measureText(text).width;
    const th = fs + 3;
    const sx = n.x * view.s + view.x;
    const sy = n.y * view.s + view.y;
    const rp = nodeScreenR(n.r);
    const cands = [
      { x: sx - tw / 2, y: sy + rp + 4 },
      { x: sx - tw / 2, y: sy - rp - th - 4 },
      { x: sx + rp + 5, y: sy - th / 2 },
      { x: sx - tw - rp - 5, y: sy - th / 2 },
    ];
    let box: typeof placed[0] | null = null;
    for (const c of cands) {
      const b = { x: Math.round(c.x), y: Math.round(c.y), w: tw + 4, h: th + 2 };
      if (b.x < 6 || b.x + b.w > W - 6 || b.y < 4 || b.y + b.h > H - 4) continue;
      if (!placed.some((p) => intersect(b, p)) && !nodeBoxes.some((p) => p.n !== n && intersect(b, p))) { box = b; break; }
    }
    if (!box) continue; // 放不下就不放，宁缺毋滥
    placed.push(box);
    labelPlan.push({ n, text, fs, bold, dx: box.x - sx + 2, dy: box.y - sy + th / 2 });
  }
}

function drawBase() {
  if (!bctx || !W) return;
  const T = theme();
  bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  bctx.clearRect(0, 0, W, H);
  if (!visible.length) return;
  bctx.save();
  bctx.translate(view.x, view.y);
  bctx.scale(view.s, view.s);

  // 边：一次性批量描边（不逐条 stroke，省一半时间）
  bctx.beginPath();
  for (const l of visibleLinks) {
    const a = rawNodes[l.a];
    const b = rawNodes[l.b];
    bctx.moveTo(a.x, a.y);
    bctx.lineTo(b.x, b.y);
  }
  bctx.lineWidth = linkScale() / view.s;
  bctx.strokeStyle = T.edge;
  bctx.stroke();

  // 节点：屏幕半径钳制在 2.5–18px，放大时不会变成巨球
  for (const n of visible) {
    const sx = n.x * view.s + view.x;
    const sy = n.y * view.s + view.y;
    if (sx < -24 || sx > W + 24 || sy < -24 || sy > H + 24) continue;
    const rr = nodeScreenR(n.r);
    bctx.beginPath();
    bctx.arc(n.x, n.y, rr / view.s, 0, Math.PI * 2);
    bctx.fillStyle = colorOf(n);
    bctx.fill();
    if (rr > 7) {
      bctx.lineWidth = 1.2 / view.s;
      bctx.strokeStyle = app.dark ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.85)';
      bctx.stroke();
    }
  }
  bctx.restore();

  // 标签
  bctx.textBaseline = 'middle';
  bctx.textAlign = 'left';
  const occupied: GraphLabelBox[] = [];
  const focus = hover || selected.value;
  if (focus) {
    bctx.font = '600 12.5px "Segoe UI","Microsoft YaHei",system-ui,sans-serif';
    const width = bctx.measureText(focus.label).width;
    occupied.push({ x: focus.x * view.s + view.x - width / 2,
      y: focus.y * view.s + view.y - nodeScreenR(focus.r) - 20, w: width, h: 16 });
  }
  for (const L of labelPlan) {
    if (L.n.id === (hover || selected.value)?.id) continue; // The overlay draws the focused title once.
    const x = Math.round(L.n.x * view.s + view.x + L.dx);
    const y = Math.round(L.n.y * view.s + view.y + L.dy);
    bctx.font = `${L.bold ? 600 : 400} ${L.fs}px "Segoe UI","Microsoft YaHei",system-ui,sans-serif`;
    // Nodes move while dragging. Recheck collisions without rebuilding or swapping label anchors.
    if (!acceptGraphLabel({ x, y: y - L.fs / 2 - 2, w: bctx.measureText(L.text).width, h: L.fs + 4 }, occupied)) continue;
    bctx.lineWidth = 3.2;
    bctx.strokeStyle = T.bg;
    bctx.strokeText(L.text, x, y);
    bctx.fillStyle = L.bold ? T.labelHot : T.label;
    bctx.fillText(L.text, x, y);
  }
}

/** 节点在屏幕上的实际绘制半径（含面板「节点大小」倍率与 2.5–18px 钳制）：画布、标签、高亮共用一套 */
function nodeScreenR(r: number) {
  return Math.max(2.5, Math.min(18, r * (opt.nodeScale / 100) * view.s));
}
/** 同一半径的世界坐标版本——高亮必须紧贴节点本身 */
function nodeRadius(r: number) {
  return nodeScreenR(r) / view.s;
}
/** 连线粗细倍率（面板档位，默认 100%） */
const linkScale = () => opt.linkScale / 100;

function drawOver() {
  if (!octx || !W) return;
  const T = theme();
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, W, H);
  const focus = hover || selected.value;
  if (!focus) return;
  const idx = nodeIndex.get(focus.id);
  if (idx == null) return;
  octx.save();
  octx.translate(view.x, view.y);
  octx.scale(view.s, view.s);
  octx.beginPath();
  for (const a of adj[idx]) {
    const m = rawNodes[a.i];
    if (!visibleIds.has(m.id)) continue;
    octx.moveTo(focus.x, focus.y);
    octx.lineTo(m.x, m.y);
  }
  octx.lineWidth = (1.6 * linkScale()) / view.s;
  octx.strokeStyle = T.edgeHot;
  octx.stroke();
  // 关联节点：只叠一层亮色（不再是描边圈——圈在缩放后常常比节点本身还大，太抢眼）
  octx.fillStyle = T.tint;
  for (const a of adj[idx]) {
    const m = rawNodes[a.i];
    if (!visibleIds.has(m.id)) continue;
    octx.beginPath();
    octx.arc(m.x, m.y, nodeRadius(m.r), 0, Math.PI * 2);
    octx.fill();
  }
  // 焦点：亮色实心 + 柔和外发光，尺寸只比原节点大半像素，不做圈
  const fr = nodeRadius(focus.r) + 1.5 / view.s;
  octx.save();
  octx.shadowColor = T.focus;
  octx.shadowBlur = Math.min(10, 3 + fr * view.s * 0.8);
  octx.beginPath();
  octx.arc(focus.x, focus.y, fr, 0, Math.PI * 2);
  octx.fillStyle = T.focus;
  octx.fill();
  octx.restore();
  octx.restore();

  // 焦点标签强制显示
  const px = focus.x * view.s + view.x;
  const py = focus.y * view.s + view.y;
  const rp = nodeScreenR(focus.r);
  octx.font = '600 12.5px "Segoe UI","Microsoft YaHei",system-ui,sans-serif';
  octx.textAlign = 'center';
  octx.textBaseline = 'middle';
  octx.lineWidth = 3.2;
  octx.strokeStyle = T.bg;
  octx.strokeText(focus.label, px, py - rp - 12);
  octx.fillStyle = T.labelHot;
  octx.fillText(focus.label, px, py - rp - 12);
}

/* ────────────────────────── 视图操作 ────────────────────────── */

function fit() {
  if (!visible.length) return;
  cancelAnimationFrame(camRaf);
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const n of visible) {
    x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r);
    x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r);
  }
  const pad = Math.min(90, W * 0.16, H * 0.16);
  const s = Math.min(1.5, Math.max(0.06, Math.min((W - pad * 2) / Math.max(1, x1 - x0), (H - pad * 2) / Math.max(1, y1 - y0))));
  view.s = s;
  view.x = W / 2 - ((x0 + x1) / 2) * s;
  view.y = H / 2 - ((y0 + y1) / 2) * s;
  paintFrame.schedule(true);
}

function screenToWorld(mx: number, my: number) {
  return { x: (mx - view.x) / view.s, y: (my - view.y) / view.s };
}
function hitTest(mx: number, my: number): GNode | null {
  const w = screenToWorld(mx, my);
  let best: GNode | null = null;
  let bd = Infinity;
  for (const n of visible) {
    const d = Math.hypot(n.x - w.x, n.y - w.y);
    const tol = nodeRadius(n.r) + 6 / view.s;
    if (d < tol && d < bd) { bd = d; best = n; }
  }
  return best;
}

/** 以某个节点为中心：只平移（缩得太小时拉到可读档），不重载数据、不重跑布局，所以不会乱跳 */
let camRaf = 0;
function centerOn(node: GNode) {
  if (!W) return;
  const s = view.s < 0.85 ? 1 : view.s;
  const from = { x: view.x, y: view.y, s: view.s };
  const to = { x: W / 2 - node.x * s, y: H / 2 - node.y * s, s };
  const t0 = performance.now();
  const dur = 240;
  cancelAnimationFrame(camRaf);
  userAdjusted = true; // 用户主动对焦：收敛后不再自动带动视图
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / dur);
    const e = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2; // easeInOutQuad
    view.s = from.s + (to.s - from.s) * e;
    view.x = from.x + (to.x - from.x) * e;
    view.y = from.y + (to.y - from.y) * e;
    paintFrame.schedule(k === 1);
    if (k < 1) camRaf = requestAnimationFrame(step);
  };
  step();
}

/* ────────────────────────── 交互 ────────────────────────── */

let drag: { node: GNode | null; pointerId: number; x: number; y: number; vx: number; vy: number; offsetX: number; offsetY: number; moved: boolean } | null = null;
let clickTimer = 0;
let lastClickAt = 0;
let lastClickId = '';

function pointerPos(ev: PointerEvent | WheelEvent) {
  const rect = baseRef.value!.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

function onPointerDown(ev: PointerEvent) {
  const cv = baseRef.value;
  if (!cv || drag || ev.button !== 0) return;
  cancelAnimationFrame(camRaf);
  clearTimeout(clickTimer);
  cv.setPointerCapture(ev.pointerId);
  const { x, y } = pointerPos(ev);
  const node = hitTest(x, y);
  const w = screenToWorld(x, y);
  drag = { node, pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, offsetX: node ? node.x - w.x : 0, offsetY: node ? node.y - w.y : 0, moved: false };
  if (node) { node.fixed = true; node.vx = 0; node.vy = 0; }
  hover = null;
  tip.value = null;
  paintFrame.schedule();
  cursor.value = 'grabbing';
}

function onPointerMove(ev: PointerEvent) {
  if (!baseRef.value) return;
  const { x, y } = pointerPos(ev);
  if (drag) {
    if (ev.pointerId !== drag.pointerId) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; userAdjusted = true; }
    if (drag.node) {
      // 被拖节点固定在指针处，其余节点继续受连线、斥力与惯性影响。
      const w = screenToWorld(x, y);
      drag.node.x = w.x + drag.offsetX;
      drag.node.y = w.y + drag.offsetY;
      drag.node.vx = 0;
      drag.node.vy = 0;
      if (drag.moved && !pinned.value) {
        alpha = Math.max(alpha, P.dragAlpha);
        settled = false;
        if (!simActive) run();
      }
    } else {
      view.x = drag.vx + dx;
      view.y = drag.vy + dy;
      userAdjusted = true;
    }
    paintFrame.schedule();
    return;
  }
  const node = hitTest(x, y);
  if (node !== hover) {
    hover = node;
    paintFrame.schedule();
    cursor.value = node ? 'pointer' : 'grab';
    if (node) {
      tip.value = {
        x: Math.max(8, Math.min(x + 14, W - 240)), y: Math.max(8, Math.min(y + 14, H - 110)),
        title: node.label, kind: typeName(node.group), color: colorOf(node),
        deg: node.deg, words: node.words, tags: node.tags, updatedAt: node.updatedAt,
      };
    } else {
      tip.value = null;
    }
  }
}

function onPointerUp(ev: PointerEvent) {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  cursor.value = 'grab';
  const wasDrag = drag.moved;
  const node = drag.node;
  drag = null;
  if (baseRef.value?.hasPointerCapture(ev.pointerId)) baseRef.value.releasePointerCapture(ev.pointerId);
  if (node) { node.fixed = false; posCache.set(node.id, { x: node.x, y: node.y }); }
  // Keep neighbor momentum on release; cool the forces instead of freezing or restarting the layout.
  if (node && wasDrag && !pinned.value) {
    settled = false;
    run();
  }
  paintFrame.schedule(true);
  if (ev.type === 'pointercancel' || ev.type === 'lostpointercapture') return;
  if (wasDrag || !node) return;

  // 单击 = 选中（打开页面走右栏按钮）；300ms 内的第二次点击 = 以它为中心（只挪视图，不重排）
  const now = Date.now();
  if (node.id === lastClickId && now - lastClickAt < 300) {
    clearTimeout(clickTimer);
    lastClickAt = 0;
    centerOn(node);
    return;
  }
  lastClickAt = now;
  lastClickId = node.id;
  clearTimeout(clickTimer);
  clickTimer = window.setTimeout(() => {
    selectNode(node);
  }, 200);
}

function onPointerLeave() {
  if (drag) return;
  hover = null;
  tip.value = null;
  paintFrame.schedule();
}

function selectNode(node: GNode) {
  const index = nodeIndex.get(node.id);
  if (index == null) return;
  selected.value = rawNodes[index];
  hover = null;
  tip.value = null;
  detailOpen.value = true;
  paintFrame.schedule();
}

function zoomAt(k: number, x: number, y: number) {
  cancelAnimationFrame(camRaf);
  const ns = Math.min(4, Math.max(0.06, view.s * k));
  view.x = x - (x - view.x) * (ns / view.s);
  view.y = y - (y - view.y) * (ns / view.s);
  view.s = ns;
  userAdjusted = true;
  paintFrame.schedule();
  scheduleLabels();
}
function zoomBy(k: number) { zoomAt(k, W / 2, H / 2); }

function onWheel(ev: WheelEvent) {
  ev.preventDefault();
  const { x, y } = pointerPos(ev);
  if (drag) return;
  const delta = ev.deltaY * (ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? H : 1);
  zoomAt(Math.exp(-delta * 0.0012), x, y);
}

/* ────────────────────────── 模式与跳转 ────────────────────────── */

function switchMode(next: 'business' | 'all' | 'local') {
  if (mode.value === next) return;
  if (next === 'local' && !localId()) {
    notify.info('先选中一个节点，或从某个页面点「本页关联」进来');
    return;
  }
  const wasLocal = mode.value === 'local';
  mode.value = next;
  if (next === 'local') {
    load();
    return;
  }
  if (wasLocal) { load(); return; }
  posCache.clear();
  applyFilter();
}

/** 「以它为中心」：把视图平移到该节点（缩得太小时拉到可读档），不再重载局部图、不再重排 */
function focusSelected() {
  if (selected.value) centerOn(selected.value);
}

function openSelected() {
  const n = selected.value;
  if (!n) return;
  if (n.id.includes(':')) { notify.info('该节点不是知识库页面，无法打开'); return; }
  router.push(`/page/${n.id}`);
}

/**
 * 面板档位变化：外观（节点大小 / 连线粗细）立即重绘；力学参数防抖后再重新收敛，
 * 拖滑块时不会每帧重启布局；固定布局状态下不打扰用户已经摆好的位置。
 */
let optTimer = 0;
watch(opt, () => {
  syncPhysics();
  saveOptions();
  paintFrame.schedule(true);
  clearTimeout(optTimer);
  optTimer = window.setTimeout(() => {
    if (pinned.value || !visible.length) return;
    alpha = Math.max(alpha, 0.6);
    settled = false;
    run();
  }, 140);
});

watch(() => app.dark, () => {
  refreshPalette();
  paintFrame.schedule();
});
watch(selected, () => paintFrame.schedule());

watch(() => route.params.id, (id) => {
  if (!id) return;
  pageId.value = id as string;
  mode.value = 'local';
  posCache.clear();
  load();
});

/* ────────────────────────── 生命周期 ────────────────────────── */

let ro: ResizeObserver | null = null;

onMounted(async () => {
  restoreFilters();
  loadOptions();
  syncPhysics();
  resize();
  refreshPalette();
  document.addEventListener('pointerdown', onDocPointerDown);
  const cv = baseRef.value!;
  cv.addEventListener('pointerdown', onPointerDown);
  cv.addEventListener('pointermove', onPointerMove);
  cv.addEventListener('pointerup', onPointerUp);
  cv.addEventListener('pointercancel', onPointerUp as unknown as EventListener);
  cv.addEventListener('lostpointercapture', onPointerUp);
  cv.addEventListener('pointerleave', onPointerLeave);
  cv.addEventListener('wheel', onWheel, { passive: false });
  ro = new ResizeObserver(() => { resize(); paintFrame.schedule(true); });
  ro.observe(stageRef.value!);
  if (pageId.value) mode.value = 'local';
  await nextTick();
  resize();
  await load();
});

onUnmounted(() => {
  simActive = false;
  cancelAnimationFrame(camRaf);
  paintFrame.cancel();
  clearTimeout(fitTimer);
  clearTimeout(labelTimer);
  clearTimeout(clickTimer);
  clearTimeout(filterTimer);
  clearTimeout(searchTimer);
  clearTimeout(optTimer);
  document.removeEventListener('pointerdown', onDocPointerDown);
  ro?.disconnect();
});
</script>

<style scoped>
.graph-view {
  height: 100%; position: relative; isolation: isolate; display: flex; flex-direction: column;
  overflow: hidden; background: var(--bg); color: var(--text);
}
button { font: inherit; cursor: pointer; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.gv-top {
  flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 12px;
  min-height: 68px; padding: 14px 20px; border-bottom: 1px solid var(--border); background: var(--card-bg);
}
.gv-brand { display: flex; align-items: center; gap: 9px; margin-right: 8px; color: var(--accent); }
.gv-brand b { color: var(--text); font-size: 18px; font-weight: 650; letter-spacing: -.03em; }
.gv-seg { display: flex; background: var(--bg-tertiary); border-radius: var(--radius-control); padding: 3px; }
.gv-seg button {
  appearance: none; border: 0; background: transparent; font-size: 13px;
  color: var(--text-secondary); padding: 7px 12px; border-radius: 6px; white-space: nowrap;
  transition: background .16s, color .16s, box-shadow .16s;
}
.gv-seg button.on { background: var(--card-bg); color: var(--accent); font-weight: 600; box-shadow: var(--shadow-raised); }
.gv-search {
  display: flex; align-items: center; gap: 9px; height: 36px; padding: 0 12px;
  border: 1px solid var(--border); border-radius: var(--radius-control); background: var(--bg-secondary);
  flex: 1; min-width: 160px; max-width: 340px; color: var(--text-faint); transition: border-color .16s;
}
.gv-search:focus-within { border-color: var(--accent); }
.gv-search input { border: 0; background: transparent; outline: none; font: inherit; font-size: 13px; color: var(--text); width: 100%; min-width: 0; }
.gv-chips { display: flex; gap: 6px; align-items: center; overflow-x: auto; order: 5; width: 100%; }
.gv-chips:empty { display: none; }
.gv-chip {
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; padding: 4px 10px;
  border-radius: 99px; font-size: 12px; background: var(--accent-soft); color: var(--accent);
}
.gv-chip button { border: 0; background: transparent; color: inherit; padding: 0 2px; font-size: 16px; }
.gv-actions { display: flex; gap: 6px; margin-left: auto; }
.gv-icon, .gv-tool {
  appearance: none; height: 36px; border-radius: var(--radius-control); border: 1px solid transparent;
  background: var(--bg-secondary); color: var(--text-secondary); display: flex; align-items: center; justify-content: center;
  transition: color .16s, background .16s, border-color .16s;
}
.gv-icon { width: 36px; flex: none; font-size: 19px; }
.gv-tool { gap: 6px; padding: 0 11px; font-size: 13px; white-space: nowrap; }
.gv-icon:hover, .gv-tool:hover { color: var(--text); background: var(--bg-hover); border-color: var(--border); }
.gv-icon.on, .gv-tool.on { color: var(--accent); background: var(--accent-soft); }
.gv-main { flex: 1; display: flex; min-height: 0; position: relative; }
.gv-facets {
  width: 212px; flex: none; border-right: 1px solid var(--border); background: var(--card-bg);
  overflow-y: auto; padding: 18px 12px;
}
.gv-facets.hidden, .gv-detail.hidden { display: none; }
.gv-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 20px; font-size: 14px; }
.gv-panel-head b { font-weight: 600; }
.gv-panel-head button { border: 0; background: transparent; color: var(--text-secondary); font-size: 12px; padding: 4px; }
.gv-panel-head button:hover { color: var(--accent); }
.gv-fgroup { padding: 0 0 18px; }
.gv-fgroup + .gv-fgroup { padding-top: 2px; }
.gv-fgroup h4 {
  margin: 0 4px 8px; font-size: 12px; color: var(--text-secondary); font-weight: 600;
  display: flex; justify-content: space-between; align-items: center;
}
.gv-fgroup h4 button { border: 0; background: transparent; color: var(--text-faint); font-size: 12px; padding: 2px; }
.gv-fgroup h4 button:hover { color: var(--accent); }
.gv-frow {
  appearance: none; border: 0; background: transparent; width: 100%; text-align: left;
  display: flex; align-items: center; gap: 9px; min-height: 34px; padding: 6px 8px; border-radius: 8px;
  font-size: 13px; color: var(--text-secondary); transition: background .14s, color .14s;
}
.gv-frow:hover { background: var(--bg-hover); color: var(--text); }
.gv-frow.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.gv-frow .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.gv-frow .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gv-frow .ct { min-width: 24px; text-align: center; font-size: 12px; color: var(--text-secondary); background: var(--bg-tertiary); border-radius: 5px; padding: 1px 4px; font-variant-numeric: tabular-nums; }
.gv-frow.on .ct { color: var(--accent); background: var(--card-bg); }
.gv-frow.switch { cursor: pointer; }
.gv-sw { position: relative; width: 32px; height: 18px; flex: none; }
.gv-sw input { position: absolute; opacity: 0; inset: 0; width: 100%; height: 100%; margin: 0; }
.gv-sw i { pointer-events: none; position: absolute; inset: 0; background: var(--border-strong); border-radius: 99px; transition: background .18s; }
.gv-sw i::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .18s; }
.gv-sw input:checked + i { background: var(--accent); }
.gv-sw input:checked + i::after { transform: translateX(14px); }
.gv-sw input:focus-visible + i { outline: 2px solid var(--accent); outline-offset: 3px; }
.gv-range { padding: 2px 8px 0; }
.gv-range .lbl { display: flex; justify-content: space-between; gap: 6px; font-size: 12px; color: var(--text-secondary); }
.gv-range input[type='range'] { width: 100%; accent-color: var(--accent); margin: 5px 0; }
.gv-stage {
  position: relative; flex: 1; min-width: 0; overflow: hidden; background-color: var(--bg);
  background-image: radial-gradient(var(--border-strong) .7px, transparent .7px); background-size: 24px 24px;
}
.gv-canvas { position: absolute; inset: 0; display: block; touch-action: none; }
.gv-canvas.over { pointer-events: none; }
.gv-stats {
  position: absolute; left: 20px; top: 18px; z-index: 5; display: flex; align-items: center; gap: 10px;
  font-size: 12px; color: var(--text-secondary); background: var(--card-bg); border: 1px solid var(--border);
  border-radius: 99px; padding: 8px 12px; box-shadow: var(--shadow-raised); pointer-events: none;
}
.gv-stats b { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
.gv-status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success); }
.gv-status-dot.busy { background: var(--accent); }
.gv-layout-state { border-left: 1px solid var(--border-strong); padding-left: 10px; font-size: 12px; }
.gv-help { position: absolute; bottom: 22px; left: 20px; color: var(--text-secondary); font-size: 12px; pointer-events: none; }
.gv-hud {
  position: absolute; right: 20px; bottom: 16px; z-index: 5; display: flex; align-items: center; gap: 3px;
  padding: 5px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-card);
}
.gv-hud .gv-icon { background: transparent; }
.gv-hud .gv-icon:hover { background: var(--bg-hover); }
.gv-hud .gv-icon.on { background: var(--accent-soft); }
.gv-zoom { font-size: 12px; width: 44px; text-align: center; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.gv-tweaks {
  position: absolute; right: 20px; bottom: 76px; z-index: 8; width: 248px; padding: 16px 18px;
  background: var(--card-bg); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow);
  animation: graph-panel-in .16s ease-out;
}
.gv-tweaks h4 { margin: 14px 0 8px; font-size: 13px; color: var(--text); font-weight: 600; }
.gv-tweaks h4:first-child { margin-top: 0; }
.gv-trow { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; font-size: 13px; color: var(--text-secondary); }
.gv-trow output { color: var(--text); font-size: 12px; font-variant-numeric: tabular-nums; }
.gv-tweaks input[type='range'] { width: 100%; margin: 4px 0; accent-color: var(--accent); }
.gv-treset { width: 100%; min-height: 34px; margin-top: 14px; font-size: 13px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-secondary); color: var(--text-secondary); }
.gv-treset:hover { background: var(--bg-hover); color: var(--text); }
.gv-tip { position: absolute; z-index: 6; pointer-events: none; max-width: min(240px, calc(100% - 16px)); padding: 12px 14px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); }
.gv-tip .t { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; overflow-wrap: anywhere; }
.gv-tip .t i { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.gv-tip .m { margin-top: 6px; font-size: 12px; color: var(--text-secondary); display: flex; gap: 8px; flex-wrap: wrap; }
.gv-tip .g { margin-top: 6px; font-size: 12px; color: var(--text-secondary); }
.gv-state { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(340px, calc(100% - 40px)); display: flex; flex-direction: column; align-items: center; gap: 12px; color: var(--text-secondary); z-index: 7; text-align: center; }
.gv-state strong { font-size: 17px; color: var(--text); }
.gv-state span { font-size: 13px; line-height: 1.7; }
.gv-state.error { color: var(--danger); }
.gv-state .gv-btn { flex: none; padding: 0 16px; }
.gv-detail { width: 272px; flex: none; border-left: 1px solid var(--border); background: var(--card-bg); overflow-y: auto; padding: 18px; }
.gv-kind { font-size: 12px; color: var(--text-secondary); line-height: 1.6; }
.gv-detail h3 { margin: 8px 0; font-size: 21px; font-weight: 650; letter-spacing: -.025em; line-height: 1.4; overflow-wrap: anywhere; }
.gv-detail h5 { margin: 24px 0 10px; font-size: 13px; color: var(--text); font-weight: 600; }
.gv-nums { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px 8px; margin: 18px 0; padding-bottom: 18px; border-bottom: 1px solid var(--border); }
.gv-nums div { font-size: 12px; color: var(--text-secondary); }
.gv-nums b { display: block; margin-bottom: 5px; font-size: 23px; font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
.gv-nums span { display: flex; align-items: center; gap: 5px; }
.gv-nums i { width: 5px; height: 5px; border-radius: 50%; }
.gv-tagbox { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.gv-tag { border: 0; font-size: 12px; padding: 5px 9px; border-radius: 6px; background: var(--bg-tertiary); color: var(--text-secondary); transition: background .16s, color .16s; }
.gv-tag b { margin-left: 4px; font-size: 11px; font-weight: 500; }
.gv-tag:hover { background: var(--accent-soft); color: var(--accent); }
.gv-btnrow { display: flex; gap: 8px; margin: 18px 0 2px; }
.gv-btn { font-size: 13px; flex: 1; min-height: 36px; border-radius: 8px; border: 1px solid var(--border-strong); background: var(--card-bg); color: var(--text); transition: background .16s; }
.gv-btnrow .gv-btn:first-child, .gv-state .gv-btn { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
.gv-btn:hover { background: var(--bg-hover); }
.gv-btnrow .gv-btn:first-child:hover, .gv-state .gv-btn:hover { background: var(--accent-hover); }
.gv-rel { display: flex; flex-direction: column; gap: 3px; }
.gv-rel button { border: 0; background: transparent; display: flex; align-items: center; gap: 8px; padding: 9px 5px; border-radius: 6px; text-align: left; font-size: 13px; color: var(--text-secondary); }
.gv-rel button:hover { background: var(--bg-hover); color: var(--text); }
.gv-rel button i { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.gv-rel button span { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.gv-rel button em { font-style: normal; margin-left: auto; color: var(--text-faint); font-size: 11px; max-width: 42%; overflow-wrap: anywhere; }
.faint { color: var(--text-faint); font-size: 13px; }
@keyframes graph-panel-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
@media (max-width: 1024px) {
  .gv-top { padding: 12px 16px; gap: 8px; }
  .gv-brand { margin-right: 0; }
  .gv-brand b { font-size: 16px; }
  .gv-facets { width: 190px; }
  .gv-detail { width: 240px; padding: 16px; }
  .gv-help { display: none; }
}
@media (max-width: 768px) {
  .gv-top { padding: 12px; gap: 10px; }
  .gv-brand { flex: 1 1 calc(100% - 180px); min-width: 110px; }
  .gv-brand b { white-space: nowrap; }
  .gv-seg { order: 2; }
  .gv-search { order: 3; flex: 1; min-width: 100px; max-width: none; }
  .gv-actions { gap: 4px; }
  .gv-actions .gv-tool { padding: 0 8px; }
  .gv-main { position: static; }
  .gv-facets {
    position: absolute; top: 110px; bottom: calc(72px + var(--safe-bottom)); left: 0; z-index: 9;
    height: auto; box-shadow: var(--shadow); width: min(272px, 85%); padding: 18px;
  }
  .gv-facets.hidden { display: none; }
  .gv-detail {
    position: absolute; left: 12px; right: 12px; bottom: calc(72px + var(--safe-bottom)); z-index: 10;
    width: auto; max-height: 42%; border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow);
    animation: graph-panel-in .16s ease-out;
  }
  .gv-detail .gv-panel-head { margin-bottom: 12px; }
  .gv-stats { left: 12px; top: 14px; padding: 7px 10px; gap: 8px; }
  .gv-hud { right: 12px; bottom: calc(84px + var(--safe-bottom)); }
  .gv-tweaks {
    left: 12px; right: 12px; bottom: calc(144px + var(--safe-bottom)); width: auto;
    max-height: 52%; overflow-y: auto; z-index: 11;
  }
}
@media (hover: none) and (pointer: coarse) {
  .gv-sw { width: 46px; height: 26px; }
  .gv-sw i::after { width: 22px; height: 22px; }
  .gv-sw input:checked + i::after { transform: translateX(20px); }
  .gv-frow { min-height: 40px; }
  .gv-icon { width: 40px; height: 40px; }
  .gv-tool { height: 40px; }
  .gv-seg button { padding: 8px 12px; }
  .gv-tweaks input[type='range'] { height: 30px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
</style>
