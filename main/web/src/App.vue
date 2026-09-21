<template>
  <div v-if="isDesktop" class="win-titlebar">
    <span class="win-titlebar-logo">
      <svg viewBox="0 0 100 100" width="13" height="13" aria-hidden="true">
        <defs>
          <linearGradient id="engram-orbit-titlebar" gradientUnits="userSpaceOnUse" x1="24" y1="76" x2="76" y2="22">
            <stop offset="0" stop-color="#22D3EE" />
            <stop offset="1" stop-color="#4D8AFF" />
          </linearGradient>
          <linearGradient id="engram-core-titlebar" gradientUnits="userSpaceOnUse" x1="39" y1="39" x2="61" y2="61">
            <stop offset="0" stop-color="#4D8AFF" />
            <stop offset="1" stop-color="#245BDB" />
          </linearGradient>
        </defs>
        <ellipse cx="50" cy="50" rx="36" ry="15.5" fill="none" stroke="url(#engram-orbit-titlebar)" stroke-width="8.5" transform="rotate(-28 50 50)" />
        <circle cx="74" cy="28.5" r="5" fill="#22D3EE" />
        <circle cx="50" cy="50" r="11" fill="url(#engram-core-titlebar)" />
      </svg>
    </span>
    <span class="win-titlebar-name">Engram</span>
  </div>
  <router-view />
  <AssetDrawer />
  <ToastHost />
  <ConfirmHost />
  <UpdateOverlay />
  <AppTooltip />
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { useAppStore } from './stores/app';
import ToastHost from './components/ui/ToastHost.vue';
import ConfirmHost from './components/ui/ConfirmHost.vue';
import AppTooltip from './components/ui/AppTooltip.vue';
import UpdateOverlay from './components/UpdateOverlay.vue';
import AssetDrawer from './components/AssetDrawer.vue';
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
