<template>
  <div class="doxent-section">
    <!-- 状态条：绑定态、缺 Python、等登录三类结论都在这一条里说完 -->
    <div class="state-strip" :class="stripTone">
      <span class="state-dot" aria-hidden="true" />
      <div class="doxent-status-copy">
        <strong>{{ stripTitle }}</strong>
        <span class="doxent-status-hint">{{ stripHint }}</span>
      </div>
      <div class="setting-actions">
        <button class="btn ghost small" type="button" :disabled="loading" @click="refresh">
          {{ loading ? '检测中…' : '重新检测' }}
        </button>
      </div>
    </div>

    <ul class="value-list">
      <li class="value-row">
        <span class="value-label">Python</span>
        <span class="value-text" :class="pythonOk ? '' : 'tone-warn'">{{ pythonText }}</span>
      </li>
      <li class="value-row">
        <span class="value-label">官方技能</span>
        <span class="value-text">{{ skillText }}</span>
      </li>
      <li class="value-row">
        <span class="value-label">登录状态</span>
        <span class="value-text" :class="loginTextClass">{{ loginText }}</span>
      </li>
    </ul>

    <!-- 主操作：未绑定时是「绑定办公本」，已绑定后是解绑；登录链接单独一行，便于关掉浏览器后重新打开 -->
    <div class="setting-row">
      <div class="setting-copy">
        <strong>{{ bound ? '已绑定：内置 Agent 可以调阅办公本' : '绑定办公本' }}</strong>
        <span v-if="bound">在聊天抽屉里直接说「查一下我办公本的笔记」「把这份纪要写进办公本笔记」。新开的会话生效。</span>
        <span v-else-if="waiting">已打开浏览器：在页面里完成登录，这里会自动变成已绑定。</span>
        <span v-else>点「绑定办公本」会装官方技能并生成本人的登录链接，在浏览器里扫码 / 登录即可。</span>
      </div>
      <div class="setting-actions">
        <button
          v-if="!bound"
          class="btn small"
          type="button"
          :disabled="busy || !pythonOk"
          @click="bind"
        >
          {{ busy ? '准备中…' : (waiting ? '重新获取链接' : '绑定办公本') }}
        </button>
        <button v-else class="btn danger small" type="button" :disabled="busy" @click="unbind">
          {{ busy ? '处理中…' : '解除绑定' }}
        </button>
      </div>
    </div>

    <div v-if="loginUrl" class="setting-row doxent-link-row">
      <div class="setting-copy">
        <strong>登录链接</strong>
        <a :href="loginUrl" target="_blank" rel="noopener noreferrer">打开登录页面</a>
      </div>
      <div class="setting-actions">
        <button class="btn ghost small" type="button" @click="copyLink">复制链接</button>
        <button class="btn small" type="button" :disabled="polling" @click="checkLogin">
          {{ polling ? '确认中…' : '我已完成登录' }}
        </button>
      </div>
    </div>

    <p v-if="errorText" class="setting-note tone-warn">{{ errorText }}</p>
    <p v-else-if="!pythonOk" class="setting-note tone-warn">
      官方客户端是 Python 脚本（meta.json 要求 3.8+）：装好 Python 后点「重新检测」，或用环境变量
      <code>DOXENT_PYTHON</code> 指定解释器路径。
    </p>
    <p class="setting-note">
      技能包来自 <code>{{ status.downloadUrl || '官方下载地址' }}</code>；登录凭证由官方 CLI 自己保管，Engram 只读取登录状态，不保存账号与令牌。
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../../api';
import { notify } from '../../lib/notify';

/**
 * 设置 → Agent 与自动化 →「办公本（讯飞）」。
 *
 * 三条状态线：Python 是否可用（官方客户端是 Python 脚本）、官方技能是否已装进内置 Agent 的
 * DSH_HOME/skills、官方 CLI 当前是否已登录。绑定动作在服务端完成（装技能 + 跑 --cli-action login），
 * 这里只负责打开服务端返回的真实登录链接、轮询登录状态、解绑。
 *
 * 登录链接带一次性 pollKey：只放在页面上，不写进日志、不做本地缓存。
 */

