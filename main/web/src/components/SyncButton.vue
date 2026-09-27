<template>
  <!-- 侧栏标题栏里的连接通道胶囊：左边「点 + 通道名」看详情，右边 ⟳ 立即同步（与今天同一个动作）。
       未配置同步、或本机是中枢时不渲染（今天就是这样：不参与同步就看不到同步入口） -->
  <div
    v-if="view"
    ref="chipEl"
    class="sync-chip"
    :class="[`link-${view.key}`, { syncing }]"
    v-tooltip="chipTip"
  >
    <button
      ref="mainEl"
      class="chip-main"
      type="button"
      :aria-expanded="popoverOpen ? 'true' : 'false'"
      aria-haspopup="dialog"
      :aria-label="`连接通道：${view.fullLabel}（打开连接详情）`"
      @click="togglePopover"
    >
      <span class="chip-dot" aria-hidden="true" />
      <span v-if="showLabel" class="chip-label">{{ view.label }}</span>
      <span v-if="view.busy && view.pending > 0" class="chip-pending">{{ view.pending }}</span>
    </button>
    <span v-if="showLabel" class="chip-sep" aria-hidden="true" />
    <button
      class="chip-sync"
      type="button"
      :disabled="syncing"
      :aria-label="syncAria"
      v-tooltip="syncTip"
      @click="syncNow"
    >
      <Icon name="rotate-right" :size="15" />
    </button>

    <SyncChannelPopover
      :open="popoverOpen"
      :anchor="chipEl ?? null"
      :view="view"
      :syncing="syncing"
      @close="closePopover"
      @sync="syncNow"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 侧栏一键同步 → 连接通道胶囊（方案 A）。
 *
 * 右边 ⟳ 的行为与改动前逐字一致：触发一次全量对账，完成信号取状态日志里新增的 reconcile-done
 * （服务端 reconcile 是异步的，POST 立即返回）；状态轮询交给 stores/sync（与首页状态条共用同一份），
 * 这里只维护「本次点击触发的同步」进度。
 *
 * 加的是左边那块：通道点 + 名字（局域网 / IPv6 / IPv4 / 已断开），点开连接详情浮层。
 * 通道色只来自 lib/syncChannel 给的 key（`.link-<key>` 类取 main.css 的令牌），
 * 颜色永远和文字一起出现——色盲、截图、小屏都不丢信息。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '../api';
import { notify } from '../lib/notify';
import { openSyncLogDrawer } from '../lib/syncLog';
import { syncChannelView } from '../lib/syncChannel';
import { useSyncStore, type SyncLogEntry } from '../stores/sync';
import Icon from './Icon.vue';
import SyncChannelPopover from './SyncChannelPopover.vue';

const sync = useSyncStore();
const syncing = ref(false);
const popoverOpen = ref(false);

const chipEl = ref<HTMLElement>();
const mainEl = ref<HTMLButtonElement>();

/**
 * 232px 最窄档放不下带字的胶囊：侧栏内容宽 = 侧栏宽 - 头部内边距 22px - 标题栏内边距 8px，
 * 再让开「知识库」标题（约 48px）与右边三个 26px 图标按钮（约 84px）——留给胶囊的不到 72px，
 * 而带字的胶囊约 92px。264px 起才够，低于此值只留「点 + ⟳」，通道名靠悬停提示。
 * 触屏档那三个图标按钮是 44px（见 Sidebar 里的 44px 热区约定），门槛跟着抬到 304px。
 */
const LABEL_MIN_WIDTH = 264;
const LABEL_MIN_WIDTH_TOUCH = 304;
const showLabel = ref(true);
let observer: ResizeObserver | null = null;
let observed: HTMLElement | null = null;

/** 触屏（无 hover / 粗指针）判断与 Sidebar 的 44px 规则同一个媒体查询，两边不能各用一套 */
function labelMinWidth(): number {
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches
    ? LABEL_MIN_WIDTH_TOUCH
    : LABEL_MIN_WIDTH;
}

/** 只在成员端显示：中枢没有「连出去」的通道，未配置则整块不出现（与今天一致） */
const view = computed(() => (sync.role === 'member' ? syncChannelView(sync.status) : null));

const chipTip = computed(() => {
  const current = view.value;
  if (!current) return '';
  // 三段式：通道名 · 主机 / 延迟与队列 / 这块怎么点（浮层的三段提示都用同一个形状）
  return { title: current.title, body: current.detail, meta: current.hint };
});

const syncTip = computed(() => {
  if (syncing.value) return '同步中…';
  if (!sync.connected) return '立即重连';
  return sync.pending ? `立即同步（待推送 ${sync.pending}）` : '立即同步';
});

const syncAria = computed(() => syncTip.value);

/**
 * 量一下手里有多少宽度：侧栏拖宽改的是 --sidebar-width（Home 布局写在 .layout 上），
 * 手机抽屉另有 min(变量, 100vw - 80px) 的收窄，所以取两者更小的那个；量不到就按「放得下」处理，
 * 宁可偶尔挤一点，也不无缘无故把通道名藏起来。
 */
