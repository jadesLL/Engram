<template>
  <SettingsGroup class="settings-native" anchor="app-version" title="版本信息" hint="当前版本、提交身份与更新" flush>
    <ul class="value-list">
      <li class="value-row">
        <span class="value-label">版本</span>
        <span class="value-text">v{{ APP_VERSION }}</span>
      </li>
      <li class="value-row">
        <span class="value-label">提交</span>
        <span class="value-text">{{ commitText }}</span>
      </li>
      <li class="value-row">
        <span class="value-label">{{ dateLabel }}</span>
        <span class="value-text">{{ dateText }}</span>
      </li>
      <li class="value-row">
        <span class="value-label">运行形态</span>
        <span class="value-text is-muted">{{ runtimeForm }}</span>
      </li>
    </ul>

    <!-- 本机软件更新：用户 2026-11-18 要求「版本信息这里也要能更新」。
         各运行形态的更新通道不同：桌面源码 / 安装包直接在卡片里检查并更新，
         预构建安装、Docker 服务端与安卓端跳到各自的更新分组，避免两处各写一套完整流程。 -->
    <div class="setting-row">
      <div class="setting-copy">
        <strong>更新本机软件</strong>
        <span>{{ updateHint }}</span>
      </div>
      <div class="setting-actions">
        <span v-if="updateStatus" class="setting-value" :class="updateStatusTone">{{ updateStatus }}</span>
        <button
          class="btn"
          :class="{ primary: updatePrimary }"
          type="button"
          :disabled="updateBusy"
          @click="runUpdateAction"
        >
          <AppSpinner v-if="updateBusy" :size="11" />
          <template v-else>{{ updateActionLabel }}</template>
        </button>
      </div>
    </div>
    <div v-if="downloadPercent !== null" class="update-progress">
      <div class="update-progress-bar" :style="{ width: downloadPercent + '%' }" />
    </div>
    <p v-if="updateError" class="setting-message err">{{ updateError }}</p>
    <p v-else-if="updateNote" class="setting-message">{{ updateNote }}</p>

    <p v-if="versionNote" class="setting-note">{{ versionNote }}</p>
  </SettingsGroup>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../../api';
import SettingsGroup from './SettingsGroup.vue';
import AppSpinner from '../ui/AppSpinner.vue';
import { APP_VERSION } from '../../version';
import { formatVersionHint, type GitIdentity } from '../../lib/buildLabel';
import {
  applyDesktopInstallerUpdate,
  applySourceUpdate,
  friendlyApplyError,
} from '../../lib/applyUpdate';
import { useAppUpdateStore } from '../../stores/appUpdate';
import { useRuntimeCapabilities } from '../../lib/capabilities';

/**
 * 「本机应用 → 版本信息」分组。
 * 2026-09-28 从 AccountPanel 的「连接与版本」拆出（方案 A）：版本号属于"这台机器上跑的是哪一版"，
 * 放进「本机应用」；同一个分组里的「连接通道」留在「账户与访问」。
 *
 * 提交身份两个来源：桌面源码模式由主进程经 IPC 给出（含提交日期/脏标记），
 * Docker 镜像与浏览器访问由服务端 /api/update/state 给出（镜像内烤入 /app/GIT_SHA）。
 * 都拿不到时（安装包形态、无 git 的部署）退回纯版本号。
 *
 * 2026-11 第二轮：成对信息改用 value-list（版本 / 提交 / 日期 / 运行形态），
 * 空值统一写「—」；只保留一条真正需要解释的备注（预构建安装、源码模式读不到提交号）。
 *
 * 2026-11-18：用户要求在版本信息这个位置也能更新本机软件。这里按运行形态给一个动作：
 *  - 桌面源码模式：检查远端 → 「更新并重启」（增量拉源码 + 重建）；
 *  - 桌面安装包：检查 Release → 「下载并安装」（静默安装后重启）；
 *  - 预构建安装 / Docker 服务端 / 浏览器访问：跳「版本与更新」对应分组（那边有完整流程）；
 *  - 安卓端：复用 appUpdate store 的检查 / 下载 / 安装三步。
 * 与「版本与更新」共用同一套 applyUpdate 实现，不另写一套下载 / 安装逻辑。
 */
