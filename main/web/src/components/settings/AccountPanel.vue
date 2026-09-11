<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>账户与外观</h3>
        <p>调整登录凭据和界面显示方式。</p>
      </div>
    </div>

    <div class="settings-group">
      <div class="setting-row setting-row-form">
        <div class="setting-copy">
          <strong>修改密码</strong>
          <span>新密码至少需要 6 位。</span>
        </div>
        <div class="password-controls">
          <SecretField v-model="pwd.old" autocomplete="current-password" placeholder="原密码" aria-label="原密码" />
          <SecretField v-model="pwd.next" autocomplete="new-password" placeholder="新密码" aria-label="新密码" />
          <button class="btn primary" type="button" @click="changePwd">修改密码</button>
        </div>
        <p v-if="pwdMsg" class="setting-message" :class="pwdOk ? 'ok' : 'err'">{{ pwdMsg }}</p>
      </div>

      <div class="setting-row">
        <div class="setting-copy">
          <strong>主题</strong>
          <span>选择浅色、深色或跟随系统。</span>
        </div>
        <select
          class="setting-control"
          :value="app.theme"
          aria-label="主题"
          @change="app.setTheme(($event.target as HTMLSelectElement).value as any)"
        >
          <option value="light">浅色</option>
          <option value="dark">深色</option>
          <option value="system">跟随系统</option>
        </select>
      </div>

      <div v-if="connState !== 'unconfigured'" class="setting-row">
        <div class="setting-copy">
          <strong>连接通道</strong>
          <span>当前访问路径与直连可用性。</span>
        </div>
        <div class="conn-controls">
          <span class="conn-badge" :class="'conn-' + connState">{{ connBadgeText }}</span>
          <button v-if="connState === 'tunnel-ok'" class="btn primary" type="button" @click="switchToDirect">
            使用直连访问
          </button>
          <button v-else-if="connState !== 'direct'" class="btn" type="button" @click="probeConn">重测</button>
        </div>
        <p v-if="directUrl && connState !== 'direct'" class="setting-message conn-direct-row">
          直连地址（可填入 APP / 桌面端的「直连地址」可选框）：
          <code>{{ directUrl }}</code>
          <button class="btn" type="button" @click="copyDirect">{{ directCopied ? '已复制' : '复制' }}</button>
        </p>
      </div>

      <div class="setting-row">
        <div class="setting-copy">
          <strong>当前会话</strong>
          <span>退出后需要重新输入密码。</span>
        </div>
        <button class="btn danger" type="button" @click="logout">退出登录</button>
      </div>

      <div class="setting-row">
        <div class="setting-copy">
          <strong>应用版本</strong>
          <span>{{ versionHint }}</span>
        </div>
        <code class="app-version">{{ versionLabel }}</code>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api';
import SecretField from '../SecretField.vue';
import { useAppStore } from '../../stores/app';
import { useAuthStore } from '../../stores/auth';
import { APP_VERSION } from '../../version';
import { formatVersionLabel, type GitIdentity } from '../../lib/buildLabel';

const app = useAppStore();
const auth = useAuthStore();

// 提交身份两个来源：桌面源码模式由主进程经 IPC 给出（含提交日期/脏标记），
// Docker 镜像与浏览器访问由服务端 /api/update/state 给出（镜像内烤入 /app/GIT_SHA）。
// 都拿不到时（安装包形态、无 git 的部署）退回纯版本号。
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
const versionLabel = computed(() => formatVersionLabel(APP_VERSION, identity.value));
const versionHint = computed(() =>
  desktopEnv.value?.commit
    ? '源码模式：版本号仅随发版变化，提交号随每次更新变化。'
    : serverCommit.value
      ? '当前运行部署的构建版本：版本号随发版变化，提交号随每次构建变化。'
      : '当前安装的 Engram 版本。',
);

const pwd = ref({ old: '', next: '' });
const pwdMsg = ref('');
const pwdOk = ref(false);

// ---------- 连接通道状态（服务器经 /health 通告直连地址；未通告则整块隐藏） ----------
const connState = ref<'loading' | 'unconfigured' | 'direct' | 'tunnel-ok' | 'tunnel'>('loading');
const directUrl = ref('');
const directLatency = ref<number | null>(null);
const directCopied = ref(false);

