<template>
  <span
    class="app-skeleton"
    :class="variant === 'block' ? 'sk-block' : 'sk-line'"
    :style="{ width: width || undefined, height: height || undefined }"
    aria-hidden="true"
  />
</template>

<script setup lang="ts">
/**
 * 通用骨架占位（2026-11 加载态）：一行（.sk-line）或一块（.sk-block），宽高由调用方给。
 * 微光动画与底色来自 main.css 的全局工具类，和设置面板骨架（SettingsPanelSkeleton）
 * 是同一套语言——暖纸底 + 暖色微光，全站不再出现页面级转圈。
 * 用途：收集箱列表、任务看板、图谱画布、编辑器页面的页面级加载态。
 */
withDefaults(defineProps<{
  /** line=一行文字高度；block=一块面板/卡片 */
  variant?: 'line' | 'block';
  width?: string;
  height?: string;
}>(), { variant: 'line', width: '', height: '' });
</script>

<style scoped>
.app-skeleton { display: block; }
</style>
