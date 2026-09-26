import { getSetting, setSetting } from '../lib/db.js';

/**
 * 梦境思考的配置与排期（纯函数 + 一层 settings 读写，便于单测）。
 *
 * 需求形态是「每天几点」或「每隔几天几点」——不是 cron：所以这里不引 cron 依赖，
 * 只按本地时钟算「严格晚于基准时刻的第一个计划时刻」。
 *
 * 排期锚点（anchorAt）的用意：桌面端不一定整夜开机，机器在计划时刻关着时，下一次
 * 启动应当补跑一次。做法是把「上次实际跑完的时刻」与「本次启用的时刻」取较晚者当基准，
 * 算出下一个计划时刻；当前时刻越过它就算到期（错过多次也只补跑一次）。
 */

export type DreamFrequency = 'daily' | 'interval';

export interface DreamConfig {
  enabled: boolean;
  /** daily = 每天；interval = 每隔 intervalDays 天 */
  frequency: DreamFrequency;
  /** 本地时间 HH:MM */
  time: string;
  /** frequency='interval' 时的间隔天数（1..30） */
  intervalDays: number;
}

/** 配置与状态的 settings 键（清库时状态会被重置，配置保留） */
export const DREAM_SETTINGS_KEY = 'dream_config';
export const DREAM_STATE_KEY = 'dream_state';

/** 调度 tick 粒度：到期判断按分钟级精度，30 秒一次足够（与 DDNS 同档） */
export const DREAM_TICK_MS = 30_000;

export const DEFAULT_DREAM_TIME = '03:00';
export const DEFAULT_DREAM_INTERVAL_DAYS = 1;
export const MAX_DREAM_INTERVAL_DAYS = 30;

export const DEFAULT_DREAM_CONFIG: DreamConfig = {
  enabled: false,
  frequency: 'daily',
  time: DEFAULT_DREAM_TIME,
  intervalDays: DEFAULT_DREAM_INTERVAL_DAYS,
};

/** 最近一次运行的结果：skipped = 到点但没有待办，自动跳过（不烧 token） */
export type DreamRunStatus = '' | 'completed' | 'failed' | 'cancelled' | 'skipped';

export interface DreamState {
  /** 排期锚点：启用（或改计划）的时刻 */
  anchorAt: string;
  /** 上次运行（含跳过的自动检查）的收口时刻 */
  lastRunAt: string;
  lastTrigger: '' | 'schedule' | 'manual';
  lastStatus: DreamRunStatus;
  lastError: string;
  /** 最近一次运行的收尾小结（助手最后一段正文，截断后的单行） */
  lastSummary: string;
  lastRunId: string;
  /** 正在跑的那一轮：tick 据此等它收口，不重复起轮 */
  currentRunId: string;
  /** 本轮开始时刻 */
  runningSince: string;
  /** 起跑前的问题计数（界面显示「整理前 → 整理后」） */
  beforePendingFiles: number;
  beforeIssues: number;
}

export const EMPTY_DREAM_STATE: DreamState = {
  anchorAt: '',
  lastRunAt: '',
  lastTrigger: '',
  lastStatus: '',
  lastError: '',
  lastSummary: '',
  lastRunId: '',
  currentRunId: '',
  runningSince: '',
  beforePendingFiles: 0,
  beforeIssues: 0,
};

/** HH:MM → 规范化写法；非法（含 25:00、3:5、空）返回 null */
export function parseClock(value: unknown): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function clampDreamIntervalDays(value: unknown): number {
  const days = Number(value);
  if (!Number.isFinite(days)) return DEFAULT_DREAM_INTERVAL_DAYS;
  return Math.min(MAX_DREAM_INTERVAL_DAYS, Math.max(1, Math.floor(days)));
}

/** 归一化外部输入（设置页/接口/历史数据都走这里）：认不出的值退回默认，不抛错 */
export function normalizeDreamConfig(raw: unknown): DreamConfig {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    enabled: source.enabled === true,
    frequency: source.frequency === 'interval' ? 'interval' : 'daily',
    time: parseClock(source.time) ?? DEFAULT_DREAM_TIME,
    intervalDays: clampDreamIntervalDays(source.intervalDays),
  };
}

