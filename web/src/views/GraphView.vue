<template>
  <div class="graph-view">
    <div class="graph-toolbar">
      <b>知识图谱</b>
      <div class="graph-controls">
        <button class="btn small" :class="{ primary: scope === 'global' }" @click="scope = 'global'; load()">全局</button>
        <button v-if="pageId" class="btn small" :class="{ primary: scope === 'page' }" @click="scope = 'page'; load()">本页关联</button>
        <span class="legend faint small">
          <i style="background:#64748b"></i>笔记 <i style="background:#16a34a"></i>概念
          <i style="background:#ea580c"></i>人物 <i style="background:#7c3aed"></i>项目
          <i style="background:#2563eb"></i>文档 <i style="background:#f87171"></i>死链
        </span>
      </div>
    </div>
    <div ref="container" class="graph-container" />
    <p v-if="empty" class="faint empty-hint">还没有图谱数据。写几篇带 [[双链]] 的页面后，图谱会自动生长。</p>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Network } from 'vis-network';
import { api } from '../api';

const route = useRoute();
const router = useRouter();
const container = ref<HTMLElement>();
const scope = ref('global');
const empty = ref(false);
const pageId = ref((route.params.id as string) || '');

let network: Network | null = null;

async function load() {
  const params: any = { scope: scope.value };
  if (scope.value === 'page') {
    if (!pageId.value) { scope.value = 'global'; }
    else { params.id = pageId.value; params.depth = 2; }
  }
  const { data } = await api.get('/api/graph', { params });
  empty.value = data.nodes.length === 0;
  if (empty.value) return;

  network?.destroy();
  network = new Network(container.value!, { nodes: data.nodes, edges: data.edges }, {
    physics: {
      solver: 'forceAtlas2Based',
      forceAtlas2Based: { gravitationalConstant: -60, springLength: 120 },
      stabilization: { iterations: 120 },
    },
    nodes: {
      shape: 'dot',
      font: { color: getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#37352f', size: 13 },
      borderWidth: 1,
    },
    edges: { width: 1, smooth: { enabled: true, type: 'continuous', roundness: 0.5 } },
    interaction: { hover: true, tooltipDelay: 100 },
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
.graph-view { height: 100%; display: flex; flex-direction: column; }
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
.legend { display: inline-flex; align-items: center; gap: 4px; }
.legend i {
  display: inline-block;
  width: 10px; height: 10px;
  border-radius: 50%;
  margin-left: 8px;
}
.graph-container { flex: 1; min-height: 0; }
.empty-hint { text-align: center; padding: 60px 20px; }
</style>
