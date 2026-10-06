<template>
  <!-- 随机漫游：从库里随手翻一篇（「换一个」不出页面就换；池子为空时给出口） -->
  <div v-if="page" class="roam">    <button class="hb-card roam-card" type="button" @click="$emit('go', `/page/${page.id}`)">
      <span class="hb-badge" :class="pageBadge(page).cls">{{ pageBadge(page).label }}</span>
      <span class="hb-row-main">
        <span class="roam-title">{{ page.title }}</span>
        <span class="hb-row-meta">{{ pageBadge(page).meta }} · 更新于 {{ sinceShort(page.updated_at) }}</span>
      </span>
    </button>
    <div class="roam-actions">
      <button class="btn small" type="button" @click="shuffle">
        <Icon name="compass" :size="13" /> 换一个
      </button>
      <span class="muted roam-hint">共 {{ poolSize }} 篇可翻</span>
    </div>
  </div>
  <div v-else class="roam-empty">
    <p class="hb-empty">库里还没有可翻的页面。</p>
    <button class="btn small" type="button" @click="$emit('capture')">
      <Icon name="plus" :size="13" /> 记一条
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * 随机漫游：兜底「想不起来库里有啥」的场景。
 *
 * 组件自己持有当前那一篇（不是 homeBoard 的布局状态）：翻页纯属临时动作，不该写盘；
 * 库变了（props.pages 换了个数组）就重新挑一篇，但「换一个」只避开当前这篇。
 */
import { computed, onMounted, ref, watch } from 'vue';
import Icon from '../Icon.vue';
import { sinceShort, pageBadge } from '../../lib/homeBoardData.ts';
import { pickRoamPage } from '../../lib/homeBoard.ts';

const props = defineProps<{ pages: any[] }>();
defineEmits<{ (e: 'go', path: string): void; (e: 'capture'): void }>();

const currentId = ref('');
/** 只按 id 找当前这篇：挑一次就定住，别在每次渲染时重挑（否则卡片会自己跳） */
const page = computed(() => (props.pages || []).find((item) => String(item?.id) === currentId.value) || null);
const poolSize = computed(() => (props.pages || []).length);

function shuffle() {
  const next = pickRoamPage(props.pages, currentId.value);
  if (next) currentId.value = String(next.id);
}

onMounted(() => {
  if (!currentId.value) shuffle();
});

// 库内容变了（新增 / 同步进来一批）且当前这篇没了：重新挑
watch(
  () => (props.pages || []).map((item) => String(item?.id)).join(','),
  () => {
    if (!currentId.value || !(props.pages || []).some((item) => String(item?.id) === currentId.value)) {
      shuffle();
    }
  }
);
</script>

<style scoped>
.roam { display: flex; flex-direction: column; gap: 8px; }
.roam-card {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  text-align: left;
  transition: border-color 150ms ease, box-shadow 150ms ease;
}
.roam-card:hover { border-color: var(--accent); box-shadow: var(--shadow-card); }
.roam-card:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent); }
.roam-title { font-size: 14px; font-weight: 600; color: var(--text); line-height: 1.45; }
.roam-actions { display: flex; align-items: center; gap: 8px; }
.roam-hint { font-size: 11px; }
.roam-empty { display: flex; flex-direction: column; align-items: center; gap: 4px; padding-bottom: 8px; }
</style>
