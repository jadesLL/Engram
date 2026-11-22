<template>
  <!--
    桌面融合标题栏（46px 铭牌页眉）：品牌块（库名 + 页数）+ 当前页 + 日期 + 搜索/记灵感 + 同步胶囊 + 更新入口。
    右侧 152px 内边距留给 Windows 原生窗口按钮（3 × 46px + 14px 间隙），不在这里自绘。
    整条除按钮外都可拖拽（-webkit-app-region: drag）。
  -->
  <div v-if="isDesktop" class="win-titlebar">
    <span class="win-titlebar-brand">
      <span class="win-titlebar-logo">
        <BrandMark :size="24" />
      </span>
      <span class="win-titlebar-brand-text">
        <span class="win-titlebar-name">Engram</span>
        <span v-if="!isLoginPage" class="win-titlebar-sub">
          知识库<template v-if="app.libraryPages !== null"> · {{ app.libraryPages }} 页</template>
        </span>
      </span>
    </span>
    <template v-if="!isLoginPage">
      <span class="win-titlebar-divider" aria-hidden="true"></span>
      <span v-if="sectionTitle" class="win-titlebar-page">
        <span class="win-titlebar-page-dot" aria-hidden="true"></span>{{ sectionTitle }}
      </span>
      <span class="win-titlebar-date">{{ dateLabel }}</span>
      <span class="win-titlebar-spacer"></span>
      <span class="win-titlebar-actions">
        <button class="win-titlebar-action" type="button" title="搜索 (Ctrl+K)" aria-label="搜索 (Ctrl+K)" @click="openSearch">
          <Icon name="search" :size="15" />
        </button>
        <button class="win-titlebar-action" type="button" title="记一条灵感 (Ctrl+N)" aria-label="记一条灵感 (Ctrl+N)" @click="quickNote">
          <Icon name="plus" :size="15" />
        </button>
      </span>
      <button
        v-if="syncChip"
        class="win-titlebar-sync"
        :class="`tone-${syncChip.tone}`"
        type="button"
        :title="syncChip.tip"
        :aria-label="syncChip.aria"
        @click="openSyncSettings"
      >
        <span class="win-titlebar-sync-dot" aria-hidden="true"></span>
        <span class="win-titlebar-sync-label">{{ syncChip.label }}</span>
      </button>
      <!-- 更新入口挂载点：桌面端「更新」小按钮由 UpdateNotice Teleport 到这里（同步胶囊右侧，永不与正文/抽屉重叠） -->
      <span id="win-titlebar-slot" class="win-titlebar-slot"></span>
    </template>
    <span v-else class="win-titlebar-spacer"></span>
  </div>
  <!-- 路由切换过渡（2026-11 动效）：只做入场淡入（见 main.css .page-*），离场瞬时卸载，重页面切换不加延迟 -->
  <router-view v-slot="{ Component, route }">
    <Transition name="page">
      <component :is="Component" :key="route.path" />
    </Transition>
  </router-view>
  <AssetDrawer />
  <!-- 同步详情抽屉：与图片资产抽屉同一挂载方式（Teleport 到 body），设置页只留一个入口按钮 -->
  <SyncLogDrawer />
  <ToastHost />
  <ConfirmHost />
  <!-- 记灵感撰写框：正文进、标题由 Engram 拟（左下角「+」/Ctrl+N/欢迎页卡片共用） -->
  <IdeaComposer />
  <UpdateOverlay />
  <!-- 全文美化最小化后的全局胶囊：切页/收起编辑页时任务继续跑 -->
  <BeautifyTaskPill />
  <AppTooltip />
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAppStore } from './stores/app';
import { useAuthStore } from './stores/auth';
import { useServerUpdateStore } from './stores/serverUpdate';
import { useSyncStore } from './stores/sync';
import ToastHost from './components/ui/ToastHost.vue';
import ConfirmHost from './components/ui/ConfirmHost.vue';
import IdeaComposer from './components/ui/IdeaComposer.vue';
import AppTooltip from './components/ui/AppTooltip.vue';
import UpdateOverlay from './components/UpdateOverlay.vue';
import BeautifyTaskPill from './components/BeautifyTaskPill.vue';
import AssetDrawer from './components/AssetDrawer.vue';
import SyncLogDrawer from './components/SyncLogDrawer.vue';
import BrandMark from './components/BrandMark.vue';
import Icon from './components/Icon.vue';
import { loadRuntimeCapabilities } from './lib/capabilities';
import { registerGlobalBackLayers } from './lib/globalBackLayers';
import { installJoinLinkReceiver } from './lib/joinLink';
import { installShareInboxReceiver } from './lib/shareInbox';
import { installUiZoom } from './lib/uiZoom';
import { createIdeaNote } from './lib/quickNote';
import { titlebarDate, titlebarSection, titlebarSyncChip } from './lib/titlebarHeader';
import { api } from './api';
import { notify } from './lib/notify';
import {
  clearServerUpdatePending,
  evaluateServerUpdateOutcome,
  readServerUpdatePending,
  serverUpdateOutcomeText,
} from './lib/serverUpdateFeedback';

