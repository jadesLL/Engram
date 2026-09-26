<template>
  <section class="settings-panel settings-native">
    <SettingsGroup anchor="account-credentials" title="账户" hint="登录密码与当前会话" :default-open="true" flush>
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
          <strong>当前会话</strong>
          <span>退出后需要重新输入密码。</span>
        </div>
        <button class="btn danger" type="button" @click="logout">退出登录</button>
      </div>
    </SettingsGroup>

    <!-- 连接通道：服务器经 /health 通告直连地址时才存在（Android 本地版没有这条链路）；
         整组只有这一行，所以显隐必须与导航登记用同一个条件，否则会留下点不动的死锚点 -->
    <SettingsGroup
      v-if="connectionVisible"
      anchor="account-connection"
      title="连接通道"
      hint="当前访问路径与直连可用性"
      flush
    >
      <div class="setting-row">
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
    </SettingsGroup>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api';
import SecretField from '../SecretField.vue';
import SettingsGroup from './SettingsGroup.vue';
import { useAuthStore } from '../../stores/auth';
import { useRuntimeCapabilities } from '../../lib/capabilities';
import { useSettingsAnchorVisible } from '../../lib/settingsNavVisibility';

/**
 * 「账户与访问」大类：账户凭据 + 连接通道。
 *
 * 2026-09-28 改版（方案 A「一事一类」）：
 *  - 「外观」拆到 AppearanceSection.vue，归「界面与检索」；
 *  - 「应用版本」拆到 AppVersionSection.vue，归「本机应用」；
 *  - 原来混装的「连接与版本」只剩连接通道，改名为「连接通道」，留在本大类。
 */
const auth = useAuthStore();
const { capabilities, load: loadCapabilities } = useRuntimeCapabilities();

const pwd = ref({ old: '', next: '' });
const pwdMsg = ref('');
const pwdOk = ref(false);

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

// ---------- 连接通道状态（服务器经 /health 通告直连地址；未通告则整组隐藏） ----------
const connState = ref<'loading' | 'unconfigured' | 'direct' | 'tunnel-ok' | 'tunnel'>('loading');
const directUrl = ref('');
const directLatency = ref<number | null>(null);
const directCopied = ref(false);

/** 组是否存在：Android 本地版没有直连/隧道这条链路；服务端没通告直连地址时也没有可讲的内容。
 *  探测中（loading）也按不存在算——否则隧道部署下导航里会先闪出一条「连接通道」再消失。 */
const connectionVisible = computed(
  () => capabilities.value.runtime !== 'android-local'
    && (connState.value === 'direct' || connState.value === 'tunnel-ok' || connState.value === 'tunnel'),
);
// 导航里的「连接通道」与上面的渲染条件同源（隐藏时二级项一起消失）
useSettingsAnchorVisible('account-connection', connectionVisible);

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

onMounted(async () => {
  await loadCapabilities();
  if (capabilities.value.runtime !== 'android-local') probeConn();
});
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
