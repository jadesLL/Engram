<template>
  <!-- 只负责「这一秒的时长」：把每秒心跳关在这个小组件里，父级转录不会因为秒表每秒重渲。
       放在文本流里（父级样式照常作用），起始时间非法时渲染空串。 -->
  <span>{{ text }}</span>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { formatDuration } from '../../lib/chatTime';

const props = defineProps<{ from?: string | number | null }>();

const now = ref(Date.now());
const timer = window.setInterval(() => { now.value = Date.now(); }, 1000);
onUnmounted(() => window.clearInterval(timer));

const started = computed(() => {
  const from = props.from;
  if (from === undefined || from === null || from === '') return NaN;
  return typeof from === 'number' ? from : Date.parse(String(from));
});

const text = computed(() => (
  Number.isFinite(started.value) ? formatDuration(Math.max(0, now.value - started.value)) : ''
));
</script>
