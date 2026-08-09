<template>
  <router-view />
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { useAppStore } from './stores/app';

const app = useAppStore();
onMounted(() => {
  app.applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (app.theme === 'system') app.applyTheme();
  });
});
</script>
