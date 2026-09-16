<template>
  <button
    v-if="role === 'member'"
    class="sidebar-sync"
    :class="{ syncing }"
    type="button"
    :disabled="syncing"
    v-tooltip="tip"
    aria-label="立即同步"
    @click="syncNow"
  >
    <Icon name="rotate-right" :size="16" />
  </button>
</template>

<script setup lang="ts">
/**
 * 侧栏一键同步：成员角色（已绑定中枢）显示，点击触发一次全量对账。
 * 服务端 reconcile 是异步的（POST 立即返回），完成信号取状态日志里新增的 reconcile-done。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';
import { notify } from '../lib/notify';
import Icon from './Icon.vue';

type Role = 'hub' | 'member' | 'none';

const role = ref<Role | null>(null);
const pending = ref(0);
const connected = ref(false);
const syncing = ref(false);
let timer: number | null = null;

const tip = computed(() => {
  if (syncing.value) return '同步中…';
  if (!connected.value) return '立即同步（未连接中枢）';
  return pending.value ? `立即同步（待推送 ${pending.value}）` : '立即同步';
});

/** 日志里某事件最新一条的时间戳；ISO 字符串按字典序比较即时间序 */
function latestTs(log: any[], event: string): string {
  const hit = (log || []).filter((e) => e?.event === event).pop();
  return hit?.ts || '';
}

function applyStatus(data: any): void {
  role.value = (data?.role as Role) || 'none';
  pending.value = Number(data?.pending) || 0;
  connected.value = Boolean(data?.connected);
}

async function loadStatus(): Promise<void> {
  try {
    applyStatus((await api.get('/api/sync/status')).data);
  } catch { /* 服务未就绪时保持上次状态 */ }
}

async function waitReconcile(before: string): Promise<'ok' | 'failed' | 'timeout'> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const { data } = await api.get('/api/sync/status');
      applyStatus(data);
      if (latestTs(data.log, 'reconcile-done') > before) return 'ok';
      if (latestTs(data.log, 'reconcile-failed') > before) return 'failed';
    } catch { /* 单次轮询失败忽略，下一轮继续 */ }
  }
  return 'timeout';
}

async function syncNow(): Promise<void> {
  if (syncing.value) return;
  syncing.value = true;
  try {
    const before = latestTs((await api.get('/api/sync/status')).data.log, 'reconcile-done');
    await api.post('/api/sync/reconcile');
    const result = await waitReconcile(before);
    if (result === 'ok') notify.success('同步完成');
    else if (result === 'failed') notify.error('同步失败，详见 设置 → 多端同步 的日志');
    else notify.info('同步仍在进行，稍后可在 设置 → 多端同步 查看');
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '触发同步失败');
  } finally {
    syncing.value = false;
  }
}

onMounted(() => {
  loadStatus();
  timer = window.setInterval(loadStatus, 30000);
});

onUnmounted(() => {
  if (timer !== null) window.clearInterval(timer);
});
</script>

<style scoped>
.sidebar-sync {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--text-secondary);
}

.sidebar-sync:hover:not(:disabled) {
  color: var(--text);
  background: var(--sidebar-hover);
}

.sidebar-sync:focus-visible {
  outline: 2px solid var(--sidebar-accent);
  outline-offset: 1px;
}

.sidebar-sync:disabled {
  cursor: default;
  color: var(--sidebar-accent);
}

.sidebar-sync.syncing :deep(svg) {
  animation: sync-spin 900ms linear infinite;
}

@keyframes sync-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .sidebar-sync.syncing :deep(svg) { animation-duration: 2.4s; }
}
</style>
