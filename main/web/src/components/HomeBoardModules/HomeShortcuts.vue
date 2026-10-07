<template>
  <!-- 快捷入口：行内芯片卡，空间不足自动折行（与旧欢迎页同一套观感） -->
  <div class="welcome-cards">
    <button class="welcome-card" type="button" @click="go('/page')">
      <span class="wc-icon"><Icon name="file-plus" :size="17" /></span>
      <span class="wc-text"><strong>新建页面</strong><em>存到 Wiki</em></span>
    </button>
    <button class="welcome-card" type="button" @click="go('/search')">
      <span class="wc-icon"><Icon name="search" :size="17" /></span>
      <span class="wc-text"><strong>搜索知识库</strong><em>{{ touchPointer ? '搜页面与资料' : 'Ctrl+K' }}</em></span>
    </button>
    <button class="welcome-card" type="button" @click="go('/graph')">
      <span class="wc-icon"><Icon name="graph" :size="17" /></span>
      <span class="wc-text"><strong>知识图谱</strong><em>总览关系结构</em></span>
    </button>
    <button class="welcome-card" type="button" @click="$emit('chat')">
      <span class="wc-icon"><Icon name="ai" :size="17" /></span>
      <span class="wc-text"><strong>问问 Agent</strong><em>{{ agentHint }}</em></span>
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
  border: 1px solid var(--border);
  border-radius: var(--radius, 11px);
  background: var(--bg-secondary);
  text-align: left;
  transition: border-color 150ms ease, background 150ms ease, box-shadow 150ms ease, transform 150ms ease;
}
.welcome-card:hover {
  border-color: transparent;
  background: var(--card-bg);
  box-shadow: var(--shadow-card);
}
.welcome-card:active { transform: translateY(1px); }
.welcome-card:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent-soft), 0 0 0 1px var(--accent);
}
.wc-icon {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--bg-tertiary, var(--bg));
  color: var(--text-secondary);
}
.welcome-card:hover .wc-icon { background: var(--accent-soft); color: var(--accent); }
.wc-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.wc-text strong { font-size: 13px; font-weight: 600; color: var(--text); }
.wc-text em { font-style: normal; font-size: 11px; color: var(--text-faint); }

/* 横条档（h=1, w≥2）：按钮排铺成一整行，图标在上去掉副文案，高度填满 */
@container (max-height: 140px) {
  .welcome-cards {
    flex-wrap: nowrap;
    gap: 8px;
    height: 100%;
    align-items: stretch;
  }
  .welcome-card {
    flex: 1 1 0;
    min-width: 0;
    flex-direction: column;
    justify-content: center;
    gap: 4px;
    padding: 4px;
    text-align: center;
  }
  .wc-icon { width: 22px; height: 22px; border-radius: 6px; }
  .wc-text { align-items: center; gap: 0; }
  .wc-text strong {
    font-size: 11px;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wc-text em { display: none; }
}
</style>
