<template>
  <router-view />
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

const app = useAppStore();
onMounted(() => {
  app.applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (app.theme === 'system') app.applyTheme();
  });
});
</script>
