<template>
  <!-- settings-native：本组件原先由 AgentPanel 的 settings-native 祖先提供行/值列表框架样式；
       2026-11-18 迁到「外设接入」后直接在 SettingsGroup 里渲染，必须自带这套框架类。 -->
  <div class="doxent-section settings-native">
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
        <button
          v-if="canInstallRuntime"
          class="btn small"
          type="button"
          :disabled="loading || binding"
          @click="installRuntime"
        >
          {{ runtimeInstallLabel }}
        </button>
        <button
          v-else-if="runtimeBusy"
          class="btn ghost small"
          type="button"
          :disabled="cancellingRuntime"
          @click="cancelRuntime"
        >
          {{ cancellingRuntime ? '取消中…' : '取消下载' }}
        </button>
        <button class="btn ghost small" type="button" :disabled="loading || binding" @click="refresh">
          {{ loading ? '检测中…' : binding ? '绑定中…' : '重新检测' }}
        </button>
      </div>
    </div>

    <!-- 运行时下载进度：约 21MB，后台下载；界面只读服务端状态，离开本页再回来会接着显示 -->
    <div v-if="runtimeBusy" class="python-runtime-progress" aria-live="polite">
      <div
        class="python-runtime-track"
        role="progressbar"
        :aria-valuenow="runtimePercent"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <span class="python-runtime-fill" :style="{ width: runtimePercent + '%' }" />
      </div>
      <span class="python-runtime-meta">{{ runtimeProgressText }}</span>
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
        <span class="value-label">官方 CLI</span>
        <span class="value-text" :class="cliTextClass" :title="status.cli?.path">{{ cliText }}</span>
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

    <!-- 残留安装锁：官方客户端会为它白等 180 秒，必须显式告诉用户并给一键清理 -->
    <div v-if="cliLockStale" class="state-strip tone-warn doxent-lock-strip">
      <span class="state-dot" aria-hidden="true" />
      <div class="doxent-status-copy">
        <strong>官方 CLI 安装锁残留</strong>
        <span class="doxent-status-hint">
          上次安装 CLI 被中断留下的锁，会让之后每次绑定都白等 3 分钟。清理后重试即可。
        </span>
      </div>
      <div class="setting-actions">
        <button
          class="btn ghost small"
          type="button"
          :disabled="clearingLock || binding || busy"
          @click="clearCliLock"
        >
          {{ clearingLock ? '清理中…' : '清理安装锁' }}
        </button>
      </div>
    </div>

    <!-- 主操作：未绑定时是「绑定办公本」，已绑定后是「切换账号 / 解除绑定」；登录链接单独一行，便于关掉浏览器后重新打开 -->
    <div class="setting-row">
      <div class="setting-copy">
        <strong>{{ bound ? '已绑定：内置 Agent 可以调阅办公本' : '绑定办公本' }}</strong>
        <span v-if="bound">在聊天抽屉里直接说「查一下我办公本的笔记」「把这份纪要写进办公本笔记」。新开的会话生效。</span>
        <span v-else-if="binding" class="doxent-progress" aria-live="polite">
          正在按下面的步骤执行；离开本页再回来会接着显示进度。
        </span>
        <span v-else-if="syncing" class="doxent-progress" aria-live="polite">
          {{ syncDetail }}完成后这里会自动变成已绑定，无需再扫码。
        </span>
        <span v-else-if="waiting">已打开浏览器：在页面里完成登录，这里会自动变成已绑定。</span>
        <span v-else-if="bindFailed">上次绑定没有完成：{{ errorText || '可查看下方官方 CLI 状态后重试' }}</span>
        <span v-else>点「绑定办公本」会装官方技能并生成本人的登录链接，在浏览器里扫码 / 登录即可。</span>
      </div>
      <div class="setting-actions">
        <button
          v-if="!bound"
          class="btn small"
          type="button"
          :disabled="binding || busy || syncing || savingType || !pythonOk || runtimeBusy"
          @click="bind"
        >
          {{ binding ? (switching ? '切换中…' : '准备中…') : syncing ? '同步中…' : (waiting ? '重新获取链接' : switchRequested ? '切换中…' : bindFailed ? '重试绑定' : '绑定办公本') }}
        </button>
        <template v-else>
          <button
            class="btn ghost small"
            type="button"
            :disabled="binding || busy || syncing || savingType || !pythonOk || runtimeBusy"
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

    <!-- 分步进度：把「装技能 / 装 CLI / 生成链接」拆开，并显示服务端最后一句人话说明 -->
    <div v-if="binding" class="doxent-bind-progress" aria-live="polite">
      <ol class="doxent-steps">
        <li v-for="step in bindSteps" :key="step.key" :class="'is-' + step.state">
          <span class="doxent-step-dot" aria-hidden="true" />
          <span>{{ step.label }}</span>
        </li>
      </ol>
      <p class="doxent-bind-detail">{{ bindDetailText }}</p>
      <p class="doxent-bind-elapsed">
        已等待 {{ bindElapsedText }}。绑定完成后会自动打开登录页面；浏览器没打开就点下方「打开登录页面」。
      </p>
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
    <p v-else-if="!pythonOk && !runtimeBusy" class="setting-note tone-warn">
      <template v-if="runtime?.supported">
        官方客户端是 Python 脚本（meta.json 要求 3.8+）：点上方「下载 Python 运行时」由 Engram 安装一份共用解释器
        （约 {{ runtimeSizeMb }}MB，不修改系统环境，其他需要 Python 的接入共用这一份）；也可以自行安装 Python 后点「重新检测」，
        或用环境变量 <code>DOXENT_PYTHON</code> 指定解释器路径。
      </template>
      <template v-else>
        官方客户端是 Python 脚本（meta.json 要求 3.8+），当前平台没有可下载的托管运行时{{ runtime?.error ? `：${runtime.error}` : '' }}；
        可用环境变量 <code>DOXENT_PYTHON</code> 指定解释器路径。
      </template>
    </p>
    <p v-else-if="runtime?.ready" class="setting-note">
      正在使用 Engram 共享 Python 运行时（Python {{ runtime.version }}）：运行时装在数据目录内，不修改系统环境，
      之后其他需要 Python 的接入会直接复用这一份。
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
 * 设置 → 外设接入 →「办公本接入」（2026-11-18 从「Agent 与自动化」移出：它接入的是外部设备）。
 *
 * 四条状态线：Python 是否可用（官方客户端是 Python 脚本）、官方技能是否已装进内置 Agent 的
 * DSH_HOME/skills、官方 CLI 是否已落盘（以及有没有残留安装锁）、官方 CLI 当前是否已登录。
 * 绑定动作在服务端后台完成（装技能 + 跑 --cli-action login），这里轮询绑定任务拿阶段、
 * 人话说明与真实登录链接，再轮询登录状态、负责解绑。
 *
 * 为什么单独显示官方 CLI：CLI 由官方客户端在首次 login 时自己下载，成功后每次登录只需几十秒；
 * 但下载/替换被中断会留下 `.doxent-cli-install.lock`，官方客户端会为它白等 180 秒。
 * 设置页现在能看到「已安装 v1.0.4 / 正在安装 / 安装锁残留」，并能一键清理后重试。
 *
 * 已登录时多显示一行「当前账号」：服务端只回由官方 CLI 会话派生的脱敏展示值（手机号或用户 ID
 * 尾号）。「切换账号」会先退出旧会话（同步设备一起退出）、再生成新账号的登录链接，走的还是
 * 同一个后台任务，所以进度、计时和刷新恢复逻辑与绑定完全一致。
 *
 * 绑定不再用一个长请求硬等：首次要下载技能包并启动官方 CLI，可能 1–3 分钟；旧版只显示
 * 「准备中…」，看起来像卡死。现在服务端立即返回任务，设置页每秒刷新阶段与说明；任务失败会
 * 直接弹「重试」框，并带上残留安装锁的清理提示。
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
  /** env=显式指定 / managed=Engram 共享运行时 / system=系统 Python */
  source?: 'env' | 'managed' | 'system';
  error?: string;
}

