<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>软件更新</h3>
        <p>检测新版本并就地更新；服务器（Docker）拉取镜像自动重建，桌面端下载安装包覆盖安装。</p>
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
        <code>docker-compose.pull.yml</code>，在 example-wiki 服务的 volumes 增加一行
        <code>- /var/run/docker.sock:/var/run/docker.sock</code>，然后执行
        <code>docker compose -f docker-compose.pull.yml up -d</code> 重新创建容器，之后即可在此页一键更新。
      </div>

      <template v-else>
        <div class="setting-row">
          <div class="setting-copy">
            <strong>检查更新</strong>
            <span>从 Gitea Release 与镜像仓库比对当前版本。</span>
          </div>
          <div class="check-controls">
            <span v-if="checkResult" class="check-status" :class="checkResult.hasUpdate ? 'has' : 'none'">
              {{ checkResult.hasUpdate ? `有新版本 v${checkResult.latestVersion}` : '已是最新' }}
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
          <code>docker start example-wiki-old</code> 手动恢复，然后刷新本页。
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
        <div class="setting-row">
          <div class="setting-copy">
            <strong>检查更新</strong>
            <span>从 Gitea Release 比对桌面端版本。</span>
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
        <p v-if="desktopCheck && !desktopCheck.ok && desktopCheck.error === 'not-configured'" class="setting-message warn">
          尚未配置 Gitea 更新源（见下方「更新源配置」）。
        </p>
        <p v-else-if="desktopCheck && !desktopCheck.ok" class="setting-message err">{{ desktopCheck.error }}</p>

        <div v-if="desktopCheck?.ok && desktopCheck.hasUpdate && desktopCheck.exe" class="setting-row">
          <div class="setting-copy">
            <strong>下载并安装</strong>
            <span>{{ desktopCheck.exe.name }}（{{ fmtSize(desktopCheck.exe.size) }}），下载完成后运行安装包覆盖安装。</span>
          </div>
          <button class="btn primary" type="button" :disabled="downloading || installing" @click="downloadAndInstall">
            {{ installing ? '安装中…' : downloading ? `下载中 ${downloadPercent ?? ''}${downloadPercent !== null ? '%' : ''}` : '下载并安装' }}
          </button>
        </div>
        <div v-if="downloading && downloadPercent !== null" class="update-progress">
          <div class="update-progress-bar" :style="{ width: downloadPercent + '%' }" />
        </div>
        <p v-if="downloadError" class="setting-message err">{{ downloadError }}</p>
        <p v-else-if="installing" class="setting-message warn">安装包已启动，应用即将退出，请按安装向导完成更新。</p>
      </template>
    </div>

    <!-- ============ 更新源配置节 ============ -->
    <div class="settings-group">
      <div class="update-section-title">
        <Icon name="link" :size="14" />
        <span>更新源配置</span>
      </div>

      <div class="integration-note">
        所有令牌仅保存在服务器数据目录的 .env 文件中（不进数据库、不进代码库）。拉取公开源无需填写令牌。
      </div>

      <div class="setting-row setting-row-form">
        <div class="setting-copy">
          <strong>Gitea 服务地址</strong>
          <span>版本检测与桌面端安装包的来源，如 https://gitea.example.com。</span>
        </div>
        <input v-model="form.giteaUrl" type="text" placeholder="https://gitea.example.com" aria-label="Gitea 服务地址" />
        <p v-if="formMsg && formMsgField === 'gitea'" class="setting-message" :class="formOk ? 'ok' : 'err'">{{ formMsg }}</p>
      </div>

      <div class="setting-row setting-row-form">
        <div class="setting-copy">
          <strong>Gitea 仓库</strong>
          <span>owner/name 形式，如 example/ExampleProject。</span>
        </div>
        <input v-model="form.giteaRepo" type="text" placeholder="owner/name" aria-label="Gitea 仓库" />
      </div>

      <div class="setting-row setting-row-form">
        <div class="setting-copy">
          <strong>Gitea 访问令牌</strong>
          <span>公开仓库无需填写；私有仓库需有 Release 读取权限。</span>
        </div>
        <div class="token-input-row">
          <input
            v-model="form.giteaToken"
            type="password"
            autocomplete="new-password"
            :placeholder="config.giteaTokenConfigured ? '已配置（留空保持不变）' : '公开源无需填写'"
            aria-label="Gitea 访问令牌"
          />
          <button v-if="config.giteaTokenConfigured" class="text-action danger" type="button" @click="clearToken('giteaToken')">清除</button>
        </div>
      </div>

      <template v-if="!state.desktop && state.supported">
        <div class="setting-row setting-row-form">
          <div class="setting-copy">
            <strong>镜像更新源</strong>
            <span>镜像仓库地址（不含 tag，自动拉 latest），如 registry.example.com/example-wiki。</span>
          </div>
          <input
            v-model="form.imageRef"
            type="text"
            :placeholder="state.imageRef || '未配置（将无法拉取新镜像）'"
            aria-label="镜像更新源"
          />
        </div>

        <div class="setting-row setting-row-form">
          <div class="setting-copy">
            <strong>镜像仓库用户名</strong>
            <span>私有镜像仓库的账号。</span>
          </div>
          <input v-model="form.registryUsername" type="text" placeholder="registry 用户名" aria-label="镜像仓库用户名" />
        </div>

        <div class="setting-row setting-row-form">
          <div class="setting-copy">
            <strong>镜像仓库令牌</strong>
            <span>私有镜像仓库的密码/令牌；公开仓库无需填写。</span>
          </div>
          <div class="token-input-row">
            <input
              v-model="form.registryToken"
              type="password"
              autocomplete="new-password"
              :placeholder="config.registryTokenConfigured ? '已配置（留空保持不变）' : '公开源无需填写'"
              aria-label="镜像仓库令牌"
            />
            <button v-if="config.registryTokenConfigured" class="text-action danger" type="button" @click="clearToken('registryToken')">清除</button>
          </div>
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
  registryTokenConfigured: boolean;
  giteaUrl: string;
  giteaRepo: string;
  giteaTokenConfigured: boolean;
}

