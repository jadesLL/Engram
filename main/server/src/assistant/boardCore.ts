import { db, getSetting } from '../lib/db.js';
import { nextWeekRange } from './playbooks.js';
import * as repo from './repository.js';

/**
 * 任务看板的核心口径：会话身份 + 「最近一次成功答案」的提取。
 *
 * 为什么单独成模块：taskBoard.ts 依赖 runner.ts（起一轮），而同步层要在「一轮跑完」时
 * 顺手把看板推给其他端——如果口径留在 taskBoard.ts 里，同步层就会反向依赖 runner，
 * 形成 taskBoard → runner → sync → taskBoard 的循环导入。这里只依赖 repository / playbooks / db，
 * 三方都不依赖同步层。
 */

/** 看板会话 id 的设置键。注意这是「本端内部会话」，看板对象本身跨端唯一（见 BOARD_SYNC_ID） */
export const BOARD_SESSION_SETTING = 'task_board_session_id';
/** 看板会话标题（createSession 带标题 → title_source=user，自动命名不会把它改掉） */
export const BOARD_SESSION_TITLE = '任务看板';
/** 跨端唯一键：看板不做「每端一份」，全网共用这一个对象 */
export const BOARD_SYNC_ID = 'default';
/** 系统会话标记：任务看板会话不参与会话同步，否则每台设备各留一份同名会话 */
export const BOARD_SYSTEM_KEY = 'task_board';

/** YYYY-MM-DD（本地日，不用 UTC 加减） */
export function isoDay(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${at.getFullYear()}-${month}-${day}`;
}

/**
 * 这份看板是哪一周的：按生成时刻算自然周（答案里的「下周」就是按那一刻推的）。
 * 没有答案时按当前时刻算，前端照样能铺出空的每一天。
 */
export function windowOf(anchor: Date): { windowStart: string; windowEnd: string } {
  const range = nextWeekRange(anchor);
  return { windowStart: isoDay(range.start), windowEnd: isoDay(range.end) };
}

export interface BoardAnswer {
  sessionId: string;
  /** 最近一次成功答案的 markdown 原文 */
  answer: string;
  /** 答案落库时间（完成时刻） */
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
}

/**
 * 最近一次「有正文的答案」：跳过空答案与失败轮次，往前找第一条真正有内容的助手消息。
 * 没有就是 null（看板为空）。
 */
export function latestBoardAnswer(): BoardAnswer | null {
  const sessionId = String(getSetting(BOARD_SESSION_SETTING) || '').trim();
  if (!sessionId) return null;
  if (!repo.getSession(sessionId)) return null;

  const answered = [...repo.listRuns(sessionId)]
    .reverse()
    .find((run) => run.assistantMessageId && (repo.getMessage(run.assistantMessageId)?.content || '').trim());
  if (!answered?.assistantMessageId) return null;

  const answer = repo.getMessage(answered.assistantMessageId)?.content || '';
  const generatedAt = answered.completedAt || answered.updatedAt || '';
  return {
    sessionId,
    answer,
    generatedAt,
    ...windowOf(generatedAt ? new Date(generatedAt) : new Date()),
  };
}

/**
 * 多端同步下来的那份看板（全端唯一一份，按答案生成时刻「最新者胜」）。
 *
 * 落在叶子模块的原因：同步层与看板状态都要读它，而看板状态不能反向依赖同步层
 * （taskBoard → runner → sync 会成环）。这里直接读 task_board_sync 这张表。
 */
export interface SyncedBoardPayload {
  id: string;
  answer: string;
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  /** 生成它的设备（界面据此显示「来自哪台设备」） */
  nodeId: string;
  nodeLabel: string;
  /** 这一份看板写入同步链路的时间 */
  updatedAt: string;
}

export function readSyncedBoard(): SyncedBoardPayload | null {
  const row = db.prepare(`SELECT payload FROM task_board_sync WHERE id = ?`).get(BOARD_SYNC_ID) as
    | { payload: string }
    | undefined;
  if (!row?.payload) return null;
  try {
    const parsed = JSON.parse(row.payload) as SyncedBoardPayload;
    return parsed && typeof parsed.answer === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
