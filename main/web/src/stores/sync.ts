import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '../api';
import type { SyncStatusInput } from '../lib/syncStatus';

/**
 * 同步状态共享源。
 *
 * 首页状态条与侧栏「立即同步」按钮都要读 `/api/sync/status`：放在 store 里只留一份轮询，
 * 两个组件挂载时共用同一份状态（引用计数：最后一个订阅者卸载才停表）。
 * 轮询节奏自适应——同步中/有排队/断线重连时 5s（用户正盯着状态变化），空闲时 30s。
 */

const BUSY_POLL_MS = 5_000;
const IDLE_POLL_MS = 30_000;

export interface SyncLogEntry {
  ts: string;
  level: string;
  event: string;
  detail?: string;
}

export interface SyncStatusPayload extends SyncStatusInput {
  hubUrl?: string;
  hubToken?: string;
  nodeId?: string;
  cursor?: number;
  log?: SyncLogEntry[];
  peers?: Array<{ id: string; name: string; online?: boolean; last_seen_at?: string | null }>;
}

export const useSyncStore = defineStore('sync', () => {
  const status = ref<SyncStatusPayload | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let subscribers = 0;

  /** 拉一次状态；失败（服务未就绪/离线）保留上次状态，下一轮继续 */
  async function refresh(): Promise<void> {
    try {
      const { data } = await api.get('/api/sync/status');
      status.value = data;
    } catch { /* 保持上次状态 */ }
  }

  const role = computed(() => status.value?.role || 'none');
  const configured = computed(() => role.value !== 'none');
  const enabled = computed(() => Boolean(status.value?.enabled));
  const connected = computed(() => Boolean(status.value?.connected));
  const pending = computed(() => Number(status.value?.pending || 0));
  const pendingPulls = computed(() => Number(status.value?.pendingPulls || 0));
  /** 状态正在变化：这段时间用快节奏轮询，让「同步中 → 同步已完成」及时翻面 */
  const busy = computed(() =>
    Boolean(status.value?.syncing || status.value?.reconciling || status.value?.running) ||
    pending.value > 0 ||
    pendingPulls.value > 0 ||
    (enabled.value && !connected.value)
  );

  function schedule(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (subscribers === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void refresh().then(schedule);
    }, busy.value ? BUSY_POLL_MS : IDLE_POLL_MS);
  }

  /** 组件挂载：首个订阅者拉起轮询，其余订阅者复用同一份状态 */
  function subscribe(): void {
    subscribers += 1;
    if (subscribers > 1) return;
    void refresh().then(schedule);
  }

  /** 组件卸载：最后一个订阅者离开时停表 */
  function unsubscribe(): void {
    subscribers = Math.max(0, subscribers - 1);
    if (subscribers === 0 && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    status,
    refresh,
    subscribe,
    unsubscribe,
    role,
    configured,
    enabled,
    connected,
    pending,
    pendingPulls,
    busy,
  };
});
