<template>
  <!-- 收集箱：待整理原件数 + 几个文件名（点进去整理） -->
  <div class="hb-card inbox-card">
    <div class="inbox-head">
      <span class="inbox-count num" :class="{ zero: !pending }">{{ pending }}</span>
      <span class="inbox-text">
        <span class="inbox-title">{{ pending ? `${pending} 份原件等着整理` : '收集箱是空的' }}</span>
        <span class="hb-row-meta">{{ pending ? '转换后入库才算进知识库' : '拖文件进来，或从网页抓一份' }}</span>
      </span>
    </div>
    <ul v-if="sample.length" class="inbox-list">
      <li v-for="item in sample" :key="item.path">{{ item.name }}</li>
    </ul>
    <div class="inbox-foot">
      <button class="btn small" type="button" @click="$emit('go', '/inbox')">
        <Icon name="inbox" :size="13" /> {{ pending ? '去整理' : '打开收集箱' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 收集箱卡片：数据来自 inbox store（图标栏那颗角标用的是同一份 counts）。
 * 只读展示，不允许在这里直接转换/入库——那是收集箱页面的职责（要预览产物才能入库）。
 */
import { computed } from 'vue';
import Icon from '../Icon.vue';
import { useInboxStore } from '../../stores/inbox';

defineEmits<{ (e: 'go', path: string): void }>();

const inbox = useInboxStore();
const pending = computed(() => Number(inbox.counts.pending || 0));
const sample = computed(() =>
  (inbox.pendingItems || []).slice(0, 3).map((item: any) => ({
    path: item.path,
    name: String(item.path || '').split('/').pop() || String(item.path || ''),
  }))
);
</script>

<style scoped>
.inbox-card { padding: 14px 16px 12px; }
.inbox-head { display: flex; align-items: center; gap: 12px; }
.inbox-count {
  min-width: 40px;
  font-size: 26px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.02em;
  color: var(--badge-idea);
}
.inbox-count.zero { color: var(--text-faint); }
.inbox-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.inbox-title { font-size: 13px; font-weight: 550; }
.inbox-list { margin: 10px 0 0; padding: 0; list-style: none; }
.inbox-list li {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 3px 0;
  color: var(--text-secondary);
  font-size: 11.5px;
}
.inbox-list li::before { content: '· '; color: var(--text-faint); }
.inbox-foot { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border); }
</style>
