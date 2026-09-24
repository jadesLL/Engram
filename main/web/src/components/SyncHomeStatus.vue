<template>
  <button
    v-if="view"
    class="sync-pill"
    :class="view.tone"
    type="button"
    v-tooltip="view.hint"
    :aria-label="`${view.label}：${view.detail}（打开多端同步设置）`"
    @click="openSettings"
  >
    <Icon :name="view.icon" :size="14" class="sync-icon" :class="{ spinning: view.phase === 'syncing' }" />
    <span class="sync-label">{{ view.label }}</span>
    <span v-if="view.detail" class="sync-detail">{{ view.detail }}</span>
  </button>
</template>

<script setup lang="ts">
/**
 * 首页（欢迎页）同步状态条：配置过多端同步才出现，一眼看出「同步中」还是「同步已完成」。
 * 状态来自共享 store（与侧栏同步按钮同一份轮询），点击进入 设置 → 多端同步 查看详情。
 */
import { computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useSyncStore } from '../stores/sync';
import { syncStatusView } from '../lib/syncStatus';
import { useRuntimeCapabilities } from '../lib/capabilities';
import Icon from './Icon.vue';

const router = useRouter();
const sync = useSyncStore();
const { capabilities } = useRuntimeCapabilities();

const view = computed(() =>
  syncStatusView(sync.status, {
    androidLocal: capabilities.value.runtime === 'android-local',
  })
);

function openSettings(): void {
  router.push('/settings?section=sync');
}

onMounted(() => sync.subscribe());
onUnmounted(() => sync.unsubscribe());
</script>

<style scoped>
.sync-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  /* 欢迎页里紧跟问候头（.welcome-head 自身 margin-bottom: 22px），与下方快捷卡保持 14px */
  margin: 2px 0 14px;
  padding: 4px 11px 4px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: var(--font-sm);
  line-height: 1.6;
  text-align: left;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}

.sync-pill:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
  color: var(--text);
}

.sync-pill:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.sync-icon { flex-shrink: 0; }
.sync-label { font-weight: 600; white-space: nowrap; }

.sync-detail {
  min-width: 0;
  overflow: hidden;
  color: var(--text-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 状态色：进行中=强调色，已完成=绿，异常=琥珀，停用=灰 */
.sync-pill.busy { border-color: var(--accent-soft); background: var(--accent-soft); color: var(--accent); }
.sync-pill.busy .sync-detail { color: var(--accent); opacity: 0.75; }
.sync-pill.ok { border-color: var(--success-soft); background: var(--success-soft); color: var(--success); }
.sync-pill.ok .sync-detail { color: var(--success); opacity: 0.75; }
.sync-pill.warn { border-color: var(--warn-soft); background: var(--warn-soft); color: var(--warn); }
.sync-pill.warn .sync-detail { color: var(--warn); opacity: 0.75; }

.sync-icon.spinning {
  animation: sync-pill-spin 900ms linear infinite;
}

@keyframes sync-pill-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .sync-icon.spinning { animation-duration: 2.4s; }
}

@media (max-width: 640px) {
  .sync-detail { display: block; max-width: 38vw; font-size: 11px; }
}
</style>
