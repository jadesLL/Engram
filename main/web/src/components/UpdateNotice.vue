<template>
  <!-- 桌面端（有 wikiDesktop 桥）：入口整块 Teleport 进标题栏「Engram」右侧的挂载点，跟着窗口左上角走，
       任何分辨率都不会压住正文或对话抽屉按钮；Docker/浏览器端没有融合标题栏，disabled 后原地渲染（沿用右上角入口） -->
  <Teleport to="#win-titlebar-slot" :disabled="!inTitlebar">
    <div
      v-if="hasUpdate"
      ref="noticeEl"
      class="update-notice"
      :class="{ 'update-notice-titlebar': inTitlebar }"
      @mouseenter="onNoticeEnter"
      @mouseleave="onNoticeLeave"
    >
      <!-- 入口只有一枚绿色更新图标：不再自动展开面板，鼠标扫到才弹出（点一下仍可开合，供触屏用） -->
      <button
        type="button"
        class="update-notice-trigger"
        :aria-expanded="panelOpen"
        aria-controls="update-notice-panel"
        :aria-label="triggerHint"
        @click="panelOpen = !panelOpen"
      >
        <Icon name="download" :size="inTitlebar ? 13 : 17" :stroke-width="2" />
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
          <!-- 按「更新 / 优化 / 修复」分组：只展示用户能看懂的条目，不显示提交标题、Merge 记录或平台影响标记 -->
          <div class="update-notice-groups">
            <div v-for="section in changeSections" :key="section.title" class="update-notice-group">
              <div class="update-notice-group-label">{{ section.title }}</div>
              <ul>
                <li v-for="(change, index) in section.items" :key="index">
                  <span class="update-notice-check"><Icon name="check" :size="11" :stroke-width="2" /></span>
                  <span>{{ change }}</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
        <!-- 一键更新按下后就地显示进度：源码/安装包形态会随即重启应用，服务端形态会等服务恢复后自动刷新。
             自动更新正在后台下载/安装时也常驻这一块：用户点右上角图标就能直接看到后台进度，
             不用再点一次「下载」去撞「已经在下载」的报错。 -->
        <div v-if="applyPhase !== 'idle' || autoBusyPhase" class="update-notice-progress" :class="{ failed: applyPhase === 'error' }">
          <div class="update-notice-progress-head">
            <span class="update-notice-progress-label">{{ progressLabel }}</span>
            <span v-if="shownPercent !== null" class="update-notice-progress-pct">{{ shownPercent }}%</span>
          </div>
          <div v-if="shownPercent !== null" class="update-notice-progress-bar">
            <i :style="{ width: shownPercent + '%' }" />
          </div>
          <div v-if="progressLines.length" class="update-notice-progress-log">
            <div v-for="(line, index) in progressLines" :key="index">{{ line }}</div>
          </div>
        </div>
        <!-- 安装位置提示：所有用户安装每次更新都会弹一次 UAC，提前说清并给出一次性切换入口 -->
        <p v-if="shellKind === 'installer' && machineScope" class="update-notice-note">
          当前为「所有用户」安装，更新时会弹一次管理员确认；到「设置 → 版本与更新」可切换为当前用户安装，以后不再弹。
        </p>
        <p v-if="desktopAuto.installError" class="update-notice-note err">{{ desktopAuto.installError }}</p>
        <div class="update-notice-foot">
          <div class="update-notice-foot-left">
            <button type="button" class="update-notice-later" :disabled="applying" @click="snooze">稍后提醒</button>
            <button type="button" class="update-notice-link" @click="goToUpdate">查看详情</button>
          </div>
          <button type="button" class="update-notice-go" :disabled="applying || Boolean(autoBusyPhase)" @click="runUpdate">{{ applyLabel }}</button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useUpdateStore } from '../stores/update';
