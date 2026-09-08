<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>软件更新</h3>
        <p>检测新版本并就地更新；服务器（Docker）拉取镜像自动重建，桌面端默认自动下载并静默安装，也可手动下载安装包覆盖安装。</p>
      </div>
      <span v-if="state.currentVersion" class="app-version">v{{ state.currentVersion }}</span>
    </div>

    <!-- ============ 服务器（Docker）节 ============ -->
    <div class="settings-group">
      <div class="update-section-title">
        <Icon name="archive" :size="14" />
        <span>服务器（Docker 部署）</span>
      </div>

      <!-- 环境不支持：桌面端壳 -->
      <div v-if="state.desktop" class="integration-note">
        当前运行在桌面端壳内，服务器容器更新请从浏览器登录服务器地址操作；桌面端自身的更新见下方「桌面端」一节。
      </div>
      <!-- 环境不支持：未挂 sock -->
      <div v-else-if="!state.supported" class="integration-note">
        当前服务器未挂载 Docker socket，无法在网页内自动更新。请编辑服务器上的
        <code>docker-compose.pull.yml</code>，在 engram 服务的 volumes 增加一行
        <code>- /var/run/docker.sock:/var/run/docker.sock</code>，然后执行
        <code>docker compose -f docker-compose.pull.yml up -d</code> 重新创建容器，之后即可在此页一键更新。
      </div>

      <template v-else>
        <div class="setting-row">
          <div class="setting-copy">
            <strong>检查更新</strong>
            <span>从远端仓库 Release 与镜像仓库比对当前版本。</span>
          </div>
          <div class="check-controls">
            <span v-if="checkResult" class="check-status" :class="checkResult.hasUpdate ? 'has' : 'none'">
              {{ checkResult.hasUpdate ? (checkResult.latestVersion ? `有新版本 v${checkResult.latestVersion}` : '远端镜像有更新') : '已是最新' }}
            </span>
            <button class="btn" type="button" :disabled="checking" @click="doCheck">
              <AppSpinner v-if="checking" :size="11" />
              <template v-else>检查更新</template>
            </button>
          </div>
        </div>
        <p v-if="checkError" class="setting-message err">{{ checkError }}</p>
        <p v-else-if="checkResult?.warning" class="setting-message warn">{{ checkResult.warning }}</p>

        <div class="setting-row">
          <div class="setting-copy">
            <strong>立即更新</strong>
            <span>拉取最新镜像并重建容器，服务将中断 1–3 分钟，数据不受影响。</span>
          </div>
          <button class="btn primary" type="button" :disabled="updating || !state.supported" @click="confirmApply">
            立即更新
          </button>
        </div>

        <!-- 更新进度日志 -->
        <div v-if="updateLog.length" class="update-log">
          <div v-for="(line, i) in updateLog" :key="i" class="log-line">{{ line }}</div>
          <div v-if="updating" class="log-line pending">
            <AppSpinner :size="10" />
            <span>{{ healthWaiting ? '服务重启中，等待恢复…' : '更新执行中…' }}</span>
          </div>
        </div>
        <p v-if="healthTimeout" class="setting-message err">
          服务长时间未恢复。若更新失败，旧容器已自动回滚；仍无法访问时请在服务器执行
          <code>docker start engram-old</code> 手动恢复，然后刷新本页。
        </p>
      </template>
    </div>

    <!-- ============ 桌面端节 ============ -->
    <div class="settings-group">
      <div class="update-section-title">
        <Icon name="external" :size="14" />
        <span>桌面端（Windows）</span>
      </div>

      <div v-if="!isDesktop" class="integration-note">
        在 Windows 桌面端本地模式内可在此下载并安装最新安装包；浏览器访问服务器时此节仅作展示。
      </div>

      <template v-else>
        <div v-if="sourceMode" class="integration-note">
          当前为<strong>源码模式</strong>：更新 = 增量拉取源码并重新构建，不使用安装包。构建约需 1 分钟，期间会显示最小化控制台窗口，完成后应用自动重启，数据不受影响。
        </div>

        <div v-if="autoSupported && !sourceMode" class="setting-row">
          <div class="setting-copy">
            <strong>自动更新</strong>
            <span>启动后自动检查（之后每 8 小时复查），发现新版本自动在后台下载并静默安装；安装前应用内会提示，装完自动重启，全程无需手动操作。</span>
          </div>
          <label class="switch-control">
            <input type="checkbox" :checked="autoState.enabled" @change="toggleAuto" />
            <span aria-hidden="true"></span>
            <em>{{ autoState.enabled ? '已开启' : '已关闭' }}</em>
          </label>
        </div>
        <p v-if="autoSupported && !sourceMode && autoStatus && (!autoState.enabled || autoState.phase !== 'idle')" class="setting-message" :class="autoState.phase === 'failed' ? 'err' : autoState.phase === 'installing' ? 'warn' : ''">
          {{ autoStatus }}
        </p>
        <div v-if="autoSupported && !sourceMode && autoState.enabled && autoState.phase === 'downloading' && autoState.percent !== null" class="update-progress">
          <div class="update-progress-bar" :style="{ width: autoState.percent + '%' }" />
        </div>

        <div v-if="!sourceMode" class="setting-row">
          <div class="setting-copy">
            <strong>检查更新</strong>
            <span>手动从远端仓库 Release 比对桌面端版本。</span>
          </div>
          <div class="check-controls">
            <span v-if="desktopCheck && desktopCheck.ok" class="check-status" :class="desktopCheck.hasUpdate ? 'has' : 'none'">
              {{ desktopCheck.hasUpdate ? `有新版本 v${desktopCheck.latestVersion}` : '已是最新' }}
            </span>
            <button class="btn" type="button" :disabled="desktopChecking" @click="doDesktopCheck">
              <AppSpinner v-if="desktopChecking" :size="11" />
              <template v-else>检查更新</template>
            </button>
          </div>
        </div>
        <p v-if="!sourceMode && desktopUnsupported" class="setting-message warn">
          当前桌面端版本过旧，不支持应用内更新。请到仓库 Release 页手动下载最新安装包覆盖安装一次，之后即可在应用内更新。
        </p>
        <p v-if="!sourceMode && desktopCheck && !desktopCheck.ok && desktopCheck.error === 'not-configured'" class="setting-message warn">
          尚未配置远端仓库更新源（见下方「更新源配置」）。
        </p>
        <p v-else-if="!sourceMode && desktopCheck && !desktopCheck.ok" class="setting-message err">{{ desktopCheck.error }}</p>

        <div v-if="!sourceMode && desktopCheck?.ok && desktopCheck.hasUpdate && desktopCheck.exe" class="setting-row">
          <div class="setting-copy">
            <strong>下载并安装</strong>
            <span>{{ desktopCheck.exe.name }}（{{ fmtSize(desktopCheck.exe.size) }}），点击后自动下载并静默安装，全程无需操作。</span>
          </div>
          <button class="btn primary" type="button" :disabled="downloading || installing" @click="downloadAndInstall">
            {{ installing ? '安装中…' : downloading ? `下载中 ${downloadPercent ?? ''}${downloadPercent !== null ? '%' : ''}` : '下载并安装' }}
          </button>
        </div>
        <div v-if="!sourceMode && downloading && downloadPercent !== null" class="update-progress">
          <div class="update-progress-bar" :style="{ width: downloadPercent + '%' }" />
        </div>
        <p v-if="!sourceMode && downloadError" class="setting-message err">{{ downloadError }}</p>
        <p v-else-if="!sourceMode && installing" class="setting-message warn">正在静默安装更新，应用将自动重启，请勿关闭。</p>

        <!-- 源码模式：增量拉源码 + 重新构建 -->
        <template v-if="sourceMode">
          <div class="setting-row">
            <div class="setting-copy">
              <strong>检查更新</strong>
              <span>增量拉取远端源码，比对当前分支落后多少提交。</span>
            </div>
            <div class="check-controls">
              <span v-if="srcResult && srcResult.ok" class="check-status" :class="srcResult.upToDate ? 'none' : 'has'">
                {{ srcResult.upToDate ? '已是最新' : `落后 ${srcResult.behind} 个提交（分支 ${srcResult.branch}）` }}
              </span>
              <button class="btn" type="button" :disabled="srcChecking || srcUpdating" @click="doSourceCheck">
                <AppSpinner v-if="srcChecking" :size="11" />
                <template v-else>检查更新</template>
              </button>
            </div>
          </div>
          <p v-if="srcError" class="setting-message err">{{ srcError }}</p>

          <div v-if="srcResult?.ok && !srcResult.upToDate" class="setting-row">
            <div class="setting-copy">
              <strong>更新并重启</strong>
              <span>增量拉取 {{ srcResult.behind }} 个提交并重新构建（约 1 分钟），应用将自动重启，数据不受影响。</span>
            </div>
            <button class="btn primary" type="button" :disabled="srcUpdating" @click="doSourceUpdate">
              更新并重启
            </button>
          </div>
          <p v-if="srcUpdating" class="setting-message warn">正在增量拉取源码并重新构建，请看置顶的更新进度窗口；构建完成后应用自动重启，数据不受影响。</p>
        </template>
      </template>
    </div>

    <!-- ============ 更新源配置节 ============ -->
    <div class="settings-group">
      <div class="update-section-title">
        <Icon name="link" :size="14" />
        <span>更新源配置</span>
      </div>

      <div class="integration-note">
        只需粘贴仓库地址，服务器和仓库会自动识别；配置保存在服务器数据目录 .env 文件中（随数据卷持久化，不进代码库）。公开仓库无需填凭据。
      </div>

      <div class="setting-row setting-row-form">
        <div class="setting-copy">
          <strong>远端仓库地址</strong>
          <span>打开仓库首页，把浏览器地址栏整条复制粘贴过来（Release 页地址也可以），如 https://gitea.example.com/username/Engram。</span>
        </div>
        <input v-model="form.repoUrl" type="text" placeholder="https://gitea.example.com/username/Engram" aria-label="远端仓库地址" @input="repoUrlError = ''" />
        <p v-if="repoUrlError" class="setting-message err">{{ repoUrlError }}</p>
      </div>

      <div class="setting-row setting-row-form credential-row">
        <div class="setting-copy">
          <strong>访问凭据</strong>
          <span>私有仓库才需要。可任选一种方式，公开仓库留空即可。</span>
          <div class="auth-type-toggle">
            <button type="button" :class="['seg-btn', form.authType === 'token' ? 'active' : '']" @click="form.authType = 'token'">访问令牌</button>
            <button type="button" :class="['seg-btn', form.authType === 'password' ? 'active' : '']" @click="form.authType = 'password'">用户名密码</button>
          </div>
        </div>
        <div class="credential-inputs">
          <template v-if="form.authType === 'token'">
            <input v-model="form.token" type="text" autocomplete="off" spellcheck="false" placeholder="粘贴访问令牌" aria-label="远端仓库访问令牌" />
            <p class="setting-message hint">在仓库站点右上角头像 → 设置 → 应用 → 「生成新令牌」（勾选只读权限）。清空保存即删除。</p>
          </template>
          <template v-else>
            <input v-model="form.username" type="text" autocomplete="off" spellcheck="false" placeholder="用户名" aria-label="远端仓库用户名" />
            <input v-model="form.password" type="text" autocomplete="off" spellcheck="false" placeholder="密码" aria-label="远端仓库密码" />
          </template>
        </div>
      </div>

      <!-- 高级选项：绝大多数部署用不到（镜像源自动从当前容器推导，公开仓库免认证），默认收起 -->
      <div v-if="!state.desktop && state.supported" class="advanced-toggle">
        <button type="button" class="text-action" @click="showAdvanced = !showAdvanced">
          {{ showAdvanced ? '收起高级选项' : '高级选项（自定义镜像源）' }}
        </button>
      </div>

      <template v-if="!state.desktop && state.supported && showAdvanced">
        <div class="setting-row setting-row-form">
          <div class="setting-copy">
            <strong>镜像更新源</strong>
            <span>留空即自动使用当前容器的镜像仓库（推荐）。仅私有仓库或需切换镜像源时填写，如 registry.example.com/engram（不含 tag）。</span>
          </div>
          <input
            v-model="form.imageRef"
            type="text"
            :placeholder="state.imageRef || '留空自动从当前镜像推导'"
            aria-label="镜像更新源"
          />
        </div>

        <div class="setting-row setting-row-form">
          <div class="setting-copy">
            <strong>镜像仓库用户名</strong>
            <span>私有镜像仓库的账号；公开仓库无需填写。</span>
          </div>
          <input v-model="form.registryUsername" type="text" placeholder="registry 用户名" aria-label="镜像仓库用户名" />
        </div>

        <div class="setting-row setting-row-form">
          <div class="setting-copy">
            <strong>镜像仓库令牌</strong>
            <span>私有镜像仓库的密码或令牌；公开仓库无需填写。清空保存即删除。</span>
          </div>
          <input v-model="form.registryToken" type="text" autocomplete="off" spellcheck="false" placeholder="公开仓库无需填写" aria-label="镜像仓库令牌" />
        </div>
      </template>

      <div class="setting-row">
        <div class="setting-copy">
          <strong>保存配置</strong>
          <span>写入服务器数据目录 .env 文件，即时生效。</span>
        </div>
        <button class="btn primary" type="button" :disabled="savingConfig" @click="saveConfig">
          {{ savingConfig ? '保存中…' : '保存配置' }}
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { api, ssePost } from '../../api';
import Icon from '../Icon.vue';
import AppSpinner from '../ui/AppSpinner.vue';
import { confirmDialog } from '../../lib/confirm';
import { notify } from '../../lib/notify';

