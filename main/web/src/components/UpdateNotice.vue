<template>
  <div v-if="visible" ref="noticeEl" class="update-notice">
    <button
      type="button"
      class="update-notice-trigger"
      :aria-expanded="panelOpen"
      aria-controls="update-notice-panel"
      @click="panelOpen = !panelOpen"
    >
      <Icon name="ai" :size="16" />
      <span>{{ triggerLabel }}</span>
      <span class="update-notice-dot" aria-hidden="true" />
      <Icon name="chevron-down" :size="13" class="update-notice-chevron" />
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
      <div class="update-notice-foot">
        <button type="button" class="update-notice-later" @click="snooze">稍后提醒</button>
        <button type="button" class="update-notice-go" @click="goToUpdate">{{ sourceMode ? '前往更新' : '查看更新' }}</button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useUpdateStore } from '../stores/update';
import Icon from './Icon.vue';

interface SourceUpdateState {
  phase?: string;
  behind?: number;
  remoteCommit?: string;
  localCommit?: string;
  changes?: string[];
  checkedAt?: number | null;
}

const emit = defineEmits<{ change: [visible: boolean, sourceHasUpdate: boolean] }>();
const router = useRouter();
const updateStore = useUpdateStore();
const noticeEl = ref<HTMLElement | null>(null);
const panelOpen = ref(false);
const sourceMode = ref(false);
const sourceState = ref<SourceUpdateState>({});
const snoozedKey = ref(sessionStorage.getItem('updateNoticeSnoozedKey') || '');
let openedKey = '';
let offSourceState: (() => void) | null = null;

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
watch([visible, sourceHasUpdate], ([show, source]) => emit('change', show, source), { immediate: true });

function snooze() {
  snoozedKey.value = noticeKey.value;
  sessionStorage.setItem('updateNoticeSnoozedKey', snoozedKey.value);
  panelOpen.value = false;
}

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
    sourceMode.value = Boolean(env && !env.packaged && env.platform === 'win32');
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
  offSourceState?.();
});
</script>

<style scoped>
.update-notice { position: fixed; z-index: var(--z-popup); top: calc(var(--win-titlebar-h, 0px) + 11px); right: 22px; }
.update-notice-trigger { height: 34px; display: inline-flex; align-items: center; gap: 7px; padding: 0 10px; border: 1px solid var(--accent); border-radius: 8px; background: var(--accent-soft); color: var(--accent); font-size: 12px; font-weight: 600; white-space: nowrap; box-shadow: var(--shadow-raised); }
.update-notice-trigger:hover { background: var(--card-bg); }
.update-notice-trigger:focus-visible, .update-notice-close:focus-visible, .update-notice-later:focus-visible, .update-notice-go:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.update-notice-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--danger); }
.update-notice-chevron { transition: transform 150ms ease; }
.update-notice-trigger[aria-expanded="true"] .update-notice-chevron { transform: rotate(180deg); }
.update-notice-panel { position: absolute; top: 44px; right: 0; width: 364px; max-width: calc(100vw - 28px); border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--card-bg); box-shadow: var(--shadow-dialog); overflow: hidden; }
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
.update-notice-foot { display: flex; justify-content: space-between; gap: 8px; padding: 11px 18px; border-top: 1px solid var(--border); background: var(--bg-secondary); }
.update-notice-foot button { border-radius: 6px; padding: 6px 10px; font-size: 12px; font-weight: 600; }
.update-notice-later { color: var(--text-secondary); background: var(--card-bg); border: 1px solid var(--border-strong); }
.update-notice-later:hover { color: var(--text); background: var(--bg-hover); }
.update-notice-go { color: var(--on-accent); background: var(--accent); border: 1px solid var(--accent); }
.update-notice-go:hover { background: var(--accent-hover); }
@media (max-width: 768px) {
  .update-notice { top: calc(var(--win-titlebar-h, 0px) + 8px); right: 10px; }
  .update-notice-trigger { height: 32px; max-width: min(190px, calc(100vw - 20px)); font-size: 11px; }
  .update-notice-trigger span:not(.update-notice-dot) { overflow: hidden; text-overflow: ellipsis; }
  .update-notice-panel { top: 41px; width: min(350px, calc(100vw - 20px)); }
}
</style>