const { capabilities, loaded: capabilitiesLoaded, load: loadCapabilities } = useRuntimeCapabilities();
const router = useRouter();
const appUpdate = useAppUpdateStore();

const desktopEnv = ref<GitIdentity | null>(null);
const serverCommit = ref('');
const identity = computed<GitIdentity>(() => {
  const commit = desktopEnv.value?.commit || serverCommit.value;
  if (!commit) return { commit: '' };
  return {
    commit,
    commitDate: desktopEnv.value?.commitDate || '',
    dirty: desktopEnv.value?.dirty,
  };
});

/** 提交号：源码模式工作区有未提交改动时标出来（与版本徽标同一套语义） */
const commitText = computed(() => {
  const commit = identity.value.commit;
  if (!commit) return '—';
  return identity.value.dirty ? `${commit} · 有未提交改动` : commit;
});

/** 日期：预构建包清单给的是打包时间（builtAt），git 检出给的是提交日期，别混为一谈 */
const dateLabel = computed(() => (desktopEnv.value?.prebuilt ? '构建时间' : '提交日期'));
const dateText = computed(() => identity.value.commitDate || '—');

/** 运行形态：这台机器上是哪种跑法（桌面三种形态 / 浏览器访问 / Android / 服务器部署） */
const runtimeForm = computed(() => {
  const env = desktopEnv.value;
  if (env) {
    if (env.packaged) return '桌面端 · 安装包';
    if (env.prebuilt) return '桌面端 · 预构建安装';
    return '桌面端 · 源码模式';
  }
  if (!capabilitiesLoaded.value) return '—';
  switch (capabilities.value.runtime) {
    case 'desktop':
      return '桌面端 · 浏览器访问';
    case 'android-local':
      return 'Android 应用';
    default:
      return '服务器部署';
  }
});

/**
 * 备注只留两句必要的：预构建安装不含 Git（应用内更新方式不同）、
 * 源码模式却读不到提交号（Git 不可用或不在检出目录——否则用户只看到一个光秃秃的版本号）。
 */
const versionNote = computed(() => {
  const env = desktopEnv.value;
  if (env?.prebuilt) return formatVersionHint({ prebuilt: true, commit: identity.value.commit });
  if (env?.packaged === false && !identity.value.commit) {
    return formatVersionHint({ sourceMode: true, commit: '' });
  }
  return '';
});

/* ---------- 本机软件更新 ---------- */
type UpdateMode = 'source' | 'installer' | 'prebuilt' | 'android' | 'server' | 'browser' | 'unknown';

const updateMode = ref<UpdateMode>('unknown');
const updateChecking = ref(false);
const updateApplying = ref(false);
const updateResult = ref<any>(null);
const updateError = ref('');
const updateNote = ref('');
const downloadPercent = ref<number | null>(null);

const updateBusy = computed(() => {
  if (updateChecking.value || updateApplying.value) return true;
  if (updateMode.value === 'android') return appUpdate.running;
  return false;
});

/** 桌面源码 / 安装包在卡片里能直接完成更新，是主操作；其余形态只是跳转到更新分组 */
const updatePrimary = computed(() => {
  if (updateMode.value === 'source') return Boolean(updateResult.value?.ok && !updateResult.value.upToDate);
  if (updateMode.value === 'installer') return Boolean(updateResult.value?.ok && updateResult.value.hasUpdate);
  if (updateMode.value === 'android') return appUpdate.hasUpdate || appUpdate.installPending;
  return false;
});

const updateHint = computed(() => {
  switch (updateMode.value) {
    case 'source':
      return '源码模式：增量拉取远端源码并重新构建，完成后应用自动重启，数据不受影响。';
    case 'installer':
      return '安装包模式：从 Release 检查并下载新版安装包，静默安装后自动重启。';
    case 'prebuilt':
      return '预构建安装不含 Git：请用新版安装器覆盖安装，知识库数据保留。';
    case 'android':
      return '手机只能靠安装包升级：检查 Release 后下载，再点「安装更新」。';
    case 'browser':
      return '浏览器访问桌面本地服务：更新入口在「版本与更新 → 桌面端更新」。';
    case 'server':
      return '服务器部署：更新需要重建容器，到「版本与更新 → 服务器更新」执行。';
    default:
      return '正在识别运行形态…';
  }
});

