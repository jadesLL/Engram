<template>
  <div v-if="isDesktop" class="win-titlebar">
    <span class="win-titlebar-logo">
      <BrandMark :size="20" />
    </span>
    <span class="win-titlebar-name">Engram</span>
    <!-- 更新入口挂载点：桌面端「更新」小按钮由 UpdateNotice Teleport 到这里（应用名右侧，永不与正文/抽屉重叠） -->
    <span id="win-titlebar-slot" class="win-titlebar-slot"></span>
  </div>
  <router-view />
  <AssetDrawer />
  <!-- 同步详情抽屉：与图片资产抽屉同一挂载方式（Teleport 到 body），设置页只留一个入口按钮 -->
  <SyncLogDrawer />
  <ToastHost />
  <ConfirmHost />
  <!-- 记灵感撰写框：正文进、标题由 Engram 拟（左下角「+」/Ctrl+N/欢迎页卡片共用） -->
  <IdeaComposer />
  <UpdateOverlay />
  <AppTooltip />
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useAppStore } from './stores/app';
import ToastHost from './components/ui/ToastHost.vue';
import ConfirmHost from './components/ui/ConfirmHost.vue';
import IdeaComposer from './components/ui/IdeaComposer.vue';
import AppTooltip from './components/ui/AppTooltip.vue';
import UpdateOverlay from './components/UpdateOverlay.vue';
import AssetDrawer from './components/AssetDrawer.vue';
import SyncLogDrawer from './components/SyncLogDrawer.vue';
import BrandMark from './components/BrandMark.vue';
import { loadRuntimeCapabilities } from './lib/capabilities';
import { registerGlobalBackLayers } from './lib/globalBackLayers';
import { installJoinLinkReceiver } from './lib/joinLink';
import { installShareInboxReceiver } from './lib/shareInbox';
import { api } from './api';
import { notify } from './lib/notify';
import {
  clearServerUpdatePending,
  evaluateServerUpdateOutcome,
  readServerUpdatePending,
  serverUpdateOutcomeText,
} from './lib/serverUpdateFeedback';

const app = useAppStore();
// 桌面端壳（有 wikiDesktop 桥）：启用标题栏融合条（logo + 应用名 + 系统窗口按钮）；
// Docker/Android 无此桥，不渲染也不加偏移
const isDesktop = Boolean((window as any).wikiDesktop);

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
onMounted(() => {
  loadRuntimeCapabilities().catch(() => {});
  // 上一次服务器更新是否成功（跨页面刷新结算，成功/回滚都在这里给提示）
  void settleServerUpdateFeedback();
  // 安卓：点别人发来的邀请链接（engram://join?…）打开应用时，把链接交给设置页的同步表单
  installJoinLinkReceiver();
  stopShareInbox = installShareInboxReceiver();
  if (isDesktop) document.documentElement.classList.add('desktop-frame');
  app.applyTheme();
  // 安卓侧滑返回：先关全局浮层（确认框/长按菜单/资产抽屉/同步日志/记灵感），
  // 桌面端没有原生调用，注册了也不会触发
  stopBackLayers = registerGlobalBackLayers();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (app.theme === 'system') app.applyTheme();
  });
});
onUnmounted(() => {
  stopShareInbox?.();
  stopBackLayers?.();
  stopBackLayers = null;
});
</script>
