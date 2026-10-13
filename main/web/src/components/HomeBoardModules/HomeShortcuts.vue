<template>
  <!-- 快捷入口：轻量图标与文字，横条按可用宽度均分。 -->
  <div class="welcome-cards">
    <button class="welcome-card" type="button" @click="go('/page')">
      <span class="wc-icon"><Icon name="file-plus" :size="17" /></span>
      <span class="wc-text"><strong>新建页面</strong><em>存到 Wiki</em></span>
    </button>
    <button class="welcome-card" type="button" aria-label="搜索知识库" title="搜索知识库" @click="go('/search')">
      <span class="wc-icon"><Icon name="search" :size="17" /></span>
      <span class="wc-text"><strong><span class="full-label">搜索知识库</span><span class="short-label">搜索</span></strong><em>{{ touchPointer ? '搜页面与资料' : 'Ctrl+K' }}</em></span>
    </button>
    <button class="welcome-card" type="button" @click="go('/graph')">
      <span class="wc-icon"><Icon name="graph" :size="17" /></span>
      <span class="wc-text"><strong>知识图谱</strong><em>总览关系结构</em></span>
    </button>
    <button class="welcome-card" type="button" aria-label="问问 Agent" title="问问 Agent" @click="$emit('chat')">
      <span class="wc-icon"><Icon name="ai" :size="17" /></span>
      <span class="wc-text"><strong><span class="full-label">问问 Agent</span><span class="short-label">问 Agent</span></strong><em>{{ agentHint }}</em></span>
    </button>
    <button class="welcome-card" type="button" @click="go('/tasks')">
      <span class="wc-icon"><Icon name="board" :size="17" /></span>
      <span class="wc-text"><strong>任务看板</strong><em>本周要做什么</em></span>
    </button>
    <button class="welcome-card" type="button" @click="go('/inbox')">
      <span class="wc-icon"><Icon name="inbox" :size="17" /></span>
      <span class="wc-text"><strong>收集箱</strong><em>待整理的资料</em></span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import Icon from '../Icon.vue';
import { useTouchPointer } from '../../lib/pointer';

// agentName 只用于无障碍描述（按钮本身写死了「问问 Agent」），保留 prop 让外层口径统一
defineProps<{ agentName: string }>();
const emit = defineEmits<{ (e: 'go', path: string): void; (e: 'chat'): void }>();

const touchPointer = useTouchPointer();
/** Agent 的入口就是左栏那颗「AI」图标（手机在「更多」里）：这里只说明去哪儿找，不编快捷键 */
const agentHint = computed(() => (touchPointer.value ? '点开对话直接问' : '左栏图标打开对话'));

function go(path: string) {
  emit('go', path);
}
</script>

<style scoped>
/* 快捷入口：行内芯片卡，空间不足自动折行 */
.welcome-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.welcome-card {
  flex: 1 1 150px;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px 13px;
  min-width: 0;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  text-align: left;
  transition: border-color 150ms ease, background 150ms ease, box-shadow 150ms ease, transform 150ms ease;
}
.welcome-card:hover {
  background: var(--bg-secondary);
}
.welcome-card:active { transform: translateY(1px); }
.welcome-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  background: var(--accent-soft);
}
.wc-icon {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent);
  transition: background 150ms ease, color 150ms ease;
}
.welcome-card:hover .wc-icon { background: var(--accent-soft); color: var(--accent); }
.wc-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.wc-text strong { font-size: 12px; font-weight: 500; line-height: 1.4; color: var(--text); }
.wc-text em { font-style: normal; font-size: 11px; color: var(--text-faint); }
.short-label { display: none; }
@container (max-width: 520px) {
  .full-label { display: none; }
  .short-label { display: inline; }
}

/* 横条档（h=1, w≥2）：按钮排铺成一整行，图标在上去掉副文案，高度填满 */
@container (max-height: 140px) {
  .welcome-cards {
    flex-wrap: nowrap;
    gap: 2px;
    height: 100%;
    align-items: stretch;
  }
  .welcome-card {
    flex: 1 1 0;
    min-width: 0;
    flex-direction: column;
    justify-content: center;
    gap: 6px;
    padding: 6px 2px;
    text-align: center;
  }
  .wc-icon { width: 26px; height: 26px; border-radius: 8px; }
  .wc-text { align-items: center; gap: 0; max-width: 100%; }
  .wc-text strong {
    font-size: 11px;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wc-text em { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .welcome-card, .wc-icon { transition: none; }
  .welcome-card:active { transform: none; }
}
</style>
