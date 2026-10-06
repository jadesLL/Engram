<template>
  <!-- Agent 摘要：把「最近怎么样」拼成一句人话（本地拼的，不调模型） -->
  <div class="hb-card digest-card">
    <p v-for="(line, index) in lines" :key="index" class="digest-line">{{ line }}</p>
    <div class="digest-foot">
      <span class="digest-avatar"><Icon name="ai" :size="13" /></span>
      <span class="muted">{{ agentName }} · 按库里的数据现算的</span>
      <button class="digest-open" type="button" @click="$emit('chat')">问一句 →</button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Agent 摘要：**不调模型**——按库存量、近 7 天动静、待办与收集箱现算两三句话。
 * 想听真正的分析就点「问一句」把抽屉打开，摘要只负责「一眼看到状态」。
 */
import Icon from '../Icon.vue';

defineProps<{ lines: string[]; agentName: string }>();
defineEmits<{ (e: 'chat'): void; (e: 'go', path: string): void }>();
</script>

<style scoped>
.digest-card { padding: 14px 16px 12px; }
.digest-line {
  margin: 0 0 8px;
  padding-left: 12px;
  border-left: 3px solid var(--accent);
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.6;
}
.digest-line:last-of-type { margin-bottom: 0; }
.digest-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  font-size: 11px;
}
.digest-avatar {
  width: 22px;
  height: 22px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
}
.digest-open {
  margin-left: auto;
  color: var(--accent);
  font-size: 11.5px;
}
.digest-open:hover { text-decoration: underline; }
</style>