interface UpdateStateInfo {
  supported: boolean;
  reason: string;
  desktop: boolean;
  currentVersion: string;
  imageRef: string;
  imageRefConfigured: boolean;
  registryAuthConfigured: boolean;
  giteaConfigured: boolean;
  busy: boolean;
  containerName: string;
  currentImage: string;
}

interface ConfigInfo {
  imageRef: string;
  registryUsername: string;
  registryToken: string;
  giteaUrl: string;
  giteaRepo: string;
  giteaAuthType: string;
  giteaToken: string;
  giteaUsername: string;
  giteaPassword: string;
}

const isDesktop = computed(() => typeof window !== 'undefined' && Boolean((window as any).wikiDesktop));

const state = ref<UpdateStateInfo>({
  supported: false, reason: '', desktop: false, currentVersion: '',
  imageRef: '', imageRefConfigured: false, registryAuthConfigured: false,
  giteaConfigured: false, busy: false, containerName: '', currentImage: '',
});
const config = ref<ConfigInfo>({
  imageRef: '', registryUsername: '', registryToken: '',
  giteaUrl: '', giteaRepo: '', giteaAuthType: 'token', giteaToken: '', giteaUsername: '', giteaPassword: '',
});
const form = reactive({ repoUrl: '', authType: 'token', token: '', username: '', password: '', imageRef: '', registryUsername: '', registryToken: '' });
const repoUrlError = ref('');
const showAdvanced = ref(false);

