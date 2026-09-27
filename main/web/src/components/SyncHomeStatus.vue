<template>
  <button
    v-if="pill"
    class="sync-pill"
    :class="[`link-${pill.key}`, { syncing: pill.spinning }]"
    type="button"
    v-tooltip="pill.tip"
    :aria-label="pill.aria"
    @click="openSettings"
  >
    <span class="sync-dot" aria-hidden="true" />
    <span class="sync-label">{{ pill.label }}</span>
    <span v-if="pill.detail" class="sync-detail">{{ pill.detail }}</span>
  </button>
</template>

<script setup lang="ts">
/**
 * 首页（欢迎页）同步状态条：配置过多端同步才出现，一眼看出「走的是哪条路」与「同没同步完」。
 *
 * 视觉与侧栏胶囊同源：通道色点 + 通道名（lib/syncChannel 的 key → main.css 的 --link-* 令牌），
 * 一字状态（最近同步 / 待推送）仍由 lib/syncStatus 给——那套文案锁着欢迎页的既有口径，不动。
 * 状态来自共享 store（与侧栏胶囊同一份轮询），点击进入 设置 → 多端同步 查看详情。
 */
import { computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useSyncStore } from '../stores/sync';
import { syncStatusView } from '../lib/syncStatus';
import { syncChannelView } from '../lib/syncChannel';
import { useRuntimeCapabilities } from '../lib/capabilities';

const router = useRouter();
const sync = useSyncStore();
const { capabilities } = useRuntimeCapabilities();

const view = computed(() =>
  syncStatusView(sync.status, {
    androidLocal: capabilities.value.runtime === 'android-local',
  })
);

const channel = computed(() => syncChannelView(sync.status));

/**
 * 两个模型合成一颗胶囊：通道给颜色与名字，状态条给「同步到哪一步了」。
 *
 * 中枢端是个例外——通道那档的标签本身就是「中枢 2/3」，后面再跟一句「2/3 个成员在线」
 * 等于同一句话说两遍，所以那一档用通道的完整说法（中枢运行中）配在线数，
 * 与改动前的欢迎页逐字一致；成员端才用短通道名 + 状态条的说明。
 *
 * 断开/停用同样取通道那档的说明：`lib/syncStatus` 把「正在全量对账」排在「没连上」之前，
 * 于是刚失去连接时会给出「首次同步，正在拉取知识库」——那句话和红色的「已断开」摆在一起
 * 自相矛盾（红点说连不上，灰字说正在拉取）。这几档直接用通道模型的说明，一次只说一件事。
 */
const pill = computed(() => {
  const state = view.value;
  const current = channel.value;
  if (!state || !current) return null;
  const hub = current.key === 'hub';
  const channelTakesDetail = hub || current.key === 'offline' || current.key === 'muted';
  const detail = channelTakesDetail ? current.detail : state.detail;
  return {
    key: current.key,
    label: hub ? current.fullLabel : current.label,
    detail,
    spinning: state.phase === 'syncing' && !channelTakesDetail,
    // 提示第一行说明走的是哪条路（与侧栏胶囊同一句话），第二行是状态条原有的排查提示
    tip: `${current.title}\n${state.hint}`,
    aria: `${current.fullLabel}：${detail}（打开多端同步设置）`,
  };
});

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
  border: 1px solid color-mix(in srgb, var(--channel) 34%, var(--border));
  border-radius: 999px;
  background: var(--channel-soft);
  color: var(--channel);
  font-size: var(--font-sm);
  line-height: 1.6;
  text-align: left;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}

.sync-pill:hover {
  border-color: color-mix(in srgb, var(--channel) 58%, transparent);
}

.sync-pill:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* 通道点：与侧栏胶囊同一颗、同一个颜色来源 */
.sync-dot {
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--channel);
}

/* 颜色永远配文字：通道名与点同色，不让颜色单独承担含义 */
.sync-label {
  font-weight: 600;
  color: var(--channel);
  white-space: nowrap;
}

.sync-detail {
  min-width: 0;
  overflow: hidden;
  color: var(--text-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 同步中：圆点呼吸（原来是转 ⟳ 图标，这版状态条已经没有图标了） */
.sync-pill.syncing .sync-dot {
  animation: sync-pill-pulse 1.4s ease-in-out infinite;
}

@keyframes sync-pill-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

@media (prefers-reduced-motion: reduce) {
  .sync-pill.syncing .sync-dot { animation: none; }
}

@media (max-width: 640px) {
  .sync-detail { display: block; max-width: 38vw; font-size: 11px; }
}
</style>
