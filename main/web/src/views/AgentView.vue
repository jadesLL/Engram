<template>
  <!-- 内置 Agent 的独立全屏页（2026-11 安卓改版）：手机档（<840）的顶层目的地之一。
       正文不是重写的聊天界面，而是把 ChatDrawer 的「满窗形态」当成页面正文用（embedded）；
       这一层只负责页面自己的 chrome——顶栏（返回 / 标题 / 来源标记 / 会话列表 / 新对话）。 -->
  <div ref="rootEl" class="agent-page" :style="shellStyle">
    <header class="agent-bar">
      <button class="ab-back" type="button" aria-label="返回" @click="goBack">
        <Icon name="chevron-left" :size="22" />
      </button>

      <div class="ab-head">
        <span class="ab-mark" aria-hidden="true"><Icon name="ai" :size="15" /></span>
        <h1 class="ab-title">Agent</h1>
        <!-- 来源标记：这一页跑在哪儿（手机不跑模型，对话在中枢或随包 dsh 上执行） -->
        <span class="ab-src" :class="'kind-' + sourceKind" :title="sourceTip">{{ sourceLabel }}</span>
      </div>

      <div class="ab-actions">
        <!-- 运行中才出现：停止键原本在抽屉头部，嵌入形态没有那条头部，挪到页面顶栏 -->
        <button v-if="liveRun" class="ab-stop" type="button" :disabled="stopping" @click="onStop">
          <Icon name="square" :size="11" />{{ stopping ? '停止中' : '停止' }}
        </button>
        <button
          class="ab-iconbtn"
          type="button"
          :class="{ on: chat.sessionPanelOpen }"
          :aria-pressed="chat.sessionPanelOpen"
          aria-label="会话列表"
          @click="toggleSessions"
        >
          <Icon name="messages" :size="20" />
          <span v-if="chat.runningCount" class="ab-count" aria-hidden="true">{{ chat.runningCount }}</span>
        </button>
        <button class="ab-iconbtn" type="button" aria-label="新对话" @click="onNewSession">
          <Icon name="plus" :size="20" />
        </button>
      </div>
    </header>

    <!-- 正文：聊天抽屉的嵌入形态。转录 / 工具卡 / 子代理 / 附件 / 输入区 / 会话列表全部复用，
         发送、流式与停止仍走 ChatDrawer 原本的实现，这一页不碰聊天逻辑。 -->
    <ChatDrawer ref="drawerRef" class="agent-chat" embedded />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import ChatDrawer from '../components/ChatDrawer.vue';
import Icon from '../components/Icon.vue';
import { useAppStore } from '../stores/app';
import { useChatStore } from '../stores/chat';
import { useRuntimeCapabilities } from '../lib/capabilities';
import { registerBackHandler } from '../lib/androidBack';

/**
 * 全屏 Agent 页（路由 /agent，只在 <840 的手机/折叠屏档出现）。
 *
 * 为什么复用 ChatDrawer 而不是重写一套聊天界面：
 *   - 转录流、工具卡、子代理卡、附件、排队、流式渲染、停止/重试全在 ChatDrawer 里，
 *     另写一份等于把最容易出错的一段逻辑复制两遍；
 *   - 抽屉本来就有 full（满窗）形态，几何上就是「铺满内容区的一列」——与全屏页的正文区是同一个东西。
 * 于是这里只补两件抽屉给不了的东西：**页面顶栏**（返回 / 标题 / 来源 / 会话列表 / 新对话）与
 * **底栏让位**（输入区不能压在底部导航下面）。
 *
 * 桌面档（≥840）没有这一页：router.ts 的守卫把 /agent 送回 /page，并按既有方式打开右侧抽屉。
 */

const router = useRouter();
const app = useAppStore();
const chat = useChatStore();
const { capabilities } = useRuntimeCapabilities();

/** 抽屉实例只暴露两个动作：新对话（连草稿/附件一起清）与停止（处理排队消息回填） */
type ChatDrawerHandle = {
  newSession: () => Promise<void> | void;
  stopRun: () => Promise<void> | void;
};
const drawerRef = ref<ChatDrawerHandle | null>(null);
const rootEl = ref<HTMLElement | null>(null);
const stopping = ref(false);

/* ===== 顶栏状态 ===== */

/** 任意会话在跑就算「运行中」：停止键对应的是当前会话那一轮（chat.currentRun） */
const liveRun = computed(() => chat.currentRun);

