<template>
  <div class="doxent-section">
    <!-- 办公本类型：目前只实装讯飞（Doxent）。下拉是后续品牌的唯一入口，分组名保持中性的「办公本接入」 -->
    <div class="setting-row">
      <div class="setting-copy">
        <strong>办公本类型</strong>
        <span v-if="bound">已绑定讯飞办公本；要换品牌请先解除绑定。</span>
        <span v-else>选择要接入的办公本品牌，目前支持讯飞。</span>
      </div>
      <div class="setting-control doxent-type-control">
        <AppSelect
          v-model="notebookType"
          aria-label="办公本类型"
          :options="notebookTypeOptions"
          :disabled="binding || busy || bound"
        />
      </div>
    </div>

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
        <span v-else-if="binding" class="doxent-progress" aria-live="polite">
          {{ bindProgressText }}已等待 {{ bindElapsedText }}。离开本页再回来会接着显示进度。
        </span>
        <span v-else-if="waiting">已打开浏览器：在页面里完成登录，这里会自动变成已绑定。</span>
        <span v-else>点「绑定办公本」会装官方技能并生成本人的登录链接，在浏览器里扫码 / 登录即可。</span>
      </div>
      <div class="setting-actions">
        <button
          v-if="!bound"
          class="btn small"
          type="button"
          :disabled="binding || busy || !pythonOk"
          @click="bind"
        >
          {{ binding ? '准备中…' : (waiting ? '重新获取链接' : '绑定办公本') }}
        </button>
        <button v-else class="btn danger small" type="button" :disabled="binding || busy" @click="unbind">
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
        <button class="btn small" type="button" :disabled="checking" @click="checkLogin">
          {{ checking ? '确认中…' : '我已完成登录' }}
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
import AppSelect from '../ui/AppSelect.vue';

/**
 * 设置 → Agent 与自动化 →「办公本接入」。
 *
 * 三条状态线：Python 是否可用（官方客户端是 Python 脚本）、官方技能是否已装进内置 Agent 的
 * DSH_HOME/skills、官方 CLI 当前是否已登录。绑定动作在服务端后台完成（装技能 + 跑 --cli-action login），
 * 这里轮询绑定任务拿阶段与真实登录链接，再轮询登录状态、负责解绑。
 *
 * 为什么绑定不再用一个长请求硬等：首次要下载技能包并启动官方 CLI，可能 1–3 分钟；旧版只显示
 * 「准备中…」，看起来像卡死。现在服务端立即返回任务，设置页每秒刷新阶段和已等待时长。
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

interface DoxentLoginBlock {
  pageType: '登录' | '设置';
  url: string;
}

interface DoxentBindJob {
  state: 'running' | 'done' | 'error';
  step: 'install' | 'login';
  startedAt: number;
  finishedAt?: number;
  skill?: DoxentSkill;
  login?: DoxentLogin;
  page?: DoxentLoginBlock;
  error?: string;
}

interface DoxentStatus {
  python: DoxentPython;
  skill: DoxentSkill;
  login: DoxentLogin;
  downloadUrl: string;
  /** 进行中 / 刚结束的绑定任务（服务端重启后为 null） */
  bind?: DoxentBindJob | null;
}

/** 办公本品牌：目前只实现讯飞（Doxent）。新增品牌时在这里加选项，并在服务端补对应接入。 */
type NotebookType = 'iflytek';
const NOTEBOOK_TYPES: Array<{ value: NotebookType; label: string }> = [{ value: 'iflytek', label: '讯飞办公本' }];