const connBadgeText = computed(() => {
  switch (connState.value) {
    case 'loading':
      return '检测中…';
    case 'direct':
      return 'IPv6 直连';
    case 'tunnel-ok':
      return `隧道（直连可用 ${directLatency.value ?? '?'}ms）`;
    case 'tunnel':
      return '隧道';
    default:
      return '';
  }
});

async function probeConn() {
  connState.value = 'loading';
  directCopied.value = false;
  try {
    // 同源请求：/health 未配置 DIRECT_ACCESS_URL 时是纯文本 'ok'，视为未通告
    const res = await api.get('/health');
    const h = res.data;
    const direct =
      typeof h === 'object' && h !== null ? String((h as any).direct || '').replace(/\/+$/, '') : '';
    if (!direct) {
      connState.value = 'unconfigured';
      directUrl.value = '';
      return;
    }
    directUrl.value = direct;
    if (location.origin === direct) {
      connState.value = 'direct';
      return;
    }
    // 当前走隧道：测直连可达性与延迟（no-cors opaque，resolve 即可达，3.5s 硬超时）
    const t0 = performance.now();
    const ok = await new Promise<boolean>((resolve) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3500);
      fetch(direct + '/health', { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
        .then(() => resolve(true))
        .catch(() => resolve(false))
        .finally(() => clearTimeout(timer));
    });
    directLatency.value = ok ? Math.round(performance.now() - t0) : null;
    connState.value = ok ? 'tunnel-ok' : 'tunnel';
  } catch {
    connState.value = 'unconfigured';
  }
}

async function copyDirect() {
  try {
    await navigator.clipboard.writeText(directUrl.value);
    directCopied.value = true;
    setTimeout(() => (directCopied.value = false), 2000);
  } catch {
    /* 剪贴板不可用时忽略 */
  }
}

/** 一键切直连：仅直连探测可用时展示；跳转直连域（登录态随父域 Cookie 共享，免重登） */
function switchToDirect() {
  if (directUrl.value) location.href = directUrl.value + '/';
}

onMounted(() => {
  probeConn();
  // 桌面端源码模式：主进程经 IPC 给提交身份
  const wd = (window as any).wikiDesktop;
  if (wd?.getDesktopEnv) {
    wd.getDesktopEnv()
      .then((env: GitIdentity | null) => {
        desktopEnv.value = env;
      })
      .catch(() => {
        /* 主进程未就绪时忽略，版本号照常显示 */
      });
  }
  // Docker 镜像 / 浏览器访问：服务端读 /app/GIT_SHA 或源码检出的 .git
  api
    .get('/api/update/state')
    .then((res) => {
      serverCommit.value = String(res.data?.commit || '');
    })
    .catch(() => {
      /* 未登录或接口不可用时保持纯版本号 */
    });
});

async function changePwd() {
  pwdMsg.value = '';
  try {
    await api.post('/api/auth/password', {
      oldPassword: pwd.value.old,
      newPassword: pwd.value.next,
    });
    pwdOk.value = true;
    pwdMsg.value = '密码已修改';
    pwd.value = { old: '', next: '' };
  } catch (error: any) {
    pwdOk.value = false;
    pwdMsg.value = error.response?.data?.error || '修改失败';
  }
}

function logout() {
  auth.logout();
}
</script>

<style scoped>
.conn-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}
.conn-badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}
.conn-loading { background: var(--bg-tertiary); color: var(--text-faint); }
.conn-direct { background: var(--success-soft); color: var(--success); }
.conn-tunnel-ok { background: var(--accent-soft); color: var(--accent); }
.conn-tunnel { background: var(--warn-soft); color: var(--warning); }
.conn-direct-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.conn-direct-row code {
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--bg-tertiary);
  font-size: 12.5px;
  user-select: all;
}
/* 可换行 flex：窄列时输入框收缩、按钮换行。不依赖视口媒体查询——
   桌面端 DPI 缩放使 CSS 视口远宽于实际内容列，断点感知不到侧栏挤占 */
.password-controls {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  max-width: 530px;
}
.password-controls :deep(.secret-input-wrap) {
  flex: 1 1 130px;
  min-width: 0;
}
.password-controls .btn {
  flex: 0 0 auto;
}
</style>