const checking = ref(false);
const checkResult = ref<any>(null);
const checkError = ref('');

const updating = ref(false);
const healthWaiting = ref(false);
const healthTimeout = ref(false);
const updateLog = ref<string[]>([]);

const desktopChecking = ref(false);
const desktopCheck = ref<any>(null);
/** 旧版桌面端 exe 的 preload 缺 desktopUpdateCheck API：无法应用内更新，引导手动下载 */
const desktopUnsupported = ref(false);
const downloading = ref(false);
const installing = ref(false);
const downloadPercent = ref<number | null>(null);
const downloadError = ref('');
let offProgress: (() => void) | null = null;

// 自动更新（主进程状态机）：旧版壳无 desktopUpdateGetState API 时隐藏该节
const autoSupported = ref(false);
const autoState = ref<any>({ enabled: true, phase: 'idle', latestVersion: null, percent: null, error: '' });
let offAutoState: (() => void) | null = null;

const savingConfig = ref(false);

// 源码模式（非打包形态）：更新 = 增量拉源码 + 重新构建，不使用安装包
const sourceMode = ref(false);
const srcChecking = ref(false);
const srcResult = ref<any>(null);
const srcUpdating = ref(false);
const srcError = ref('');

const wikiDesktop = () => (window as any).wikiDesktop;

