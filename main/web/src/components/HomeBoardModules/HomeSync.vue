<template>
  <!-- 多端同步状态：配置过同步时显示状态胶囊；没配置时给一条「去配置」的空态，不留空卡 -->
  <div class="sync-slot">
    <SyncHomeStatus v-if="sync.configured" />
    <div v-else class="sync-empty">
      <p class="hb-empty">还没配置多端同步。</p>
      <button class="btn small" type="button" @click="goSettings">去配置同步</button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 同步状态模块（2026-10-05 首页看板化后新增的外壳）。
 *
 * 原来状态条直接挂在问候头右侧，SyncHomeStatus 内部「没配置就整块不渲染」就够了；
 * 现在它是一块可增删的模块，「什么都不渲染」会变成一张只剩标题的空卡，所以这里用
 * 同步 store 的 configured 判定：有同步给状态条，没有就给一条指向设置页的空态。
 * 订阅由 SyncHomeStatus 自己拉起（subscribe/unsubscribe 在它的生命周期里）。
 */
import { useRouter } from 'vue-router';
import SyncHomeStatus from '../SyncHomeStatus.vue';
import { useSyncStore } from '../../stores/sync';

const router = useRouter();
const sync = useSyncStore();

function goSettings() {
  router.push('/settings?section=sync');
}
</script>

<style scoped>
.sync-slot { min-width: 0; }
/* 卡片里状态条不再需要它自带的上外边距（那是当年挤在问候头下面时留的） */
.sync-slot :deep(.sync-pill) { margin: 0; }
.sync-empty { display: flex; flex-direction: column; align-items: center; gap: 4px; padding-bottom: 8px; }
.sync-empty .hb-empty { padding-bottom: 0; }
</style>
