<template>
  <!-- 桌面端（有 wikiDesktop 桥）：入口整块 Teleport 进标题栏「Engram」右侧的挂载点，跟着窗口左上角走，
       任何分辨率都不会压住正文或对话抽屉按钮；Docker/浏览器端没有融合标题栏，disabled 后原地渲染（沿用右上角入口） -->
  <Teleport to="#win-titlebar-slot" :disabled="!inTitlebar">
    <div
      v-if="visible"
      ref="noticeEl"
      class="update-notice"
      :class="{ 'update-notice-titlebar': inTitlebar }"
      @mouseenter="onNoticeEnter"
      @mouseleave="onNoticeLeave"
    >
      <button
        type="button"
        class="update-notice-trigger"
        :aria-expanded="panelOpen"
        aria-controls="update-notice-panel"
        @click="panelOpen = !panelOpen"
      >
        <!-- 标题栏里只写「更新」两个字：按钮本身就是「有更新」的提示，不再堆图标/圆点/箭头 -->
        <span v-if="inTitlebar">更新</span>
        <template v-else>
          <Icon name="ai" :size="16" />
          <span>{{ triggerLabel }}</span>
          <span class="update-notice-dot" aria-hidden="true" />
          <Icon name="chevron-down" :size="13" class="update-notice-chevron" />
        </template>
      </button>

      <section v-if="panelOpen" id="update-notice-panel" class="update-notice-panel" aria-label="更新内容">
        <div class="update-notice-head">
          <span class="update-notice-symbol"><Icon name="ai" :size="19" /></span>
          <div class="update-notice-heading">
            <strong>{{ title }}</strong>
            <span>{{ subtitle }}</span>
          </div>
          <button type="button" class="update-notice-close" aria-label="关闭更新内容" @click="panelOpen = false">
            <Icon name="x" :size="15" />
          </button>
        </div>
        <div class="update-notice-checked"><span class="update-notice-ok" />已自动检查 · {{ checkedLabel }}</div>
        <div class="update-notice-body">
          <div class="update-notice-caption">本次更新内容</div>
          <ul>
            <li v-for="(change, index) in changes" :key="index">
              <span class="update-notice-check"><Icon name="check" :size="11" :stroke-width="2" /></span>
              <span>{{ change }}</span>
            </li>
          </ul>
        </div>
        <!-- 一键更新按下后就地显示进度：源码/安装包形态会随即重启应用，服务端形态会等服务恢复后自动刷新 -->
        <div v-if="applyPhase !== 'idle'" class="update-notice-progress" :class="{ failed: applyPhase === 'error' }">
          <div class="update-notice-progress-head">
            <span class="update-notice-progress-label">{{ progressLabel }}</span>
            <span v-if="applyPercent !== null" class="update-notice-progress-pct">{{ applyPercent }}%</span>
          </div>
          <div v-if="applyPercent !== null" class="update-notice-progress-bar">
            <i :style="{ width: applyPercent + '%' }" />
          </div>
          <div v-if="progressLines.length" class="update-notice-progress-log">
            <div v-for="(line, index) in progressLines" :key="index">{{ line }}</div>
          </div>
        </div>
        <div class="update-notice-foot">
          <div class="update-notice-foot-left">
            <button type="button" class="update-notice-later" :disabled="applying" @click="snooze">稍后提醒</button>
            <button type="button" class="update-notice-link" @click="goToUpdate">查看详情</button>
          </div>
          <button type="button" class="update-notice-go" :disabled="applying" @click="runUpdate">{{ applyLabel }}</button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useUpdateStore } from '../stores/update';
import {
  applyDesktopInstallerUpdate,
  applyServerUpdate,
  applySourceUpdate,
  friendlyApplyError,
  type ApplyResult,
} from '../lib/applyUpdate';
import Icon from './Icon.vue';

interface SourceUpdateState {
  phase?: string;
  behind?: number;
  remoteCommit?: string;
  localCommit?: string;
  changes?: string[];
  checkedAt?: number | null;
}

interface DesktopEnv {
  packaged?: boolean;
  platform?: string;
}

/** 更新动作的阶段：idle=未开始，running/waiting=进行中，done=已移交重启或刷新，error=失败 */
type ApplyPhase = 'idle' | 'running' | 'waiting' | 'done' | 'skipped' | 'error';

