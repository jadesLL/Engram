<template>
  <div class="login-wrap">
    <div class="login-card card">
      <div class="logo">
        <svg viewBox="0 0 100 100" width="28" height="28" aria-hidden="true">
          <defs>
            <linearGradient id="engram-orbit-login" gradientUnits="userSpaceOnUse" x1="24" y1="76" x2="76" y2="22">
              <stop offset="0" stop-color="#22D3EE" />
              <stop offset="1" stop-color="#4D8AFF" />
            </linearGradient>
            <linearGradient id="engram-core-login" gradientUnits="userSpaceOnUse" x1="39" y1="39" x2="61" y2="61">
              <stop offset="0" stop-color="#4D8AFF" />
              <stop offset="1" stop-color="#245BDB" />
            </linearGradient>
          </defs>
          <ellipse cx="50" cy="50" rx="36" ry="15.5" fill="none" stroke="url(#engram-orbit-login)" stroke-width="8.5" transform="rotate(-28 50 50)" />
          <circle cx="74" cy="28.5" r="5" fill="#22D3EE" />
          <circle cx="50" cy="50" r="11" fill="url(#engram-core-login)" />
        </svg>
      </div>
      <h1>Engram</h1>
      <p class="muted">{{ isSetup ? '首次使用，请设置访问密码' : '请输入密码进入知识库' }}</p>
      <SecretField
        v-model="password"
        :placeholder="isSetup ? '设置密码（至少6位）' : '密码'"
        :aria-label="isSetup ? '设置密码（至少6位）' : '密码'"
        autofocus
        @keyup.enter="submit"
        @keyup="checkCaps"
      />
      <SecretField
        v-if="isSetup"
        v-model="confirm"
        placeholder="确认密码"
        aria-label="确认密码"
        @keyup.enter="submit"
        @keyup="checkCaps"
      />
      <p v-if="capsOn" class="caps-hint">
        <Icon name="activity" :size="12" />
        大写锁定（Caps Lock）已开启
      </p>
      <div v-if="isSetup && password" class="pwd-strength">
        <span class="strength-bar">
          <span class="strength-fill" :class="strength.level" :style="{ width: strength.percent + '%' }"></span>
        </span>
        <span class="strength-label" :class="strength.level">{{ strength.label }}</span>
      </div>
      <button class="btn primary" :disabled="loading" @click="submit">
        {{ loading ? '请稍候…' : isSetup ? '初始化并进入' : '进入' }}
      </button>
      <p v-if="error" class="error">{{ error }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { api } from '../api';
import Icon from '../components/Icon.vue';
import SecretField from '../components/SecretField.vue';

const router = useRouter();
const auth = useAuthStore();
const password = ref('');
const confirm = ref('');
const error = ref('');
const loading = ref(false);
const isSetup = ref(false);
const capsOn = ref(false);

const strength = computed(() => {
  const pwd = password.value;
  if (!pwd) return { level: 'weak', percent: 0, label: '' };
  let score = 0;
  if (pwd.length >= 6) score += 25;
  if (pwd.length >= 10) score += 20;
  if (/[a-z]/.test(pwd) && /[A-Z]/.test(pwd)) score += 20;
  if (/\d/.test(pwd)) score += 15;
  if (/[^a-zA-Z0-9]/.test(pwd)) score += 20;
  if (score < 40) return { level: 'weak', percent: Math.max(20, score), label: '弱' };
  if (score < 70) return { level: 'medium', percent: score, label: '中' };
  return { level: 'strong', percent: score, label: '强' };
});

function checkCaps(e: KeyboardEvent) {
  capsOn.value = e.getModifierState?.('CapsLock') || false;
}

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
  if (isSetup.value && password.value.length < 6) {
    error.value = '密码至少需要 6 位';
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
  background: var(--bg);
}
.login-card {
  width: min(340px, calc(100vw - 32px));
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 32px 28px;
  box-shadow: var(--shadow-dialog);
}
.logo {
  width: 44px;
  height: 44px;
  margin: 0 auto;
  border-radius: 8px;
  background: #0f172a;
  display: flex;
  align-items: center;
  justify-content: center;
}
h1 { margin: 0; font-size: 20px; text-align: center; font-weight: 600; }
p { margin: 0; text-align: center; }
.btn { justify-content: center; }
.error { color: var(--danger); font-size: var(--font-md); }

.caps-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  color: var(--warning);
  font-size: 11px;
}

.pwd-strength {
  display: flex;
  align-items: center;
  gap: 8px;
}
.strength-bar {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--bg-tertiary);
  overflow: hidden;
}
.strength-fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  transition: width 200ms ease, background 200ms ease;
}
.strength-fill.weak { background: var(--danger); }
.strength-fill.medium { background: var(--warning); }
.strength-fill.strong { background: var(--success); }
.strength-label { font-size: 11px; font-weight: 600; min-width: 16px; text-align: center; }
.strength-label.weak { color: var(--danger); }
.strength-label.medium { color: var(--warning); }
.strength-label.strong { color: var(--success); }
</style>