/**
 * Engram 共享 Python 运行时（服务端 /api/settings/python-runtime 同款结构）。
 * 这块 UI 虽然出现在办公本分组里，运行时本身是 Engram 级共享资产。
 */
interface PythonRuntime {
  supported: boolean;
  platform: string;
  version: string;
  ready: boolean;
  phase: 'ready' | 'missing' | 'downloading' | 'installing' | 'error' | 'unsupported';
  downloadedBytes: number;
  totalBytes: number;
  root: string;
  interpreter?: string;
  error?: string;
}

interface DoxentSkill {
  installed: boolean;
  version?: string;
  root: string;
  managed: boolean;
}

/**
 * 官方 CLI 的本地安装状态（服务端只读文件系统给出）：
 * installed=二进制是否已落盘；lock=官方安装锁是否存在；lockStale=锁已过期可清理。
 */
interface DoxentCli {
  installed: boolean;
  path: string;
  version?: string;
  lock: boolean;
  lockAgeMs?: number;
  lockStale: boolean;
  error?: string;
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
  /** 最近一次阶段/说明变化时间（旧任务可能没有） */
  updatedAt?: number;
  /** 当前阶段的人话说明（旧任务可能没有） */
  detail?: string;
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
  /** 官方 CLI 安装状态（服务端读文件系统，不起进程） */
  cli?: DoxentCli;
  login: DoxentLogin;
  downloadUrl: string;
  /** 进行中 / 刚结束的绑定任务（服务端重启后为 null） */
  bind?: DoxentBindJob | null;
  /** 办公本类型（preference doxent_config） */
  config?: DoxentConfig;
  /** 登录凭据的跨端同步进度 */
  sync?: DoxentSyncState;
  /** Engram 共享 Python 运行时状态（缺 Python 时给「下载」入口与进度） */
  runtime?: PythonRuntime;
}