const emit = defineEmits<{ change: [visible: boolean, sourceHasUpdate: boolean] }>();
const router = useRouter();
const updateStore = useUpdateStore();
/**
 * 桌面端（App.vue 同款判定：有 wikiDesktop 桥就有融合标题栏）：入口渲染进标题栏 #win-titlebar-slot，
 * 变成「Engram」右侧一枚只写「更新」的小按钮；鼠标扫过即展开，点一下也能开合。
 */
const inTitlebar = Boolean((window as any).wikiDesktop);
const noticeEl = ref<HTMLElement | null>(null);
const panelOpen = ref(false);
const desktopEnv = ref<DesktopEnv | null>(null);
const sourceState = ref<SourceUpdateState>({});
const applyPhase = ref<ApplyPhase>('idle');
const applyLog = ref<string[]>([]);
const applyError = ref('');
const applyPercent = ref<number | null>(null);
const snoozedKey = ref(sessionStorage.getItem('updateNoticeSnoozedKey') || '');
let openedKey = '';
let offSourceState: (() => void) | null = null;
let hoverCloseTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 当前运行形态决定「立即更新」到底做什么：
 *   web = 浏览器访问（含 Docker 服务端）→ 请求服务端更新并等它重启；
 *   source = 桌面源码模式 → 主进程增量拉源码重建；
 *   installer = 桌面安装包形态 → 下载新 exe 静默安装。
 */
const shellKind = computed<'web' | 'source' | 'installer'>(() => {
  const env = desktopEnv.value;
  if (!env) return 'web';
  return env.packaged ? 'installer' : 'source';
});
/** 源码模式的检测由主进程做（git 提交号才有意义），且仅 Windows 桌面源码版走这条路 */
const sourceMode = computed(() => Boolean(desktopEnv.value && !desktopEnv.value.packaged && desktopEnv.value.platform === 'win32'));

const sourceHasUpdate = computed(() => sourceMode.value && sourceState.value.phase === 'behind' && Number(sourceState.value.behind) > 0);
const releaseHasUpdate = computed(() => !sourceMode.value && updateStore.hasNewVersion);
const hasUpdate = computed(() => sourceHasUpdate.value || releaseHasUpdate.value);
const noticeKey = computed(() => {
  if (sourceHasUpdate.value) return `source:${sourceState.value.remoteCommit || sourceState.value.behind}`;
  if (!releaseHasUpdate.value) return '';
  const result = updateStore.lastResult;
  return result ? `release:${result.imageTag || ''}:${result.releaseTag}:${result.latestVersion}:${result.digestMatch}` : '';
});
const visible = computed(() => hasUpdate.value && noticeKey.value !== snoozedKey.value);
const mainImageUpdate = computed(() => !sourceMode.value && updateStore.lastResult?.imageTag === 'main' && updateStore.lastResult?.digestMatch === false);

const triggerLabel = computed(() => {
  if (sourceMode.value) return `发现 ${sourceState.value.behind} 个新提交`;
  return mainImageUpdate.value ? '主分支有更新' : '发现新版本';
});
const title = computed(() => sourceMode.value ? '源码有新更新' : mainImageUpdate.value ? '主分支镜像有更新' : 'Engram 有新版本');
const subtitle = computed(() => {
  if (sourceMode.value) {
    const from = sourceState.value.localCommit;
    const to = sourceState.value.remoteCommit;
    return from && to ? `${from} → ${to} · ${sourceState.value.behind} 个新提交` : `远端领先 ${sourceState.value.behind} 个提交`;
  }
  const result = updateStore.lastResult;
  if (!result) return '';
  if (mainImageUpdate.value) return 'main 通道发现新镜像构建';
  return result.latestVersion
    ? `v${result.latestVersion} 已可更新 · 当前 v${result.currentVersion}`
    : '远端镜像发现新内容';
});

/* ===== 一键更新 ===== */
const applying = computed(() => applyPhase.value === 'running' || applyPhase.value === 'waiting');

