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
import { onMounted } from 'vue';
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

const app = useAppStore();
// 桌面端壳（有 wikiDesktop 桥）：启用标题栏融合条（logo + 应用名 + 系统窗口按钮）；
// Docker/Android 无此桥，不渲染也不加偏移
const isDesktop = Boolean((window as any).wikiDesktop);
onMounted(() => {
  loadRuntimeCapabilities().catch(() => {});
  if (isDesktop) document.documentElement.classList.add('desktop-frame');
  app.applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (app.theme === 'system') app.applyTheme();
  });
});
</script>