interface DoxentPython {
  available: boolean;
  command?: string;
  args?: string[];
  version?: string;
  error?: string;
}

interface DoxentSkill {
  installed: boolean;
  version?: string;
  root: string;
  managed: boolean;
}

interface DoxentLogin {
  state: 'logged-in' | 'logged-out' | 'unknown';
  detail?: string;
}

interface DoxentStatus {
  python: DoxentPython;
  skill: DoxentSkill;
  login: DoxentLogin;
  downloadUrl: string;
}

const status = ref<DoxentStatus>({
  python: { available: false },
  skill: { installed: false, root: '', managed: false },
  login: { state: 'unknown' },
  downloadUrl: '',
});
const loading = ref(false);
const busy = ref(false);
const polling = ref(false);
const errorText = ref('');
const loginUrl = ref('');
/** 已经触发过登录、等用户去浏览器完成的阶段（决定按钮文案） */
const waiting = ref(false);

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollCount = 0;
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_TIMES = 60;

const pythonOk = computed(() => Boolean(status.value.python?.available));
const bound = computed(() => status.value.login?.state === 'logged-in');

const stripTone = computed(() => {
  if (!pythonOk.value) return 'tone-warn';
  if (bound.value) return 'tone-ok';
  return status.value.login?.state === 'unknown' ? 'tone-warn' : '';
});

const stripTitle = computed(() => {
  if (!pythonOk.value) return '环境不满足：需要 Python 3.8+';
  if (bound.value) return '已绑定办公本';
  if (!status.value.skill?.installed) return '未绑定办公本';
  return status.value.login?.state === 'unknown' ? '登录状态未知' : '已装技能，等待登录';
});

const stripHint = computed(() => {
  if (!pythonOk.value) return status.value.python?.error || '未找到可用的 Python';
  if (bound.value) return '内置 Agent 可读写笔记、Office 文档、书籍与日程。';
  if (!status.value.skill?.installed) return '绑定后会把官方技能装进内置 Agent，并生成登录链接。';
  return status.value.login?.detail || '点「绑定办公本」重新获取登录链接。';
});

const pythonText = computed(() => {
  const python = status.value.python;
  if (!python?.available) return python?.error || '未找到 Python 3.8+';
  const command = [python.command, ...(python.args ?? [])].filter(Boolean).join(' ');
  return `Python ${python.version || ''}（${command}）`.trim();
});

const skillText = computed(() => {
  const skill = status.value.skill;
  if (!skill?.installed) return '未安装';
  return skill.version ? `doxent ${skill.version} · 已装进内置 Agent` : 'doxent · 已装进内置 Agent';
});

const loginText = computed(() => {
  const state = status.value.login?.state;
  if (state === 'logged-in') return '已登录';
  if (state === 'logged-out') return '未登录';
  return status.value.login?.detail || '未知';
});

const loginTextClass = computed(() => {
  const state = status.value.login?.state;
  if (state === 'logged-in') return 'tone-ok';
  if (state === 'logged-out') return '';
  return 'tone-warn';
});

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  polling.value = false;
}

async function loadStatus(refresh = false, skillOnly = false): Promise<void> {
  loading.value = true;
  errorText.value = '';
  try {
    const params: Record<string, string> = {};
    if (refresh) params.refresh = '1';
    if (skillOnly) params.skillOnly = '1';
    const { data } = await api.get('/api/settings/doxent', { params });
    status.value = data as DoxentStatus;
  } catch (error) {
    errorText.value = errorMessage(error, '读取办公本状态失败');
  } finally {
    loading.value = false;
  }
}

