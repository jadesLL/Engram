<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="panelEl"
      class="sync-popover"
      :class="[`link-${view.key}`, { ready }]"
      :style="{ left: `${left}px`, top: `${top}px` }"
      role="dialog"
      aria-label="连接通道详情"
      tabindex="-1"
      @keydown.esc.stop.prevent="close"
    >
      <!-- 头部：当前通道（点 + 名字 + 地址）。地址靠右、等宽字体：出问题时用户第一眼要抄的就是它 -->
      <div class="po-head">
        <span class="po-dot" aria-hidden="true" />
        <strong>{{ view.fullLabel }}</strong>
        <span class="po-host">{{ host || '—' }}</span>
      </div>
      <!-- 副行：这条路好不好走（延迟 / 保持了多久 / 本机在群组里的名字）；断开时换成一行原因 -->
      <p class="po-sub" :class="{ bad: offline }">{{ subLine }}</p>

      <dl class="po-kv">
        <dt>最近同步</dt>
        <dd>{{ syncLine }}</dd>

        <!-- link 缺失（Android 本地端）时不摆「自动择优 / 探测记录」：这两块的前提是服务端在探路 -->
        <template v-if="channelLink">
          <dt>自动择优</dt>
          <dd class="po-order-row">
            <span class="po-order">局域网 → IPv6 → IPv4</span>
            <label class="po-switch">
              <input
                v-model="preferLan"
                type="checkbox"
                :disabled="savingLan"
                @change="savePreferLan"
              />
              <span>优先局域网</span>
            </label>
          </dd>

          <dt>探测记录</dt>
          <dd>
            <ul v-if="candidates.length" class="po-probes">
              <li v-for="(item, index) in candidates" :key="`${item.kind}-${item.url}-${index}`">
                <span class="po-probe-label">{{ item.label }}</span>
                <span class="po-probe-url">{{ item.url }}</span>
                <span v-if="item.ok" class="po-probe-ok">✓ {{ probeLatency(item.latencyMs) }}</span>
                <span v-else class="po-probe-bad">✗ {{ item.error || '不可达' }}</span>
              </li>
            </ul>
            <span v-else class="po-faint">还没有探测记录：下一轮连接会先试局域网</span>
          </dd>
        </template>
        <template v-else>
          <dt>本机状态</dt>
          <dd class="po-faint">这台设备没有连接通道明细（本机直连模式），同步按最近一轮是否跑完判定</dd>
        </template>
      </dl>

      <div class="po-acts">
        <button class="btn primary" type="button" :disabled="syncing" @click="emit('sync')">
          {{ syncing ? '同步中…' : (offline ? '立即重连' : '立即同步') }}
        </button>
        <button class="btn" type="button" @click="openLog">同步详情</button>
        <button class="btn" type="button" @click="openSettings">多端同步设置</button>
      </div>

      <p class="po-foot">
        <Icon name="refresh" :size="12" />
        {{ footLine }}
      </p>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * 连接通道详情浮层（点侧栏胶囊左侧那块打开）。
 *
 * 这里放的都是「设置页才有、但排查时最想看」的东西：现在走哪条路、延迟多少、保持了多久、
 * 候选地址各探成什么样、优先局域网的开关；点右侧 ⟳ 的「立即同步」老习惯不变，所以浮层里的
 * 主按钮走的是**同一个同步流程**（由父组件 SyncButton 通过 sync 事件执行，不写第二份）。
 *
 * 形态照 AppContextMenu：Teleport 到 body + fixed 定位（侧栏是独立滚动容器，留在原地会被裁掉），
 * 按触发元素 rect 就近展开、越界夹紧；Esc / 点外部 / 换路由都关闭，关闭后由父组件把焦点还给胶囊。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { notify } from '../lib/notify';
import { openSyncLogDrawer } from '../lib/syncLog';
import { formatSyncTime } from '../lib/syncStatus';
import {
  channelErrorText,
  formatChannelSince,
  type SyncChannelView,
} from '../lib/syncChannel';
import { useSyncStore } from '../stores/sync';
import Icon from './Icon.vue';

const props = defineProps<{
  open: boolean;
  /** 触发元素（胶囊）：浮层贴着它的 rect 展开 */
  anchor: HTMLElement | null;
  view: SyncChannelView;
  /** 父组件正在跑一轮同步：主按钮沿用它的状态，避免两处各转各的 */
  syncing: boolean;
}>();

const emit = defineEmits<{
  (event: 'close'): void;
  (event: 'sync'): void;
}>();

/** 本机每轮状态查询的间隔（stores/sync 的忙档节奏）：断开时的倒计时说的是「下一次探测」 */
const RETRY_TICK_SECONDS = 5;

