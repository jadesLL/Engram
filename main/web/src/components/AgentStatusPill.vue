<template>
  <button
    v-if="visible"
    class="agent-pill"
    type="button"
    :aria-label="busy ? `${agentName} 正在回复，打开对话` : `${agentName} 已最小化，打开对话`"
    @click="open"
  >
    <AppSpinner v-if="busy" :size="12" />
    <Icon v-else name="ai" :size="14" />
    <span class="txt">{{ busy ? `${agentName} 回复中` : `${agentName} 已最小化` }}</span>
    <span class="detail">{{ busy ? detail : '点此继续对话' }}</span>
    <span v-if="liveRun" class="time">{{ elapsed }}</span>
    <span v-if="liveRun" class="go">查看</span>
  </button>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import AppSpinner from './ui/AppSpinner.vue';
import Icon from './Icon.vue';
import { useAppStore } from '../stores/app';
import { useChatStore } from '../stores/chat';
import { agentActivityText } from '../lib/agentActivity';
import { formatDuration } from '../lib/chatTime';
import { isReasoningMessage, reasoningDurationMs } from '../lib/chatTimeline';
import { useRuntimeCapabilities } from '../lib/capabilities';

/**
 * 内置 Agent 最小化后的常驻状态胶囊（正文区右下角）。
 *
 * 满窗形态下一导航，Agent 就最小化了，抽屉连同它的「回复中」胶囊与贴底状态条一起卸载——
 * 用户于是看不到「它还在干活」。这颗胶囊补上这一段：
 *   · 有轮次在跑 → 常驻（回复中 + 当前动作 + 秒表），任何视图都看得见；
 *   · 刚被导航挤下去 → 提示 4 秒「已最小化 · 点此继续对话」，免得用户以为对话丢了；
 *   · 抽屉开着 / 空闲已久 → 不显示（抽屉自己会报状态，右下角不占地方）。
 * 点它即回到对话：形态偏好没被动过，恢复的就是最小化前那个满窗。
 */

/** 最小化提示的存活时间：够看清抽屉去哪儿了，又不至于一直占着右下角 */
const HINT_MS = 4000;

const app = useAppStore();
const chat = useChatStore();
const { capabilities } = useRuntimeCapabilities();
const agentName = computed(() => capabilities.value.agentMode === 'hub' ? '服务器 Agent' : capabilities.value.agentMode === 'unavailable' ? 'Agent' : '内置 Agent');

/** 每秒跳一次的钟：秒表与提示到期都靠它（只在胶囊可见时走） */
const clock = ref(Date.now());
let timer: number | undefined;

const liveRun = computed(() => chat.currentRun);
/** 是否有任意会话在跑（后台会话也算：本端没开抽屉也可能有活儿） */
const busy = computed(() => chat.hasRunning);
const hint = computed(
  () => !busy.value && app.chatMinimizedAt > 0 && clock.value - app.chatMinimizedAt < HINT_MS
);
const visible = computed(() => !app.chatDrawerOpen && (busy.value || hint.value));

/** 最后一条是不是还在长的思考段（与抽屉状态条同一判断，文案才不会两处走样） */
const thinking = computed(() => {
  if (!liveRun.value) return false;
  const last = chat.messages[chat.messages.length - 1];
  return Boolean(last && isReasoningMessage(last) && reasoningDurationMs(last) === 0);
});

const detail = computed(() => {
  if (liveRun.value) {
    return agentActivityText({
      subagents: chat.runningSubagents,
      toolCalls: chat.sessionToolCalls,
      statusText: chat.statusText,
      thinking: thinking.value,
    });
  }
  // 跑的是别的会话：本端拿不到那一轮的细节，说清楚是后台在干活就够了
  const count = chat.runningCount;
  return count > 1 ? `${count} 个会话在回复中` : '后台会话正在回复';
});

const elapsed = computed(() => {
  const run = liveRun.value;
  if (!run) return '';
  const started = Date.parse(run.createdAt);
  if (!Number.isFinite(started)) return '';
  return formatDuration(Math.max(0, clock.value - started));
});

watch(
  visible,
  (on) => {
    if (window === undefined) return;
    if (on && timer === undefined) {
      clock.value = Date.now();
      timer = window.setInterval(() => { clock.value = Date.now(); }, 1000);
    } else if (!on && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  },
  { immediate: true }
);

onUnmounted(() => {
  if (timer !== undefined) {
    window.clearInterval(timer);
    timer = undefined;
  }
});

function open() {
  app.toggleChat(true);
}
</script>

<style scoped>
.agent-pill {
  position: absolute;
  right: 18px;
  bottom: 18px;
  /* 低于遮罩(32)与侧栏(35)：紧凑档文件树浮层打开时，胶囊跟着正文一起被压住 */
  z-index: var(--z-drawer);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: calc(100% - 36px);
  padding: 8px 12px 8px 11px;
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
  border-radius: 999px;
  background: var(--card-bg);
  color: var(--accent);
  box-shadow: var(--shadow);
  font-size: var(--font-sm);
  cursor: pointer;
}

.agent-pill:hover {
  border-color: var(--accent);
}

.agent-pill > * {
  min-width: 0;
}

.agent-pill .txt {
  color: var(--text);
  font-weight: 600;
  white-space: nowrap;
}

.agent-pill .detail {
  overflow: hidden;
  color: var(--text-faint);
  font-weight: 400;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.agent-pill .time {
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.agent-pill .go {
  padding-left: 8px;
  border-left: 1px solid var(--border);
  color: var(--accent);
  white-space: nowrap;
}

/* 移动端：让开底部导航，也别在窄屏上把一整行文字铺满 */
@media (max-width: 768px) {
  .agent-pill {
    right: 12px;
    bottom: 74px;
    max-width: calc(100% - 24px);
  }

  .agent-pill .detail,
  .agent-pill .go {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .agent-pill {
    animation: none;
  }
}
</style>