import { useAppUpdateStore } from '../stores/appUpdate';
import { useRuntimeCapabilities } from '../lib/capabilities';
import { appUpdateCheckedLabel, appUpdateStatusText } from '../lib/appUpdate';
import { releaseNoteSections } from '../lib/releaseNotes';
import {
  applyDesktopInstallerUpdate,
  applyServerUpdate,
  applySourceUpdate,
  friendlyApplyError,
  isServerAlreadyLatest,
  type ApplyResult,
} from '../lib/applyUpdate';
import { api } from '../api';
import { notify } from '../lib/notify';
import { markServerUpdatePending } from '../lib/serverUpdateFeedback';
import { useServerUpdateStore } from '../stores/serverUpdate';
import Icon from './Icon.vue';

interface SourceUpdateState {
  phase?: string;
  behind?: number;
  remoteCommit?: string;
  localCommit?: string;
  changes?: string[];
  /** 远端 CHANGELOG 增量条目的 Markdown 片段（主进程解析；旧版桌面壳没有这个字段） */
  changeNotes?: string;
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
/** 手机端（Android App）的应用内更新：下载 APK → 调起系统安装器，见 stores/appUpdate.ts */
const appUpdate = useAppUpdateStore();
/** 服务器更新中：连接状态（侧栏胶囊 / 首页状态条）据此显示「服务器更新中」 */
const serverUpdate = useServerUpdateStore();
const { capabilities, load: loadCapabilities } = useRuntimeCapabilities();
/**
 * 桌面端（App.vue 同款判定：有 wikiDesktop 桥就有融合标题栏）：入口渲染进标题栏 #win-titlebar-slot，
 * 变成「Engram」右侧一枚绿色更新图标；Docker/浏览器端没有融合标题栏，就地渲染在右上角。
 * 两种形态都不自动弹出：检测到更新只留图标，鼠标扫到才展开面板（点一下仍可开合）。
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
/**
 * 安装包形态的自动更新状态（主进程 autoState）：后台下载时也要能在这里看到进度，
 * 并且下载被别人占用时把界面切到它的进度而不是报错（2026-11-24 用户报障）。
 */
const desktopAuto = ref<any>({ phase: 'idle', percent: null, latestVersion: null, error: '', installError: '' });
/** 安装位置（machine=Program Files，更新会弹 UAC；user=个人目录，更新无提权） */
const installScopeInfo = ref<any>(null);
/** 本次点击被后台自动更新接手：失败/安装阶段由它的状态推动界面 */
const attachedAuto = ref(false);
let offSourceState: (() => void) | null = null;
let offAutoState: (() => void) | null = null;
let hoverCloseTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 当前运行形态决定「立即更新」到底做什么：
 *   web = 浏览器访问（含 Docker 服务端）→ 请求服务端更新并等它重启；
 *   source = 桌面源码模式 → 主进程增量拉源码重建；
 *   installer = 桌面安装包形态 → 下载新 exe 静默安装；
 *   apk = 手机 App（Android）→ 下载 APK 后调起系统安装器，装完由系统替换应用。
 */
const shellKind = computed<'web' | 'source' | 'installer' | 'apk'>(() => {
  if (apkMode.value) return 'apk';
  const env = desktopEnv.value;
  if (!env) return 'web';
  return env.packaged ? 'installer' : 'source';
});
/** 手机端形态：能力位由 App 内的 Kotlin 本地服务报 true（桌面/服务端永远是 false） */
const apkMode = computed(() => Boolean(capabilities.value.features.apkUpdate));
/** 源码模式的检测由主进程做（git 提交号才有意义），且仅 Windows 桌面源码版走这条路 */
const sourceMode = computed(() => Boolean(desktopEnv.value && !desktopEnv.value.packaged && desktopEnv.value.platform === 'win32'));

const sourceHasUpdate = computed(() => sourceMode.value && sourceState.value.phase === 'behind' && Number(sourceState.value.behind) > 0);
/** 手机端：有新版本或安装包已下好（待安装）都要挂着绿色图标提示 */
const apkHasUpdate = computed(() => apkMode.value && (appUpdate.hasUpdate || appUpdate.installPending));
const releaseHasUpdate = computed(() => !sourceMode.value && !apkMode.value && updateStore.hasNewVersion);
/** 有更新就一直挂着这枚绿色图标：不再自动弹面板，也没有「把入口藏起来」的忽略态 */
const hasUpdate = computed(() => sourceHasUpdate.value || apkHasUpdate.value || releaseHasUpdate.value);
const mainImageUpdate = computed(() => !sourceMode.value && !apkMode.value && updateStore.lastResult?.imageTag === 'main' && updateStore.lastResult?.digestMatch === false);

/** 图标按钮的读屏文案：图标本身不写字，用 aria-label 说清「有什么更新」 */
const triggerHint = computed(() => {
  if (apkMode.value) return appUpdate.installPending ? '新版本已下载，可以去安装' : '有新版本可下载';
  if (sourceMode.value) return `有更新：远端领先 ${Number(sourceState.value.behind) || 0} 个新提交`;
  return mainImageUpdate.value ? '主分支镜像有更新' : '有可用新版本';
});
const title = computed(() => {
  if (apkMode.value) return appUpdate.installPending ? '新版本已下载' : 'Engram 有新版本';
  return sourceMode.value ? '源码有新更新' : mainImageUpdate.value ? '主分支镜像有更新' : 'Engram 有新版本';
});
const subtitle = computed(() => {
  if (apkMode.value) {
    return appUpdate.info.latestVersion
      ? `v${appUpdate.info.latestVersion} 已可更新 · 当前 v${appUpdate.info.currentVersion}`
      : appUpdateStatusText(appUpdate.info);
  }
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

/** 后台自动更新正在下载/安装（仅安装包形态）：此时不发起第二次下载，直接显示它的进度 */
const autoBusyPhase = computed<'downloading' | 'installing' | ''>(() => {
  if (shellKind.value !== 'installer') return '';
  const phase = desktopAuto.value?.phase;
  return phase === 'downloading' || phase === 'installing' ? phase : '';
});
const autoBusyPercent = computed<number | null>(() => {
  const raw = desktopAuto.value?.percent;
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
});
/** 面板里显示的进度：后台自动下载优先（手动下载在它忙时本来就会被禁用），其余用手动进度 */
const shownPercent = computed<number | null>(() => {
  if (autoBusyPhase.value === 'downloading') return autoBusyPercent.value;
  return applyPercent.value;
});
/** 当前是「所有用户」安装：每次更新会弹一次 UAC，面板里提示可去设置切换 */
const machineScope = computed(() => installScopeInfo.value?.scope === 'machine');

const applyLabel = computed(() => {
  if (autoBusyPhase.value === 'downloading') {
    return autoBusyPercent.value === null ? '后台下载中…' : `后台下载中 ${autoBusyPercent.value}%`;
  }
  if (autoBusyPhase.value === 'installing') return '正在安装…';
  if (applyPhase.value === 'running') {
    if (shellKind.value === 'installer') return applyPercent.value === null ? '正在准备下载…' : `下载中 ${applyPercent.value}%`;
    if (shellKind.value === 'apk') return applyPercent.value === null ? '正在下载安装包…' : `下载中 ${applyPercent.value}%`;
    return shellKind.value === 'source' ? '正在更新并重启…' : '正在更新…';
  }
  if (applyPhase.value === 'waiting') return '等待服务恢复…';
  if (applyPhase.value === 'done') return '更新进行中…';
  if (shellKind.value === 'apk') return appUpdate.installPending ? '立即安装' : '立即下载并安装';
  if (shellKind.value === 'source') return '立即更新并重启';
  if (shellKind.value === 'installer') return '立即下载并安装';
  return '立即更新';
});
const progressLabel = computed(() => {
  // 后台自动更新优先展示它自己的阶段：这时候用户没点过下载，界面不能停在「正在更新…」
  if (autoBusyPhase.value === 'installing') return '自动更新正在安装，应用即将自动重启…';
  if (autoBusyPhase.value === 'downloading') {
    const v = desktopAuto.value?.latestVersion ? ` v${desktopAuto.value.latestVersion}` : '';
    return autoBusyPercent.value === null
      ? `自动更新正在后台下载${v}，完成后会自动安装…`
      : `自动更新正在后台下载${v} ${autoBusyPercent.value}%，完成后会自动安装`;
  }
  if (applyPhase.value === 'error') return '更新失败';
  if (applyPhase.value === 'skipped') return '已是最新版本';
  if (applyPhase.value === 'waiting') return '更新已提交，服务正在重启…';
  if (applyPhase.value === 'done') {
    if (shellKind.value === 'apk') {
      return appUpdate.info.awaitingInstallPermission
        ? '已打开系统授权页：允许 Engram 安装应用后返回会自动继续'
        : '已调起系统安装器：请在系统弹窗点「安装」';
    }
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
 * 「已经是最新」预检：更新成功后再次点更新入口时给成功提示，而不是重复重建容器
 * （与设置页同一判定，见 lib/applyUpdate 的 isServerAlreadyLatest）。
 * 检查失败不拦更新，日志写清原因后按原流程继续。
 */
async function serverUpdateAlreadyLatest(log: (line: string) => void): Promise<boolean> {
  try {
    const { data } = await api.post('/api/update/check', {});
    return isServerAlreadyLatest(data);
  } catch (e: any) {
    const reason = e.response?.data?.error || e.response?.data?.warning || e?.message || '未知错误';
    log('无法确认是否已是最新（' + reason + '），继续按原流程更新');
    return false;
  }
}

/** 更新前落一条跨刷新标记：页面在新容器起来后自动刷新，刷新回来据此弹「更新成功」 */
async function markPendingBeforeApply(): Promise<void> {
  let fromVersion = String(updateStore.lastResult?.currentVersion || '');
  let fromCommit = '';
  try {
    const { data } = await api.get('/api/update/state');
    fromVersion = String(data?.currentVersion || fromVersion);
    fromCommit = String(data?.commit || '');
  } catch {
    // 读不到提交号就只比版本号：版本没变同样能识别出「可能已回滚」
  }
  markServerUpdatePending({ fromVersion, fromCommit, source: 'notice' });
}

/**
 * 点一下就更新，不再二次确认（用户 2026-09-24 明确要求）：
 * 四种形态各自接手（源码重建重启 / 下载 exe 静默安装 / 服务端换镜像并重启 /
 * 手机端下载 APK 再调起系统安装器），这里只负责把进度与失败原因显示出来。
 */
async function runUpdate() {
  if (applying.value) return;
  applyPhase.value = 'running';
  applyLog.value = [];
  applyError.value = '';
  applyPercent.value = null;
  const log = (line: string) => { applyLog.value = [...applyLog.value, line]; };
  if (shellKind.value === 'apk') {
    await runApkUpdate(log);
    return;
  }
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
    log('正在确认是否已是最新版本…');
    if (await serverUpdateAlreadyLatest(log)) {
      applyPhase.value = 'skipped';
      log('已是最新版本，无需更新。');
      notify.success('已是最新版本，无需更新');
      return;
    }
    await markPendingBeforeApply();
    serverUpdate.begin({ target: 'local' });
    log('正在提交更新请求…');
    result = await applyServerUpdate({
      log,
      onWaiting: () => { applyPhase.value = 'waiting'; },
    });
  }
  // 后台自动更新抢在前面：不报错，把面板切到它的进度上（下载完成后它会自己安装并重启）
  if (result.ok && result.busy) {
    attachedAuto.value = true;
    applyPhase.value = 'running';
    if (result.state) desktopAuto.value = result.state;
    log(result.busy === 'auto'
      ? '自动更新已经在后台下载，这里显示它的进度，完成后会自动安装。'
      : '安装包正在下载中，请稍候…');
    return;
  }
  if (result.ok) {
    applyPhase.value = result.skipped ? 'skipped' : 'done';
    if (result.skipped) log('已是最新版本，无需更新。');
    return;
  }
  applyPhase.value = 'error';
  applyError.value = friendlyApplyError(result.error);
  serverUpdate.finish();
  log(applyError.value);
}

/**
 * 手机端一键更新：没下好就先下载（几 MB～几十 MB，走本地服务的后台下载），
 * 下载完成再调起系统安装器。安装确认由 Android 系统弹窗把关，所以这里不做二次确认。
 */
async function runApkUpdate(log: (line: string) => void) {
  if (!appUpdate.info.configured) {
    applyPhase.value = 'error';
    applyError.value = '还没有可用的更新源：到「设置 → 版本与更新 → 安卓端更新」填写仓库地址，或在同步中枢的「更新源配置」里配好（会随多端同步下发到手机）。';
    log(applyError.value);
    return;
  }
  if (!appUpdate.installPending) {
    if (!appUpdate.hasUpdate) {
      log('正在检查远端版本…');
      await appUpdate.check(true);
    }
    log('开始下载安装包…');
    await appUpdate.download();
    const info = await appUpdate.waitForSettle(20 * 60_000, (state) => {
      applyPercent.value = state.percent;
    });
    applyPercent.value = info.percent;
    if (!info.ready) {
      applyPhase.value = 'error';
      applyError.value = info.error || '下载未完成，请稍后重试。';
      log(applyError.value);
      return;
    }
    log('安装包下载完成，正在调起系统安装器…');
  } else {
    applyPercent.value = 100;
  }
  const result = await appUpdate.install();
  if (!result.ok) {
    if (result.needPermission) {
      // 授权页刚被自动打开：不是失败，等用户允许后返回，引擎会自动接着调起安装器
      applyPhase.value = 'done';
      applyError.value = '';
      log('系统还没允许 Engram 安装应用：已打开「安装未知应用」授权页，允许后返回会自动继续安装。');
      return;
    }
    applyPhase.value = 'error';
    applyError.value = result.error || '无法调起系统安装器';
    log(applyError.value);
    return;
  }
  applyPhase.value = 'done';
  log('已调起系统安装器：请在系统弹窗点「安装」，完成后 Engram 会自动重启，数据不受影响。');
}

interface ChangeGroup {
  title: string;
  items: string[];
}

/**
 * 旧版桌面壳只回原始提交标题：过滤 Merge / docs / chore / ci / test / build 这类内部提交，
 * 避免更新面板再把「Merge branch …」「docs(changelog): …」当成更新内容展示。
 */
function sanitizeCommitChanges(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => String(item).trim())
    .filter((line) => line && !/^(?:Merge\b|Revert\b|docs(?:\(|:)|chore(?:\(|:)|ci(?:\(|:)|test(?:\(|:)|build(?:\(|:)|release(?:\(|:))/i.test(line))
    .map((line) => line.replace(/^[*_`]+|[*_`]+$/g, '').trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((line) => line.slice(0, 160));
}

/** 统一成「分类 + 条目」渲染结构；无内容时给一句可操作的兜底说明 */
function fallbackGroup(text: string): ChangeGroup[] {
  return [{ title: '更新', items: [text] }];
}

/**
 * 更新内容分组：源码模式读远端 CHANGELOG 的增量片段（主进程解析），
 * Docker / 桌面安装包 / 手机端读 Release 正文（由 CHANGELOG 版本段落生成）。
 * 三端共用 lib/releaseNotes.ts 的「更新 / 优化 / 修复」口径。
 */
const changeSections = computed<ChangeGroup[]>(() => {
  const toGroups = (notes: string) => releaseNoteSections(notes, 5).map((section) => ({ title: section.title, items: section.items }));
  if (apkMode.value) {
    const groups = toGroups(appUpdate.info.releaseNotes);
    return groups.length ? groups : fallbackGroup('新版本已可下载：点「立即下载并安装」，装完 Engram 自动重启。');
  }
  if (sourceMode.value) {
    const groups = toGroups(sourceState.value.changeNotes || '');
    if (groups.length) return groups;
    const legacy = sanitizeCommitChanges(sourceState.value.changes);
    if (legacy.length) return [{ title: '更新', items: legacy }];
    const behind = Number(sourceState.value.behind) || 0;
    return fallbackGroup(behind > 0
      ? `本次更新包含 ${behind} 个新提交（以内部改进为主），可前往软件更新查看提交号并更新。`
      : '远端已有新提交，可前往软件更新查看提交号并更新。');
  }
  if (mainImageUpdate.value) return fallbackGroup('main 通道有新的镜像构建，可前往软件更新查看并升级。');
  const groups = toGroups(updateStore.lastResult?.releaseNotes || '');
  return groups.length ? groups : fallbackGroup('此版本尚未提供更新说明，可前往软件更新查看版本与更新方式。');
});

const checkedLabel = computed(() => {
  if (apkMode.value) return appUpdate.info.checkedAt ? appUpdateCheckedLabel(appUpdate.info.checkedAt) : '刚刚';
  const at = sourceMode.value ? sourceState.value.checkedAt : updateStore.checkedAt;
  if (!at || Date.now() - at < 60_000) return '刚刚';
  return new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
});

/*
 * 检测到更新不再自动展开面板（用户 2026-09-24 明确要求「不要有更新了就默认弹出」）：
 * 只在标题栏/右上角留一枚绿色更新图标，鼠标扫到才弹，点一下仍是开/关。
 */
// 更新期间面板必须留在屏幕上：进度与失败原因都显示在这里
watch(applying, (now) => { if (now) panelOpen.value = true; });
// 本次点击被后台自动更新接手后，由它的状态机推动界面：装完会自动退出重启，失败要如实报出来
watch(desktopAuto, (state) => {
  if (!attachedAuto.value || !state) return;
  if (state.phase === 'failed') {
    applyPhase.value = 'error';
    applyError.value = state.error || '自动更新失败，请稍后重试';
  } else if (state.phase === 'installing') {
    applyPhase.value = 'done';
  }
}, { deep: true });
watch([hasUpdate, sourceHasUpdate], ([show, source]) => emit('change', show, source), { immediate: true });

/** 「稍后提醒」：只收起面板，绿色图标留在原地继续提示（图标本身就是常驻的更新提醒） */
function snooze() {
  if (applying.value) return;
  panelOpen.value = false;
}

/**
 * 鼠标扫到图标就展开（移开约 0.26 秒后收起，给鼠标从图标移进面板留出余量），
 * 点一下仍是开/关切换——触屏和「鼠标不悬停」的场景都能用。
 * 桌面标题栏与 Docker/浏览器端一致：不自动弹，扫到才弹。
 */
function onNoticeEnter() {
  if (hoverCloseTimer) { clearTimeout(hoverCloseTimer); hoverCloseTimer = null; }
  panelOpen.value = true;
}
function onNoticeLeave() {
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
  const anchor = apkMode.value
    ? 'panel-update-android'
    : sourceMode.value || Boolean((window as any).wikiDesktop) ? 'panel-update-desktop' : 'panel-update-server';
  const alreadyInSettings = router.currentRoute.value.path === '/settings';
  // 2026-09-28 起「服务器更新 / 桌面端更新 / 更新源配置」属「版本与更新」大类（旧值 connect 已退役）
  await router.push({ path: '/settings', query: { section: 'update', anchor } });
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
  await loadCapabilities();
  // 手机端形态：拉一次状态，绿色图标按「有新版本 / 待安装」亮起来（桌面/服务端走各自的检测）
  if (apkMode.value) await appUpdate.refresh();
  const desktop = (window as any).wikiDesktop;
  if (!desktop?.getDesktopEnv) return;
  try {
    const env = await desktop.getDesktopEnv();
    desktopEnv.value = env || null;
    // 安装包形态：订阅自动更新状态（后台进度 / 安装 / 失败）并读一次安装位置。
    // 放在源码模式的 early-return 之前——安装包形态拿不到这些，右上角就只能干巴巴一个「下载」。
    if (desktop.desktopUpdateGetState) {
      desktop.desktopUpdateGetState().then((state: any) => { if (state) desktopAuto.value = state; }).catch(() => {});
      if (desktop.onUpdateState) {
        offAutoState = desktop.onUpdateState((state: any) => { if (state) desktopAuto.value = state; });
      }
    }
    if (desktop.desktopUpdateGetScope) {
      desktop.desktopUpdateGetScope().then((info: any) => { installScopeInfo.value = info; }).catch(() => {});
    }
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
  offAutoState?.();
});
</script>

<style scoped>
.update-notice { position: fixed; z-index: var(--z-popup); top: calc(var(--win-titlebar-h, 0px) + 11px + var(--safe-top)); right: calc(22px + var(--safe-right)); }
/*
 * 手机档没有桌面标题栏，top 只有 11px：更新图标会压住页面标题的第一行。
 * 下移到页头首行之下，仍贴右缘；桌面端（含标题栏形态）不受影响。
 */
@media (max-width: 768px) {
  .update-notice:not(.update-notice-titlebar) {
    top: calc(64px + var(--safe-top));
    right: calc(12px + var(--safe-right));
  }
}
/* 入口就是一枚绿色小图标：底色用主题的成功色（亮色 #0f7b0f / 暗色 #6ccb5f），图标取对比色 */
.update-notice-trigger { width: 34px; height: 34px; display: grid; place-items: center; padding: 0; border: 1px solid var(--success); border-radius: 8px; background: var(--success); color: var(--on-accent); box-shadow: var(--shadow-raised); }
.update-notice-trigger:hover { filter: brightness(1.08); }
.update-notice-trigger:focus-visible, .update-notice-close:focus-visible, .update-notice-later:focus-visible, .update-notice-link:focus-visible, .update-notice-go:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.update-notice-panel { position: absolute; top: 44px; right: 0; width: 364px; max-width: calc(100vw - 28px); border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--card-bg); box-shadow: var(--shadow-dialog); overflow: hidden; }
/*
 * 桌面端标题栏形态：入口不再是浮在正文上的固定层，而是 46px 页眉里紧挨同步胶囊的一枚绿色图标。
 * 面板锚在图标下方并落在页眉下缘（12+22+12=46），层级随标题栏（--z-chrome）盖住正文与抽屉；
 * no-drag 保证整条拖拽区里按钮和面板仍可点。
 * 必须右对齐：图标右侧还留着 152px 原生窗口按钮区，364px 宽的左对齐面板会冲出窗口右缘
 * 把「立即更新」裁掉（用户 2026-11-22 截图报告），右对齐后面板挂在图标下方、贴窗口内缘。
 */
.update-notice-titlebar { position: relative; top: auto; right: auto; z-index: auto; display: flex; align-items: center; -webkit-app-region: no-drag; }
.update-notice-titlebar .update-notice-trigger { width: 22px; height: 22px; padding: 0; border-radius: var(--radius-control); border-color: var(--success); box-shadow: none; -webkit-app-region: no-drag; }
.update-notice-titlebar .update-notice-trigger:hover { filter: brightness(1.08); }
.update-notice-titlebar .update-notice-panel { top: calc(100% + 12px); right: 0; left: auto; -webkit-app-region: no-drag; }
.update-notice-head { display: flex; gap: 11px; align-items: flex-start; padding: 18px 18px 12px; }
.update-notice-symbol { flex: none; width: 34px; height: 34px; display: grid; place-items: center; color: var(--accent); background: var(--accent-soft); border-radius: 9px; }
.update-notice-heading { flex: 1; min-width: 0; display: grid; gap: 3px; }
.update-notice-heading strong { font-size: 14px; line-height: 1.4; }
.update-notice-heading span { color: var(--text-secondary); font-size: 11.5px; overflow-wrap: anywhere; }
.update-notice-close { flex: none; border: 0; background: none; color: var(--text-faint); border-radius: 5px; padding: 3px; display: grid; place-items: center; }
.update-notice-close:hover { background: var(--bg-hover); color: var(--text); }
.update-notice-checked { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); padding: 0 18px 13px; font-size: var(--fs-caption); }
.update-notice-ok { width: 6px; height: 6px; border-radius: 50%; background: var(--success); }
.update-notice-body { border-top: 1px solid var(--border); padding: 13px 18px 15px; }
.update-notice-caption { color: var(--text-faint); font-size: var(--fs-caption); font-weight: 600; margin-bottom: 9px; }
/* 分类分组：更新 / 优化 / 修复各一段小标题，滚动区放在外层，组内条目不再各自滚动 */
.update-notice-groups { display: grid; gap: 12px; max-height: 232px; overflow-y: auto; }
.update-notice-group-label { color: var(--text-faint); font-size: var(--fs-caption); font-weight: 600; margin-bottom: 7px; }
.update-notice-body ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
.update-notice-body li { display: flex; align-items: flex-start; gap: 8px; color: var(--text); font-size: var(--fs-small); line-height: 1.45; overflow-wrap: anywhere; }
.update-notice-check { flex: none; width: 16px; height: 16px; display: grid; place-items: center; margin-top: 1px; color: var(--success); background: var(--success-soft); border-radius: 5px; }
/* 一键更新进度块 */
.update-notice-progress { border-top: 1px solid var(--border); padding: 11px 18px 12px; }
.update-notice-progress-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.update-notice-progress-label { color: var(--text); font-size: 11.5px; font-weight: 600; }
.update-notice-progress-pct { color: var(--text-secondary); font-size: var(--fs-caption); font-variant-numeric: tabular-nums; }
.update-notice-progress-bar { margin-top: 7px; height: 4px; border-radius: 999px; background: var(--bg-hover); overflow: hidden; }
.update-notice-progress-bar i { display: block; height: 100%; background: var(--accent); transition: width var(--motion-base) var(--ease-standard); }
.update-notice-progress-log { margin-top: 7px; max-height: 76px; overflow: hidden; color: var(--text-faint); font-size: var(--fs-caption); line-height: var(--lh-ui); overflow-wrap: anywhere; }
.update-notice-progress.failed .update-notice-progress-label { color: var(--danger); }
.update-notice-progress.failed .update-notice-progress-log { color: var(--danger); }
/* 安装位置 / 安装失败等说明：与进度块同层级，不抢标题的注意力 */
.update-notice-note { margin: 0; padding: 10px 18px; border-top: 1px solid var(--border); color: var(--text-secondary); font-size: var(--fs-caption); line-height: 1.5; overflow-wrap: anywhere; }
.update-notice-note.err { color: var(--danger); }
.update-notice-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 11px 18px; border-top: 1px solid var(--border); background: var(--bg-secondary); }
.update-notice-foot button { border-radius: 6px; padding: 6px 10px; font-size: var(--fs-small); font-weight: 600; }
.update-notice-foot button:disabled { opacity: 0.6; cursor: default; }
.update-notice-foot-left { display: flex; align-items: center; gap: 6px; }
.update-notice-later { color: var(--text-secondary); background: var(--card-bg); border: 1px solid var(--border-strong); }
.update-notice-later:hover:not(:disabled) { color: var(--text); background: var(--bg-hover); }
.update-notice-link { color: var(--accent); background: none; border: 1px solid transparent; }
.update-notice-link:hover { background: var(--accent-soft); }
.update-notice-go { color: var(--on-action-solid); background: var(--action-solid); border: 1px solid var(--action-solid); white-space: nowrap; }
.update-notice-go:hover:not(:disabled) { background: var(--action-solid-hover); border-color: var(--action-solid-hover); }
@media (max-width: 768px) {
  /* 安卓边到边：fixed 顶栏元素要让开状态栏（桌面/网页端 --safe-top 为 0，观感不变） */
  .update-notice { top: calc(var(--win-titlebar-h, 0px) + 8px + var(--safe-top)); right: calc(10px + var(--safe-right)); }
  .update-notice-trigger { width: 32px; height: 32px; }
  .update-notice-panel { top: 41px; width: min(350px, calc(100vw - 20px)); }
  .update-notice-foot { flex-direction: column; align-items: stretch; }
  .update-notice-foot-left { justify-content: space-between; }
}
</style>
