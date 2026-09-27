import { db, getSetting, setSetting } from '../lib/db.js';
import { nextWeekRange } from './playbooks.js';
import * as repo from './repository.js';

/**
 * 任务看板的核心口径：会话身份 + 「最近一次成功答案」的提取 + 自动重新提炼的间隔。
 *
 * 为什么单独成模块：taskBoard.ts 依赖 runner.ts（起一轮），而同步层要在「一轮跑完」时
 * 顺手把看板推给其他端——如果口径留在 taskBoard.ts 里，同步层就会反向依赖 runner，
 * 形成 taskBoard → runner → sync → taskBoard 的循环导入。这里只依赖 repository / playbooks / db，
 * 三方都不依赖同步层。
 */

/** 看板会话 id 的设置键。注意这是「本端内部会话」，看板对象本身跨端唯一（见 BOARD_SYNC_ID） */
export const BOARD_SESSION_SETTING = 'task_board_session_id';
/** 看板会话标题前缀（createSession 带标题 → title_source=user，自动命名不会把它改掉） */
export const BOARD_SESSION_TITLE = '任务看板';
/** 跨端唯一键：看板不做「每端一份」，全网共用这一个对象 */
export const BOARD_SYNC_ID = 'default';
/** 系统会话标记：任务看板会话不参与会话同步，否则每台设备各留一份同名会话 */
export const BOARD_SYSTEM_KEY = 'task_board';

/** 自动重新提炼间隔的设置键（单位：天；0 = 关闭自动） */
export const BOARD_AUTO_SETTING = 'task_board_auto_days';
/** 可选档位：0 = 关闭自动，其余为天数。界面按它渲染下拉，服务端按它归一化写入值 */
export const BOARD_AUTO_OPTIONS = [0, 1, 2, 3, 7];
/** 默认间隔：每 2 天（老库没有这个设置时按它算） */
export const BOARD_AUTO_DEFAULT_DAYS = 2;
/** 一天 = 24 小时；间隔按「自然时长」算，不绑某个时刻（用户不必挑几点） */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** 只认登记的档位：手写设置、接口传进来的野值一律落回默认，界面不会被带偏 */
export function normalizeBoardAutoDays(value: unknown): number {
  // 空值与布尔不算「0 天」：Number(null) / Number('') / Number(true) 都会变成 0 或 1，
  // 不挡住的话一个 `autoDays: null` 就被悄悄理解成「关闭自动」。
  if (value === null || value === undefined || typeof value === 'boolean') return BOARD_AUTO_DEFAULT_DAYS;
  if (typeof value === 'string' && value.trim() === '') return BOARD_AUTO_DEFAULT_DAYS;
  const days = Math.trunc(Number(value));
  return BOARD_AUTO_OPTIONS.includes(days) ? days : BOARD_AUTO_DEFAULT_DAYS;
}

/** 当前配置：自动重新提炼的间隔（天），0 = 关闭自动 */
export function readBoardAutoDays(): number {
  const raw = getSetting(BOARD_AUTO_SETTING);
  if (raw === undefined || String(raw).trim() === '') return BOARD_AUTO_DEFAULT_DAYS;
  return normalizeBoardAutoDays(raw);
}

/** 写配置：先归一化再落库，返回真正生效的值（界面按它回填，不自己猜） */
export function writeBoardAutoDays(value: unknown): number {
  const days = normalizeBoardAutoDays(value);
  setSetting(BOARD_AUTO_SETTING, String(days));
  return days;
}

/**
 * 到期口径：答案生成时刻 + 间隔天数 = 到期时刻。**只有打开看板页时才判一次**——
 * 看板不像梦境思考那样有后台定时器，用户没来看就不提炼（不白烧 token）。
 * 关闭自动（0）时永不判过期，只在手动点「刷新」时才重新提炼。
 */
export function boardFreshness(
  generatedAt: string,
  autoDays: number,
  now: Date = new Date(),
): { stale: boolean; dueAt: string } {
  const at = Date.parse(generatedAt);
  if (!generatedAt || !Number.isFinite(at) || autoDays <= 0) return { stale: false, dueAt: '' };
  const due = at + autoDays * DAY_MS;
  return { stale: now.getTime() > due, dueAt: new Date(due).toISOString() };
}

/** 新开会话的标题：带日期时间，聊天抽屉里能分辨哪一轮是哪一版（每次都新开，不再共用一个会话） */
export function boardSessionTitle(at: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `${BOARD_SESSION_TITLE} ${day} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

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
 * 最近一次「有正文的答案」：跳过空答案与失败轮次，跨**所有看板会话**找生成时刻最新的那条。
 * 没有就是 null（看板为空）。
 *
 * 为什么跨会话：每次提炼都新开一个会话（上下文不越滚越长），答案因此分散在多个会话里；
 * 只看最新那个会话的话，新会话一开、上一版看板就没了——提炼期间与失败时都得继续显示上一版。
 */
export function latestBoardAnswer(): BoardAnswer | null {
  const answered = repo.latestAnswerBySystemKey(BOARD_SYSTEM_KEY);
  if (!answered) return null;

  const generatedAt = answered.run.completedAt || answered.run.updatedAt || '';
  return {
    sessionId: answered.run.sessionId,
    answer: answered.content,
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