/**
 * 来源标记三态，与 ChatDrawer 头部同一份口径（lib/capabilities 的 agentMode）：
 * hub＝经本机 loopback 窄代理到已绑定的中枢；local＝随包 dsh；unavailable＝还没绑定中枢。
 */
const sourceKind = computed<'hub' | 'local' | 'off'>(() => {
  const mode = capabilities.value.agentMode;
  if (mode === 'hub') return 'hub';
  if (mode === 'unavailable') return 'off';
  return 'local';
});
const sourceLabel = computed(() => (sourceKind.value === 'hub' ? '中枢' : sourceKind.value === 'off' ? '未绑定' : '内置'));
const sourceTip = computed(() => {
  if (sourceKind.value === 'hub') return '对话经本机 loopback 窄代理到已绑定的中枢运行：手机退到后台任务仍会继续';
  if (sourceKind.value === 'off') return '还没绑定中枢：先在 设置 → 多端同步 绑定，才能在手机上使用 Agent';
  return '由 Engram 随包的 DeepSeek Harness 驱动：可以问知识库，也可以让它检索、提炼与写页';
});

/* ===== 输入区让开底部导航 =====
 * Home 的 .content 下内边距是「底栏高度 + 边距」的估算值；万一底栏实际更高（改版调过高度）或
 * 键盘弹起导致底栏隐藏，这里按底栏的真实位置补一段让位，输入区不会压在导航栏上。
 * 与 MobileInbox 的 syncShellInset 同一做法（量 .bottom-nav 的 rect，差值写进 CSS 变量）。
 */
const shellExtra = ref(0);
/* 与 MobileInbox 的 shellStyle 同一种写法（CSS 变量写成字符串，类型上最稳） */
const shellStyle = computed(() =>
  shellExtra.value ? '--agent-shell-extra: ' + shellExtra.value + 'px' : undefined
);

function syncShellInset(): void {
  const nav = document.querySelector('.bottom-nav') as HTMLElement | null;
  if (!nav) {
    shellExtra.value = 0;
    return;
  }
  const rect = nav.getBoundingClientRect();
  // 高度为 0＝底栏不在这档（medium 无底栏 / 键盘弹起被收起）：不需要额外让位
  if (!rect.height) {
    shellExtra.value = 0;
    return;
  }
  const host = rootEl.value?.parentElement;
  const reserved = host ? parseFloat(getComputedStyle(host).paddingBottom) || 0 : 0;
  const need = Math.round(window.innerHeight - rect.top + 6 - reserved);
  shellExtra.value = need > 0 ? need : 0;
}

/* ===== 动作 ===== */

/** 返回：会话列表开着先收列表，否则退回上一页；没有上一页（直接打开 /agent）就回内容页 */
function goBack(): void {
  if (chat.sessionPanelOpen) {
    chat.toggleSessionPanel(false);
    return;
  }
  const state = window.history.state as { back?: string | null } | null;
  if (state && state.back) router.back();
  else void router.replace('/page');
}

function toggleSessions(): void {
  chat.toggleSessionPanel();
}

/** 新建会话：走抽屉自己的实现（清草稿与附件、聚焦输入框），这一页不重复一遍 */
async function onNewSession(): Promise<void> {
  await drawerRef.value?.newSession();
}

async function onStop(): Promise<void> {
  if (stopping.value) return;
  stopping.value = true;
  try {
    await drawerRef.value?.stopRun();
  } finally {
    stopping.value = false;
  }
}

/* ===== 生命周期 ===== */

/** 安卓返回键：会话列表这一层由本页消费，其余交回 installRouterBack 的 router.back() */
let stopBackHandler: (() => void) | null = null;

onMounted(() => {
  /* body 类只挂在这一页：全局样式靠它隐藏右下角的 Agent 状态胶囊（见文件末尾的全局样式块）。
     Agent 页本身就是对话，那颗「回复中 / 已最小化」胶囊在这里是重复状态，还会压住输入区的发送键。 */
  document.body.classList.add('agent-page');
  stopBackHandler = registerBackHandler(() => {
    if (!chat.sessionPanelOpen) return false;
    chat.toggleSessionPanel(false);
    return true;
  });
  syncShellInset();
  window.addEventListener('resize', syncShellInset);
  window.visualViewport?.addEventListener('resize', syncShellInset);
  /* 兜底：进这一页之前抽屉若是开着的（历史后退 / 别处跳转），先关掉——
     否则 Home 会同时挂一只真抽屉，页面上叠两份对话。文件树抽屉同理：
     它挨着正文左边，留着会盖住对话，还会让 .content 的左侧让位多出一截。 */
  if (app.chatDrawerOpen) app.toggleChat(false);
  if (app.sidebarOpen) app.sidebarOpen = false;
  // 这一页就是对话本身：把「有新回复」的未读标记清掉，底栏 Agent 项不再顶一颗点
  app.chatUnread = false;
});

