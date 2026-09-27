import { getSetting, setSetting } from '../lib/db.js';
import { TASK_BOARD_PLAYBOOK, WEEKLY_TASKS_QUESTION } from './playbooks.js';
import * as repo from './repository.js';
import { submitMessage } from './runner.js';
import {
  BOARD_AUTO_OPTIONS,
  BOARD_SESSION_SETTING,
  BOARD_SESSION_TITLE,
  BOARD_SYSTEM_KEY,
  boardFreshness,
  boardSessionTitle,
  latestBoardAnswer,
  readBoardAutoDays,
  readSyncedBoard,
  windowOf,
} from './boardCore.js';

/**
 * 任务看板的服务端状态：一份「最近一次成功答案」+ 正在跑的那一轮。
 *
 * 为什么复用 assistant 会话而不是另建一张表：提问就是一次正常的 Agent 轮次，
 * 排队、停止、事件流、用量、追溯过程全都白拿；看板只是把那一轮的答案换个样子渲染。
 * 会话 id 记在服务端设置里（不靠前端记忆），会话被用户在聊天里删掉也能重建。
 *
 * **每次提炼新开一个会话**（2026-09-30 起）：以前固定一个「任务看板」会话往里追加轮次，
 * 时间长了上下文越滚越长（dsh 会话与有界历史都会膨胀），跑一轮越来越贵。现在每轮一个新会话，
 * 旧会话照旧留在聊天抽屉里可追溯；答案与在跑的那一轮都按**系统标记跨会话**取最新（见 boardCore）。
 *
 * 自动重新提炼：间隔可配（关闭自动 / 每天 / 每 2 天 / 每 3 天 / 每 7 天，默认 2 天），
 * 但**没有后台定时器**——只有用户打开看板页时才判一次「这份看板是不是已经过了间隔」，
 * 过了就自动重新提炼，没过就直接看缓存；手动「刷新」按钮任何时候都能用。
 *
 * 多端：看板对象全端唯一一份（boardCore.BOARD_SYNC_ID）。本机这份与同步下来的那份
 * 按答案生成时刻取最新，所以任意端刷新后，各端看到的都是最新那一版；界面上带
 * 「上次更新时间」与来源设备。看板会话带系统标记，不参与会话同步（否则每端多一份同名会话）。
 */

/** 看板会话 id 的设置键 / 标题（口径在 boardCore，这里转出保持既有引用可用） */
export { BOARD_SESSION_SETTING, BOARD_SESSION_TITLE };

/**
 * 终态但没产出答案的轮次状态。
 * 「过期」口径由 boardCore.boardFreshness 按用户配的间隔算（曾固定 6 小时，2026-09-30 改为可配）。
 */
const NO_ANSWER_STATUS = ['failed', 'cancelled', 'interrupted'];

export interface TaskBoardState {
  sessionId: string;
  /** empty=从没生成过；running=正在提炼；ready=有答案；failed=最近一轮失败（answer 可能仍是上一次的） */
  status: 'empty' | 'running' | 'ready' | 'failed';
  /** 最近一次成功答案的 markdown 原文（看板解析放在客户端） */
  answer: string;
  /** 答案落库时间（完成时刻） */
  generatedAt: string;
  /** 「上次更新时间」：当前这份看板答案的生成时刻（与 generatedAt 同值，界面直接显示它） */
  updatedAt: string;
  /** 这份看板是不是本机生成的（false = 从其他端同步来的） */
  local: boolean;
  /** 生成这份看板的设备（local=false 时界面显示「来自 X」） */
  sourceNodeId: string;
  sourceNodeLabel: string;
  /** 结果是否已过期：有答案、自动提炼没关、且距生成时刻超过配置的间隔天数 */
  stale: boolean;
  /** 自动重新提炼的间隔（天）；0 = 关闭自动，只能手动刷新 */
  autoDays: number;
  /** 下一次到期的时刻（关闭自动或还没有答案时为空串） */
  dueAt: string;
  /** 最近一轮（正在跑时前端据此接事件流） */
  runId: string;
  runStatus: string;
  runStartedAt: string;
  /** 最近一轮的失败原因（有的话） */
  error: string;
  /**
   * 这份看板对应的「下周」窗口（YYYY-MM-DD）：按答案生成时刻算，前端据此铺「按天」视图的每一天。
   * 由服务端算，客户端不再自己推一遍自然周（口径只此一处）。
   */
  windowStart: string;
  windowEnd: string;
}