/** 绑定：服务端装技能并生成登录链接，这里负责打开浏览器 */
async function bind(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  errorText.value = '';
  try {
    const { data } = await api.post('/api/settings/doxent/bind');
    const page = data?.page as { pageType: string; url: string } | undefined;
    if (data?.login) status.value = { ...status.value, login: data.login, skill: data.skill ?? status.value.skill };
    if (page?.url) {
      loginUrl.value = page.url;
      waiting.value = true;
      window.open(page.url, '_blank', 'noopener,noreferrer');
      notify.success(page.pageType === '设置' ? '已登录办公本' : '已打开登录页面');
      if (page.pageType === '设置') {
        // 官方 CLI 返回设置页 = 这台机器已经登录过：不用再等，直接刷新状态
        stopPolling();
        waiting.value = false;
        loginUrl.value = '';
        await loadStatus(true);
      } else {
        // 等用户在浏览器里完成登录：改由轮询推进，别再并发跑一次状态查询
        startPolling();
      }
    } else {
      notify.success('已绑定办公本');
      await loadStatus(true);
    }
  } catch (error) {
    errorText.value = errorMessage(error, '绑定办公本失败');
    notify.error(errorText.value);
    // 失败时技能可能已经装上（例如官方 CLI 下载失败）：只刷技能状态，别再拉起一次 CLI
    await loadStatus(false, true);
  } finally {
    busy.value = false;
  }
}

/** 用户点了「我已完成登录」：立刻查一次真实状态 */
async function checkLogin(): Promise<void> {
  if (polling.value) return;
  polling.value = true;
  try {
    const { data } = await api.get('/api/settings/doxent/login-status');
    const login = data?.login as DoxentLogin | undefined;
    if (login) status.value = { ...status.value, login };
    if (login?.state === 'logged-in') {
      stopPolling();
      waiting.value = false;
      loginUrl.value = '';
      notify.success('办公本已登录，内置 Agent 现在可以调阅资料了');
    } else {
      notify.info('还没检测到登录，浏览器里完成后再点一次');
    }
  } catch (error) {
    errorText.value = errorMessage(error, '查询登录状态失败');
  } finally {
    polling.value = false;
  }
}

function startPolling(): void {
  stopPolling();
  polling.value = true;
  pollCount = 0;
  pollTimer = setInterval(() => {
    pollCount += 1;
    if (pollCount > POLL_MAX_TIMES) {
      stopPolling();
      notify.info('超过 3 分钟仍未检测到登录，可点「我已完成登录」手动确认');
      return;
    }
    void pollOnce();
  }, POLL_INTERVAL_MS);
}

async function pollOnce(): Promise<void> {
  try {
    const { data } = await api.get('/api/settings/doxent/login-status');
    const login = data?.login as DoxentLogin | undefined;
    if (!login) return;
    status.value = { ...status.value, login };
    if (login.state === 'logged-in') {
      stopPolling();
      waiting.value = false;
      loginUrl.value = '';
      notify.success('办公本已登录，内置 Agent 现在可以调阅资料了');
    }
  } catch {
    /* 轮询失败静默：用户还能手动点「我已完成登录」 */
  }
}

/** 解绑：注销官方 CLI 会话并卸载技能目录 */
async function unbind(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  errorText.value = '';
  try {
    await api.post('/api/settings/doxent/unbind');
    stopPolling();
    waiting.value = false;
    loginUrl.value = '';
    notify.success('已解除办公本绑定');
    await loadStatus(true);
  } catch (error) {
    errorText.value = errorMessage(error, '解除绑定失败');
    notify.error(errorText.value);
  } finally {
    busy.value = false;
  }
}

async function refresh(): Promise<void> {
  await loadStatus(true);
}

async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(loginUrl.value);
    notify.success('已复制登录链接');
  } catch {
    notify.error('复制失败');
  }
}

function errorMessage(error: unknown, fallback: string): string {
  const response = (error as { response?: { data?: { error?: string } } })?.response;
  return response?.data?.error || (error instanceof Error ? error.message : '') || fallback;
}

onMounted(() => {
  void loadStatus(false);
});

onBeforeUnmount(stopPolling);
</script>

<style scoped>
.doxent-status-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.doxent-status-hint {
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.doxent-link-row {
  margin-top: 4px;
}
.doxent-link-row a {
  font-size: 13px;
  overflow-wrap: anywhere;
}
</style>