/** 行尾状态：与更新分组同一套口径（已是最新 / 有新版 / 落后提交 / 待安装） */
const updateStatus = computed(() => {
  if (updateMode.value === 'android') {
    const info = appUpdate.info;
    if (info.phase === 'downloading') return info.percent !== null ? `下载 ${info.percent}%` : '下载中';
    if (info.phase === 'checking') return '检查中';
    if (info.ready) return `待安装${info.latestVersion ? ' v' + info.latestVersion : ''}`;
    if (info.hasUpdate) return `有新版${info.latestVersion ? ' v' + info.latestVersion : ''}`;
    if (info.phase === 'error') return '检查失败';
    if (appUpdate.loaded) return '已是最新';
    return '';
  }
  const result = updateResult.value;
  if (!result?.ok) return '';
  if (updateMode.value === 'source') {
    return result.upToDate ? '已是最新' : `落后 ${result.behind ?? 0} 个提交`;
  }
  if (updateMode.value === 'installer') {
    return result.hasUpdate
      ? `有新版${result.latestVersion ? ' v' + result.latestVersion : ''}`
      : '已是最新';
  }
  return '';
});

const updateStatusTone = computed(() => {
  if (updateStatus.value === '已是最新') return 'tone-ok';
  if (updateStatus.value && updateStatus.value !== '检查中' && updateStatus.value !== '下载中') return 'tone-warn';
  return '';
});

const updateActionLabel = computed(() => {
  if (updateMode.value === 'android') {
    if (appUpdate.running) return '处理中…';
    if (appUpdate.installPending) return '安装更新';
    if (appUpdate.hasUpdate) return '下载更新';
    return '检查更新';
  }
  if (updateMode.value === 'source') {
    if (updateChecking.value) return '检查中…';
    if (updateApplying.value) return '更新中…';
    if (updateResult.value?.ok && !updateResult.value.upToDate) return '更新并重启';
    return '检查更新';
  }
  if (updateMode.value === 'installer') {
    if (updateChecking.value) return '检查中…';
    if (updateApplying.value) return '下载中…';
    if (updateResult.value?.ok && updateResult.value.hasUpdate) return '下载并安装';
    return '检查更新';
  }
  if (updateMode.value === 'prebuilt') return '打开更新设置';
  if (updateMode.value === 'browser') return '打开桌面端更新';
  if (updateMode.value === 'server') return '打开服务器更新';
  return '检查更新';
});

function desktopApi(): any {
  return (window as any).wikiDesktop;
}

function clearUpdateFeedback(): void {
  updateError.value = '';
  updateNote.value = '';
  downloadPercent.value = null;
}

async function checkSource(): Promise<void> {
  const wd = desktopApi();
  if (!wd?.desktopSourceUpdateCheck) {
    updateError.value = '当前桌面端壳过旧，不支持源码更新，请先更新一次桌面端再试。';
    return;
  }
  updateChecking.value = true;
  clearUpdateFeedback();
  try {
    const result = await wd.desktopSourceUpdateCheck();
    updateResult.value = result;
    if (!result?.ok) updateError.value = friendlyApplyError(result?.error || '检查失败');
  } catch (error: any) {
    updateResult.value = null;
    updateError.value = error?.message || '检查失败';
  } finally {
    updateChecking.value = false;
  }
}

async function checkInstaller(): Promise<void> {
  const wd = desktopApi();
  if (!wd?.desktopUpdateCheck) {
    updateError.value = '当前桌面端壳过旧，不支持应用内更新，请到仓库 Release 页手动下载最新安装包覆盖安装。';
    return;
  }
  updateChecking.value = true;
  clearUpdateFeedback();
  try {
    const result = await wd.desktopUpdateCheck();
    updateResult.value = result;
    if (!result?.ok) updateError.value = friendlyApplyError(result?.error || '检查失败');
  } catch (error: any) {
    updateResult.value = null;
    updateError.value = error?.message || '检查失败';
  } finally {
    updateChecking.value = false;
  }
}

async function applySource(): Promise<void> {
  updateApplying.value = true;
  clearUpdateFeedback();
  updateNote.value = '正在增量拉取源码并重新构建，完成后应用会自动重启。';
  const result = await applySourceUpdate();
  if (!result.ok) {
    updateApplying.value = false;
    updateNote.value = '';
    updateError.value = friendlyApplyError(result.error);
  }
}