const status = ref<DoxentStatus>({
  python: { available: false },
  skill: { installed: false, root: '', managed: false },
  login: { state: 'unknown' },
  downloadUrl: '',
  bind: null,
});
const loading = ref(false);
/** 解绑等一次性动作 */
const busy = ref(false);
/** 手动点「我已完成登录」的那一次查询（后台轮询不影响按钮） */
const checking = ref(false);
const errorText = ref('');
const loginUrl = ref('');
/** 已经触发过登录、等用户去浏览器完成的阶段（决定按钮文案） */
const waiting = ref(false);
const notebookType = ref<NotebookType>('iflytek');
const notebookTypeOptions = NOTEBOOK_TYPES;
const bindJob = ref<DoxentBindJob | null>(null);
/** 绑定计时器的时钟：让「已等待 N 秒」自己走，用户能看出服务端还活着 */
const now = ref(Date.now());

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollCount = 0;
/** 后台登录态轮询进行中：上一轮没回来就跳过这一轮，避免请求叠罗汉 */
let loginPollInFlight = false;
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_TIMES = 60;

let bindTimer: ReturnType<typeof setInterval> | null = null;
let bindPollInFlight = false;
const BIND_POLL_INTERVAL_MS = 1000;

const pythonOk = computed(() => Boolean(status.value.python?.available));
const bound = computed(() => status.value.login?.state === 'logged-in');
const binding = computed(() => bindJob.value?.state === 'running');

const bindProgressText = computed(() => {
  if (!binding.value) return '';
  return bindJob.value?.step === 'login'
    ? '正在启动官方客户端并生成登录链接（首次可能要 1–2 分钟）…'
    : '正在下载并安装官方技能包（首次约 30–60 秒）…';
});

