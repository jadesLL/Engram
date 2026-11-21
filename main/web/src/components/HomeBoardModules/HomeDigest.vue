<template>
  <!-- Agent 摘要：把「最近怎么样」拼成一句人话（本地拼的，不调模型） -->
  <div class="hb-card digest-card">
    <p class="digest-quote">{{ lines[0] }}</p>
    <div v-if="bullets.length" class="digest-bullets">
      <button
        v-for="(line, index) in bullets"
        :key="index"
        class="digest-bullet"
        type="button"
        @click="$emit('chat')"
      >
        <span class="spark"><Icon name="ai" :size="11" /></span>
        <span class="bullet-text">{{ line }}</span>
        <Icon class="bullet-go" name="arrow-up-right" :size="12" />
      </button>
    </div>
    <div class="digest-foot">
      <span class="digest-avatar"><Icon name="ai" :size="12" /></span>
      <span class="muted">{{ agentName }} · 按库里的数据现算</span>
      <button class="digest-open" type="button" @click="$emit('chat')">问一句 <Icon name="arrow-up-right" :size="12" /></button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Agent 摘要：**不调模型**——按库存量、近 7 天动静、待办与收集箱现算两三句话。
 * 想听真正的分析就点「问一句」把抽屉打开，摘要只负责「一眼看到状态」。
 */
import { computed } from 'vue';
import Icon from '../Icon.vue';

const props = defineProps<{ lines: string[]; agentName: string; bodyHeight?: number }>();
defineEmits<{ (e: 'chat'): void; (e: 'go', path: string): void }>();

const bullets = computed(() => {
  const capacity = props.bodyHeight ? Math.max(1, Math.floor((props.bodyHeight - 90) / 34)) : 99;
  return (props.lines || []).slice(1, 1 + capacity);
});
</script>

<style scoped>
.digest-card { display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 0; }
.digest-quote {
  margin: 0 0 8px;
  font-family: var(--font-display);
  font-size: 17px;
  line-height: var(--lh-ui);
  letter-spacing: -.01em;
  color: var(--text);
}
.digest-bullets { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.digest-bullet {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-height: 34px;
  padding: 7px 0;
  border-radius: 0;
  border-top: 1px solid var(--ai-line);
  font-size: var(--fs-caption);
  line-height: 1.45;
  color: var(--text-secondary);
  text-align: left;
}
.digest-bullet:hover .bullet-text { color: var(--text); }
.digest-bullet:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--ai); border-radius: 6px; }
.spark {
  width: 16px;
  height: 16px;
  flex: none;
  display: grid;
  place-items: center;
  margin-top: 1px;
  border-radius: 5px;
  background: var(--ai-glow);
  color: var(--ai);
}
.bullet-text { flex: 1; min-width: 0; }
.bullet-go { flex: none; margin-top: 2px; color: var(--text-faint); }
.digest-foot {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: auto;
  padding-top: 9px;
  border-top: 1px solid var(--ai-line);
  font-size: 9.5px;
  color: var(--text-faint);
}
.digest-avatar {
  width: 20px;
  height: 20px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--ai-soft);
  color: var(--ai);
}
.digest-open {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--ai);
  font-size: 10px;
  font-weight: 650;
  white-space: nowrap;
}
.digest-open:hover { text-decoration: underline; }
</style>