const applyLabel = computed(() => {
  if (applyPhase.value === 'running') {
    if (shellKind.value === 'installer') return applyPercent.value === null ? '正在准备下载…' : `下载中 ${applyPercent.value}%`;
    return shellKind.value === 'source' ? '正在更新并重启…' : '正在更新…';
  }
  if (applyPhase.value === 'waiting') return '等待服务恢复…';
  if (applyPhase.value === 'done') return '更新进行中…';
  if (shellKind.value === 'source') return '立即更新并重启';
  if (shellKind.value === 'installer') return '立即下载并安装';
  return '立即更新';
});
const progressLabel = computed(() => {
  if (applyPhase.value === 'error') return '更新失败';
  if (applyPhase.value === 'skipped') return '已是最新版本';
  if (applyPhase.value === 'waiting') return '更新已提交，服务正在重启…';
  if (applyPhase.value === 'done') {
    return shellKind.value === 'web' ? '更新完成，页面即将自动刷新…' : '更新中，应用即将自动重启…';
  }
  return '正在更新…';
});
const progressLines = computed(() => {
  const lines = applyLog.value.slice(-4);
  if (applyError.value && !lines.some((line) => line.includes(applyError.value))) lines.push(applyError.value);
  return lines.slice(-4);
});

/**
 * 点一下就更新，不再二次确认（用户 2026-09-24 明确要求）：
 * 三种形态各自接手（源码重建重启 / 下载 exe 静默安装 / 服务端换镜像并重启），
 * 这里只负责把进度与失败原因显示出来。
 */
async function runUpdate() {
  if (applying.value) return;
  applyPhase.value = 'running';
  applyLog.value = [];
  applyError.value = '';
  applyPercent.value = null;
  const log = (line: string) => { applyLog.value = [...applyLog.value, line]; };
  let result: ApplyResult;
  if (shellKind.value === 'source') {
    log('增量拉取源码并重建（会弹出置顶进度窗口显示构建步骤）…');
    result = await applySourceUpdate();
  } else if (shellKind.value === 'installer') {
    result = await applyDesktopInstallerUpdate({
      log,
      onProgress: (percent) => { applyPercent.value = percent; },
      onInstalling: () => { applyPercent.value = null; },
    });
  } else {
    log('正在提交更新请求…');
    result = await applyServerUpdate({
      log,
      onWaiting: () => { applyPhase.value = 'waiting'; },
    });
  }
  if (result.ok) {
    applyPhase.value = result.skipped ? 'skipped' : 'done';
    if (result.skipped) log('已是最新版本，无需更新。');
    return;
  }
  applyPhase.value = 'error';
  applyError.value = friendlyApplyError(result.error);
  log(applyError.value);
}