/** 办公本品牌：目前只实现讯飞（Doxent）。新增品牌时在这里加选项，并在服务端补对应接入。 */
type NotebookType = 'iflytek';
const NOTEBOOK_TYPES: Array<{ value: NotebookType; label: string }> = [{ value: 'iflytek', label: '讯飞办公本' }];

const status = ref<DoxentStatus>({
  python: { available: false },
  skill: { installed: false, root: '', managed: false },
  cli: { installed: false, path: '', lock: false, lockStale: false },
  login: { state: 'unknown' },
  downloadUrl: '',
  bind: null,
  config: { provider: 'iflytek' },
  sync: { phase: 'idle', settingsEnabled: false, role: 'none' },
});
const loading = ref(false);
/** 解绑等一次性动作 */
const busy = ref(false);
/** 清理残留的官方 CLI 安装锁 */
const clearingLock = ref(false);
/** 上次绑定任务失败（决定按钮显示「重试绑定」并保留错误说明） */
const bindFailed = ref(false);
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

/** 共享 Python 运行时下载期间轮询（约 1 秒）；离开页面不影响服务端任务 */
let runtimeTimer: ReturnType<typeof setInterval> | null = null;
let runtimePollInFlight = false;
const RUNTIME_POLL_INTERVAL_MS = 1000;

