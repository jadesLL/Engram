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
          <strong>应用版本</strong>
          <span>当前安装的 ExampleProject 版本。</span>
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

@media (max-width: 768px) {
  .password-controls {
    width: 100%;
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