/* 会话跑完时 store 会因为 chatDrawerOpen=false 点亮未读（它不知道这一页就是对话），在这里即时清掉 */
watch(
  () => app.chatUnread,
  (unread) => {
    if (unread) app.chatUnread = false;
  }
);

onUnmounted(() => {
  stopBackHandler?.();
  stopBackHandler = null;
  document.body.classList.remove('agent-page');
  window.removeEventListener('resize', syncShellInset);
  window.visualViewport?.removeEventListener('resize', syncShellInset);
  /* 会话列表面板是这一页的一层浮层，别留给下一次：否则回到抽屉形态时一开门就是列表 */
  chat.toggleSessionPanel(false);
});
</script>

<style scoped>
.agent-page {
  position: relative;
  display: flex;
  flex-direction: column;
  /* 高度吃满 Home .content 的内容盒（它已经让开底栏与系统栏）：输入区因此落在底栏之上 */
  height: 100%;
  min-height: 0;
  overflow: hidden;
  padding-bottom: var(--agent-shell-extra, 0px);
  color: var(--text);
  background: var(--bg);
}

/* ===== 顶栏：56px，返回 44 + 标题 20/650 + 右侧最多两颗 44px 图标按钮 ===== */
.agent-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 56px;
  padding: 4px 8px 4px 2px;
}

.ab-back,
.ab-iconbtn {
  position: relative;
  width: 44px;
  height: 44px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  color: var(--text-secondary);
  transition: background 0.14s ease, color 0.14s ease, transform 0.14s ease;
}

.ab-back {
  color: var(--text);
}

.ab-back:active,
.ab-iconbtn:active {
  transform: scale(0.94);
  background: var(--bg-hover);
  color: var(--text);
}

/* 右侧两颗是「看得见的一等入口」：给卡片底与细描边，与顶栏里的纯图标箭头区分开 */
.ab-iconbtn {
  border-color: var(--border);
  background: var(--card-bg);
  box-shadow: var(--shadow-raised);
}

.ab-iconbtn.on {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  background: var(--accent-soft);
  color: var(--accent);
}

.ab-count {
  position: absolute;
  top: 5px;
  right: 5px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.ab-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}

.ab-head {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  padding-left: 2px;
}

/* AI 图标盘：只用现有令牌（强调软底 + 强调色），不引入新色值 */
.ab-mark {
  width: 26px;
  height: 26px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: var(--accent-soft);
  color: var(--accent);
}

.ab-title {
  margin: 0;
  font-size: 20px;
  line-height: 1.2;
  font-weight: 650;
  letter-spacing: -0.01em;
  white-space: nowrap;
}

.ab-src {
  flex: none;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.5;
  white-space: nowrap;
}

.ab-src.kind-local {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

.ab-src.kind-hub {
  background: var(--accent-soft);
  color: var(--accent);
}

.ab-src.kind-off {
  background: var(--warn-soft);
  color: var(--warning);
}

/* 停止：视觉 36px 高，热区靠伪元素补到 48px（顶栏每高一行都吃正文） */
.ab-stop {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 36px;
  padding: 0 11px;
  border-radius: 999px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  transition: transform 0.14s ease, background 0.14s ease;
}

.ab-stop::after {
  content: '';
  position: absolute;
  inset: -6px -4px;
}

.ab-stop:active {
  transform: scale(0.96);
}

.ab-stop:disabled {
  opacity: 0.55;
}

.agent-chat {
  flex: 1;
  min-height: 0;
}

/*
 * 窄屏（360px）不新增断点（全库只允许 600/640/768/769/840/1024，见 lib/mobileLayout.test.ts）：
 * 改成让「标题 → 来源标记」按优先级收缩——标题先省略号、标记再截断，右侧两颗按钮永远不被挤出去。
 */
.ab-head {
  overflow: hidden;
}

.ab-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ab-src {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>

<style>
/*
 * Agent 页自己就是对话：Home 渲染的右下角「Agent 回复中 / 已最小化」胶囊在这一页是重复状态，
 * 而且正好压在输入区的发送键上。用 body 类把作用域限定在「本页挂载期间」，
 * 离开 /agent 立即恢复（类由 AgentView 的 onMounted / onUnmounted 增删）。
 */
body.agent-page .agent-pill {
  display: none;
}
</style>