const pythonOk = computed(() => Boolean(status.value.python?.available));
const runtime = computed<PythonRuntime | undefined>(() => status.value.runtime);
const runtimeBusy = computed(
  () => runtime.value?.phase === 'downloading' || runtime.value?.phase === 'installing',
);
const runtimePercent = computed(() => {
  const total = runtime.value?.totalBytes || 0;
  if (!total) return 0;
  return Math.min(100, Math.floor(((runtime.value?.downloadedBytes || 0) / total) * 100));
});
const runtimeSizeMb = computed(() => Math.max(1, Math.round((runtime.value?.totalBytes || 0) / (1024 * 1024))));
/** 缺 Python 且平台有托管运行时：显示「下载 Python 运行时」主按钮（已就绪但探测失败时不重复下载） */
const canInstallRuntime = computed(
  () => !pythonOk.value && Boolean(runtime.value?.supported) && !runtime.value?.ready && !runtimeBusy.value,
);
const runtimeInstallLabel = computed(() => {
  if (runtime.value?.phase === 'error') return '重新下载 Python 运行时';
  return `下载 Python 运行时（约 ${runtimeSizeMb.value}MB）`;
});
const runtimeProgressText = computed(() => {
  if (runtime.value?.phase === 'installing') return '校验安装中…';
  return `${runtimePercent.value}%`;
});
const cancellingRuntime = ref(false);
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
const cli = computed<DoxentCli | undefined>(() => status.value.cli);
/** 残留安装锁：官方客户端会为它白等 180 秒，卡片上必须显式提示并给清理入口 */
const cliLockStale = computed(() => Boolean(cli.value?.lockStale));
const cliText = computed(() => {
  const state = cli.value;
  if (!state) return '未知';
  const version = state.version ? ' v' + state.version : '';
  if (state.installed) return `已安装${version}`;
  if (state.lock) return state.lockStale ? '安装锁残留，CLI 未安装' : '正在安装';
  return '未安装（绑定时由官方客户端自动下载）';
});
const cliTextClass = computed(() => {
  const state = cli.value;
  if (!state) return '';
  return state.installed && !state.lockStale ? 'tone-ok' : 'tone-warn';
});
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
    return '正在准备官方 CLI 并生成新账号的登录链接（可能要 1–2 分钟）…';
  }
  return step === 'login'
    ? '正在准备官方 CLI 并生成登录链接（首次可能要 1–2 分钟）…'
    : '正在下载并安装官方技能包（首次约 30–60 秒）…';
});

interface BindStepView {
  key: string;
  label: string;
  state: 'done' | 'active' | 'pending';
}

/**
 * 绑定分步：把「装技能 / 装 CLI / 生成链接」拆开。
 * 服务端 login 阶段同时负责「CLI 下载/更新」和「生成链接」，这里用 CLI 安装状态细分：
 * CLI 还没落盘时停在第 2 步，落盘后进第 3 步；任务给的 detail 再说明具体在做什么。
 */
const bindStepIndex = computed(() => {
  const job = bindJob.value;
  if (!job) return -1;
  if (switching.value) {
    if (job.step === 'logout') return 0;
    if (job.step === 'install') return 1;
    return 2;
  }
  if (job.step === 'install') return 0;
  return status.value.cli && !status.value.cli.installed ? 1 : 2;
});
const bindSteps = computed<BindStepView[]>(() => {
  const labels = switching.value
    ? ['退出旧账号', '安装官方技能', '准备官方 CLI 并生成登录链接']
    : ['安装官方技能', '检查 / 安装官方 CLI', '生成登录链接'];
  return labels.map((label, index) => ({
    key: `${index}-${label}`,
    label,
    state: index < bindStepIndex.value ? 'done' : index === bindStepIndex.value ? 'active' : 'pending',
  }));
});
const bindDetailText = computed(() => {
  if (!binding.value) return '';
  return bindJob.value?.detail || bindProgressText.value;
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
  if (runtimeBusy.value) return 'tone-busy';
  if (!pythonOk.value) return 'tone-warn';
  if (bound.value) return 'tone-ok';
  if (bindFailed.value) return 'tone-danger';
  return status.value.login?.state === 'unknown' ? 'tone-warn' : '';
});

const stripTitle = computed(() => {
  if (binding.value) return switching.value ? '正在切换办公本账号' : '正在准备绑定办公本';
  if (syncing.value) {
    return sync.value.phase === 'applying' ? '正在应用同步的办公本登录' : '正在准备同步的办公本登录';
  }
  if (runtimeBusy.value) {
    return runtime.value?.phase === 'installing' ? '正在安装 Python 运行时' : '正在下载 Python 运行时';
  }
  if (!pythonOk.value) return '环境不满足：需要 Python 3.8+';
  if (bound.value) return '已绑定办公本';
  if (bindFailed.value) return '上次绑定没有完成';
  if (!status.value.skill?.installed) return '未绑定办公本';
  return status.value.login?.state === 'unknown' ? '登录状态未知' : '已装技能，等待登录';
});

