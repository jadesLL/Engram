<template>
  <Teleport to="body">
    <div v-if="visible" class="update-overlay">
      <div class="update-card">
        <AppSpinner :size="24" />
        <strong>正在更新 Engram</strong>
        <span>{{ version ? `正在安装 v${version}，应用即将自动重启…` : '正在安装更新，应用即将自动重启…' }}</span>
        <em>请勿关闭应用，整个过程通常只需数秒</em>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
// 自动更新静默安装前的全屏提示层：主进程状态机进入 installing 时显示，
// 随后应用退出静默安装并自动重启。仅在桌面端壳内（有 onUpdateState API）生效。
import { onMounted, onUnmounted, ref } from 'vue';
import AppSpinner from './ui/AppSpinner.vue';

const visible = ref(false);
const version = ref('');
let offState: (() => void) | null = null;

function apply(s: any) {
  visible.value = s?.phase === 'installing';
  if (s?.latestVersion) version.value = s.latestVersion;
}

onMounted(() => {
  const wd = (window as any).wikiDesktop;
  if (!wd?.onUpdateState) return;
  wd.desktopUpdateGetState?.().then((s: any) => apply(s));
  offState = wd.onUpdateState((s: any) => apply(s));
});
onUnmounted(() => {
  offState?.();
});
</script>

<style scoped>
.update-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 45%);
  backdrop-filter: blur(2px);
}

.update-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 28px 44px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--bg);
  box-shadow: 0 12px 40px rgb(0 0 0 / 25%);
  text-align: center;
}

.update-card strong {
  font-size: 15px;
  color: var(--text);
}

.update-card span {
  font-size: 13px;
  color: var(--text-secondary);
}

.update-card em {
  font-size: 11px;
  font-style: normal;
  color: var(--text-faint);
}
</style>