function measure(): void {
  const el = chipEl.value;
  if (!el) return;
  const declared = Number.parseFloat(getComputedStyle(el).getPropertyValue('--sidebar-width'));
  const actual = observed?.getBoundingClientRect().width ?? 0;
  const width = actual > 0
    ? Math.min(actual, Number.isFinite(declared) && declared > 0 ? declared : actual)
    : declared;
  showLabel.value = !Number.isFinite(width) || width <= 0 || width >= labelMinWidth();
}

/** 侧栏本体是宽度变化的来源（拖分隔条不走 window.resize），挂在它身上才跟得上 */
function bindObserver(): void {
  const el = chipEl.value;
  const host = el?.closest<HTMLElement>('.sidebar-inner') ?? el?.parentElement ?? null;
  if (host === observed) return;
  observer?.disconnect();
  observed = host;
  if (host && typeof ResizeObserver !== 'undefined') {
    observer = observer ?? new ResizeObserver(() => measure());
    observer.observe(host);
  }
  measure();
}

function togglePopover(): void {
  popoverOpen.value = !popoverOpen.value;
}

/** 关闭后焦点回到胶囊：Esc / 点外部关掉以后，键盘用户不该掉到页面顶部去 */
function closePopover(): void {
  if (!popoverOpen.value) return;
  popoverOpen.value = false;
  void nextTick(() => mainEl.value?.focus({ preventScroll: true }));
}

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

watch(view, async () => {
  // 胶囊是 v-if 渲染的：出现/消失后要重新挂观察（角色变化、状态第一次到手都会走到这里）
  await nextTick();
  bindObserver();
});

onMounted(() => {
  bindObserver();
  sync.subscribe();
});

onUnmounted(() => {
  observer?.disconnect();
  observer = null;
  observed = null;
  sync.unsubscribe();
});
</script>

<style scoped>
/* 一颗 26px 高的胶囊：左边「点 + 通道名」，右边 ⟳（尺寸与侧栏其它图标按钮对齐）。
   色与底都从 .link-<key> 给的变量取（浅色/深色两套在 main.css，这里不出现 hex） */
.sync-chip {
  display: inline-flex;
  align-items: center;
  height: 26px;
  padding: 0 4px 0 8px;
  border: 1px solid color-mix(in srgb, var(--channel) 32%, transparent);
  border-radius: 999px;
  background: var(--channel-soft);
  font-size: 12.5px;
  line-height: 1;
  white-space: nowrap;
  transition: background 120ms ease, border-color 120ms ease;
}

/* 悬停时把描边压深一档：通道底的饱和度已经说明状态，不再换底色（换了会像另一个通道） */
.sync-chip:hover {
  border-color: color-mix(in srgb, var(--channel) 58%, transparent);
}

.chip-main {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px 0 0;
  border-radius: 999px;
  background: none;
}

.chip-main:focus-visible,
.chip-sync:focus-visible {
  outline: 2px solid var(--sidebar-accent);
  outline-offset: 1px;
}

.chip-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--channel);
}

/* 颜色永远配文字：四档通道名与点同色，不让颜色单独承担含义 */
.chip-label {
  color: var(--channel);
  font-weight: 600;
}

.chip-sep {
  width: 1px;
  height: 13px;
  margin-right: 2px;
  background: var(--border);
}

.chip-sync {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  color: var(--text-secondary);
}

.chip-sync:hover:not(:disabled) {
  color: var(--text);
  background: var(--sidebar-hover);
}

.chip-sync:disabled {
  cursor: default;
  color: var(--sidebar-accent);
}

/* 待推送项数角标：通道色与文案都不变，排队深度挂在这里（同步中那颗点还会呼吸） */
.chip-pending {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 15px;
  height: 15px;
  margin-left: 1px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: 10.5px;
  font-weight: 700;
}

.sync-chip.syncing .chip-sync :deep(svg) {
  animation: sync-spin 900ms linear infinite;
}

.sync-chip.syncing .chip-dot {
  animation: sync-pulse 1.4s ease-in-out infinite;
}

@keyframes sync-spin {
  to { transform: rotate(360deg); }
}

@keyframes sync-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

@media (prefers-reduced-motion: reduce) {
  .sync-chip.syncing .chip-sync :deep(svg) { animation-duration: 2.4s; }
  .sync-chip.syncing .chip-dot { animation: none; }
}

/* 触屏：标题栏那三个图标按钮已经放到 44px（见 Sidebar 的热区约定），胶囊跟着长高，
   ⟳ 的热区从 22px 补到 34px——否则手机抽屉里这颗是最难点的目标 */
@media (hover: none) and (pointer: coarse) {
  .sync-chip {
    height: 44px;
    padding-left: 10px;
  }

  .chip-sync {
    width: 34px;
    height: 34px;
  }
}
</style>