const app = useAppStore();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const sync = useSyncStore();
const serverUpdate = useServerUpdateStore();
// 桌面端壳（有 wikiDesktop 桥）：启用标题栏融合条（品牌块 + 上下文 + 系统窗口按钮）；
// Docker/Android 无此桥，不渲染也不加偏移
const isDesktop = Boolean((window as any).wikiDesktop);
// 在渲染前就挂上桌面壳类：否则首帧标题栏没有高度、内容也没有顶部留白，挂载后会跳一下
if (isDesktop) document.documentElement.classList.add('desktop-frame');

const isLoginPage = computed(() => route.path === '/login');
const sectionTitle = computed(() => (isLoginPage.value ? '' : titlebarSection(route.path)));
const syncChip = computed(() =>
  isLoginPage.value ? null : titlebarSyncChip(sync.status, { updating: serverUpdate.updating })
);

/** 日期只在跨天后变：每分钟对一次表，避免「开着过夜，标题栏还停在昨天」 */
const clock = ref(Date.now());
const dateLabel = computed(() => titlebarDate(new Date(clock.value)));
let clockTimer: ReturnType<typeof setInterval> | null = null;
/** 同步胶囊订阅状态：登录态变化与卸载时按同一把尺子退订（store 是引用计数） */
let subscribedSync = false;

function navigate(path: string): void {
  app.minimizeChatForNavigation();
  void router.push(path);
}

function openSearch(): void {
  navigate('/search');
}

function openSyncSettings(): void {
  navigate('/settings?section=sync');
}

/** 标题栏「记一条灵感」：与左下角「+」同一套落盘 + 通知链路，这里只补一次侧栏刷新与跳转 */
async function quickNote(): Promise<void> {
  const created = await createIdeaNote();
  if (!created) return;
  app.bumpSidebar();
  void router.push(`/page/${created.id}`);
}

watch(
  () => auth.authed,
  (authed) => {
    if (!authed) {
      if (subscribedSync) {
        sync.unsubscribe();
        subscribedSync = false;
      }
      // 品牌块副行的页数来自侧栏那次列表加载，退出登录时清掉（登录页本来也不显示）
      app.setLibraryPages(null);
      return;
    }
    // 同步胶囊只在桌面壳渲染：Docker/安卓不为标题栏额外挂一份常驻轮询
    if (!isDesktop || subscribedSync) return;
    // 引用计数与首页状态条共用一份轮询，切页不会重复打接口
    sync.subscribe();
    subscribedSync = true;
  },
  { immediate: true }
);

/**
 * 服务器更新成功提示：更新前落的 pending 标记在这里结算。
 *
 * 容器重建会把页面刷新掉，成功证据只能跨页面保存（见 lib/serverUpdateFeedback）。
 * 刷新回来后比对版本号/提交号是否真的变了：变了弹绿条，没变提示「可能已回滚」，
 * 绝不把回滚报成成功。拿不到服务端状态（服务还没起来）时保留标记，下次加载再结算。
 */
async function settleServerUpdateFeedback(): Promise<void> {
  const pending = readServerUpdatePending();
  if (!pending) return;
  let state: { currentVersion?: string; commit?: string } | null = null;
  try {
    const { data } = pending.source === 'hub'
      ? await api.get('/api/sync/hub-update/state')
      : await api.get('/api/update/state');
    state = data;
  } catch {
    return;
  }
  const outcome = evaluateServerUpdateOutcome(pending, state);
  if (outcome.status === 'unresolved' || outcome.status === 'none') return;
  clearServerUpdatePending();
  const text = serverUpdateOutcomeText(outcome, pending.source, pending.hubHost);
  if (!text) return;
  if (outcome.status === 'success') notify.success(text);
  else notify.info(text);
}
/** 安卓返回键接管层（全局浮层）的注销函数 */
let stopBackLayers: (() => void) | null = null;
let stopShareInbox: (() => void) | null = null;
let stopUiZoom: (() => void) | null = null;
onMounted(() => {
  loadRuntimeCapabilities().catch(() => {});
  // 上一次服务器更新是否成功（跨页面刷新结算，成功/回滚都在这里给提示）
  void settleServerUpdateFeedback();
  // 安卓：点别人发来的邀请链接（engram://join?…）打开应用时，把链接交给设置页的同步表单
  installJoinLinkReceiver();
  stopShareInbox = installShareInboxReceiver();
  // 桌面端整页缩放（Ctrl + 滚轮）：无桌面桥时是空实现，Docker/安卓不接管原生缩放
  stopUiZoom = installUiZoom();
  // 标题栏日期：每分钟对一次表（只在桌面壳里渲染，其它端不必跑定时器）
  if (isDesktop) clockTimer = setInterval(() => { clock.value = Date.now(); }, 60_000);
  app.applyTheme();
  // 安卓侧滑返回：先关全局浮层（确认框/长按菜单/资产抽屉/同步日志/记灵感），
  // 桌面端没有原生调用，注册了也不会触发
  stopBackLayers = registerGlobalBackLayers();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (app.theme === 'system') app.applyTheme();
  });
});
onUnmounted(() => {
  stopUiZoom?.();
  stopUiZoom = null;
  stopShareInbox?.();
  stopBackLayers?.();
  stopBackLayers = null;
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
  if (subscribedSync) {
    sync.unsubscribe();
    subscribedSync = false;
  }
});
</script>
