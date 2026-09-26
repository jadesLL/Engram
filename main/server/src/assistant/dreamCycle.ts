import { appendWikiLog } from '../pipeline/indexFile.js';
import { getSetting, setSetting } from '../lib/db.js';
import { isMaintenanceActive } from '../jobs.js';
import { getAgentConfig } from './config.js';
import {
  dreamAudit,
  dreamAuditIdle,
  dreamAuditSummary,
  dreamIssueTotal,
  type DreamAudit,
} from './dreamAudit.js';
import {
  DREAM_TICK_MS,
  describeSchedule,
  isDreamDue,
  nextDueAt,
  readDreamConfig,
  readDreamState,
  writeDreamState,
  type DreamConfig,
  type DreamRunStatus,
  type DreamState,
} from './dreamConfig.js';
import { DREAM_PLAYBOOK } from './playbooks.js';
import * as repo from './repository.js';
import { submitMessage } from './runner.js';

/**
 * 梦境思考的运行编排：按计划用内置 Agent 跑一轮「整理未提炼资料 + 一次全库纠错」。
 *
 * 复用普通对话那一套（会话 + 轮次 + 事件流 + 用量），只是触发者从「用户点发送」换成
 * 定时器：起一轮走 runner.submitMessage，落库/收口/SSE 全都白拿——用户点开聊天抽屉
 * 就能看到这一轮的过程（工具卡、思考段、正文），服务端不另造一套运行记录。
 *
 * 会话带系统标记（system_key），不参与会话同步：否则每台设备会多出一份同名会话。
 * 配置与状态是本机设置（settings 表），不跨端同步——多端同步群组里只在一台设备开启。
 *
 * 为什么 tick 里只做「结算 + 到期判断」：起轮是异步长任务（10~30 分钟），必须让 tick
 * 立刻返回；正在跑的那一轮靠 state.currentRunId 记账，收口后由下一次 tick 结算。
 */

/** 梦境思考会话 id 的设置键 */
export const DREAM_SESSION_SETTING = 'dream_session_id';
/** 会话标题（带标题创建 → title_source=user，自动命名不会改掉它） */
export const DREAM_SESSION_TITLE = '梦境思考';
/** 系统会话标记：不参与会话同步 */
export const DREAM_SYSTEM_KEY = 'dream_thinking';

/** 终态轮次：到这些状态就该结算了 */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

export type DreamStartReason = 'disabled' | 'running' | 'unconfigured' | 'idle' | 'not-due' | 'maintenance';

export interface DreamStartResult {
  started: boolean;
  reason?: DreamStartReason;
  runId: string;
  sessionId: string;
}

/** 起轮的注入点：单测给假 submit / 假 audit，生产用真实实现 */
export interface DreamDeps {
  submit?: typeof submitMessage;
  audit?: () => DreamAudit;
}

/** 梦境思考会话（设置里记着 id，但会话可能已被删掉）；不创建 */
export function dreamSession(): repo.SessionDto | null {
  const id = String(getSetting(DREAM_SESSION_SETTING) || '').trim();
  return id ? repo.getSession(id) : null;
}

/**
 * 取梦境思考会话，没有就建一个并把 id 记进设置。
 * 会话带系统标记：它不参与会话同步，否则每端会多出一份同名会话。
 */
export function ensureDreamSession(): repo.SessionDto {
  const existing = dreamSession();
  if (existing) {
    // 老库里的会话没有系统标记：补上（否则会被当成普通会话同步出去），并把补标结果读回来
    if (existing.systemKey !== DREAM_SYSTEM_KEY) {
      repo.markSessionSystem(existing.id, DREAM_SYSTEM_KEY);
      return repo.getSession(existing.id) ?? existing;
    }
    return existing;
  }
  const created = repo.createSession(DREAM_SESSION_TITLE, DREAM_SYSTEM_KEY);
  setSetting(DREAM_SESSION_SETTING, created.id);
  return created;
}

