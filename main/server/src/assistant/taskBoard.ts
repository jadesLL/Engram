import { getSetting, setSetting } from '../lib/db.js';
import { TASK_BOARD_PLAYBOOK, WEEKLY_TASKS_QUESTION } from './playbooks.js';
import * as repo from './repository.js';
import { submitMessage } from './runner.js';
import {
  BOARD_SESSION_SETTING,
  BOARD_SESSION_TITLE,
  BOARD_SYSTEM_KEY,
  latestBoardAnswer,
  readSyncedBoard,
  windowOf,
} from './boardCore.js';

/**
 * 任务看板的服务端状态：一个专用会话 + 一份「最近一次成功答案」。
 *
 * 为什么复用 assistant 会话而不是另建一张表：提问就是一次正常的 Agent 轮次，
 * 排队、停止、事件流、用量、追溯过程全都白拿；看板只是把那一轮的答案换个样子渲染。
 * 会话 id 记在服务端设置里（不靠前端记忆），会话被用户在聊天里删掉也能重建。
 *
 * 多端：看板对象全端唯一一份（boardCore.BOARD_SYNC_ID）。本机这份与同步下来的那份
 * 按答案生成时刻取最新，所以任意端刷新后，各端看到的都是最新那一版；界面上带
 * 「上次更新时间」与来源设备。看板会话本身带系统标记，不参与会话同步（否则每端多一份同名会话）。
 */

/** 看板会话 id 的设置键 / 标题（口径在 boardCore，这里转出保持既有引用可用） */
export { BOARD_SESSION_SETTING, BOARD_SESSION_TITLE };
/** 结果多久算新鲜：进页面直接看缓存，过期才自动重跑 */
export const BOARD_FRESH_MS = 6 * 60 * 60 * 1000;

/** 终态但没产出答案的轮次状态 */
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
  /** 结果是否过期（超过 BOARD_FRESH_MS） */
  stale: boolean;
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

/** 空看板（还没有本机答案，也没有同步过来的那份） */
function emptyState(now: Date): TaskBoardState {
  return {
    sessionId: '',
    status: 'empty',
    answer: '',
    generatedAt: '',
    updatedAt: '',
    local: true,
    sourceNodeId: '',
    sourceNodeLabel: '',
    stale: true,
    runId: '',
    runStatus: '',
    runStartedAt: '',
    error: '',
    ...windowOf(now),
  };
}

/** 看板会话（设置里记着 id，但会话可能已被删掉）；不创建 */
export function boardSession(): repo.SessionDto | null {
  const id = String(getSetting(BOARD_SESSION_SETTING) || '').trim();
  return id ? repo.getSession(id) : null;
}

/**
 * 取看板会话，没有就建一个并把 id 记进设置。
 * 会话带系统标记（task_board）：它不参与会话同步，否则每端会多出一份同名会话。
 */
export function ensureBoardSession(): repo.SessionDto {
  const existing = boardSession();
  if (existing) {
    // 老库里的看板会话没有系统标记：补上（否则会被当成普通会话同步出去）
    if (existing.systemKey !== BOARD_SYSTEM_KEY) repo.markSessionSystem(existing.id, BOARD_SYSTEM_KEY);
    return existing;
  }
  const created = repo.createSession(BOARD_SESSION_TITLE, BOARD_SYSTEM_KEY);
  setSetting(BOARD_SESSION_SETTING, created.id);
  return created;
}

/**
 * 看板当前状态：最近一次成功的答案 + 正在跑的那一轮。
 *
 * 只读 runs + 那一轮的 assistant 消息，不拉整份快照——看板页每次进都要问一次。
 */
export function boardState(now: Date = new Date()): TaskBoardState {
  const session = boardSession();
  const synced = readSyncedBoard();
  const localAnswer = latestBoardAnswer();

  // 本机这份 vs 同步下来的那份：谁生成得晚用谁的。任意端刷新后，各端都显示最新那一版；
  // 本机没有答案而别端有时（新设备首次接入），也直接显示同步来的那份。
  const useSynced = Boolean(
    synced && (!localAnswer || String(synced.generatedAt) > String(localAnswer.generatedAt))
  );
  const answer = useSynced ? synced!.answer : localAnswer?.answer || '';
  const generatedAt = useSynced ? synced!.generatedAt : localAnswer?.generatedAt || '';
  const window = useSynced
    ? { windowStart: synced!.windowStart, windowEnd: synced!.windowEnd }
    : localAnswer
      ? { windowStart: localAnswer.windowStart, windowEnd: localAnswer.windowEnd }
      : windowOf(now);

  const runs = session ? repo.listRuns(session.id) : [];
  const latest = runs[runs.length - 1];
  const live = [...runs].reverse().find((run) => run.status === 'running' || run.status === 'queued') || null;
  const stale = !generatedAt || now.getTime() - Date.parse(generatedAt) > BOARD_FRESH_MS;

  let status: TaskBoardState['status'] = 'empty';
  if (live) status = 'running';
  // 本机最近一轮失败、且显示的就是本机那一版 → 标「刷新失败，下面是上一版」
  else if (answer) status = !useSynced && latest && NO_ANSWER_STATUS.includes(latest.status) ? 'failed' : 'ready';
  else if (latest && NO_ANSWER_STATUS.includes(latest.status)) status = 'failed';

  return {
    sessionId: session?.id || '',
    status,
    answer,
    generatedAt,
    updatedAt: generatedAt,
    local: !useSynced,
    sourceNodeId: useSynced ? synced!.nodeId : '',
    sourceNodeLabel: useSynced ? synced!.nodeLabel : '',
    stale,
    runId: live?.id || latest?.id || '',
    runStatus: live?.status || latest?.status || '',
    runStartedAt: live?.createdAt || latest?.createdAt || '',
    error: latest && NO_ANSWER_STATUS.includes(latest.status) ? latest.error || '' : '',
    ...window,
  };
}

/**
 * 让看板重新生成：会话里已经有一轮在跑就复用它（不重复烧 token），否则起一轮。
 * Agent 没配好时由 runner 抛 AgentNotConfiguredError（400），路由把它原样回给前端。
 */
export function refreshBoard(): {
  sessionId: string;
  run: repo.RunDto;
  queued: boolean;
  reused: boolean;
} {
  const session = ensureBoardSession();
  const live = [...repo.listRuns(session.id)]
    .reverse()
    .find((run) => run.status === 'running' || run.status === 'queued');
  if (live) {
    return { sessionId: session.id, run: live, queued: live.status === 'queued', reused: true };
  }

  const { run, queued } = submitMessage({
    sessionId: session.id,
    message: WEEKLY_TASKS_QUESTION,
    // 显式指定手册：同一个问题在聊天里走常驻手册，看板走带机器可读清单的那份
    context: { playbook: TASK_BOARD_PLAYBOOK },
  });
  return { sessionId: session.id, run, queued, reused: false };
}