/** 看板会话（设置里记着 id，但会话可能已被删掉）；不创建 */
export function boardSession(): repo.SessionDto | null {
  const id = String(getSetting(BOARD_SESSION_SETTING) || '').trim();
  return id ? repo.getSession(id) : null;
}

/** 界面上真正显示的那一份（本机这份与同步下来的那份二选一） */
interface ShownBoard {
  answer: string;
  generatedAt: string;
  local: boolean;
  sourceNodeId: string;
  sourceNodeLabel: string;
  windowStart: string;
  windowEnd: string;
}

/**
 * 挑出界面上显示的那一份：本机这份 vs 同步下来的那份，按生成时刻「最新者胜」。
 * 任意端刷新后，各端都显示最新那一版；本机没有答案而别端有时（新设备首次接入），
 * 也直接显示同步来的那份。看板页与设置面板读同一份——两边不会一个说「刚提炼过」、
 * 另一个说「早就到期」（到期判定用的是这里挑出来的生成时刻）。
 */
function shownBoard(now: Date): ShownBoard {
  const synced = readSyncedBoard();
  const localAnswer = latestBoardAnswer();
  const useSynced = Boolean(
    synced && (!localAnswer || String(synced.generatedAt) > String(localAnswer.generatedAt))
  );

  if (useSynced) {
    return {
      answer: synced!.answer,
      generatedAt: synced!.generatedAt,
      local: false,
      sourceNodeId: synced!.nodeId,
      sourceNodeLabel: synced!.nodeLabel,
      windowStart: synced!.windowStart,
      windowEnd: synced!.windowEnd,
    };
  }
  return {
    answer: localAnswer?.answer || '',
    generatedAt: localAnswer?.generatedAt || '',
    local: true,
    sourceNodeId: '',
    sourceNodeLabel: '',
    ...(localAnswer
      ? { windowStart: localAnswer.windowStart, windowEnd: localAnswer.windowEnd }
      : windowOf(now)),
  };
}

/**
 * 看板当前状态：最近一次成功的答案 + 正在跑的那一轮。
 *
 * 只读 runs + 那一轮的 assistant 消息，不拉整份快照——看板页每次进都要问一次。
 * 轮次按系统标记跨会话取（每次提炼新开会话），所以这里不再依赖「当前会话」那一个 id。
 */
export function boardState(now: Date = new Date()): TaskBoardState {
  const autoDays = readBoardAutoDays();
  const session = boardSession();
  const shown = shownBoard(now);

  const latest = repo.latestRunBySystemKey(BOARD_SYSTEM_KEY);
  const live = repo.latestRunBySystemKey(BOARD_SYSTEM_KEY, { live: true });
  const { stale, dueAt } = boardFreshness(shown.generatedAt, autoDays, now);

  let status: TaskBoardState['status'] = 'empty';
  if (live) status = 'running';
  // 本机最近一轮失败、且显示的就是本机那一版 → 标「刷新失败，下面是上一版」
  // （显示的是别端同步来的那份时，本机的失败与它无关，照旧 ready）
  else if (shown.answer) {
    status = shown.local && latest && NO_ANSWER_STATUS.includes(latest.status) ? 'failed' : 'ready';
  } else if (latest && NO_ANSWER_STATUS.includes(latest.status)) status = 'failed';

  return {
    sessionId: session?.id || '',
    status,
    answer: shown.answer,
    generatedAt: shown.generatedAt,
    updatedAt: shown.generatedAt,
    local: shown.local,
    sourceNodeId: shown.sourceNodeId,
    sourceNodeLabel: shown.sourceNodeLabel,
    stale,
    autoDays,
    dueAt,
    runId: live?.id || latest?.id || '',
    runStatus: live?.status || latest?.status || '',
    runStartedAt: live?.createdAt || latest?.createdAt || '',
    error: latest && NO_ANSWER_STATUS.includes(latest.status) ? latest.error || '' : '',
    windowStart: shown.windowStart,
    windowEnd: shown.windowEnd,
  };
}