const stripHint = computed(() => {
  if (binding.value) return bindDetailText.value;
  if (syncing.value) return syncDetail.value;
  if (runtimeBusy.value) {
    return runtime.value?.phase === 'installing'
      ? '下载完成，正在校验并解压到数据目录（不修改系统环境）…'
      : `正在下载 Engram 共享 Python 运行时：${runtimePercent.value}%（约 ${runtimeSizeMb.value}MB），完成后所有需要 Python 的接入共用。`;
  }
  if (!pythonOk.value) {
    const runtimeError = runtime.value?.phase === 'error' ? runtime.value.error : '';
    return runtimeError || status.value.python?.error || '未找到可用的 Python';
  }
  if (bound.value) return '内置 Agent 可读写笔记、Office 文档、书籍与日程。';
  if (bindFailed.value && errorText.value) return errorText.value;
  if (waiting.value) return '已打开浏览器：在页面里完成登录，这里会自动变成已绑定。';
  if (cliLockStale.value) return '检测到残留的官方 CLI 安装锁：点下方「清理安装锁」后重试。';
  if (!status.value.skill?.installed) return '绑定后会把官方技能装进内置 Agent，并生成登录链接。';
  return status.value.login?.detail || '点「绑定办公本」重新获取登录链接。';
});

const pythonText = computed(() => {
  const python = status.value.python;
  if (!python?.available) {
    if (runtimeBusy.value) {
      return runtime.value?.phase === 'installing'
        ? '正在安装 Engram 共享运行时…'
        : `正在下载 Engram 共享运行时（${runtimePercent.value}%）…`;
    }
    return python?.error || '未找到 Python 3.8+';
  }
  if (python.source === 'managed') return `Python ${python.version || ''}（Engram 共享运行时）`.trim();
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
    if (runtimeBusy.value) startRuntimeWatch();
    const job = status.value.bind;
    if (job?.state === 'running') {
      bindJob.value = job;
      bindFailed.value = false;
      startBindPolling();
    } else if (job?.state === 'error' && !bound.value) {
      // 上次绑定失败：保留阶段与说明，按钮显示「重试绑定」；不在这里自动弹框，避免每次进页面都弹
      bindJob.value = job;
      bindFailed.value = true;
      if (!errorText.value) errorText.value = job.error || '';
      stopBindPolling();
    } else if (binding.value && !job) {
      // 服务端重启 / 任务被清理：别让按钮永远停在「准备中」
      bindJob.value = null;
      stopBindPolling();
      bindFailed.value = true;
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

function stopRuntimeWatch(): void {
  if (runtimeTimer) clearInterval(runtimeTimer);
  runtimeTimer = null;
}

function startRuntimeWatch(): void {
  if (runtimeTimer) return;
  runtimeTimer = setInterval(() => {
    void pollRuntimeStatus();
  }, RUNTIME_POLL_INTERVAL_MS);
}

/** 下载期间只读运行时状态；完成后刷新一次 Python 探测结果（/api/settings/doxent?refresh=1） */
async function pollRuntimeStatus(): Promise<void> {
  if (runtimePollInFlight) return;
  runtimePollInFlight = true;
  try {
    const { data } = await api.get('/api/settings/python-runtime');
    const next = data?.runtime as PythonRuntime | undefined;
    if (!next) return;
    status.value = { ...status.value, runtime: next };
    if (next.phase === 'ready') {
      stopRuntimeWatch();
      notify.success('Python 运行时已就绪，可以绑定办公本了');
      await loadStatus(true, true);
      return;
    }
    if (next.phase === 'error' || next.phase === 'missing' || next.phase === 'unsupported') {
      stopRuntimeWatch();
      if (next.phase === 'error') {
        errorText.value = next.error || 'Python 运行时下载失败，可重试';
        notify.error(errorText.value);
      }
      await loadStatus(true, true, true);
    }
  } catch {
    /* 网络抖动：保持轮询，下一轮再试 */
  } finally {
    runtimePollInFlight = false;
  }
}

/** 一键下载 Engram 共享 Python 运行时（服务端后台任务，这里只轮询进度） */
async function installRuntime(): Promise<void> {
  if (runtimeBusy.value || cancellingRuntime.value) return;
  errorText.value = '';
  try {
    const { data } = await api.post('/api/settings/python-runtime/install');
    const next = data?.runtime as PythonRuntime | undefined;
    if (next) status.value = { ...status.value, runtime: next };
    startRuntimeWatch();
  } catch (error) {
    errorText.value = errorMessage(error, '启动 Python 运行时下载失败');
    notify.error(errorText.value);
  }
}

/** 取消下载 / 解压：服务端中止任务，界面回到「未下载」并重新探测一次 */
async function cancelRuntime(): Promise<void> {
  if (!runtimeBusy.value || cancellingRuntime.value) return;
  cancellingRuntime.value = true;
  try {
    const { data } = await api.post('/api/settings/python-runtime/cancel');
    const next = data?.runtime as PythonRuntime | undefined;
    if (next) status.value = { ...status.value, runtime: next };
    stopRuntimeWatch();
    await loadStatus(true, true, true);
  } catch (error) {
    errorText.value = errorMessage(error, '取消 Python 运行时下载失败');
  } finally {
    cancellingRuntime.value = false;
  }
}

/** 绑定：启动服务端后台任务，这里每秒看一次阶段，拿到链接后打开浏览器 */
async function bind(): Promise<void> {
  if (binding.value || busy.value) return;
  errorText.value = '';
  bindFailed.value = false;
  stopPolling();
  stopBindPolling();
  waiting.value = false;
  loginUrl.value = '';
  bindJob.value = null;
  try {
    const { data } = await api.post('/api/settings/doxent/bind');
    if (data?.cli) status.value = { ...status.value, cli: data.cli as DoxentCli };
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
    // 任务确实没跑起来：弹重试框；服务端已在跑就交给轮询，别再弹一个让人误会的失败框
    if (!binding.value) await showBindFailure(bindJob.value);
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
  await runSwitch();
}

/** 真正启动切换任务（失败重试时直接复用，不再弹一次「切换账号？」确认框） */
async function runSwitch(): Promise<void> {
  if (binding.value || busy.value || syncing.value) return;
  errorText.value = '';
  bindFailed.value = false;
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
    if (data?.cli) status.value = { ...status.value, cli: data.cli as DoxentCli };
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
    if (!binding.value) await showBindFailure(bindJob.value);
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
    // 轮询顺带更新官方 CLI 状态：装没装上、安装锁有没有残留，进度里能实时看到
    if (data?.cli) status.value = { ...status.value, cli: data.cli as DoxentCli };
    if (!job) {
      bindJob.value = null;
      stopBindPolling();
      bindFailed.value = true;
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
      bindFailed.value = true;
      errorText.value = job.error || '绑定办公本失败';
      notify.error(errorText.value);
      // 只刷「Python / 技能 / CLI」：失败时别再拉起一次官方 CLI；错误说明要留在卡片上
      await loadStatus(false, true, true);
      // 失败弹「重试」框：用户不用在页面里找按钮，也不会再盯着「准备中」干等
      await showBindFailure(job);
      return;
    }
    await applyBindResult(job);
  } catch {
    /* 网络抖动：保持轮询，下一轮再试；不能把一次失败当成绑定失败 */
  } finally {
    bindPollInFlight = false;
  }
}

/** 绑定失败弹框：说明卡在哪一步 + 残留锁情况，确认后直接重试 */
async function showBindFailure(job: DoxentBindJob | null): Promise<void> {
  const isSwitch = job?.reason === 'switch';
  const reason = job?.error || errorText.value || '未知原因';
  const stage = job ? stepLabel(job.step) : '启动绑定任务';
  const lockHint = cliLockStale.value
    ? '\n\n检测到残留的官方 CLI 安装锁：点「重试」会先自动清理再重新绑定。'
    : '\n\n点「重试」会重新走一遍绑定流程；如果还失败，可先点「重新检测」看官方 CLI 是否已安装。';
  const ok = await confirmDialog({
    title: isSwitch ? '切换办公本账号失败' : '办公本绑定失败',
    message: `卡住的阶段：${stage}\n原因：${reason}${lockHint}`,
    confirmText: '重试',
    cancelText: '稍后再试',
  });
  if (!ok) return;
  if (isSwitch) await runSwitch();
  else await bind();
}

/** 绑定阶段的中文名（失败弹框用） */
function stepLabel(step: DoxentBindJob['step']): string {
  if (step === 'logout') return '退出旧账号';
  if (step === 'install') return '安装官方技能';
  return '准备官方 CLI / 生成登录链接';
}

/** 绑定任务完成：按官方返回的「登录 / 设置」页决定是打开浏览器还是直接算已登录 */
async function applyBindResult(job: DoxentBindJob): Promise<void> {
  bindJob.value = job;
  bindFailed.value = false;
  errorText.value = '';
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
    bindFailed.value = false;
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

/** 清理残留的官方 CLI 安装锁（只删超过 5 分钟的旧锁；正在安装时服务端会拒绝） */
async function clearCliLock(): Promise<void> {
  if (clearingLock.value || binding.value) return;
  clearingLock.value = true;
  errorText.value = '';
  try {
    const { data } = await api.post('/api/settings/doxent/cli/clear-lock');
    if (data?.cli) status.value = { ...status.value, cli: data.cli as DoxentCli };
    if (data?.cleared) notify.success('已清理残留的安装锁，可以重新绑定了');
    else notify.info(data?.error || '没有需要清理的安装锁');
    await loadStatus(false, true, true);
  } catch (error) {
    const message = errorMessage(error, '清理安装锁失败');
    errorText.value = message;
    notify.error(message);
    await loadStatus(false, true, true);
  } finally {
    clearingLock.value = false;
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
  stopRuntimeWatch();
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
  font-size: var(--fs-small);
  line-height: 1.6;
}
.doxent-progress {
  color: var(--accent);
}
.doxent-lock-strip {
  align-items: flex-start;
  margin: 8px 0 2px;
}
.doxent-lock-strip .setting-actions {
  margin-left: auto;
}
/* 分步进度：细点 + 文案，当前步用主色，已完成为成功色，未开始为淡色 */
.doxent-bind-progress {
  margin: 2px 0 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
}
.doxent-steps {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--fs-small);
  line-height: 1.6;
}
.doxent-steps li {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-faint);
}
.doxent-step-dot {
  width: 7px;
  height: 7px;
  border: 1px solid var(--text-faint);
  border-radius: 50%;
  background: transparent;
}
.doxent-steps li.is-done {
  color: var(--text-secondary);
}
.doxent-steps li.is-done .doxent-step-dot {
  border-color: var(--success);
  background: var(--success);
}
.doxent-steps li.is-active {
  color: var(--accent);
  font-weight: 600;
}
.doxent-steps li.is-active .doxent-step-dot {
  border-color: var(--accent);
  background: var(--accent);
}
.doxent-bind-detail {
  margin: 8px 0 0;
  color: var(--text);
  font-size: var(--font-sm);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.doxent-bind-elapsed {
  margin: 2px 0 0;
  color: var(--text-secondary);
  font-size: var(--fs-small);
  line-height: 1.6;
}
.doxent-link-row {
  margin-top: 4px;
}
.doxent-link-row a {
  font-size: var(--font-md);
  overflow-wrap: anywhere;
}
/* 共享 Python 运行时下载进度：4px 细轨 + 主色进度，不铺大块背景 */
.python-runtime-progress {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 2px 0 4px;
}
.python-runtime-track {
  flex: 1;
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--bg-secondary);
}
.python-runtime-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width 0.25s ease;
}
.python-runtime-meta {
  color: var(--text-secondary);
  font-size: var(--fs-small);
  white-space: nowrap;
}
</style>