const sync = useSyncStore();
const router = useRouter();
const route = useRoute();

const panelEl = ref<HTMLElement>();
const left = ref(0);
const top = ref(0);
/** 量好位置再显示，避免在旧位置闪一帧 */
const ready = ref(false);

/** 每秒跳一次的钟：已保持时长与重连倒计时都靠它（只在浮层开着时走） */
const clock = ref(Date.now());
const retryIn = ref(RETRY_TICK_SECONDS);
let ticker: number | null = null;

/** 连接通道明细来自共享 store（与侧栏胶囊、首页状态条同一份轮询结果） */
const channelLink = computed(() => sync.link);
const offline = computed(() => props.view.key === 'offline');
const host = computed(() => props.view.host || channelLink.value?.host || '');
const candidates = computed(() => channelLink.value?.candidates || []);
const pending = computed(() => Number(sync.status?.pending || 0));
const pendingPulls = computed(() => Number(sync.status?.pendingPulls || 0));
const preferLan = ref(true);
const savingLan = ref(false);

/** 副行：可用的通道说延迟与保持了多久；断开说原因（无信息量的网络错误不外露） */
const subLine = computed(() => {
  if (offline.value) {
    return channelErrorText(sync.status?.lastError)
      || (pending.value > 0 ? `局域网、IPv6、IPv4 都不通；本机改动已排队 ${pending.value} 项` : '局域网、IPv6、IPv4 都不通');
  }
  const bits: string[] = [];
  const latency = channelLink.value?.latencyMs ?? props.view.latencyMs;
  if (typeof latency === 'number') bits.push(`延迟 ${latency}ms`);
  const kept = formatChannelSince(props.view.since ?? channelLink.value?.since ?? null, clock.value);
  if (kept) bits.push(`已保持 ${kept}`);
  // deviceLabel 在成员端是「中枢给这台设备起的成员名」（不是中枢自己的名字），
  // 所以这里写「本机」——写成「中枢 X」会把本机当成中枢，与设置页的说法自相矛盾
  if (sync.status?.deviceLabel) bits.push(`本机 ${sync.status.deviceLabel}`);
  return bits.join(' · ') || props.view.detail;
});

const syncLine = computed(() => {
  const bits: string[] = [];
  const last = formatSyncTime(sync.status?.lastSyncAt, clock.value);
  bits.push(last ? `最近同步 ${last}` : '还没有成功同步过');
  if (pending.value > 0) bits.push(`待推送 ${pending.value} 项`);
  if (pendingPulls.value > 0) bits.push(`待补拉 ${pendingPulls.value} 个文件`);
  return bits.join(' · ');
});

const footLine = computed(() => (
  offline.value
    ? `本机照常可用 · 正在自动重连，${Math.max(0, retryIn.value)} 秒后再探一次`
    : '本机与中枢内容一致，改动会自动推送'
));

function probeLatency(ms: number | null): string {
  return typeof ms === 'number' ? `${ms}ms` : '可达';
}

/* ── 开合与落位 ─────────────────────────────────────────── */

async function place(): Promise<void> {
  const el = panelEl.value;
  const anchor = props.anchor;
  if (!el || !anchor) return;
  ready.value = false;
  const rect = anchor.getBoundingClientRect();
  // 窄屏（<400px）左右各留 10px，普通窗口 8px（与右键菜单同一口径）
  const margin = window.innerWidth < 400 ? 10 : 8;
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  // 默认挂在胶囊下方、左端对齐；下方放不下就翻到上方
  const below = rect.bottom + 8;
  const above = rect.top - height - 8;
  const y = below + height > window.innerHeight - margin ? Math.max(margin, above) : below;
  left.value = Math.max(margin, Math.min(rect.left - 4, window.innerWidth - width - margin));
  top.value = y;
  ready.value = true;
}

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      ready.value = false;
      return;
    }
    retryIn.value = RETRY_TICK_SECONDS;
    await nextTick();
    await place();
    panelEl.value?.focus({ preventScroll: true });
  },
);

// 每轮状态都是「刚探测过」的信号：倒计时跟着重置（断开时这句话才有意义）
watch(() => sync.status, () => { retryIn.value = RETRY_TICK_SECONDS; });

watch(clock, () => {
  if (!props.open || !offline.value) return;
  retryIn.value = Math.max(0, retryIn.value - 1);
});

// 开关的服务端值回填：用户刚点、还在提交时不回填，免得被 5 秒轮询冲回旧值
watch(
  () => [props.open, channelLink.value?.preferLan] as const,
  () => {
    if (savingLan.value) return;
    preferLan.value = channelLink.value?.preferLan !== false;
  },
  { immediate: true },
);

