<template>
  <div class="doxent-section">
    <!-- 办公本类型：目前只实装讯飞（Doxent）。下拉是后续品牌的唯一入口，分组名保持中性的「办公本接入」 -->
    <div class="setting-row">
      <div class="setting-copy">
        <strong>办公本类型</strong>
        <span v-if="bound">已绑定讯飞办公本；要换品牌请先解除绑定，只换账号可直接点下方「切换账号」。</span>
        <span v-else-if="syncing">其他设备同步来的登录凭据正在应用，类型先锁定。</span>
        <span v-else>选择要接入的办公本品牌，目前支持讯飞；类型与登录凭据随「设置」分类同步。</span>
      </div>
      <div class="setting-control doxent-type-control">
        <AppSelect
          v-model="notebookType"
          aria-label="办公本类型"
          :options="notebookTypeOptions"
          :disabled="binding || busy || bound || savingType || syncing"
          @change="saveNotebookType"
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
      <li v-if="bound" class="value-row">
        <span class="value-label">当前账号</span>
        <span class="value-text">{{ accountText }}</span>
      </li>
    </ul>

    <!-- 主操作：未绑定时是「绑定办公本」，已绑定后是「切换账号 / 解除绑定」；登录链接单独一行，便于关掉浏览器后重新打开 -->
    <div class="setting-row">
      <div class="setting-copy">
        <strong>{{ bound ? '已绑定：内置 Agent 可以调阅办公本' : '绑定办公本' }}</strong>
        <span v-if="bound">在聊天抽屉里直接说「查一下我办公本的笔记」「把这份纪要写进办公本笔记」。新开的会话生效。</span>
        <span v-else-if="binding" class="doxent-progress" aria-live="polite">
          {{ bindProgressText }}已等待 {{ bindElapsedText }}。离开本页再回来会接着显示进度。
        </span>
        <span v-else-if="syncing" class="doxent-progress" aria-live="polite">
          {{ syncDetail }}完成后这里会自动变成已绑定，无需再扫码。
        </span>
        <span v-else-if="waiting">已打开浏览器：在页面里完成登录，这里会自动变成已绑定。</span>
        <span v-else>点「绑定办公本」会装官方技能并生成本人的登录链接，在浏览器里扫码 / 登录即可。</span>
      </div>
      <div class="setting-actions">
        <button
          v-if="!bound"
          class="btn small"
          type="button"
          :disabled="binding || busy || syncing || savingType || !pythonOk"
          @click="bind"
        >
          {{ binding ? (switching ? '切换中…' : '准备中…') : syncing ? '同步中…' : (waiting ? '重新获取链接' : switchRequested ? '切换中…' : '绑定办公本') }}
        </button>
        <template v-else>
          <button
            class="btn ghost small"
            type="button"
            :disabled="binding || busy || syncing || savingType || !pythonOk"
            @click="switchAccount"
          >
            {{ switching ? '切换中…' : '切换账号' }}
          </button>
          <button class="btn danger small" type="button" :disabled="binding || busy || syncing" @click="unbind">
            {{ busy ? '处理中…' : '解除绑定' }}
          </button>
        </template>
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
    <p v-if="bound && accountFallback" class="setting-note">
      官方 CLI 的扫码 / 旧版会话没有记录手机号，这里用脱敏的用户 ID 展示当前账号；不影响读写办公本资料。
    </p>
    <p class="setting-note">
      技能包来自 <code>{{ status.downloadUrl || '官方下载地址' }}</code>；登录凭据由官方 CLI 生成，开启「设置」分类同步后 Engram 只在本机与同步群组之间转存官方 CLI 的会话文件，不读取账号密码。
    </p>
    <p v-if="settingsSyncOff" class="setting-note tone-warn">
      当前已加入多端同步，但「设置」分类同步未开启：办公本类型与登录凭据不会跨设备同步。到「多端同步 → 同步内容」打开「设置」即可。
    </p>
    <p v-else-if="sync.settingsEnabled && sync.role !== 'none'" class="setting-note">
      办公本类型与登录凭据会随「设置」分类同步；在任一设备完成绑定后，其他设备会自动应用登录态，无需重复扫码。切换账号会先让同步设备一起退出旧账号，新账号登录成功后自动切过去。
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../../api';
import { confirmDialog } from '../../lib/confirm';
import { notify } from '../../lib/notify';
import AppSelect from '../ui/AppSelect.vue';