function stamp(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 小结：助手最后一段正文压成一行（界面一行显示，完整内容在会话里看） */
function shortSummary(text: string, limit = 400): string {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * 任务文本：待办信号 + 手册（手册由 playbook 注入）。
 * 这段话会作为「用户消息」出现在会话里，用户点开就能看清这轮为什么跑。
 */
export function buildDreamMessage(audit: DreamAudit, now: Date = new Date()): string {
  const lines = [
    `【梦境思考】自动整理与纠错（${stamp(now)}）`,
    `本轮待办信号：${dreamAuditSummary(audit)}。以清单工具的实时结果为准。`,
  ];
  if (audit.pendingSamples.length) {
    const more = audit.pendingFiles > audit.pendingSamples.length ? ` 等 ${audit.pendingFiles} 份` : '';
    lines.push(`待提炼样例：${audit.pendingSamples.map((item) => `\`${item}\``).join(' · ')}${more}`);
  }
  if (audit.pendingUnreadable > 0) {
    lines.push(`其中 ${audit.pendingUnreadable} 份还没有可读文本（等自动提取完成，本轮先跳过）。`);
  }
  if (audit.deadLinkSamples.length) {
    lines.push(`死链样例：${audit.deadLinkSamples.map((item) => `[[${item.title}]]（来自 ${item.from.join('、')}）`).join('；')}`);
  }
  if (audit.duplicateSamples.length) {
    lines.push(`疑似重复样例：${audit.duplicateSamples.map((item) => item.paths.join(' ↔ ')).join('；')}`);
  }
  if (audit.outdatedSamples.length) {
    lines.push(`规则落后样例：${audit.outdatedSamples.map((item) => `${item.path}（v${item.guideVersion}）`).join('；')}`);
  }
  if (dreamAuditIdle(audit)) {
    lines.push('当前待办信号为空：请做一次轻量巡检（死链 / 重复 / 页面契约），确认没有明显问题就直说无待办，不要为了有产出而硬改。');
  }
  return lines.join('\n');
}

/** 操作日志（一行式）：只记完成与失败，取消与跳过不写，避免日志噪音 */
function logDreamResult(status: DreamRunStatus, error: string, before: { pendingFiles: number; issues: number }, after: DreamAudit): void {
  try {
    if (status === 'completed') {
      appendWikiLog(
        '梦境思考',
        `自动整理完成（待提炼 ${before.pendingFiles}→${after.pendingFiles} 份 · 待核查 ${before.issues}→${dreamIssueTotal(after)} 处）`,
      );
    } else if (status === 'failed') {
      const brief = String(error || '未知错误').split(/\r?\n/).filter((line) => line.trim())[0] || '未知错误';
      appendWikiLog('梦境思考', `自动整理失败：${brief.slice(0, 120)}`);
    }
  } catch {
    /* 日志失败不阻塞调度 */
  }
}

/**
 * 结算上一轮：轮次到终态就写状态（含小结）并记操作日志。
 * 幂等：currentRunId 为空、或该轮还在跑时什么都不做。
 */
export function settleDreamRun(now: Date = new Date(), deps: DreamDeps = {}): boolean {
  const state = readDreamState();
  if (!state.currentRunId) return false;
  const runId = state.currentRunId;
  const run = repo.getRun(runId);
  if (run && !TERMINAL_STATUSES.has(run.status)) return false;

  const status: DreamRunStatus = !run
    ? 'failed'
    : run.status === 'completed'
      ? 'completed'
      : run.status === 'cancelled'
        ? 'cancelled'
        : 'failed';
  const summary = run?.assistantMessageId
    ? shortSummary(repo.getMessage(run.assistantMessageId)?.content || '')
    : '';
  const error = status === 'failed' ? run?.error || (run ? '本轮没有产出' : '运行记录已不存在') : '';
  writeDreamState({
    currentRunId: '',
    runningSince: '',
    lastRunId: runId,
    lastRunAt: run?.completedAt || run?.updatedAt || now.toISOString(),
    lastStatus: status,
    lastError: error,
    lastSummary: summary,
  });
  logDreamResult(
    status,
    error,
    { pendingFiles: state.beforePendingFiles, issues: state.beforeIssues },
    (deps.audit ?? dreamAudit)(),
  );
  return true;
}

/**
 * 起一轮：定时与「立即执行一次」共用。
 * 返回 started=false 时带上原因（界面据此给一句人话，而不是空响应）。
 */
export function startDreamRun(options: {
  trigger: 'schedule' | 'manual';
  now?: Date;
  deps?: DreamDeps;
}): DreamStartResult {
  const now = options.now ?? new Date();
  const submit = options.deps?.submit ?? submitMessage;
  const auditOf = options.deps?.audit ?? dreamAudit;

  const config = readDreamConfig();
  if (options.trigger === 'schedule' && !config.enabled) {
    return { started: false, reason: 'disabled', runId: '', sessionId: '' };
  }
  // 上一轮已收口但还没结算（进程刚起/这次 tick 没跑到）：先结算，再判断能不能起新的
  settleDreamRun(now, options.deps);
  const state = readDreamState();
  if (state.currentRunId) {
    return {
      started: false,
      reason: 'running',
      runId: state.currentRunId,
      sessionId: dreamSession()?.id || '',
    };
  }
  if (!getAgentConfig().apiKey) {
    return { started: false, reason: 'unconfigured', runId: '', sessionId: dreamSession()?.id || '' };
  }

  const audit = auditOf();
  // 定时跑没事可做就跳过：不烧 token，也不制造「每夜都跑一遍空库」的日志
  if (options.trigger === 'schedule' && dreamAuditIdle(audit)) {
    writeDreamState({
      lastRunAt: now.toISOString(),
      lastTrigger: 'schedule',
      lastStatus: 'skipped',
      lastError: '',
      lastSummary: '',
      beforePendingFiles: 0,
      beforeIssues: 0,
    });
    return { started: false, reason: 'idle', runId: '', sessionId: dreamSession()?.id || '' };
  }

  const session = ensureDreamSession();
  const { run } = submit({
    sessionId: session.id,
    message: buildDreamMessage(audit, now),
    context: { playbook: DREAM_PLAYBOOK },
  });
  writeDreamState({
    currentRunId: run.id,
    runningSince: now.toISOString(),
    lastTrigger: options.trigger,
    lastError: '',
    beforePendingFiles: audit.pendingFiles,
    beforeIssues: dreamIssueTotal(audit),
  });
  return { started: true, runId: run.id, sessionId: session.id };
}

/**
 * 定时 tick：先结算上一轮，再按「已启用 + 没在跑 + 没在做数据维护 + 已到期 + 配好凭据」决定起不起轮。
 * 没配凭据时把这次计划往前推并记一条状态——否则会每 30 秒重试一次。
 * 数据维护（清库 / 恢复）是短暂的，不推进计划：维护结束后的下一次 tick 照常补跑。
 */
export function dreamTick(now: Date = new Date(), deps: DreamDeps = {}): DreamStartResult {
  settleDreamRun(now, deps);
  const config = readDreamConfig();
  if (!config.enabled) return { started: false, reason: 'disabled', runId: '', sessionId: '' };
  if (isMaintenanceActive()) return { started: false, reason: 'maintenance', runId: '', sessionId: '' };

  const state = readDreamState();
  if (state.currentRunId) {
    return { started: false, reason: 'running', runId: state.currentRunId, sessionId: dreamSession()?.id || '' };
  }
  if (!isDreamDue(config, state, now)) return { started: false, reason: 'not-due', runId: '', sessionId: '' };
  if (!getAgentConfig().apiKey) {
    writeDreamState({
      lastRunAt: now.toISOString(),
      lastTrigger: 'schedule',
      lastStatus: 'skipped',
      lastError: '内置 Agent 还没配模型凭据，本轮未执行（到 设置 → Agent 接入 → 内置 Agent 配置）',
      lastSummary: '',
    });
    return { started: false, reason: 'unconfigured', runId: '', sessionId: dreamSession()?.id || '' };
  }
  return startDreamRun({ trigger: 'schedule', now, deps });
}

/** 进程级启动入口：启动 30 秒后首跑（等 Fastify 监听就绪，Agent 的 MCP 工具要回调本机），此后每 30 秒 tick */
export function startDreamScheduler(): void {
  const run = () => {
    try {
      dreamTick();
    } catch (error) {
      console.warn('[dream] 调度 tick 失败', error);
    }
  };
  const first = setTimeout(run, 30_000);
  first.unref?.();
  const timer = setInterval(run, DREAM_TICK_MS);
  timer.unref?.();
}

export interface DreamStatus {
  config: DreamConfig;
  /** 「每天 03:00」/「每隔 3 天 03:00」 */
  scheduleLabel: string;
  /** 下次计划时刻（ISO，本地算；未启用时为空） */
  nextRunAt: string;
  /** 是否已到期（含错过补跑） */
  due: boolean;
  running: boolean;
  /** 正在跑（或最近一轮）的轮次 id：前端据此接事件流/展示 */
  runId: string;
  sessionId: string;
  /** 内置 Agent 是否配了模型凭据（没配则定时跑不会起轮） */
  agentReady: boolean;
  /** 本轮待办快照 */
  audit: DreamAudit;
  /** 起跑前的计数（界面显示「整理前 → 整理后」） */
  before: { pendingFiles: number; issues: number };
  last: {
    at: string;
    trigger: DreamState['lastTrigger'];
    status: DreamRunStatus;
    error: string;
    summary: string;
    runId: string;
  };
}

/** 设置页状态面板用的一份全量状态（只读，可在轮询里调用） */
export function dreamStatus(now: Date = new Date()): DreamStatus {
  const config = readDreamConfig();
  const state = readDreamState();
  const due = nextDueAt(config, state, now);
  const lastRun = state.lastRunId ? repo.getRun(state.lastRunId) : null;
  return {
    config,
    scheduleLabel: describeSchedule(config),
    nextRunAt: due ? due.toISOString() : '',
    due: isDreamDue(config, state, now),
    running: Boolean(state.currentRunId),
    runId: state.currentRunId || lastRun?.id || '',
    sessionId: dreamSession()?.id || '',
    agentReady: Boolean(getAgentConfig().apiKey),
    audit: dreamAudit(),
    before: { pendingFiles: state.beforePendingFiles, issues: state.beforeIssues },
    last: {
      at: state.lastRunAt,
      trigger: state.lastTrigger,
      status: state.lastStatus,
      error: state.lastError,
      summary: state.lastSummary,
      runId: state.lastRunId,
    },
  };
}
