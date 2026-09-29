<template>
  <div class="login-wrap">
    <div class="login-card card">
      <div class="logo">
        <BrandMark :size="52" />
      </div>
      <h1>Engram</h1>
      <p class="muted">{{ isSetup ? '首次使用，请设置访问密码' : '请输入密码进入知识库' }}</p>

      <!-- 系统解锁（手机端）：已经开过指纹/人脸的设备，这一颗就是主入口。
           点它弹的是**系统自己的**解锁界面（BiometricPrompt / 锁屏验证），我们不自绘。 -->
      <template v-if="biometricReady">
        <button class="btn primary bio-unlock" type="button" :disabled="loading" @click="unlockBySystem">
          <Icon name="fingerprint" :size="17" />
          <span>{{ loading ? '请稍候…' : biometricLabel }}</span>
        </button>
        <p class="bio-or">或输入密码</p>
      </template>

      <SecretField
        v-model="password"
        :placeholder="isSetup ? '设置密码（至少6位）' : '密码'"
        :aria-label="isSetup ? '设置密码（至少6位）' : '密码'"
        :autofocus="!biometricReady"
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
      <!-- 首次输入密码时顺手开启系统解锁：密码交给系统安全区保管，应用只持有密文 -->
      <label v-if="biometricOffer" class="bio-remember">
        <input v-model="rememberLogin" type="checkbox" />
        <span>记住密码，下次用系统指纹 / 人脸直接进入</span>
      </label>
      <button class="btn primary" :disabled="loading" @click="submit">
        {{ loading ? '请稍候…' : isSetup ? '初始化并进入' : '进入' }}
      </button>
      <!-- 关掉系统解锁的入口就放在它旁边：换过密码、不想再用的用户当场能退 -->
      <button v-if="biometricReady" class="bio-forget" type="button" @click="disableBiometric">
        关闭指纹 / 人脸解锁
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
import { notify } from '../lib/notify';
import {
  biometricButtonLabel,
  biometricStatus,
  forgetPassword,
  rememberPassword,
  unlockWithSystem,
  type BiometricStatus,
} from '../lib/biometric';
import Icon from '../components/Icon.vue';
import SecretField from '../components/SecretField.vue';
import BrandMark from '../components/BrandMark.vue';

const router = useRouter();
const auth = useAuthStore();
const password = ref('');
const confirm = ref('');
const error = ref('');
const loading = ref(false);
const isSetup = ref(false);
const capsOn = ref(false);
/** 系统解锁能力与「有没有记住密码」；桌面/网页端恒为 null（整块不渲染） */
const bio = ref<BiometricStatus | null>(null);
const rememberLogin = ref(true);
const biometricReady = computed(() => Boolean(bio.value?.available && bio.value?.saved && !isSetup.value));
// 首次设置密码时也能顺手开启（这一步之后就不用再输一次密码来开它了）
const biometricOffer = computed(() => Boolean(bio.value?.available && !bio.value?.saved));
const biometricLabel = computed(() => biometricButtonLabel(bio.value?.kind ?? 'biometric'));

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
  // 系统解锁能力是同步读的（原生桥是同步接口），先读一次再问服务端状态，
  // 免得登录页先闪一下密码框、再换成指纹按钮
  bio.value = biometricStatus();
  const { data } = await api.get('/api/auth/status');
  isSetup.value = !data.initialized;
});

/** 系统解锁成功后拿回来的密码：走与手输完全相同的登录通道，服务端不区分来源 */
async function unlockBySystem() {
  error.value = '';
  loading.value = true;
  try {
    const result = await unlockWithSystem();
    if (!result.ok || !result.password) {
      // 用户主动取消不算错误；其余情况给出可操作的提示
      if (result.reason !== 'canceled') error.value = '系统解锁未通过，请改用密码登录';
      bio.value = biometricStatus();
      return;
    }
    await auth.login(result.password, false);
    router.push('/');
  } catch {
    // 记住了旧密码（用户在别处改过密码）时，清掉它并退回手输，别让人反复撞 401
    forgetPassword();
    bio.value = biometricStatus();
    error.value = '记住的密码已失效，请手动输入密码';
  } finally {
    loading.value = false;
  }
}

function disableBiometric() {
  forgetPassword();
  bio.value = biometricStatus();
  notify.info('已关闭指纹 / 人脸解锁');
}

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
    // 密码校验通过后再交给系统安全区：密码错的开启请求没有任何意义
    if (biometricOffer.value && rememberLogin.value && rememberPassword(password.value)) {
      notify.success('已开启指纹 / 人脸解锁');
    }
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
  /* 顶部浅蓝光晕过渡到中性底，品牌感但不喧宾夺主 */
  background:
    radial-gradient(1100px 560px at 50% -12%, rgba(15, 108, 189, 0.10) 0%, rgba(15, 108, 189, 0) 62%),
    var(--bg);
}
html.dark .login-wrap {
  background:
    radial-gradient(1100px 560px at 50% -12%, rgba(90, 169, 230, 0.12) 0%, rgba(90, 169, 230, 0) 62%),
    var(--bg);
}
.login-card {
  width: min(360px, calc(100vw - 32px));
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 36px 32px;
  border-radius: 16px;
  box-shadow:
    0 16px 40px rgba(31, 30, 29, 0.10),
    0 2px 8px rgba(31, 30, 29, 0.05);
}
html.dark .login-card {
  box-shadow:
    0 16px 40px rgba(0, 0, 0, 0.45),
    0 2px 8px rgba(0, 0, 0, 0.3);
}
/* 品牌图标：盒装贴片由 SVG 自带，这里只负责居中与投影 */
.logo {
  width: 52px;
  height: 52px;
  margin: 0 auto 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  filter: drop-shadow(0 6px 16px rgba(15, 108, 189, 0.3));
}
html.dark .logo {
  filter: drop-shadow(0 6px 16px rgba(0, 0, 0, 0.5));
}
h1 { margin: 0; font-size: 20px; text-align: center; font-weight: 600; }
p { margin: 0; text-align: center; }
.btn { justify-content: center; }
.error { color: var(--danger); font-size: var(--font-md); }

/* ---------- 系统解锁（手机端） ---------- */
/* 解锁按钮就是主按钮，只是更高一点：手机上这是最主要的入口 */
.bio-unlock {
  height: 44px;
  gap: 8px;
  font-weight: 600;
}

/* 「或输入密码」：一条细分隔线，明确下面那套还是可用的 */
.bio-or {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text-faint);
  font-size: 12px;
}
.bio-or::before,
.bio-or::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
}

/* 开启开关：整行可点（label 包着 checkbox），触屏上 44px 高 */
.bio-remember {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.4;
  cursor: pointer;
}
@media (hover: none) and (pointer: coarse) {
  .bio-remember { min-height: 44px; }
}
.bio-remember input {
  width: 16px;
  height: 16px;
  flex: none;
  accent-color: var(--accent);
}

.bio-forget {
  align-self: center;
  padding: 4px 8px;
  border-radius: 6px;
  color: var(--text-faint);
  font-size: 12px;
}
.bio-forget:hover { color: var(--text-secondary); }
.bio-forget:active { background: var(--press-bg); }

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