/** 自动更新状态机的用户可读描述 */
const autoStatus = computed(() => {
  const s = autoState.value;
  switch (s.phase) {
    case 'checking':
      return '正在检查更新…';
    case 'downloading':
      return `发现新版本 v${s.latestVersion ?? '?'}，正在后台下载${s.percent != null ? ` ${s.percent}%` : ''}…`;
    case 'up-to-date':
      return '自动检查完成，已是最新版本';
    case 'installing':
      return s.latestVersion ? `正在安装 v${s.latestVersion}，应用即将自动重启…` : '正在安装更新，应用即将自动重启…';
    case 'failed':
      return `自动更新失败：${s.error}。可关闭后重开自动更新，或用下方「下载并安装」手动更新。`;
    case 'unconfigured':
      return '尚未配置更新源，自动更新未生效（见下方「更新源配置」）。';
    default:
      return '';
  }
});

async function toggleAuto(e: Event) {
  const wd = wikiDesktop();
  const enabled = (e.target as HTMLInputElement).checked;
  if (!wd?.desktopUpdateSetAuto) return;
  try {
    autoState.value = await wd.desktopUpdateSetAuto(enabled);
    notify.success(enabled ? '自动更新已开启' : '自动更新已关闭');
  } catch {
    notify.error('设置失败，请重试');
  }
}