/** Release 正文只作为纯文本显示，提取前几条内容；不渲染远端 Markdown/HTML。 */
function releaseSummary(notes: string): string[] {
  return notes.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(?:#{1,6}\s|```|---+$|\|\s*[-:]+|<)/.test(line))
    .map((line) => line.replace(/^[-*+]\s+|^\d+[.)]\s+/, '').replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`]/g, '').trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((line) => line.slice(0, 160));
}

const changes = computed(() => {
  if (sourceMode.value) {
    const items = Array.isArray(sourceState.value.changes) ? sourceState.value.changes : [];
    return items.length ? items.slice(0, 5).map((item) => String(item).slice(0, 160)) : ['远端已有新提交，可前往软件更新查看提交号并更新。'];
  }
  if (mainImageUpdate.value) return ['main 通道有新的镜像构建，可前往软件更新查看并升级。'];
  const items = releaseSummary(updateStore.lastResult?.releaseNotes || '');
  return items.length ? items : ['此版本尚未提供更新说明，可前往软件更新查看版本与更新方式。'];
});

const checkedLabel = computed(() => {
  const at = sourceMode.value ? sourceState.value.checkedAt : updateStore.checkedAt;
  if (!at || Date.now() - at < 60_000) return '刚刚';
  return new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
});

watch(noticeKey, (key) => {
  if (key && key !== snoozedKey.value && key !== openedKey) {
    openedKey = key;
    panelOpen.value = true;
  }
});
// 更新期间面板必须留在屏幕上：进度与失败原因都显示在这里
watch(applying, (now) => { if (now) panelOpen.value = true; });
watch([visible, sourceHasUpdate], ([show, source]) => emit('change', show, source), { immediate: true });

function snooze() {
  if (applying.value) return;
  snoozedKey.value = noticeKey.value;
  sessionStorage.setItem('updateNoticeSnoozedKey', snoozedKey.value);
  panelOpen.value = false;
}

/**
 * 标题栏入口：鼠标扫到按钮上就展开（移开约 0.26 秒后收起，给鼠标从按钮移进面板留出余量），
 * 点一下仍是开/关切换——触屏和「鼠标不悬停」的场景都能用。
 * 只在标题栏形态生效：Docker/浏览器端维持原来的「点开」行为，不改成扫一下就弹。
 */
function onNoticeEnter() {
  if (!inTitlebar) return;
  if (hoverCloseTimer) { clearTimeout(hoverCloseTimer); hoverCloseTimer = null; }
  panelOpen.value = true;
}
function onNoticeLeave() {
  if (!inTitlebar) return;
  if (hoverCloseTimer) clearTimeout(hoverCloseTimer);
  hoverCloseTimer = setTimeout(() => {
    hoverCloseTimer = null;
    // 更新进行中面板必须留着（进度/失败原因都在这里）
    if (!applying.value) panelOpen.value = false;
  }, 260);
}

/** 次级入口：跳设置页看完整更新信息（提交列表 / 更新日志 / 手动检查） */
async function goToUpdate() {
  panelOpen.value = false;
  const anchor = sourceMode.value || Boolean((window as any).wikiDesktop) ? 'panel-update-desktop' : 'panel-update-server';
  const alreadyInSettings = router.currentRoute.value.path === '/settings';
  await router.push({ path: '/settings', query: { section: 'connect', anchor } });
  if (alreadyInSettings) window.dispatchEvent(new CustomEvent('engram:settings-target', { detail: { anchor } }));
}

function onPointerDown(event: PointerEvent) {
  if (noticeEl.value && !noticeEl.value.contains(event.target as Node)) panelOpen.value = false;
}
function onKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape') panelOpen.value = false;
}

onMounted(async () => {
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('keydown', onKeyDown);
  const desktop = (window as any).wikiDesktop;
  if (!desktop?.getDesktopEnv) return;
  try {
    const env = await desktop.getDesktopEnv();
    desktopEnv.value = env || null;
    if (!sourceMode.value || !desktop.desktopSourceAutoState) return;
    if (desktop.onSourceState) offSourceState = desktop.onSourceState((state: SourceUpdateState) => { sourceState.value = state; });
    sourceState.value = await desktop.desktopSourceAutoState();
  } catch {
    // 桌面壳不可用时保留服务端检测结果。
  }
});
onUnmounted(() => {
  document.removeEventListener('pointerdown', onPointerDown);
  document.removeEventListener('keydown', onKeyDown);
  if (hoverCloseTimer) clearTimeout(hoverCloseTimer);
  offSourceState?.();
});
</script>

<style scoped>
.update-notice { position: fixed; z-index: var(--z-popup); top: calc(var(--win-titlebar-h, 0px) + 11px); right: 22px; }
.update-notice-trigger { height: 34px; display: inline-flex; align-items: center; gap: 7px; padding: 0 10px; border: 1px solid var(--accent); border-radius: 8px; background: var(--accent-soft); color: var(--accent); font-size: 12px; font-weight: 600; white-space: nowrap; box-shadow: var(--shadow-raised); }
.update-notice-trigger:hover { background: var(--card-bg); }
.update-notice-trigger:focus-visible, .update-notice-close:focus-visible, .update-notice-later:focus-visible, .update-notice-link:focus-visible, .update-notice-go:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.update-notice-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--danger); }
.update-notice-chevron { transition: transform 150ms ease; }
.update-notice-trigger[aria-expanded="true"] .update-notice-chevron { transform: rotate(180deg); }
.update-notice-panel { position: absolute; top: 44px; right: 0; width: 364px; max-width: calc(100vw - 28px); border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--card-bg); box-shadow: var(--shadow-dialog); overflow: hidden; }
/*
 * 桌面端标题栏形态：入口不再是浮在正文上的固定层，而是标题栏里紧跟应用名的一枚小按钮。
 * 面板锚在按钮下方（左对齐），层级随标题栏（--z-chrome）盖住正文与抽屉；no-drag 保证整条拖拽区里按钮和面板仍可点。
 */
.update-notice-titlebar { position: relative; top: auto; right: auto; z-index: auto; display: flex; align-items: center; -webkit-app-region: no-drag; }
.update-notice-titlebar .update-notice-trigger { height: 22px; gap: 0; padding: 0 9px; border-color: transparent; border-radius: var(--radius-control); font-size: 11.5px; box-shadow: none; -webkit-app-region: no-drag; }
.update-notice-titlebar .update-notice-trigger:hover { border-color: var(--accent); }
.update-notice-titlebar .update-notice-panel { top: calc(100% + 6px); left: 0; right: auto; -webkit-app-region: no-drag; }
.update-notice-head { display: flex; gap: 11px; align-items: flex-start; padding: 18px 18px 12px; }
.update-notice-symbol { flex: none; width: 34px; height: 34px; display: grid; place-items: center; color: var(--accent); background: var(--accent-soft); border-radius: 9px; }
.update-notice-heading { flex: 1; min-width: 0; display: grid; gap: 3px; }
.update-notice-heading strong { font-size: 14px; line-height: 1.4; }
.update-notice-heading span { color: var(--text-secondary); font-size: 11.5px; overflow-wrap: anywhere; }
.update-notice-close { flex: none; border: 0; background: none; color: var(--text-faint); border-radius: 5px; padding: 3px; display: grid; place-items: center; }
.update-notice-close:hover { background: var(--bg-hover); color: var(--text); }
.update-notice-checked { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); padding: 0 18px 13px; font-size: 11px; }
.update-notice-ok { width: 6px; height: 6px; border-radius: 50%; background: var(--success); }
.update-notice-body { border-top: 1px solid var(--border); padding: 13px 18px 15px; }
.update-notice-caption { color: var(--text-faint); font-size: 11px; font-weight: 600; margin-bottom: 9px; }
.update-notice-body ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 9px; max-height: 190px; overflow-y: auto; }
.update-notice-body li { display: flex; align-items: flex-start; gap: 8px; color: var(--text); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
.update-notice-check { flex: none; width: 16px; height: 16px; display: grid; place-items: center; margin-top: 1px; color: var(--success); background: var(--success-soft); border-radius: 5px; }
/* 一键更新进度块 */
.update-notice-progress { border-top: 1px solid var(--border); padding: 11px 18px 12px; }
.update-notice-progress-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.update-notice-progress-label { color: var(--text); font-size: 11.5px; font-weight: 600; }
.update-notice-progress-pct { color: var(--text-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
.update-notice-progress-bar { margin-top: 7px; height: 4px; border-radius: 999px; background: var(--bg-hover); overflow: hidden; }
.update-notice-progress-bar i { display: block; height: 100%; background: var(--accent); transition: width 200ms ease; }
.update-notice-progress-log { margin-top: 7px; max-height: 76px; overflow: hidden; color: var(--text-faint); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.update-notice-progress.failed .update-notice-progress-label { color: var(--danger); }
.update-notice-progress.failed .update-notice-progress-log { color: var(--danger); }
.update-notice-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 11px 18px; border-top: 1px solid var(--border); background: var(--bg-secondary); }
.update-notice-foot button { border-radius: 6px; padding: 6px 10px; font-size: 12px; font-weight: 600; }
.update-notice-foot button:disabled { opacity: 0.6; cursor: default; }
.update-notice-foot-left { display: flex; align-items: center; gap: 6px; }
.update-notice-later { color: var(--text-secondary); background: var(--card-bg); border: 1px solid var(--border-strong); }
.update-notice-later:hover:not(:disabled) { color: var(--text); background: var(--bg-hover); }
.update-notice-link { color: var(--accent); background: none; border: 1px solid transparent; }
.update-notice-link:hover { background: var(--accent-soft); }
.update-notice-go { color: var(--on-accent); background: var(--accent); border: 1px solid var(--accent); white-space: nowrap; }
.update-notice-go:hover:not(:disabled) { background: var(--accent-hover); }
@media (max-width: 768px) {
  .update-notice { top: calc(var(--win-titlebar-h, 0px) + 8px); right: 10px; }
  .update-notice-trigger { height: 32px; max-width: min(190px, calc(100vw - 20px)); font-size: 11px; }
  .update-notice-trigger span:not(.update-notice-dot) { overflow: hidden; text-overflow: ellipsis; }
  .update-notice-panel { top: 41px; width: min(350px, calc(100vw - 20px)); }
  .update-notice-foot { flex-direction: column; align-items: stretch; }
  .update-notice-foot-left { justify-content: space-between; }
}
</style>