// 换路由（点「多端同步设置」、或用户在别处导航）后这块已经不属于当前上下文了
watch(() => route.fullPath, () => { if (props.open) emit('close'); });

function close(): void {
  emit('close');
}

function onDocPointerDown(event: PointerEvent): void {
  if (!props.open) return;
  const target = event.target as Node | null;
  if (!target) return;
  // 点在胶囊上交给它自己的切换逻辑：这里也关一次会把「点一下开、点两下关」变成永远打不开
  if (panelEl.value?.contains(target) || props.anchor?.contains(target)) return;
  close();
}

function onDocKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !props.open) return;
  event.stopPropagation();
  close();
}

function onViewportChange(): void {
  if (props.open) void place();
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('keydown', onDocKeyDown, true);
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('scroll', onViewportChange, true);
  ticker = window.setInterval(() => { clock.value = Date.now(); }, 1000);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  document.removeEventListener('keydown', onDocKeyDown, true);
  window.removeEventListener('resize', onViewportChange);
  window.removeEventListener('scroll', onViewportChange, true);
  if (ticker !== null) window.clearInterval(ticker);
  ticker = null;
});

/* ── 动作 ───────────────────────────────────────────────── */

async function savePreferLan(): Promise<void> {
  const next = preferLan.value;
  savingLan.value = true;
  try {
    const res = await api.post('/api/sync/config', { prefer_lan: next });
    if (!res.data?.ok) throw new Error(res.data?.error || '保存失败');
    notify.success(next ? '已开启：优先用局域网地址' : '已关闭：局域网地址不再优先');
    await sync.refresh();
  } catch (error: any) {
    // 乐观更新失败要滚回去：开关停在用户点的那一侧会与实际配置不一致
    preferLan.value = !next;
    notify.error(error?.response?.data?.error || error?.message || '保存失败');
  } finally {
    savingLan.value = false;
  }
}

function openLog(): void {
  close();
  openSyncLogDrawer();
}

function openSettings(): void {
  close();
  void router.push('/settings?section=sync');
}
</script>

<style scoped>
.sync-popover {
  position: fixed;
  z-index: var(--z-menu);
  width: 372px;
  /* 窄屏左右各留 10px（见 place() 的 margin 口径） */
  max-width: calc(100vw - 20px);
  padding: 14px 15px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--card-bg);
  box-shadow: var(--shadow);
  color: var(--text);
  opacity: 0;
  transition: opacity 0.12s ease;
}

.sync-popover.ready { opacity: 1; }
.sync-popover:focus { outline: none; }

.po-head {
  display: flex;
  align-items: center;
  gap: 9px;
}

.po-dot {
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--channel);
}

.po-head strong { font-size: 14.5px; }

/* 地址靠右 + 等宽：排查时要抄的就是它 */
.po-host {
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  color: var(--text-faint);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.po-sub {
  margin: 3px 0 0 18px;
  color: var(--text-faint);
  font-size: 12.5px;
}

/* 断开态：红字（与胶囊的红点红字同一档），但不铺红底——浮层里已经有一行原因，不必再喊一次 */
.po-sub.bad { color: var(--danger); }

.po-kv {
  display: grid;
  grid-template-columns: 66px minmax(0, 1fr);
  gap: 6px 0;
  margin: 12px 0 0;
  padding: 10px 0 0;
  border-top: 1px solid var(--border);
  font-size: 13px;
}

.po-kv dt { color: var(--text-faint); }
.po-kv dd { min-width: 0; margin: 0; }

.po-order-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.po-order { color: var(--text-secondary); }

.po-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.po-switch input { margin: 0; }
.po-switch span { color: var(--text-faint); font-size: 12px; }

.po-probes {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.po-probes li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.po-probe-label { flex: none; color: var(--text-secondary); }

.po-probe-url {
  min-width: 0;
  overflow: hidden;
  color: var(--text-faint);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.po-probe-ok { flex: none; margin-left: auto; color: var(--success); }
.po-probe-bad { flex: none; margin-left: auto; color: var(--danger); }
.po-faint { color: var(--text-faint); font-size: 12.5px; }

.po-acts {
  display: flex;
  gap: 8px;
  margin-top: 13px;
  flex-wrap: wrap;
}

.po-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px 0 0;
  color: var(--text-faint);
  font-size: 12px;
}

@media (max-width: 640px) {
  /* 紧凑档：三个按钮挤在 372px 里会换行，换行后各自撑满一行更好点 */
  .po-acts .btn { flex: 1 1 auto; justify-content: center; }
}
</style>
