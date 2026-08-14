<template>
  <div class="login-wrap">
    <div class="login-card card">
      <div class="logo">W</div>
      <h1>LLM Wiki</h1>
      <p class="muted">{{ isSetup ? '首次使用，请设置访问密码' : '请输入密码进入知识库' }}</p>
      <input
        v-model="password"
        type="password"
        :placeholder="isSetup ? '设置密码（至少6位）' : '密码'"
        autofocus
        @keyup.enter="submit"
      />
      <input
        v-if="isSetup"
        v-model="confirm"
        type="password"
        placeholder="确认密码"
        @keyup.enter="submit"
      />
      <button class="btn primary" :disabled="loading" @click="submit">
        {{ loading ? '请稍候…' : isSetup ? '初始化并进入' : '进入' }}
      </button>
      <p v-if="error" class="error">{{ error }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { api } from '../api';

const router = useRouter();
const auth = useAuthStore();
const password = ref('');
const confirm = ref('');
const error = ref('');
const loading = ref(false);
const isSetup = ref(false);

onMounted(async () => {
  const { data } = await api.get('/api/auth/status');
  isSetup.value = !data.initialized;
});

async function submit() {
  error.value = '';
  if (isSetup.value && password.value !== confirm.value) {
    error.value = '两次输入的密码不一致';
    return;
  }
  loading.value = true;
  try {
    await auth.login(password.value, isSetup.value);
    router.push('/');
  } catch (e: any) {
    error.value = e.response?.data?.error || '登录失败';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-wrap {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
}
.login-card {
  width: min(340px, calc(100vw - 32px));
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 32px 28px;
  box-shadow: var(--shadow);
}
.logo {
  width: 44px;
  height: 44px;
  margin: 0 auto;
  border-radius: 11px;
  background: var(--text);
  color: var(--bg);
  font-size: 22px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
h1 { margin: 0; font-size: 20px; text-align: center; font-weight: 600; }
p { margin: 0; text-align: center; }
.btn { justify-content: center; }
.error { color: var(--danger); font-size: var(--font-md); }
</style>