const isDesktop = computed(() => typeof window !== 'undefined' && Boolean((window as any).wikiDesktop));

const state = ref<UpdateStateInfo>({
  supported: false, reason: '', desktop: false, currentVersion: '',
  imageRef: '', imageRefConfigured: false, registryAuthConfigured: false,
  giteaConfigured: false, busy: false, containerName: '', currentImage: '',
});
const config = ref<ConfigInfo>({
  imageRef: '', registryUsername: '', registryTokenConfigured: false,
  giteaUrl: '', giteaRepo: '', giteaTokenConfigured: false,
});
const form = reactive({ giteaUrl: '', giteaRepo: '', giteaToken: '', imageRef: '', registryUsername: '', registryToken: '' });

const checking = ref(false);
const checkResult = ref<any>(null);
const checkError = ref('');

const updating = ref(false);
const healthWaiting = ref(false);
const healthTimeout = ref(false);
const updateLog = ref<string[]>([]);

const desktopChecking = ref(false);
const desktopCheck = ref<any>(null);
const downloading = ref(false);
const installing = ref(false);
const downloadPercent = ref<number | null>(null);
const downloadError = ref('');
let offProgress: (() => void) | null = null;

const savingConfig = ref(false);
const formMsg = ref('');
const formMsgField = ref('');
const formOk = ref(false);

const wikiDesktop = () => (window as any).wikiDesktop;

async function load() {
  try {
    const [s, c] = await Promise.all([
      api.get('/api/update/state'),
      api.get('/api/update/config'),
    ]);
    state.value = s.data;
    config.value = c.data;
    form.giteaUrl = c.data.giteaUrl;
    form.giteaRepo = c.data.giteaRepo;
    form.imageRef = c.data.imageRef;
    form.registryUsername = c.data.registryUsername;
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
    checkError.value = e.response?.data?.error || e.response?.data?.warning || '检查失败，请确认 Gitea 配置';
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
  if (!wd?.desktopUpdateCheck) return;
  desktopChecking.value = true;
  try {
    desktopCheck.value = await wd.desktopUpdateCheck();
  } finally {
    desktopChecking.value = false;
  }
}

async function downloadAndInstall() {
  const wd = wikiDesktop();
  const exe = desktopCheck.value?.exe;
  if (!wd?.desktopUpdateDownload || !exe) return;
  const ok = await confirmDialog({
    title: '下载并安装更新',
    message: `将下载 ${exe.name}（约 ${fmtSize(exe.size)}）并运行安装包，应用会退出并按向导完成覆盖安装。继续？`,
    confirmText: '下载并安装',
  });
  if (!ok) return;
  downloading.value = true;
  downloadError.value = '';
  try {
    const { path: filePath } = await wd.desktopUpdateDownload(exe.url);
    downloading.value = false;
    installing.value = true;
    await wd.desktopUpdateRunInstaller(filePath);
  } catch (e: any) {
    downloading.value = false;
    downloadError.value = e?.message || '下载失败';
  }
}

async function saveConfig() {
  savingConfig.value = true;
  formMsg.value = '';
  try {
    await api.put('/api/update/config', {
      giteaUrl: form.giteaUrl,
      giteaRepo: form.giteaRepo,
      giteaToken: form.giteaToken,
      imageRef: form.imageRef,
      registryUsername: form.registryUsername,
      registryToken: form.registryToken,
    });
    form.giteaToken = '';
    form.registryToken = '';
    await load();
    notify.success('更新源配置已保存');
  } catch (e: any) {
    notify.error(e.response?.data?.error || '保存失败');
  } finally {
    savingConfig.value = false;
  }
}

async function clearToken(field: 'registryToken' | 'giteaToken') {
  const ok = await confirmDialog({
    title: '清除令牌',
    message: '清除后拉取私有源将无法认证，确定清除？',
    confirmText: '清除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.post('/api/update/config/clear-token', { clear: field });
    await load();
    notify.success('已清除');
  } catch (e: any) {
    notify.error(e.response?.data?.error || '清除失败');
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
  if (wd?.onUpdateProgress) {
    offProgress = wd.onUpdateProgress((p: any) => {
      downloadPercent.value = p?.percent ?? null;
    });
  }
});
onUnmounted(() => {
  offProgress?.();
});
</script>

<style scoped>
.update-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 18px 0 4px;
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

.update-log {
  margin: 12px 0;
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
  margin: -4px 0 12px;
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

.token-input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(530px, 100%);
}
.token-input-row input {
  flex: 1;
  min-width: 0;
}

@media (max-width: 640px) {
  .check-controls {
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
  }
}
</style>
