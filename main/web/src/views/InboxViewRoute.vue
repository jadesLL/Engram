<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import InboxView from './InboxView.vue';
import MobileInbox from '../components/MobileInbox.vue';

/**
 * 收集箱路由外壳：窄屏（Android WebView / 手机浏览器）走「清仓台」卡片视图，
 * 宽屏保持原来的列表工作台。两套界面共用同一个收集箱 store，切换宽度不丢数据。
 */
const media = typeof window !== 'undefined'
  ? window.matchMedia('(max-width: 768px)')
  : null;
const mobile = ref(media ? media.matches : false);

function onChange(event: MediaQueryListEvent): void {
  mobile.value = event.matches;
}

onMounted(() => { media?.addEventListener('change', onChange); });
onBeforeUnmount(() => { media?.removeEventListener('change', onChange); });
</script>

<template>
  <MobileInbox v-if="mobile" />
  <InboxView v-else />
</template>