/**
 * 解析用户粘贴的远端仓库地址 → { url: 服务地址, repo: owner/name }。
 * 容忍 Release/分支页后缀、缺协议、.git 后缀、末尾斜杠；只给服务首页地址时返回 error 提示。
 */
function parseRepoUrl(input: string): { url: string; repo: string } | { error: string } {
  const raw = input.trim();
  if (!raw) return { url: '', repo: '' };
  let u: URL;
  try {
    u = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return { error: '地址格式无法识别，请粘贴浏览器地址栏的完整仓库地址' };
  }
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length < 2) {
    return { error: '这是站点首页地址，缺少仓库路径；请先打开仓库页面再复制，例如 https://gitea.example.com/username/Engram' };
  }
  const owner = decodeURIComponent(segs[0]);
  const name = decodeURIComponent(segs[1]).replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    return { error: '仓库路径包含无法识别的字符，请确认复制的是仓库首页地址' };
  }
  return { url: u.origin, repo: `${owner}/${name}` };
}

async function load() {
  try {
    const [s, c] = await Promise.all([
      api.get('/api/update/state'),
      api.get('/api/update/config'),
    ]);
    state.value = s.data;
    config.value = c.data;
    form.repoUrl = c.data.giteaUrl && c.data.giteaRepo ? `${c.data.giteaUrl}/${c.data.giteaRepo}` : (c.data.giteaUrl || '');
    form.authType = c.data.giteaAuthType === 'password' ? 'password' : 'token';
    form.token = c.data.giteaToken || '';
    form.username = c.data.giteaUsername || '';
    form.password = c.data.giteaPassword || '';
    form.imageRef = c.data.imageRef;
    form.registryUsername = c.data.registryUsername;
    form.registryToken = c.data.registryToken || '';
  } catch {
    /* 面板加载失败由 message 区提示 */
  }
}

async function doCheck() {
  checking.value = true;
  checkError.value = '';
  try {
    const { data } = await api.post('/api/update/check', {});
    checkResult.value = data;
  } catch (e: any) {
    checkResult.value = null;
    checkError.value = e.response?.data?.error || e.response?.data?.warning || '检查失败，请确认远端仓库配置';
  } finally {
    checking.value = false;
  }
}

async function confirmApply() {
  const ok = await confirmDialog({
    title: '立即更新',
    message: '将拉取最新镜像并重建容器，服务中断约 1–3 分钟（数据不受影响）。更新失败会自动回滚旧版本。继续？',
    confirmText: '开始更新',
  });
  if (!ok) return;
  updating.value = true;
  healthWaiting.value = false;
  healthTimeout.value = false;
  updateLog.value = [];
  let streamEnded = false;
  try {
    await ssePost('/api/update/apply', {}, {
      onEvent: (event, data) => {
        if (event === 'progress' && data?.text) updateLog.value.push(String(data.text));
        else if (event === 'done') updateLog.value.push(String(data?.message || '更新流程已移交'));
        else if (event === 'error') {
          updateLog.value.push(`更新失败: ${data?.error || '未知错误'}`);
          updating.value = false;
        }
      },
    });
    streamEnded = true;
  } catch (e: any) {
    updateLog.value.push(`连接中断: ${e?.message || e}`);
  }
  if (streamEnded && updating.value) {
    // 服务即将重启：轮询 /health 等恢复，然后刷新页面加载新版本前端
    healthWaiting.value = true;
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      if (Date.now() > deadline) {
        healthTimeout.value = true;
        updating.value = false;
        return;
      }
      try {
        const r = await fetch('/health', { cache: 'no-store' });
        if (r.ok) {
          await new Promise((res) => setTimeout(res, 1500));
          location.reload();
          return;
        }
      } catch { /* 服务重启中 */ }
      await new Promise((res) => setTimeout(res, 3000));
    }
  } else if (!streamEnded) {
    updating.value = false;
  }
}

