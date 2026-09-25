<template>
  <button
    v-if="sync.role === 'member'"
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
 * 状态轮询交给 stores/sync（与首页状态条共用同一份），这里只维护「本次点击触发的同步」进度。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';
import { notify } from '../lib/notify';
import { openSyncLogDrawer } from '../lib/syncLog';
import { useSyncStore, type SyncLogEntry } from '../stores/sync';
import Icon from './Icon.vue';

const sync = useSyncStore();
const syncing = ref(false);

const tip = computed(() => {
  if (syncing.value) return '同步中…';
  if (!sync.connected) return '立即同步（未连接中枢）';
  return sync.pending ? `立即同步（待推送 ${sync.pending}）` : '立即同步';
});

/** 日志里某事件最新一条的时间戳；ISO 字符串按字典序比较即时间序 */
function latestTs(log: SyncLogEntry[], event: string): string {
  const hit = (log || []).filter((e) => e?.event === event).pop();
  return hit?.ts || '';
}

async function waitReconcile(before: string): Promise<'ok' | 'failed' | 'timeout'> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await sync.refresh();
    const log = sync.status?.log || [];
    if (latestTs(log, 'reconcile-done') > before) return 'ok';
    if (latestTs(log, 'reconcile-failed') > before) return 'failed';
  }
  return 'timeout';
}

async function syncNow(): Promise<void> {
  if (syncing.value) return;
  syncing.value = true;
  try {
    await sync.refresh();
    const before = latestTs(sync.status?.log || [], 'reconcile-done');
    await api.post('/api/sync/reconcile');
    const result = await waitReconcile(before);
    if (result === 'ok') notify.success('同步完成');
    // 失败不再只丢一句「详见设置里的日志」：直接把同步详情抽屉打开，用户当场看到失败原因
    else if (result === 'failed') {
      notify.error('同步失败，已为你打开同步详情');
      openSyncLogDrawer();
    } else notify.info('同步仍在进行，稍后可在「同步详情」里查看进度');
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '触发同步失败');
  } finally {
    syncing.value = false;
    // 首页状态条读同一份状态：收尾补拉一次，按钮停下时状态已经是新的
    void sync.refresh();
  }
}

onMounted(() => sync.subscribe());
onUnmounted(() => sync.unsubscribe());
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
