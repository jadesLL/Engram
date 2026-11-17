<template>
  <!--
    面板懒加载占位（2026-11-17）：设置大类是异步组件，首次进入时如果 chunk 还在路上，
    右侧只剩 DomainHead，看起来就是「白屏一会儿」。骨架直接把分组卡的形状画出来，
    让标题下面立刻有内容骨架，而不是空白；chunk 到达后 Vue 用真实面板替换它。
    只画卡片形状，不带 anchor / 折叠按钮：它不能参与左栏 scrollspy 与折叠持久化。
  -->
  <section
    class="settings-panel settings-native settings-panel-skeleton"
    aria-busy="true"
    aria-label="正在加载设置面板"
  >
    <div v-for="index in count" :key="index" class="settings-group skeleton-group" aria-hidden="true">
      <div class="group-card">
        <div class="skeleton-head">
          <span class="skeleton-line title" />
          <span class="skeleton-line hint" />
        </div>
        <div class="skeleton-body">
          <span class="skeleton-line" />
          <span class="skeleton-line short" />
          <span class="skeleton-line" />
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * 设置面板的加载骨架。
 *
 * 用途：`defineAsyncComponent({ loadingComponent: SettingsPanelSkeleton, delay: 0 })`。
 * 默认的异步组件在 chunk 到达前渲染空注释节点——第一次进「Agent 与自动化」时
 * 深链/冷缓存会让右侧卡片区空白 1~3 秒（用户报的「先要白一会才能显示内容」）。
 * 骨架卡片与真实分组卡共用 .settings-group / .group-card 尺寸，加载完成后不会跳版。
 */
withDefaults(defineProps<{ count?: number }>(), { count: 2 });
</script>

<style scoped>
.settings-panel-skeleton {
  width: 100%;
}
.skeleton-head {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 22px 12px;
}
.skeleton-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 22px 18px;
}
.skeleton-line {
  height: 12px;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--bg-secondary), var(--border), var(--bg-secondary));
  background-size: 200% 100%;
  animation: settings-skeleton 1.2s ease-in-out infinite;
}
.skeleton-line.title {
  width: 30%;
  height: 15px;
}
.skeleton-line.hint {
  width: 52%;
}
.skeleton-line.short {
  width: 58%;
}
@keyframes settings-skeleton {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .skeleton-line {
    animation: none;
  }
}
</style>