/** 设置面板与看板页共用的配置态：档位 + 上次更新时间 + 到期时刻 + 有没有一轮在跑 */
export interface TaskBoardConfigState {
  /** 自动重新提炼的间隔（天）；0 = 关闭自动 */
  autoDays: number;
  /** 可选档位（0 是「关闭自动」，其余为天数）；界面按它渲染下拉 */
  options: number[];
  /** 当前这份看板的生成时刻（空 = 还没生成过） */
  generatedAt: string;
  /** 下一版到期时刻（关闭自动或还没有答案时为空串） */
  dueAt: string;
  /** 是否已到期（到期与否只在打开看板页时才触发提炼） */
  stale: boolean;
  /** 有没有一轮正在跑（界面显示「正在提炼」） */
  running: boolean;
  runId: string;
  /** 这份看板是不是本机生成的（false = 别端同步来的） */
  local: boolean;
  /** 生成这份看板的设备（local=false 时界面标「来自 X」） */
  sourceNodeLabel: string;
}

export function boardConfig(now: Date = new Date()): TaskBoardConfigState {
  const autoDays = readBoardAutoDays();
  // 与看板页显示同一份：别端同步来的那份也算「上次提炼」，两处的到期口径才一致
  const shown = shownBoard(now);
  const live = repo.latestRunBySystemKey(BOARD_SYSTEM_KEY, { live: true });
  const { stale, dueAt } = boardFreshness(shown.generatedAt, autoDays, now);
  return {
    autoDays,
    options: [...BOARD_AUTO_OPTIONS],
    generatedAt: shown.generatedAt,
    dueAt,
    stale,
    running: Boolean(live),
    runId: live?.id || '',
    local: shown.local,
    sourceNodeLabel: shown.sourceNodeLabel,
  };
}

/**
 * 新开一个看板会话并把设置指向它。
 *
 * 每次提炼都调它：新会话 = 新的 dsh 运行上下文（runner 按会话 id 保活运行时，历史也是按会话拼的），
 * 所以上一轮的对话不会被带进这一轮，跑多轮的成本不会一轮比一轮高。
 * 旧会话一律保留（用户可在聊天抽屉里翻过程），因此答案/状态都按系统标记跨会话取。
 */
export function newBoardSession(at: Date = new Date()): repo.SessionDto {
  // 老库里的看板会话可能没有系统标记：开新一轮前补上（否则会被当普通会话同步出去）
  const previous = boardSession();
  if (previous && previous.systemKey !== BOARD_SYSTEM_KEY) repo.markSessionSystem(previous.id, BOARD_SYSTEM_KEY);

  const created = repo.createSession(boardSessionTitle(at), BOARD_SYSTEM_KEY);
  setSetting(BOARD_SESSION_SETTING, created.id);
  return created;
}

/**
 * 让看板重新生成：已有一轮在跑就复用它（不重复烧 token），否则**新开一个会话**起一轮。
 * Agent 没配好时由 runner 抛 AgentNotConfiguredError（400），路由把它原样回给前端；
 * 这种情况下刚建的空会话会连同指针一起回滚——看板不能因为一次「起不来」就丢掉上一版。
 */
export function refreshBoard(): {
  sessionId: string;
  run: repo.RunDto;
  queued: boolean;
  reused: boolean;
} {
  const live = repo.latestRunBySystemKey(BOARD_SYSTEM_KEY, { live: true });
  if (live) {
    return { sessionId: live.sessionId, run: live, queued: live.status === 'queued', reused: true };
  }

  const previous = String(getSetting(BOARD_SESSION_SETTING) || '').trim();
  const session = newBoardSession();
  try {
    const { run, queued } = submitMessage({
      sessionId: session.id,
      message: WEEKLY_TASKS_QUESTION,
      // 显式指定手册：同一个问题在聊天里走常驻手册，看板走带机器可读清单的那份
      context: { playbook: TASK_BOARD_PLAYBOOK },
    });
    return { sessionId: session.id, run, queued, reused: false };
  } catch (error) {
    repo.deleteSession(session.id);
    if (previous) setSetting(BOARD_SESSION_SETTING, previous);
    throw error;
  }
}