/** 频率的中文说法（界面与作业手册共用一处口径） */
export function describeSchedule(config: DreamConfig): string {
  return config.frequency === 'interval'
    ? `每隔 ${clampDreamIntervalDays(config.intervalDays)} 天 ${config.time}`
    : `每天 ${config.time}`;
}

function readJson(key: string): Record<string, unknown> {
  try {
    const raw = getSetting(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readDreamConfig(): DreamConfig {
  return normalizeDreamConfig(readJson(DREAM_SETTINGS_KEY));
}

/**
 * 保存配置；计划本身变了（开关从关到开、频率/时间/间隔变化）就把排期锚点重置为此刻，
 * 只改无关字段时保留原锚点——否则同一天里反复保存会把当晚的计划推走。
 */
export function writeDreamConfig(patch: Partial<DreamConfig>, now: Date = new Date()): DreamConfig {
  const before = readDreamConfig();
  const next = normalizeDreamConfig({ ...before, ...patch });
  setSetting(DREAM_SETTINGS_KEY, JSON.stringify(next));
  const scheduleChanged = !before.enabled !== !next.enabled
    || before.frequency !== next.frequency
    || before.time !== next.time
    || clampDreamIntervalDays(before.intervalDays) !== clampDreamIntervalDays(next.intervalDays);
  if (scheduleChanged) writeDreamState({ anchorAt: now.toISOString() });
  return next;
}

export function readDreamState(): DreamState {
  const raw = readJson(DREAM_STATE_KEY);
  const text = (key: keyof DreamState) => String(raw[key] ?? '');
  const count = (key: keyof DreamState) => {
    const value = Number(raw[key]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  };
  const trigger = text('lastTrigger');
  const status = text('lastStatus');
  return {
    anchorAt: text('anchorAt'),
    lastRunAt: text('lastRunAt'),
    lastTrigger: trigger === 'schedule' || trigger === 'manual' ? trigger : '',
    lastStatus: (['completed', 'failed', 'cancelled', 'skipped'] as string[]).includes(status)
      ? (status as DreamRunStatus)
      : '',
    lastError: text('lastError'),
    lastSummary: text('lastSummary'),
    lastRunId: text('lastRunId'),
    currentRunId: text('currentRunId'),
    runningSince: text('runningSince'),
    beforePendingFiles: count('beforePendingFiles'),
    beforeIssues: count('beforeIssues'),
  };
}

export function writeDreamState(patch: Partial<DreamState>): DreamState {
  const next = { ...readDreamState(), ...patch };
  setSetting(DREAM_STATE_KEY, JSON.stringify(next));
  return next;
}

function atClock(day: Date, clock: string): Date {
  const [hour, minute] = clock.split(':').map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0);
}

function addDays(day: Date, days: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + days);
}

/**
 * 严格晚于 base 的第一个计划时刻（本地时间）：
 * - daily：base 当天这个点还没到就用今天，已过就用明天；
 * - interval N：base 那天再隔 N 天的这个点。
 */
export function firstOccurrenceAfter(config: DreamConfig, base: Date): Date {
  const clock = parseClock(config.time) ?? DEFAULT_DREAM_TIME;
  if (config.frequency === 'interval') {
    return atClock(addDays(base, clampDreamIntervalDays(config.intervalDays)), clock);
  }
  const today = atClock(base, clock);
  return today.getTime() > base.getTime() ? today : atClock(addDays(base, 1), clock);
}

/** 解析 ISO 时刻；空串/坏值返回 null */
function parseTime(value: string): Date | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? at : null;
}

/** 下一次该跑的时刻：没启用、或从没启用过（没有锚点也没有历史）时返回 null */
export function nextDueAt(
  config: DreamConfig,
  state: DreamState,
  now: Date = new Date(),
): Date | null {
  if (!config.enabled) return null;
  const lastRun = parseTime(state.lastRunAt);
  const anchor = parseTime(state.anchorAt);
  const base = lastRun && anchor ? (lastRun.getTime() >= anchor.getTime() ? lastRun : anchor) : (lastRun ?? anchor);
  return firstOccurrenceAfter(config, base ?? now);
}

/** 是否已到期该跑（错过的计划在下次 tick 补跑，且只补一次） */
export function isDreamDue(config: DreamConfig, state: DreamState, now: Date = new Date()): boolean {
  const due = nextDueAt(config, state, now);
  return Boolean(due && due.getTime() <= now.getTime());
}