/**
 * 设置 → Agent 与自动化 →「办公本接入」。
 *
 * 三条状态线：Python 是否可用（官方客户端是 Python 脚本）、官方技能是否已装进内置 Agent 的
 * DSH_HOME/skills、官方 CLI 当前是否已登录。绑定动作在服务端后台完成（装技能 + 跑 --cli-action login），
 * 这里轮询绑定任务拿阶段与真实登录链接，再轮询登录状态、负责解绑。
 *
 * 已登录时多显示一行「当前账号」：服务端只回由官方 CLI 会话派生的脱敏展示值（手机号或用户 ID
 * 尾号）。「切换账号」会先退出旧会话（同步设备一起退出）、再生成新账号的登录链接，走的还是
 * 同一个后台任务，所以进度、计时和刷新恢复逻辑与绑定完全一致。
 *
 * 为什么绑定不再用一个长请求硬等：首次要下载技能包并启动官方 CLI，可能 1–3 分钟；旧版只显示
 * 「准备中…」，看起来像卡死。现在服务端立即返回任务，设置页每秒刷新阶段和已等待时长。
 *
 * 登录链接带一次性 pollKey：只放在页面上，不写进日志、不做本地缓存。
 */

interface DoxentAccount {
  /** 脱敏后的展示值（手机号 138 **** 5678 / 用户名 / 用户 ID 2110 **** 3250） */
  display: string;
  /** false = 官方会话没记录手机号，display 是用户 ID 兜底 */
  recorded: boolean;
}

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
  /** 已登录时的当前账号（脱敏；不含任何凭据） */
  account?: DoxentAccount;
}

interface DoxentLoginBlock {
  pageType: '登录' | '设置';
  url: string;
}

interface DoxentBindJob {
  state: 'running' | 'done' | 'error';
  step: 'logout' | 'install' | 'login';
  /** bind=绑定；switch=换账号（旧任务可能没有这个字段，按 bind 处理） */
  reason?: 'bind' | 'switch';
  startedAt: number;
  finishedAt?: number;
  skill?: DoxentSkill;
  login?: DoxentLogin;
  page?: DoxentLoginBlock;
  error?: string;
}

interface DoxentConfig {
  provider: 'iflytek';
}

interface DoxentSyncState {
  phase: 'idle' | 'applying' | 'preparing';
  detail?: string;
  /** 「设置」分类同步是否开启（未加入同步群组时也恒 false） */
  settingsEnabled?: boolean;
  /** none / hub / member；none 时同步提示不出现 */
  role?: 'none' | 'hub' | 'member';
}

interface DoxentStatus {
  python: DoxentPython;
  skill: DoxentSkill;
  login: DoxentLogin;
  downloadUrl: string;
  /** 进行中 / 刚结束的绑定任务（服务端重启后为 null） */
  bind?: DoxentBindJob | null;
  /** 办公本类型（preference doxent_config） */
  config?: DoxentConfig;
  /** 登录凭据的跨端同步进度 */
  sync?: DoxentSyncState;
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
  config: { provider: 'iflytek' },
  sync: { phase: 'idle', settingsEnabled: false, role: 'none' },
});
const loading = ref(false);
/** 解绑等一次性动作 */
const busy = ref(false);
/** 保存办公本类型 */
const savingType = ref(false);
/** 手动点「我已完成登录」的那一次查询（后台轮询不影响按钮） */
const checking = ref(false);
const errorText = ref('');
const loginUrl = ref('');
/** 已经触发过登录、等用户去浏览器完成的阶段（决定按钮文案） */
const waiting = ref(false);
/** 切换账号请求发出到服务端返回任务之间：按钮先显示「切换中…」，别闪回「绑定办公本」 */
const switchRequested = ref(false);
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

/** 凭据同步应用期间轮询服务端阶段；完成后自动回到常规登录态检查 */
let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncPollInFlight = false;
const SYNC_POLL_INTERVAL_MS = 1500;