async function doDesktopCheck() {
  const wd = wikiDesktop();
  if (!wd?.desktopUpdateCheck) {
    desktopUnsupported.value = true;
    return;
  }
  desktopUnsupported.value = false;
  desktopChecking.value = true;
  try {
    // 把设置页当前的更新源配置传给主进程：本地/远端模式均所见即所得，
    // 也兼容主进程尚未从远端服务器拉到配置的窗口期
    desktopCheck.value = await wd.desktopUpdateCheck({
      giteaUrl: config.value.giteaUrl,
      giteaRepo: config.value.giteaRepo,
      giteaAuthType: config.value.giteaAuthType,
      giteaToken: config.value.giteaToken,
      giteaUsername: config.value.giteaUsername,
      giteaPassword: config.value.giteaPassword,
    });
  } finally {
    desktopChecking.value = false;
  }
}

async function downloadAndInstall() {
  const wd = wikiDesktop();
  const exe = desktopCheck.value?.exe;
  if (!wd?.desktopUpdateDownload || !exe) return;
  // 点击即全自动：下载（进度条）→ 静默安装（应用内全屏提示 + 独立进度窗）→ 自动重启，无需再点任何确认
  downloading.value = true;
  downloadError.value = '';
  try {
    const { path: filePath } = await wd.desktopUpdateDownload(exe.url, {
      giteaUrl: config.value.giteaUrl,
      giteaRepo: config.value.giteaRepo,
      giteaAuthType: config.value.giteaAuthType,
      giteaToken: config.value.giteaToken,
      giteaUsername: config.value.giteaUsername,
      giteaPassword: config.value.giteaPassword,
    });
    downloading.value = false;
    installing.value = true;
    await wd.desktopUpdateRunInstaller(filePath, desktopCheck.value?.latestVersion);
  } catch (e: any) {
    downloading.value = false;
    downloadError.value = e?.message || '下载失败';
  }
}

async function doSourceCheck() {
  const wd = wikiDesktop();
  if (!wd?.desktopSourceUpdateCheck) {
    srcError.value = '当前桌面端壳过旧，不支持源码更新，请更新一次桌面端后再试。';
    return;
  }
  srcChecking.value = true;
  srcError.value = '';
  try {
    srcResult.value = await wd.desktopSourceUpdateCheck();
    if (!srcResult.value?.ok) srcError.value = srcResult.value?.error || '检查失败';
  } catch (e: any) {
    srcResult.value = null;
    srcError.value = e?.message || '检查失败';
  } finally {
    srcChecking.value = false;
  }
}

async function doSourceUpdate() {
  const wd = wikiDesktop();
  if (!wd?.desktopSourceUpdate) return;
  const ok = await confirmDialog({
    title: '更新并重启',
    message: `将增量拉取 ${srcResult.value?.behind ?? ''} 个提交并重新构建（约 1 分钟），期间会弹出置顶进度窗口实时显示构建步骤，完成后应用自动重启，数据不受影响。继续？`,
    confirmText: '开始更新',
  });
  if (!ok) return;
  srcUpdating.value = true;
  srcError.value = '';
  try {
    const r = await wd.desktopSourceUpdate();
    if (!r?.ok) {
      srcUpdating.value = false;
      srcError.value = r?.error || '更新失败';
    }
    // ok：主进程已拉起构建脚本，约 1.5s 后应用自动退出并由新实例接管
  } catch (e: any) {
    srcUpdating.value = false;
    srcError.value = e?.message || '更新失败';
  }
}