const bindElapsedText = computed(() => {
  if (!binding.value) return '';
  const startedAt = bindJob.value?.startedAt || now.value;
  const seconds = Math.max(0, Math.floor((now.value - startedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
});

const stripTone = computed(() => {
  if (!pythonOk.value) return 'tone-warn';
  if (bound.value) return 'tone-ok';
  return status.value.login?.state === 'unknown' ? 'tone-warn' : '';
});

const stripTitle = computed(() => {
  if (!pythonOk.value) return '环境不满足：需要 Python 3.8+';
  if (binding.value) return '正在准备绑定办公本';
  if (bound.value) return '已绑定办公本';
  if (!status.value.skill?.installed) return '未绑定办公本';
  return status.value.login?.state === 'unknown' ? '登录状态未知' : '已装技能，等待登录';
});

const stripHint = computed(() => {
  if (!pythonOk.value) return status.value.python?.error || '未找到可用的 Python';
  if (binding.value) return bindProgressText.value;
  if (bound.value) return '内置 Agent 可读写笔记、Office 文档、书籍与日程。';
  if (waiting.value) return '已打开浏览器：在页面里完成登录，这里会自动变成已绑定。';
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
  loginPollInFlight = false;
}

function stopBindPolling(): void {
  if (bindTimer) clearInterval(bindTimer);
  bindTimer = null;
}

async function loadStatus(refresh = false, skillOnly = false, keepError = false): Promise<void> {
  loading.value = true;
  if (!keepError) errorText.value = '';
  try {
    const params: Record<string, string> = {};
    if (refresh) params.refresh = '1';
    if (skillOnly) params.skillOnly = '1';
    const { data } = await api.get('/api/settings/doxent', { params });
    status.value = data as DoxentStatus;
    const job = status.value.bind;
    if (job?.state === 'running') {
      bindJob.value = job;
      startBindPolling();
    } else if (binding.value && !job) {
      // 服务端重启 / 任务被清理：别让按钮永远停在「准备中」
      bindJob.value = null;
      stopBindPolling();
      notify.info('绑定任务已中断，请重新点「绑定办公本」');
    }
  } catch (error) {
    errorText.value = errorMessage(error, '读取办公本状态失败');
  } finally {
    loading.value = false;
  }
}

/** 绑定：启动服务端后台任务，这里每秒看一次阶段，拿到链接后打开浏览器 */
async function bind(): Promise<void> {
  if (binding.value || busy.value) return;
  errorText.value = '';
  stopPolling();
  stopBindPolling();
  waiting.value = false;
  loginUrl.value = '';
  bindJob.value = null;
  try {
    const { data } = await api.post('/api/settings/doxent/bind');
    const job = data?.job as DoxentBindJob | undefined;
    if (job) {
      bindJob.value = job;
      if (job.state === 'running') startBindPolling();
      else await applyBindResult(job);
    } else {
      // 服务端没有返回任务快照（旧版接口）：别猜结果，回到状态卡
      await loadStatus(false, true);
    }
  } catch (error) {
    errorText.value = errorMessage(error, '绑定办公本失败');
    notify.error(errorText.value);
    // 请求失败不代表任务没启动：刷新状态，服务端还在跑就接着显示进度；不要覆盖错误说明
    await loadStatus(false, true, true);
  }
}

function startBindPolling(): void {
  stopBindPolling();
  now.value = Date.now();
  bindTimer = setInterval(() => {
    now.value = Date.now();
    void pollBindOnce();
  }, BIND_POLL_INTERVAL_MS);
}

async function pollBindOnce(): Promise<void> {
  if (bindPollInFlight) return;
  bindPollInFlight = true;
  try {
    const { data } = await api.get('/api/settings/doxent/bind');
    const job = (data?.job ?? null) as DoxentBindJob | null;
    if (!job) {
      bindJob.value = null;
      stopBindPolling();
      notify.info('绑定任务已中断，请重新点「绑定办公本」');
      return;
    }
    bindJob.value = job;
    if (job.state === 'running') return;
    stopBindPolling();
    if (job.state === 'error') {
      errorText.value = job.error || '绑定办公本失败';
      notify.error(errorText.value);
      // 只刷「Python / 技能」：失败时别再拉起一次官方 CLI；错误说明要留在卡片上
      await loadStatus(false, true, true);
      return;
    }
    await applyBindResult(job);
  } catch {
    /* 网络抖动：保持轮询，下一轮再试；不能把一次失败当成绑定失败 */
  } finally {
    bindPollInFlight = false;
  }
}

/** 绑定任务完成：按官方返回的「登录 / 设置」页决定是打开浏览器还是直接算已登录 */
async function applyBindResult(job: DoxentBindJob): Promise<void> {
  bindJob.value = job;
  if (job.login) {
    status.value = { ...status.value, login: job.login, skill: job.skill ?? status.value.skill };
  }
  const page = job.page;
  if (!page?.url) {
    notify.success('已绑定办公本');
    await loadStatus(false, true);
    return;
  }
  if (page.pageType === '设置') {
    // 官方 CLI 返回设置页 = 这台机器已经登录过：不用再等，直接刷新状态
    waiting.value = false;
    loginUrl.value = '';
    notify.success('已登录办公本');
    await loadStatus(false, true);
    return;
  }
  loginUrl.value = page.url;
  waiting.value = true;
  // 绑定任务完成是在轮询回调里，浏览器可能拦截 window.open：页面上的登录链接是兜底入口
  window.open(page.url, '_blank', 'noopener,noreferrer');
  notify.success('登录链接已生成；浏览器没弹出就点下方「打开登录页面」');
  startPolling();
}

/** 用户点了「我已完成登录」：立刻查一次真实状态 */
async function checkLogin(): Promise<void> {
  if (checking.value) return;
  checking.value = true;
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
    checking.value = false;
  }
}

function startPolling(): void {
  stopPolling();
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
  if (loginPollInFlight) return;
  loginPollInFlight = true;
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
  } finally {
    loginPollInFlight = false;
  }
}

/** 解绑：注销官方 CLI 会话并卸载技能目录 */
async function unbind(): Promise<void> {
  if (binding.value || busy.value) return;
  busy.value = true;
  errorText.value = '';
  try {
    await api.post('/api/settings/doxent/unbind');
    stopPolling();
    stopBindPolling();
    bindJob.value = null;
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

onBeforeUnmount(() => {
  stopPolling();
  stopBindPolling();
});
</script>

<style scoped>
.doxent-type-control {
  min-width: 160px;
}
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
.doxent-progress {
  color: var(--accent);
}
.doxent-link-row {
  margin-top: 4px;
}
.doxent-link-row a {
  font-size: 13px;
  overflow-wrap: anywhere;
}
</style>
