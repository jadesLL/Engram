import { getSetting, setSetting } from '../lib/db.js';
import { TASK_BOARD_PLAYBOOK, WEEKLY_TASKS_QUESTION } from './playbooks.js';
import * as repo from './repository.js';
import { submitMessage } from './runner.js';

/**
 * 任务看板的服务端状态：一个专用会话 + 一份「最近一次成功答案」。
 *
 * 为什么复用 assistant 会话而不是另建一张表：提问就是一次正常的 Agent 轮次，
 * 排队、停止、事件流、用量、追溯过程全都白拿；看板只是把那一轮的答案换个样子渲染。
 * 会话 id 记在服务端设置里（不靠前端记忆），会话被用户在聊天里删掉也能重建。
 */

/** 看板会话 id 的设置键 */
export const BOARD_SESSION_SETTING = 'task_board_session_id';
/** 看板会话标题（createSession 带标题 → title_source=user，自动命名不会把它改掉） */
export const BOARD_SESSION_TITLE = '任务看板';
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
  /** 结果是否过期（超过 BOARD_FRESH_MS） */
  stale: boolean;
  /** 最近一轮（正在跑时前端据此接事件流） */
  runId: string;
  runStatus: string;
  runStartedAt: string;
  /** 最近一轮的失败原因（有的话） */
  error: string;
}

function emptyState(): TaskBoardState {
  return {
    sessionId: '',
    status: 'empty',
    answer: '',
    generatedAt: '',
    stale: true,
    runId: '',
    runStatus: '',
    runStartedAt: '',
    error: '',
  };
}

/** 看板会话（设置里记着 id，但会话可能已被删掉）；不创建 */
export function boardSession(): repo.SessionDto | null {
  const id = String(getSetting(BOARD_SESSION_SETTING) || '').trim();
  return id ? repo.getSession(id) : null;
}

/** 取看板会话，没有就建一个并把 id 记进设置 */
export function ensureBoardSession(): repo.SessionDto {
  const existing = boardSession();
  if (existing) return existing;
  const created = repo.createSession(BOARD_SESSION_TITLE);
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
  if (!session) return emptyState();

  const runs = repo.listRuns(session.id);
  if (!runs.length) return { ...emptyState(), sessionId: session.id };

  const latest = runs[runs.length - 1];
  const live = [...runs].reverse().find((run) => run.status === 'running' || run.status === 'queued') || null;
  const answered = [...runs]
    .reverse()
    .find((run) => run.assistantMessageId && (repo.getMessage(run.assistantMessageId)?.content || '').trim());

  const answer = answered ? repo.getMessage(answered.assistantMessageId!)?.content || '' : '';
  const generatedAt = answered?.completedAt || answered?.updatedAt || '';
  const stale = !generatedAt || now.getTime() - Date.parse(generatedAt) > BOARD_FRESH_MS;

  let status: TaskBoardState['status'] = 'empty';
  if (live) status = 'running';
  else if (answer) status = NO_ANSWER_STATUS.includes(latest.status) ? 'failed' : 'ready';
  else if (NO_ANSWER_STATUS.includes(latest.status)) status = 'failed';
  else status = 'empty';

  return {
    sessionId: session.id,
    status,
    answer,
    generatedAt,
    stale,
    runId: live?.id || latest.id,
    runStatus: live?.status || latest.status,
    runStartedAt: live?.createdAt || latest.createdAt,
    error: NO_ANSWER_STATUS.includes(latest.status) ? latest.error || '' : '',
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