const pythonOk = computed(() => Boolean(status.value.python?.available));
const bound = computed(() => status.value.login?.state === 'logged-in');
const binding = computed(() => bindJob.value?.state === 'running');
/** 切换到新账号：请求刚发出，或后台任务正在跑且明确标记为 switch */
const switching = computed(
  () => switchRequested.value || (bindJob.value?.state === 'running' && bindJob.value?.reason === 'switch'),
);
const accountText = computed(
  () => status.value.login?.account?.display || '官方 CLI 未记录账号信息',
);
/** 会话里没有手机号，账号行是 userId 尾号兜底：补一句说明，避免用户以为显示错了 */
const accountFallback = computed(() => bound.value && status.value.login?.account?.recorded === false);
const sync = computed<DoxentSyncState>(() => status.value.sync ?? { phase: 'idle' });
const syncing = computed(() => sync.value.phase !== 'idle');
const syncDetail = computed(() => {
  if (!syncing.value) return '';
  return (
    sync.value.detail ||
    (sync.value.phase === 'applying'
      ? '正在写入从其他设备同步来的办公本登录凭据…'
      : '正在准备官方技能与客户端，完成后即可直接读写…')
  );
});
/** 已加入同步群组但「设置」分类没开：给出明确入口，避免用户以为功能坏了 */
const settingsSyncOff = computed(
  () => sync.value.settingsEnabled === false && !!sync.value.role && sync.value.role !== 'none',
);

const bindProgressText = computed(() => {
  if (!binding.value) return '';
  const step = bindJob.value?.step;
  if (switching.value) {
    if (step === 'logout') return '正在退出当前账号并清理同步的登录凭据…';
    if (step === 'install') return '正在准备官方技能（切换账号）…';
    return '正在启动官方客户端并生成新账号的登录链接（可能要 1–2 分钟）…';
  }
  return step === 'login'
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
  if (syncing.value) return 'tone-busy';
  if (!pythonOk.value) return 'tone-warn';
  if (bound.value) return 'tone-ok';
  return status.value.login?.state === 'unknown' ? 'tone-warn' : '';
});

const stripTitle = computed(() => {
  if (binding.value) return switching.value ? '正在切换办公本账号' : '正在准备绑定办公本';
  if (syncing.value) {
    return sync.value.phase === 'applying' ? '正在应用同步的办公本登录' : '正在准备同步的办公本登录';
  }
  if (!pythonOk.value) return '环境不满足：需要 Python 3.8+';
  if (bound.value) return '已绑定办公本';
  if (!status.value.skill?.installed) return '未绑定办公本';
  return status.value.login?.state === 'unknown' ? '登录状态未知' : '已装技能，等待登录';
});

