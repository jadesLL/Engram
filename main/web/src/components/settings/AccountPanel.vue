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
          <input v-model="pwd.old" type="password" autocomplete="current-password" placeholder="原密码" aria-label="原密码" />
          <input v-model="pwd.next" type="password" autocomplete="new-password" placeholder="新密码" aria-label="新密码" />
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

      <div class="setting-row">
        <div class="setting-copy">
          <strong>当前会话</strong>
          <span>退出后需要重新输入密码。</span>
        </div>
        <button class="btn danger" type="button" @click="logout">退出登录</button>
      </div>

      <div class="setting-row">
        <div class="setting-copy">
          <strong>连接通道</strong>
          <span>
            当前访问路径{{ conn.directUrl ? '与 IPv6 直连可达性' : '' }}。
            <template v-if="conn.directUrl">
              直连可达时客户端可自动切换（低延迟）；不可达走 Cloudflare 隧道。
            </template>
            <template v-else>服务器未配置直连地址（DIRECT_ACCESS_URL）。</template>
          </span>
        </div>
        <div class="conn-status">
          <template v-if="conn.loading">
            <span class="conn-badge testing">检测中…</span>
          </template>
          <template v-else-if="conn.currentIsDirect">
            <span class="conn-badge direct">IPv6 直连</span>
          </template>
          <template v-else-if="conn.directUrl && conn.directOk">
            <span class="conn-badge tunnel">隧道（直连可用）</span>
          </template>
          <template v-else-if="conn.directUrl">
            <span class="conn-badge tunnel-only">隧道</span>
          </template>
          <template v-else>
            <span class="conn-badge tunnel-only">隧道</span>
          </template>
          <button class="btn" type="button" :disabled="conn.loading" @click="probeConn">重测</button>
        </div>
        <p v-if="conn.directUrl && !conn.loading" class="setting-message conn-detail">
          当前 origin：<code>{{ conn.currentOrigin }}</code>
          <template v-if="!conn.currentIsDirect">；直连地址：<code>{{ conn.directUrl }}</code>
          {{ conn.directOk ? '（可达 ' + conn.directMs + 'ms）' : '（不可达）' }}</template>
        </p>
      </div>

      <div class="setting-row">
        <div class="setting-copy">
          <strong>应用版本</strong>
          <span>当前安装的 Engram 版本。</span>
        </div>
        <code class="app-version">{{ APP_VERSION }}</code>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { api } from '../../api';
import { useAppStore } from '../../stores/app';
import { useAuthStore } from '../../stores/auth';
import { APP_VERSION } from '../../version';

const app = useAppStore();
const auth = useAuthStore();

const pwd = ref({ old: '', next: '' });
const pwdMsg = ref('');
const pwdOk = ref(false);

/** 连接通道状态：当前 origin 是否直连、direct 地址可达性与延迟 */
const conn = ref({
  loading: true,
  currentOrigin: '',
  currentIsDirect: false,
  directUrl: '' as string,
  directOk: false,
  directMs: 0,
});

async function probeConn() {
  const c = conn.value;
  c.loading = true;
  c.currentOrigin = location.origin;
  try {
    const r = await api.get('/health');
    const h = typeof r.data === 'string' ? { ok: r.data } : r.data || {};
    c.directUrl = h.direct || '';
  } catch {
    c.directUrl = '';
  }
  c.currentIsDirect = Boolean(c.directUrl) && c.currentOrigin === c.directUrl.replace(/\/+$/, '');
  if (c.directUrl && !c.currentIsDirect) {
    const t0 = performance.now();
    try {
      await fetch(c.directUrl + '/health', { mode: 'no-cors', cache: 'no-store' });
      c.directOk = true;
      c.directMs = Math.round(performance.now() - t0);
    } catch {
      c.directOk = false;
    }
  } else {
    c.directOk = false;
  }
  c.loading = false;
}

probeConn();

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
.password-controls {
  display: grid;
  grid-template-columns: minmax(130px, 1fr) minmax(130px, 1fr) auto;
  gap: 8px;
  width: min(530px, 100%);
}

@media (max-width: 1024px) {
  .password-controls {
    grid-template-columns: 1fr 1fr;
  }
  .password-controls .btn {
    grid-column: 1 / -1;
    justify-self: end;
  }
}

.conn-status {
  display: flex;
  align-items: center;
  gap: 8px;
}
.conn-badge {
  display: inline-flex;
  align-items: center;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
}
.conn-badge.direct {
  background: rgba(47, 158, 68, 0.14);
  color: #2f9e44;
}
.conn-badge.tunnel {
  background: rgba(61, 123, 255, 0.14);
  color: #3d7bff;
}
.conn-badge.tunnel-only {
  background: rgba(138, 144, 153, 0.16);
  color: #6b7280;
}
.conn-badge.testing {
  background: rgba(138, 144, 153, 0.16);
  color: #9aa0a6;
}
.conn-detail {
  margin: 0;
  font-size: 12.5px;
}
.conn-detail code {
  font-size: 12px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(138, 144, 153, 0.14);
}

@media (max-width: 768px) {
  .password-controls {
    width: 100%;
  }
  .conn-detail {
    word-break: break-all;
  }
}

@media (max-width: 640px) {
  .password-controls {
    grid-template-columns: 1fr;
  }
  .password-controls .btn {
    grid-column: auto;
    width: 100%;
  }
}
</style>
