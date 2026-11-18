<template>
  <!-- 随机漫游：从库里随手翻一篇（「换一个」不出页面就换；池子为空时给出口） -->
  <div v-if="page" class="roam">
    <button class="roam-card" type="button" @click="$emit('go', `/page/${page.id}`)">
      <span class="roam-top">
        <span class="hb-badge" :class="pageBadge(page).cls">{{ pageBadge(page).label }}</span>
        <span class="roam-time">更新于 {{ sinceShort(page.updated_at) }}</span>
      </span>
      <span class="roam-title">{{ page.title }}</span>
      <span class="roam-meta">{{ pageBadge(page).meta }}<template v-if="wordCount"> · {{ formatCount(wordCount, ' 字') }}</template></span>
      <span v-if="tags.length" class="roam-tags">
        <span v-for="tag in tags" :key="tag">#{{ tag }}</span>
      </span>
    </button>
    <div class="roam-actions">
      <button class="btn small" type="button" @click="shuffle">
        <Icon name="compass" :size="13" /> 换一个
      </button>
      <span class="muted roam-hint">共 {{ poolSize }} 篇可翻</span>
      <button class="roam-open" type="button" @click="$emit('go', `/page/${page.id}`)">打开 <Icon name="arrow-up-right" :size="12" /></button>
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
import { formatCount, sinceShort, pageBadge } from '../../lib/homeBoardData.ts';
import { pickRoamPage } from '../../lib/homeBoard.ts';

const props = defineProps<{ pages: any[] }>();
defineEmits<{ (e: 'go', path: string): void; (e: 'capture'): void }>();

const currentId = ref('');
/** 只按 id 找当前这篇：挑一次就定住，别在每次渲染时重挑（否则卡片会自己跳） */
const page = computed(() => (props.pages || []).find((item) => String(item?.id) === currentId.value) || null);
const poolSize = computed(() => (props.pages || []).length);
const wordCount = computed(() => Math.max(0, Number(page.value?.word_count) || 0));
const tags = computed(() => {
  const raw = page.value?.tags;
  try {
    const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(list) ? list.map((tag) => String(tag)).filter(Boolean).slice(0, 3) : [];
  } catch {
    return [];
  }
});

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
.roam { display: flex; flex-direction: column; flex: 1; min-height: 0; gap: 9px; }
.roam-card {
  width: 100%;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  gap: 0;
  padding: 13px;
  border: 1px solid var(--card-line-soft);
  border-radius: 10px;
  background: var(--bg-secondary);
  text-align: left;
  transition: border-color 150ms ease, background 150ms ease;
}
.roam-card:hover { border-color: var(--border-strong); background: var(--bg-tertiary); }
.roam-card:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent); }
.roam-top { display: flex; align-items: center; gap: 7px; margin-bottom: 7px; }
.roam-time { margin-left: auto; font-size: 9.5px; color: var(--text-faint); white-space: nowrap; }
.roam-title {
  font-size: 15px;
  font-weight: 650;
  color: var(--text);
  line-height: 1.42;
  letter-spacing: -.01em;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.roam-meta { margin-top: 5px; font-size: 9.5px; color: var(--text-faint); }
.roam-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; }
.roam-tags span {
  display: inline-flex;
  align-items: center;
  height: 19px;
  padding: 0 6px;
  border-radius: 5px;
  background: var(--card-bg);
  color: var(--text-secondary);
  font-size: 9px;
  white-space: nowrap;
}
.roam-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.roam-hint { font-size: 9.5px; }
.roam-open {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--accent);
  font-size: 10px;
  font-weight: 650;
  white-space: nowrap;
}
.roam-open:hover { text-decoration: underline; }
.roam-empty { display: flex; flex-direction: column; align-items: center; gap: 4px; padding-bottom: 8px; }
</style>
