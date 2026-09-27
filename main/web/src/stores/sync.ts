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
 *
 * 另外对外给一个 indexRevision：Android 没有常驻页面事件流，侧栏与欢迎页靠它知道
 * 「本地索引可能变了」，从而在**一轮同步进行中**也能重读（首轮全量对账要几分钟，
 * 只在结束时刷新会让界面全程空白）。
 */

const BUSY_POLL_MS = 5_000;
const IDLE_POLL_MS = 30_000;
/** 索引重读的最小间隔：首轮全量对账期间每轮状态都变，但重读一次要打好几个列表接口 */
export const SYNC_INDEX_REFRESH_MS = 5_000;
/** 一轮刚跑完时的补拉间隔：把收尾状态尽快落进界面，不等 30s 空闲档 */
const SETTLE_POLL_MS = 1_200;

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
  /**
   * 本机在同步群组里的显示名：成员端是**中枢配置里的成员名**（对账时学回来），中枢端是「中枢」。
   * 会话来源徽标（lib/sessionSource）用它说明「本机」，不再拿电脑主机名当设备名。
   */
  deviceLabel?: string;
  cursor?: number;
  /** 中枢端：本机权威 revision 序号（成员端为 0），面板显示权威水位 */
  revision?: number;
  /** 成员端本机内容版本号：每落地一项同步改动 +1（对账进行中也能拿到，用于渐进刷新文件树） */
  contentRevision?: number;
  log?: SyncLogEntry[];
  peers?: Array<{ id: string; name: string; online?: boolean; last_seen_at?: string | null }>;
}

/** 一轮同步是否在跑（含"刚拉完还在落盘"的补拉期） */
function roundRunning(value: SyncStatusPayload | null): boolean {
  if (!value) return false;
  return Boolean(value.syncing || value.reconciling || value.running)
    || Number(value.pendingPulls || 0) > 0;
}

/**
 * 索引指纹：这些字段一变，「侧栏/欢迎页重读本地索引会看到不同结果」。
 *
 * contentRevision 是 Android 成员端每落地一项就 +1 的本机内容版本（粒度最细，逐项刷新）；
 * cursor / pendingPulls / syncProgress / 运行态则覆盖 desktop 与 Docker 成员端——它们没有
 * contentRevision，但首轮/自愈全量对账期间这些字段一直在动，同样能当过程中的刷新信号。
 */
function indexSignature(value: SyncStatusPayload | null): string {
  if (!value) return '';
  return [
    value.lastSyncAt || '',
    value.contentRevision ?? 0,
    value.cursor ?? 0,
    value.revision ?? 0,
    value.pendingPulls ?? 0,
    value.syncProgress || '',
    value.running ? 'run' : '',
    value.syncing ? 'sync' : '',
    value.reconciling ? 'rec' : '',
  ].join('|');
}

export const useSyncStore = defineStore('sync', () => {
  const status = ref<SyncStatusPayload | null>(null);
  /** 本地索引版本：一轮同步进行中或结束时都会自增，订阅方据此重读（见文件头） */
  const indexRevision = ref(0);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;
  let queued = false;
  let subscribers = 0;
  let visibilityBound = false;

  /** 拉一次状态；同一时刻只发一个请求（多个订阅者/补拉撞在一起时复用）。
   *  失败（服务未就绪/离线）保留上次状态，下一轮继续。 */
  function refresh(): Promise<void> {
    if (inflight) {
      queued = true;
      return inflight;
    }
    const run = (async () => {
      const before = indexSignature(status.value);
      try {
        const { data } = await api.get('/api/sync/status');
        const next = data as SyncStatusPayload;
        const wasRunning = roundRunning(status.value);
        status.value = next;
        // 首次拿到状态不算变化：组件挂载时本来就会各自读一次索引
        if (before !== '' && indexSignature(next) !== before) indexRevision.value += 1;
        // 一轮刚结束：补一次快照，让「同步中 → 同步已完成」与文件树尽快翻面
        if (wasRunning && !roundRunning(next)) settle();
      } catch { /* 保持上次状态 */ }
      inflight = null;
      if (queued) {
        queued = false;
        void refresh();
      } else {
        schedule();
      }
    })();
    inflight = run;
    return run;
  }

  /** 一轮结束后的短补拉：不改变常驻节奏，只在收尾时多看一眼 */
  function settle(): void {
    if (subscribers === 0) return;
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      void refresh();
    }, SETTLE_POLL_MS);
  }

  /** 回到前台立刻看一眼：Android 的同步正是「回前台」触发的，等下一个 30s 空闲档太久。
   *  再补一次短轮询：此刻同步往往刚起步（这一眼还看不到 syncing），1 秒多后那次才会看到，
   *  之后就走 5 秒快节奏，轮次结束时界面能马上翻面。 */
  function onVisibilityChange(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void refresh();
    settle();
  }

  const role = computed(() => status.value?.role || 'none');
  const configured = computed(() => role.value !== 'none');
  const enabled = computed(() => Boolean(status.value?.enabled));
  const connected = computed(() => Boolean(status.value?.connected));
  const pending = computed(() => Number(status.value?.pending || 0));
  const pendingPulls = computed(() => Number(status.value?.pendingPulls || 0));
  /** 状态正在变化：这段时间用快节奏轮询，让「同步中 → 同步已完成」及时翻面 */
  const busy = computed(() => roundRunning(status.value)
    || pending.value > 0
    || (enabled.value && !connected.value));

  function schedule(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (subscribers === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, busy.value ? BUSY_POLL_MS : IDLE_POLL_MS);
  }

  /** 组件挂载：首个订阅者拉起轮询，其余订阅者复用同一份状态 */
  function subscribe(): void {
    subscribers += 1;
    if (subscribers > 1) return;
    if (!visibilityBound && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
      visibilityBound = true;
    }
    void refresh();
  }

  /** 组件卸载：最后一个订阅者离开时停表 */
  function unsubscribe(): void {
    subscribers = Math.max(0, subscribers - 1);
    if (subscribers > 0) return;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    if (visibilityBound && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      visibilityBound = false;
    }
  }

  return {
    status,
    indexRevision,
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