const stripHint = computed(() => {
  if (binding.value) return bindProgressText.value;
  if (syncing.value) return syncDetail.value;
  if (!pythonOk.value) return status.value.python?.error || '未找到可用的 Python';
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
    applyConfigFromStatus();
    if (status.value.sync && status.value.sync.phase !== 'idle') startSyncWatch();
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

/** 服务端返回的类型写回下拉；非法/缺省时保持当前值（服务端已有默认） */
function applyConfigFromStatus(): void {
  const provider = status.value.config?.provider;
  if (provider === 'iflytek') notebookType.value = provider;
}

/** 保存办公本类型（写入 preference，随「设置」分类同步） */
async function saveNotebookType(value: NotebookType): Promise<void> {
  if (value === (status.value.config?.provider ?? 'iflytek')) return;
  savingType.value = true;
  errorText.value = '';
  try {
    const { data } = await api.put('/api/settings/doxent/config', { provider: value });
    const config = data?.config as DoxentConfig | undefined;
    status.value = { ...status.value, config: config ?? { provider: value } };
    notify.success('已保存办公本类型');
  } catch (error) {
    notebookType.value = status.value.config?.provider ?? 'iflytek';
    errorText.value = errorMessage(error, '保存办公本类型失败');
    notify.error(errorText.value);
  } finally {
    savingType.value = false;
  }
}

function stopSyncWatch(): void {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}

function startSyncWatch(): void {
  if (syncTimer) return;
  syncTimer = setInterval(() => {
    void pollSyncStatus();
  }, SYNC_POLL_INTERVAL_MS);
}

/** 同步应用期间只刷状态卡（skillOnly 不拉官方 CLI），阶段归零后再做一次完整登录检查 */
async function pollSyncStatus(): Promise<void> {
  if (syncPollInFlight) return;
  syncPollInFlight = true;
  try {
    const { data } = await api.get('/api/settings/doxent', { params: { skillOnly: '1' } });
    status.value = data as DoxentStatus;
    applyConfigFromStatus();
    if ((status.value.sync?.phase ?? 'idle') === 'idle') {
      stopSyncWatch();
      await loadStatus(true);
    }
  } catch {
    /* 网络抖动：保持轮询，下一轮再试 */
  } finally {
    syncPollInFlight = false;
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

/**
 * 切换账号：确认后走后端后台任务（退出旧会话 → 装技能 → 生成新账号登录链接）。
 * 旧账号立即退出，所以这里先把卡片按未登录渲染；新会话登录成功后由轮询补回账号。
 */
async function switchAccount(): Promise<void> {
  if (binding.value || busy.value || syncing.value) return;
  const ok = await confirmDialog({
    title: '切换办公本账号',
    message:
      '切换办公本账号？\n\n' +
      `将退出当前账号${status.value.login?.account?.display ? `（${status.value.login.account.display}）` : ''}，` +
      '并重新生成登录链接。若已开启「设置」分类同步，其他设备也会一起退出旧账号，新账号登录成功后自动切过去。',
    confirmText: '切换账号',
    cancelText: '取消',
    danger: true,
  });
  if (!ok) return;

  errorText.value = '';
  stopPolling();
  stopBindPolling();
  waiting.value = false;
  loginUrl.value = '';
  bindJob.value = null;
  switchRequested.value = true;
  busy.value = true;
  // 服务端要先 logout 再生成链接；这段空窗期不能让卡片继续显示旧账号
  status.value = { ...status.value, login: { state: 'logged-out', detail: '正在切换账号' } };
  try {
    const { data } = await api.post('/api/settings/doxent/switch');
    const job = data?.job as DoxentBindJob | undefined;
    if (job) {
      bindJob.value = job;
      if (job.state === 'running') startBindPolling();
      else await applyBindResult(job);
    } else {
      // 旧版服务端没有这个接口 / 没返回任务：回到状态卡，不要假装已切换
      await loadStatus(false, true);
    }
  } catch (error) {
    errorText.value = errorMessage(error, '切换办公本账号失败');
    notify.error(errorText.value);
    await loadStatus(false, true, true);
  } finally {
    busy.value = false;
    switchRequested.value = false;
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
      notify.info(
        switching.value ? '切换账号任务已中断，请重新点「切换账号」' : '绑定任务已中断，请重新点「绑定办公本」',
      );
      // 任务被服务端重启清掉时，卡片不能停在乐观的「未登录」上：拉一次真实状态
      await loadStatus(false, true);
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
  const isSwitch = job.reason === 'switch';
  if (job.login) {
    status.value = { ...status.value, login: job.login, skill: job.skill ?? status.value.skill };
  }
  const page = job.page;
  if (!page?.url) {
    notify.success(isSwitch ? '已切换办公本账号' : '已绑定办公本');
    await loadStatus(false, true);
    return;
  }
  if (page.pageType === '设置') {
    // 官方 CLI 返回设置页 = 这台机器已经登录过：不用再等，直接刷新状态
    waiting.value = false;
    loginUrl.value = '';
    notify.success(isSwitch ? '办公本已登录新账号' : '已登录办公本');
    await loadStatus(false, true);
    return;
  }
  loginUrl.value = page.url;
  waiting.value = true;
  // 绑定任务完成是在轮询回调里，浏览器可能拦截 window.open：页面上的登录链接是兜底入口
  window.open(page.url, '_blank', 'noopener,noreferrer');
  notify.success(
    isSwitch
      ? '新账号的登录链接已生成；浏览器没弹出就点下方「打开登录页面」'
      : '登录链接已生成；浏览器没弹出就点下方「打开登录页面」',
  );
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
  stopSyncWatch();
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
