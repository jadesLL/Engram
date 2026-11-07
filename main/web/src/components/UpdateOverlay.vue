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
import { notify } from '../lib/notify';

const visible = ref(false);
const version = ref('');
let offState: (() => void) | null = null;

/**
 * 自动更新失败一次后主进程会暂停该版本的自动更新（lib/update-failure.js）并弹系统通知；
 * 应用在前台时系统通知容易被忽略，这里再补一条应用内提示。按版本去重：同一个版本的暂停
 * 只提示一次（设置页有常驻横幅 + 「重试自动更新」按钮）。
 */
const NOTIFIED_KEY = 'engram.autoUpdateFailureNotified';
function notifiedVersion(): string {
  try {
    return localStorage.getItem(NOTIFIED_KEY) || '';
  } catch {
    return '';
  }
}
function markNotified(v: string) {
  try {
    localStorage.setItem(NOTIFIED_KEY, v);
  } catch {
    /* 隐私模式/存储禁用：提示照常弹，只是可能重复 */
  }
}
function promptBlocked(s: any) {
  const blocked = String(s?.blockedVersion || '').trim();
  if (!blocked || notifiedVersion() === blocked) return;
  markNotified(blocked);
  const reason = String(s?.blockedReason || s?.error || '').trim();
  notify.error(
    `v${blocked} 自动更新失败${reason ? `：${reason}` : ''}。已暂停该版本的自动更新，本版本不会再自动重试；可在 设置 → 版本与更新 手动更新或重试。`,
  );
}

function apply(s: any) {
  visible.value = s?.phase === 'installing';
  if (s?.latestVersion) version.value = s.latestVersion;
  promptBlocked(s);
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
  /* 让开系统栏：卡片是居中的，但小屏 + 大字体会把它顶到状态栏/导航栏下（桌面端 --safe-* 为 0） */
  padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);
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
  border-radius: 8px;
  background: var(--card-bg);
  box-shadow: var(--shadow-dialog);
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