async function saveConfig() {
  const parsed = parseRepoUrl(form.repoUrl);
  if ('error' in parsed) {
    repoUrlError.value = parsed.error;
    return;
  }
  repoUrlError.value = '';
  savingConfig.value = true;
  try {
    await api.put('/api/update/config', {
      giteaUrl: parsed.url,
      giteaRepo: parsed.repo,
      giteaAuthType: form.authType,
      giteaToken: form.authType === 'token' ? form.token : '',
      giteaUsername: form.authType === 'password' ? form.username : '',
      giteaPassword: form.authType === 'password' ? form.password : '',
      imageRef: form.imageRef,
      registryUsername: form.registryUsername,
      registryToken: form.registryToken,
    });
    await load();
    notify.success('更新源配置已保存');
  } catch (e: any) {
    notify.error(e.response?.data?.error || '保存失败');
  } finally {
    savingConfig.value = false;
  }
}

function fmtSize(bytes: number): string {
  if (!bytes) return '未知大小';
  if (bytes > 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(0) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

onMounted(() => {
  load();
  const wd = wikiDesktop();
  if (wd?.getDesktopEnv) {
    wd.getDesktopEnv().then((env: any) => {
      sourceMode.value = Boolean(env && !env.packaged && env.platform === 'win32');
    });
  }
  if (wd?.onUpdateProgress) {
    offProgress = wd.onUpdateProgress((p: any) => {
      downloadPercent.value = p?.percent ?? null;
    });
  }
  if (wd?.desktopUpdateGetState) {
    autoSupported.value = true;
    wd.desktopUpdateGetState().then((s: any) => {
      autoState.value = s;
    });
    if (wd.onUpdateState) {
      offAutoState = wd.onUpdateState((s: any) => {
        autoState.value = s;
      });
    }
  }
});
onUnmounted(() => {
  offProgress?.();
  offAutoState?.();
});
</script>

<style scoped>
.integration-note {
  margin: 0 24px 18px;
  color: var(--text-secondary);
  font-size: 12px;
}

.update-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 18px 24px 4px;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.check-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}
.check-status {
  font-size: 12px;
  color: var(--text-faint);
}
.check-status.has {
  color: var(--accent, #3b82f6);
  font-weight: 600;
}

/* 组内错误/警告消息：全局规则只覆盖面板直接子级，组内的须自行补边距 */
.settings-group > .setting-message {
  margin: 0 24px 14px;
}

/* 凭据方式二选一分段按钮 */
.auth-type-toggle {
  display: inline-flex;
  gap: 4px;
  margin-top: 8px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}
.seg-btn {
  padding: 5px 14px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.seg-btn.active {
  background: var(--bg);
  color: var(--text);
  font-weight: 600;
  box-shadow: 0 1px 2px rgb(0 0 0 / 12%);
}
.setting-message.hint {
  margin: 6px 0 0;
  color: var(--text-faint);
}

/* 凭据行：标签+切换按钮在上，输入框统一排在切换按钮下方 */
.setting-row.credential-row {
  grid-template-columns: 1fr;
}
.credential-inputs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.credential-inputs input {
  flex: 1 1 220px;
  max-width: 420px;
}
.credential-inputs .hint {
  flex-basis: 100%;
}

/* 高级选项折叠入口 */
.advanced-toggle {
  padding: 10px 24px 8px;
  border-bottom: 1px solid var(--border);
}

.update-log {
  margin: 12px 24px;
  padding: 10px 12px;
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-secondary);
}
.log-line {
  white-space: pre-wrap;
  word-break: break-all;
}
.log-line.pending {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--accent, #3b82f6);
}

.update-progress {
  height: 6px;
  margin: -4px 24px 12px;
  overflow: hidden;
  border-radius: 3px;
  background: var(--bg-secondary);
}
.update-progress-bar {
  height: 100%;
  border-radius: 3px;
  background: var(--accent, #3b82f6);
  transition: width 200ms ease;
}

@media (max-width: 768px) {
  .integration-note {
    margin: 0 18px 16px;
  }
  .update-section-title {
    margin: 18px 18px 4px;
  }
  .settings-group > .setting-message {
    margin: 0 18px 14px;
  }
  .advanced-toggle {
    padding: 10px 18px 8px;
  }
  .update-log {
    margin: 12px 18px;
  }
  .update-progress {
    margin: -4px 18px 12px;
  }
}

@media (max-width: 640px) {
  .check-controls {
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
  }
}
</style>