async function applyInstaller(): Promise<void> {
  updateApplying.value = true;
  clearUpdateFeedback();
  updateNote.value = '正在下载安装包…';
  const result = await applyDesktopInstallerUpdate({
    check: updateResult.value,
    onProgress: (percent) => {
      downloadPercent.value = percent;
    },
    onInstalling: () => {
      updateNote.value = '正在静默安装，应用即将自动重启，请勿关闭。';
    },
  });
  if (!result.ok) {
    updateApplying.value = false;
    downloadPercent.value = null;
    updateNote.value = '';
    updateError.value = friendlyApplyError(result.error);
  } else if (result.skipped) {
    updateApplying.value = false;
    updateNote.value = '已经是最新版本，无需更新。';
  }
}

async function applyAndroid(): Promise<void> {
  if (appUpdate.installPending) {
    const result = await appUpdate.install();
    if (!result.ok) updateError.value = result.error || '无法调起系统安装器';
    else updateNote.value = '已调起系统安装器，按提示完成安装。';
    return;
  }
  if (appUpdate.hasUpdate) {
    clearUpdateFeedback();
    await appUpdate.download();
    updateNote.value = appUpdate.installPending
      ? '下载完成，点「安装更新」完成升级。'
      : '已开始下载，完成后点「安装更新」。';
    return;
  }
  clearUpdateFeedback();
  await appUpdate.check(true);
  if (appUpdate.info.phase === 'error') updateError.value = appUpdate.info.error || '检查更新失败';
  else if (!appUpdate.hasUpdate) updateNote.value = '当前已是最新版本。';
}

/** 预构建 / 服务端 / 浏览器形态：跳到「版本与更新」里对应的更新分组 */
async function openUpdateSettings(): Promise<void> {
  const anchor = updateMode.value === 'android'
    ? 'panel-update-android'
    : updateMode.value === 'server'
      ? 'panel-update-server'
      : 'panel-update-desktop';
  await router.push({ path: '/settings', query: { section: 'update', anchor } });
  window.dispatchEvent(new CustomEvent('engram:settings-target', { detail: { anchor } }));
}

async function runUpdateAction(): Promise<void> {
  if (updateBusy.value) return;
  switch (updateMode.value) {
    case 'source':
      if (updateResult.value?.ok && !updateResult.value.upToDate) await applySource();
      else await checkSource();
      return;
    case 'installer':
      if (updateResult.value?.ok && updateResult.value.hasUpdate) await applyInstaller();
      else await checkInstaller();
      return;
    case 'android':
      await applyAndroid();
      return;
    case 'prebuilt':
    case 'browser':
    case 'server':
      await openUpdateSettings();
      return;
    default:
      await checkSource();
  }
}

onMounted(async () => {
  await loadCapabilities();
  // 桌面端源码模式：主进程经 IPC 给提交身份
  const wd = desktopApi();
  if (wd?.getDesktopEnv) {
    wd.getDesktopEnv()
      .then((env: GitIdentity | null) => {
        desktopEnv.value = env;
        if (env?.packaged) updateMode.value = 'installer';
        else if (env?.prebuilt) updateMode.value = 'prebuilt';
        else if (env?.platform === 'win32') updateMode.value = 'source';
        else updateMode.value = 'browser';
      })
      .catch(() => {
        /* 主进程未就绪时忽略，版本号照常显示 */
        updateMode.value = capabilities.value.runtime === 'android-local' ? 'android' : 'browser';
      });
  } else if (capabilities.value.runtime === 'android-local') {
    updateMode.value = 'android';
    void appUpdate.refresh();
  } else if (capabilities.value.runtime === 'desktop') {
    updateMode.value = 'browser';
  } else {
    updateMode.value = 'server';
  }
  // Docker 镜像 / 浏览器访问：服务端读 /app/GIT_SHA 或源码检出的 .git
  if (capabilities.value.features.serverUpdate) {
    api
      .get('/api/update/state')
      .then((res) => {
        serverCommit.value = String(res.data?.commit || '');
      })
      .catch(() => {
        /* 未登录或接口不可用时保持纯版本号 */
      });
  }
});
</script>
