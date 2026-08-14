<template>
  <div class="graph-view">
    <div class="graph-toolbar">
      <b>知识图谱</b>
      <div class="graph-controls">
        <button class="btn small" :class="{ primary: scope === 'global' }" @click="scope = 'global'; load()">全局</button>
        <button v-if="pageId" class="btn small" :class="{ primary: scope === 'page' }" @click="scope = 'page'; load()">本页关联</button>
        <button class="btn small" @click="fit">铺满</button>
        <button class="btn small" @click="relayout">重排</button>
        <span class="legend faint small">
          <i class="lg-note"></i>笔记 <i class="lg-concept"></i>概念
          <i class="lg-person"></i>人物 <i class="lg-project"></i>项目
          <i class="lg-doc"></i>文档 <i class="lg-org"></i>组织 <i class="lg-deadlink"></i>死链
        </span>
      </div>
    </div>
    <div ref="container" class="graph-container" />
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
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Network } from 'vis-network';
import { api } from '../api';
import AppSpinner from '../components/ui/AppSpinner.vue';
import { notify } from '../lib/notify';

const route = useRoute();
const router = useRouter();
const container = ref<HTMLElement>();
const scope = ref('global');
const empty = ref(false);
const loading = ref(false);
const loadError = ref('');
const pageId = ref((route.params.id as string) || '');

let network: Network | null = null;
const FONT_SIZE = 13;
// 以稳定后的铺满缩放比为基线：缩小到基线 60% 以下才隐藏标签，避免一加载就没标签
let fitScale = 0;
let labelsHidden = false;

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
  if (empty.value) return;

  network?.destroy();
  network = new Network(container.value!, { nodes: data.nodes, edges: data.edges }, {
    physics: {
      solver: 'forceAtlas2Based',
      forceAtlas2Based: { gravitationalConstant: -50, springLength: 120, damping: 0.4 },
      stabilization: { iterations: 200, fit: true, updateInterval: 25 },
    },
    nodes: {
      shape: 'dot',
      font: { color: getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#37352f', size: FONT_SIZE },
      borderWidth: 1,
    },
    edges: { width: 1, smooth: false },
    interaction: { hover: true, tooltipDelay: 100 },
  });
  fitScale = 0;
  labelsHidden = false;
  // 布局收敛后停止模拟循环（止漂、止卡顿），但保持 physics.enabled=true：
  // 这样拖动节点时 vis-network 内置 onDrag 会自动 emit('startSimulation')，
  // 连接节点受力跟随，松手后跑到 minVelocity 自停再静止（Obsidian 同款手感）。
  // 切忌用 setOptions({physics:{enabled:false}}) —— 那会彻底禁用物理，拖动时其他节点不动。
  network.once('stabilizationIterationsDone', () => {
    network!.stopSimulation();
    fitScale = network!.getScale();
  });
  // 缩小到全局视图以下时隐藏标签，放大后重现，减少标签重叠噪声
  network.on('zoom', () => {
    if (!network || !fitScale) return;
    const hide = network.getScale() < fitScale * 0.6;
    if (hide !== labelsHidden) {
      labelsHidden = hide;
      network.setOptions({ nodes: { font: { size: hide ? 0 : FONT_SIZE } } });
    }
  });
  network.on('click', (params) => {
    const id = params.nodes[0];
    if (id && !String(id).startsWith('dead:') && !String(id).startsWith('ent:')) {
      router.push(`/page/${id}`);
    }
  });
  network.on('doubleClick', (params) => {
    const id = params.nodes[0];
    if (id && !String(id).includes(':')) {
      pageId.value = id;
      scope.value = 'page';
      load();
    }
  });
}

function fit() {
  network?.fit({ animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
}
function relayout() {
  if (!network) return;
  // 物理始终 enabled，只需重新跑稳定：stabilize 触发 startSimulation，
  // 跑完 stabilizationIterationsDone 后 stopSimulation 止住，拖动响应仍在。
  network.once('stabilizationIterationsDone', () => {
    network!.stopSimulation();
    fitScale = network!.getScale();
    labelsHidden = false;
  });
  network.stabilize();
}

watch(() => route.params.id, (id) => {
  if (id) {
    pageId.value = id as string;
    scope.value = 'page';
    load();
  }
});

onMounted(() => {
  if (pageId.value) scope.value = 'page';
  load();
});
onUnmounted(() => network?.destroy());
</script>

<style scoped>
.graph-view { height: 100%; display: flex; flex-direction: column; position: relative; }
.graph-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
  gap: 8px;
}
.graph-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.legend { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.legend i {
  display: inline-block;
  width: 10px; height: 10px;
  border-radius: 50%;
  margin-left: 8px;
}
.lg-note { background: var(--graph-note); }
.lg-concept { background: var(--graph-concept); }
.lg-person { background: var(--graph-person); }
.lg-project { background: var(--graph-project); }
.lg-doc { background: var(--graph-doc); }
.lg-org { background: var(--graph-org); }
.lg-deadlink { background: var(--graph-deadlink); }
.graph-container { flex: 1; min-height: 0; }
.graph-state {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.graph-state:has(.app-spinner) { flex-direction: row; }
.graph-error-text { margin: 0; color: var(--danger); }
.empty-hint { text-align: center; padding: 60px 20px; }

@media (max-width: 768px) {
  .graph-toolbar { flex-direction: column; align-items: flex-start; }
}
</style>
