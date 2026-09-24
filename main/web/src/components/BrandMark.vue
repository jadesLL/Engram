<template>
  <img
    class="brand-mark"
    :src="src"
    :width="size"
    :height="size"
    :alt="alt"
    :aria-hidden="alt ? undefined : 'true'"
    draggable="false"
  />
</template>

<script setup lang="ts">
// 品牌标志在界面内的唯一渲染入口。
// 几何与配色全部来自 main/scripts/gen-brand-icons.cjs 生成的两份静态 SVG（亮色/暗色），
// 本组件只按当前主题切换文件，界面里不再内联任何轨道图形——避免同一图形被再写一遍、各写各的。
import { computed } from 'vue';
import { useAppStore } from '../stores/app';

const props = withDefaults(
  defineProps<{
    /** 边长（像素，正方形） */
    size?: number;
    /** true=盒装图标（圆角底 + 描边）；false=透明标志（无底，用于大尺寸装饰位） */
    plated?: boolean;
    /** 无障碍文本；留空表示纯装饰（aria-hidden） */
    alt?: string;
  }>(),
  { size: 24, plated: true, alt: '' },
);

const app = useAppStore();
const src = computed(() => `/brand/${props.plated ? 'icon' : 'mark'}-${app.dark ? 'dark' : 'light'}.svg`);
</script>

<style scoped>
.brand-mark {
  display: block;
  flex-shrink: 0;
  -webkit-user-drag: none;
}
</style>
