import crypto from 'node:crypto';
import { db, now } from '../lib/db.js';
import { addUsage, type UsageDto, type UsageStep } from './usage.js';

/**
 * 内置 Agent 的持久层：复用库里既有的 assistant_* 表（v1.1 聊天功能的表结构，
 * v1.2.0 移除内置 AI 时按「数据零破坏」保留至今），只补一列 dsh_session_id 用于续聊。
 */

/**
 * 标题来源：default = 还没起过名字（「新对话」），auto = Engram 按内容自动命名，
 * user = 用户手动改过（此后自动命名不再覆盖）。
 */
export type TitleSource = 'default' | 'auto' | 'user';

export interface SessionDto {
  id: string;
  title: string;
  titleSource: TitleSource;
  /** 该会话当前是否有正在跑的一轮（会话列表据此显示「回复中」） */
  running: boolean;
  dshSessionId: string;
  createdAt: string;
  updatedAt: string;
  /** 多端同步：产生该会话的设备（界面据此标「来自哪台设备」；同步关闭时为空） */
  originNodeId: string;
  originNodeLabel: string;
  /** 系统会话标记（当前只有 task_board）：看板自己的会话，不参与会话同步 */
  systemKey: string;
}

export interface MessageDto {
  id: string;
  sessionId: string;
  runId?: string;
  role: 'user' | 'assistant';
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RunDto {
  id: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  error?: string;
  ingestedPath?: string;
  /** 本轮主对话的累计模型用量（含缓存命中）：老轮次没有用量事件时缺省 */
  usage?: UsageDto;
  /** 本轮子代理的累计用量：单独统计，不混进主对话的命中率 */
  subagentUsage?: UsageDto;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ToolCallDto {
  id: string;
  runId: string;
  name: string;
  args: string;
  status: string;
  ok: boolean;
  text: string;
  createdAt: string;
}

/** 子代理状态：running 在跑 / completed 成功 / failed 失败 / background 本轮结束时仍在后台跑 */
export type SubagentStatus = 'running' | 'completed' | 'failed' | 'background';

/** 子代理过程里的一步（子会话里的工具调用），卡片的折叠区按顺序列出 */
export interface SubagentActivityDto {
  name: string;
  summary: string;
  status: 'running' | 'completed' | 'failed';
  text?: string;
  at: string;
}

export interface SubagentDto {
  id: string;
  runId?: string;
  /** 派它的那次工具调用行 id：前端把该工具卡合并进子代理卡，不再重复显示两行 */
  parentCallId?: string;
  /** 父会话：Engram 会话对应的 dsh 根会话，或另一个子代理的子会话 id */
  parentSessionId: string;
  childSessionId: string;
  label: string;
  mode: string;
  provider: string;
  /** 委派给它的任务原文（取自派发工具调用的 prompt 参数） */
  prompt: string;
  status: SubagentStatus;
  stopReason: string;
  /** 子代理最终产出（finished 载荷的最后一条助手消息，或流式观察到的最后正文） */
  result: string;
  activity: SubagentActivityDto[];
  createdAt: string;
  updatedAt: string;
}

export interface Snapshot {
  session: SessionDto;
  messages: MessageDto[];
  runs: RunDto[];
  toolCalls: ToolCallDto[];
  /** 本会话派出的子代理（含嵌套），对话流据此显示「用了子代理」 */
  subagents: SubagentDto[];
  /** 还在等用户点选的提问：对话最下侧弹窗据此渲染（点选后从快照里消失） */
  questions: QuestionDto[];
}

/**
 * 正在执行的轮次：只有它占着会话的单飞位（同一会话同时只跑一轮）。
 * 排队中的轮次（queued）还没送进 dsh，不占位——前一轮收口后它自动转正。
 */
const RUNNING_STATUSES = ['running'];

/** 还在推进的轮次（含排队中）：会话列表的「忙」状态、删会话时的收尾都要算上 */
const ACTIVE_STATUSES = ['queued', 'running'];

function uuid(): string {
  return crypto.randomUUID();
}

/** 标题来源归一化：老库补列前是 NULL，按「非默认标题即用户命名」处理（见 migrate 回填） */
function titleSourceOf(row: any): TitleSource {
  const value = String(row.title_source || '');
  return value === 'auto' || value === 'user' ? value : 'default';
}

function toSession(row: any, running = false): SessionDto {
  return {
    id: row.id,
    title: row.title,
    titleSource: titleSourceOf(row),
    running,
    dshSessionId: row.dsh_session_id || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    originNodeId: row.origin_node_id || '',
    originNodeLabel: row.origin_node_label || '',
    systemKey: row.system_key || '',
  };
}

function toMessage(row: any): MessageDto {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata || '{}');
  } catch {
    /* 坏 JSON 当空 */
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    ...(row.run_id ? { runId: row.run_id } : {}),
    role: row.role === 'user' ? 'user' : 'assistant',
    content: row.content,
    metadata,
    createdAt: row.created_at,
  };
}

/**
 * assistant_runs.usage 里存的形状（JSON）：主对话与子代理各记一份累计用量。
 * 单列而不是塞进 context——context 会被 runner 原样当 InterfaceContext 复用（见 runContext）。
 */
interface RunUsageBlob {
  main?: UsageDto;
  subagents?: UsageDto;
}

/** 读回一行的用量 JSON；坏 JSON / 老行一律当没有（不显示总比显示错的强） */
function parseRunUsage(raw: unknown): { usage?: UsageDto; subagentUsage?: UsageDto } {
  if (typeof raw !== 'string' || !raw) return {};
  let blob: RunUsageBlob;
  try {
    blob = JSON.parse(raw) as RunUsageBlob;
  } catch {
    return {};
  }
  if (!blob || typeof blob !== 'object') return {};
  return {
    ...(blob.main ? { usage: blob.main } : {}),
    ...(blob.subagents ? { subagentUsage: blob.subagents } : {}),
  };
}

function toRun(row: any): RunDto {
  return {
    id: row.id,
    sessionId: row.session_id,
    userMessageId: row.user_message_id,
    ...(row.assistant_message_id ? { assistantMessageId: row.assistant_message_id } : {}),
    status: row.status,
    ...(row.error ? { error: row.error } : {}),
    ...(row.ingested_path ? { ingestedPath: row.ingested_path } : {}),
    ...parseRunUsage(row.usage),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

function toToolCall(row: any): ToolCallDto {
  let result: any = {};
  try {
    result = JSON.parse(row.result || '{}');
  } catch {
    /* 坏 JSON 当空 */
  }
  return {
    id: row.id,
    runId: row.run_id,
    name: row.name,
    args: row.arguments || '',
    status: row.status,
    ok: result.ok !== false,
    text: typeof result.text === 'string' ? result.text : '',
    createdAt: row.created_at,
  };
}

/** 正在跑的会话 id 集合：会话列表一次查出，避免每行一次查询 */
function runningSessionIds(): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT session_id FROM assistant_runs
       WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')})`
    )
    .all(...ACTIVE_STATUSES) as any[];
  const ids = new Set<string>(rows.map((row) => row.session_id));
  const conversions = db.prepare(
    `SELECT DISTINCT assistant_session_id AS session_id FROM jobs
     WHERE kind = 'inbox_convert' AND assistant_session_id IS NOT NULL
       AND status IN ('pending', 'running', 'paused')`
  ).all() as { session_id: string }[];
  for (const row of conversions) ids.add(row.session_id);
  return ids;
}

function subagentStatusOf(value: unknown): SubagentStatus {
  return value === 'completed' || value === 'failed' || value === 'background' ? value : 'running';
}

function toSubagent(row: any): SubagentDto {
  let activity: SubagentActivityDto[] = [];
  try {
    const parsed = JSON.parse(row.activity || '[]');
    if (Array.isArray(parsed)) activity = parsed as SubagentActivityDto[];
  } catch {
    /* 坏 JSON 当空 */
  }
  return {
    id: row.id,
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.parent_call_id ? { parentCallId: row.parent_call_id } : {}),
    parentSessionId: row.parent_session_id || '',
    childSessionId: row.child_session_id,
    label: row.label || '',
    mode: row.mode || '',
    provider: row.provider || '',
    prompt: row.prompt || '',
    status: subagentStatusOf(row.status),
    stopReason: row.stop_reason || '',
    result: row.result || '',
    activity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listSessions(): SessionDto[] {
  const rows = db
    .prepare(`SELECT * FROM assistant_sessions ORDER BY updated_at DESC`)
    .all() as any[];
  const running = runningSessionIds();
  return rows.map((row) => toSession(row, running.has(row.id)));
}

export function getSession(id: string): SessionDto | null {
  const row = db.prepare(`SELECT * FROM assistant_sessions WHERE id = ?`).get(id) as any;
  if (!row) return null;
  return toSession(row, runningSessionIds().has(id));
}

/** systemKey 非空 = 系统会话（当前只有任务看板），不参与会话同步 */
export function createSession(title?: string, systemKey = ''): SessionDto {
  const stamp = now();
  const id = uuid();
  const named = (title || '').trim();
  db.prepare(
    `INSERT INTO assistant_sessions(id, title, summary, archived, dsh_session_id, title_source, system_key, created_at, updated_at)
     VALUES(?, ?, '', 0, ?, ?, ?, ?, ?)`
  ).run(id, named || '新对话', `session-${uuid()}`, named ? 'user' : 'default', systemKey, stamp, stamp);
  return getSession(id)!;
}

/** 把已有会话标成系统会话（老库里的任务看板会话在升级后补标） */
export function markSessionSystem(id: string, systemKey: string): void {
  db.prepare(`UPDATE assistant_sessions SET system_key = ? WHERE id = ? AND COALESCE(system_key, '') = ''`)
    .run(systemKey, id);
}

/** 手动改名：钉住标题，自动命名不再覆盖 */
export function renameSession(id: string, title: string): void {
  db.prepare(`UPDATE assistant_sessions SET title = ?, title_source = 'user', updated_at = ? WHERE id = ?`)
    .run(title.trim() || '新对话', now(), id);
}

/**
 * 自动命名：只在标题还是本方自动生成的（default/auto）时写入，用户手动改过就不动。
 * 返回是否真的改了——调用方据此决定要不要广播。
 */
export function setSessionTitleIfAuto(id: string, title: string): boolean {
  const next = title.trim();
  if (!next) return false;
  const result = db
    .prepare(
      `UPDATE assistant_sessions SET title = ?, title_source = 'auto', updated_at = ?
       WHERE id = ? AND COALESCE(title_source, 'default') != 'user' AND title != ?`
    )
    .run(next, now(), id, next);
  return result.changes > 0;
}

export function touchSession(id: string): void {
  db.prepare(`UPDATE assistant_sessions SET updated_at = ? WHERE id = ?`).run(now(), id);
}

export function deleteSession(id: string): void {
  db.prepare(`UPDATE jobs SET assistant_session_id = NULL WHERE assistant_session_id = ?`).run(id);
  db.prepare(`DELETE FROM assistant_subagents WHERE session_id = ?`).run(id);
  db.prepare(`DELETE FROM assistant_messages WHERE session_id = ?`).run(id);
  db.prepare(`DELETE FROM assistant_runs WHERE session_id = ?`).run(id);
  db.prepare(`DELETE FROM assistant_sessions WHERE id = ?`).run(id);
}

export function insertMessage(input: {
  sessionId: string;
  runId?: string;
  role: 'user' | 'assistant';
  content: string;
  metadata?: Record<string, unknown>;
}): MessageDto {
  const id = uuid();
  db.prepare(
    `INSERT INTO assistant_messages(id, session_id, run_id, role, content, metadata, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.sessionId,
    input.runId ?? null,
    input.role,
    input.content,
    JSON.stringify(input.metadata || {}),
    now()
  );
  return getMessage(id)!;
}

export function getMessage(id: string): MessageDto | null {
  const row = db.prepare(`SELECT * FROM assistant_messages WHERE id = ?`).get(id) as any;
  return row ? toMessage(row) : null;
}

export function appendMessageContent(id: string, text: string): string {
  const row = db.prepare(`SELECT content FROM assistant_messages WHERE id = ?`).get(id) as any;
  const merged = row?.content ? `${row.content}\n\n${text}` : text;
  db.prepare(`UPDATE assistant_messages SET content = ? WHERE id = ?`).run(merged, id);
  return merged;
}

/**
 * 逐块追加（原样拼接，不插空行）：思考段的增量回放用。
 * 与 appendMessageContent 的区别只在分隔符——正文是「每步一段」，思考是「一段里的第 N 个增量」。
 */
export function appendMessageChunk(id: string, text: string): string {
  const row = db.prepare(`SELECT content FROM assistant_messages WHERE id = ?`).get(id) as any;
  const merged = `${row?.content ?? ''}${text}`;
  db.prepare(`UPDATE assistant_messages SET content = ? WHERE id = ?`).run(merged, id);
  return merged;
}

export function setMessageContent(id: string, content: string): void {
  db.prepare(`UPDATE assistant_messages SET content = ? WHERE id = ?`).run(content, id);
}

/** 合并式写 metadata（思考段的用时等收口信息在段结束时补写） */
export function updateMessageMetadata(id: string, patch: Record<string, unknown>): void {
  const row = db.prepare(`SELECT metadata FROM assistant_messages WHERE id = ?`).get(id) as any;
  if (!row) return;
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(row.metadata || '{}');
  } catch {
    /* 坏 JSON 当空 */
  }
  db.prepare(`UPDATE assistant_messages SET metadata = ? WHERE id = ?`)
    .run(JSON.stringify({ ...current, ...patch }), id);
}

/** 该会话里用户发过几条消息（首轮结束才做模型总结命名） */
export function countUserMessages(sessionId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS total FROM assistant_messages WHERE session_id = ? AND role = 'user'`)
    .get(sessionId) as any;
  return Number(row?.total) || 0;
}

/**
 * 建一轮运行。status='queued' 用于「上一轮还在跑时用户又发了一条」：
 * 先把消息与轮次落库（前端立刻看得见「排队中」），等前一轮收口再转正送进 dsh。
 */
export function createRun(input: {
  sessionId: string;
  userMessageId: string;
  context: unknown;
  status?: 'running' | 'queued';
}): RunDto {
  const id = uuid();
  const stamp = now();
  db.prepare(
    `INSERT INTO assistant_runs(id, session_id, user_message_id, status, context, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.sessionId,
    input.userMessageId,
    input.status === 'queued' ? 'queued' : 'running',
    JSON.stringify(input.context ?? {}),
    stamp,
    stamp
  );
  // 用户消息回填 run_id：前端靠它把"乐观插入的本地消息"与快照里的同一条对齐
  db.prepare(`UPDATE assistant_messages SET run_id = ? WHERE id = ?`).run(id, input.userMessageId);
  return getRun(id)!;
}

/** 一轮运行里带的界面上下文（排队轮次转正、重试时都要还原同一份） */
export function runContext(runId: string): Record<string, unknown> {
  const row = db.prepare(`SELECT context FROM assistant_runs WHERE id = ?`).get(runId) as any;
  try {
    const parsed = JSON.parse(row?.context || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getRun(id: string): RunDto | null {
  const row = db.prepare(`SELECT * FROM assistant_runs WHERE id = ?`).get(id) as any;
  return row ? toRun(row) : null;
}

export function updateRun(id: string, patch: Partial<Pick<RunDto, 'status' | 'error' | 'assistantMessageId' | 'ingestedPath'>>): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    values.push(patch.status);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(patch.status)) {
      sets.push('completed_at = ?');
      values.push(now());
    }
  }
  if (patch.error !== undefined) {
    sets.push('error = ?');
    values.push(patch.error);
  }
  if (patch.assistantMessageId !== undefined) {
    sets.push('assistant_message_id = ?');
    values.push(patch.assistantMessageId);
  }
  if (patch.ingestedPath !== undefined) {
    sets.push('ingested_path = ?');
    values.push(patch.ingestedPath);
  }
  if (!sets.length) return;
  sets.push('updated_at = ?');
  values.push(now(), id);
  db.prepare(`UPDATE assistant_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * 累加一轮的模型用量（一步一次）。主对话与子代理分开记，两个命中率互不污染。
 * 不复用 updateRun：那个只管状态字段，用量是反复合并写。
 */
export function accumulateRunUsage(runId: string, target: 'main' | 'subagents', step: UsageStep): void {
  const row = db.prepare(`SELECT usage FROM assistant_runs WHERE id = ?`).get(runId) as any;
  if (!row) return;
  let blob: RunUsageBlob = {};
  try {
    const parsed = JSON.parse(row.usage || '{}');
    if (parsed && typeof parsed === 'object') blob = parsed as RunUsageBlob;
  } catch {
    /* 坏 JSON 当空 */
  }
  const key: keyof RunUsageBlob = target === 'main' ? 'main' : 'subagents';
  blob[key] = addUsage(blob[key], step);
  db.prepare(`UPDATE assistant_runs SET usage = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(blob), now(), runId);
}

/** 该会话正在跑的那一轮（会话单飞位；排队中的不算，它还没送进 dsh） */
export function runningRunForSession(sessionId: string): RunDto | null {
  const row = db
    .prepare(
      `SELECT * FROM assistant_runs WHERE session_id = ? AND status IN (${RUNNING_STATUSES.map(() => '?').join(', ')})
       ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(sessionId, ...RUNNING_STATUSES) as any;
  return row ? toRun(row) : null;
}

/** 还在推进的轮次（含排队中）：删会话、取消等收尾动作用它 */
export function activeRunForSession(sessionId: string): RunDto | null {
  const row = db
    .prepare(
      `SELECT * FROM assistant_runs WHERE session_id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')})
       ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(sessionId, ...ACTIVE_STATUSES) as any;
  return row ? toRun(row) : null;
}

/**
 * 排队：消息与轮次一起落库（前端立刻看得见这条消息），但先不送 dsh。
 * 上一轮收口时由 runner 把它转正——同一会话同时只跑一轮，先来先服务。
 */
export function queueRun(input: {
  sessionId: string;
  message: string;
  context?: unknown;
}): { run: RunDto; message: MessageDto } {
  const message = insertMessage({
    sessionId: input.sessionId,
    role: 'user',
    content: input.message.trim(),
    metadata: { queued: true },
  });
  const run = createRun({
    sessionId: input.sessionId,
    userMessageId: message.id,
    context: input.context ?? {},
    status: 'queued',
  });
  // 重取一次：createRun 会把 run_id 回填到消息上，上面那份 DTO 还是回填前的
  return { run, message: getMessage(message.id)! };
}

/** 该会话排队中的轮次（先来后到；同一毫秒建的按写入顺序，别让排队顺序飘） */
export function listQueuedRuns(sessionId: string): RunDto[] {
  const rows = db
    .prepare(`SELECT * FROM assistant_runs WHERE session_id = ? AND status = 'queued' ORDER BY created_at, rowid`)
    .all(sessionId) as any[];
  return rows.map(toRun);
}

/** 队首那条排队轮次 */
export function nextQueuedRun(sessionId: string): RunDto | null {
  return listQueuedRuns(sessionId)[0] || null;
}

/** 排队轮次转正：状态改 running，并摘掉消息上的「排队中」标记（前端据此撤下标记） */
export function promoteQueuedRun(runId: string): RunDto | null {
  const run = getRun(runId);
  if (!run) return null;
  updateRun(runId, { status: 'running' });
  updateMessageMetadata(run.userMessageId, { queued: false });
  return getRun(runId);
}

/**
 * 撤下该会话排队中的轮次：连消息一起删掉，返回原文（先来后到）。
 * 这些消息从没送进 dsh，停止时撤下来才不会在对话里留下一句没人回答的话；
 * 原文交给前端填回输入框，用户改完可以再发。
 */
export function discardQueuedRuns(sessionId: string): string[] {
  const rows = db
    .prepare(
      `SELECT r.id AS run_id, r.user_message_id AS message_id, m.content AS content
       FROM assistant_runs r
       JOIN assistant_messages m ON m.id = r.user_message_id
       WHERE r.session_id = ? AND r.status = 'queued'
       ORDER BY r.created_at, r.rowid`
    )
    .all(sessionId) as any[];
  if (!rows.length) return [];
  const dropRun = db.prepare(`DELETE FROM assistant_runs WHERE id = ?`);
  const dropMessage = db.prepare(`DELETE FROM assistant_messages WHERE id = ?`);
  for (const row of rows) {
    dropRun.run(row.run_id);
    dropMessage.run(row.message_id);
  }
  return rows.map((row) => String(row.content || ''));
}

export function listRuns(sessionId: string): RunDto[] {
  const rows = db
    .prepare(`SELECT * FROM assistant_runs WHERE session_id = ? ORDER BY created_at, rowid`)
    .all(sessionId) as any[];
  return rows.map(toRun);
}

/**
 * 全库正在跑的轮次（跨会话）。
 * 前端启动时靠它接上事件流：抽屉没打开过、或页面刚刷新，也要能显示「还在跑」。
 * 排队中的轮次没有事件流可接（还没送进 dsh），不收在这里。
 */
export function listActiveRuns(): Array<Pick<RunDto, 'id' | 'sessionId' | 'status' | 'createdAt'>> {
  const rows = db
    .prepare(
      `SELECT id, session_id, status, created_at FROM assistant_runs
       WHERE status IN (${RUNNING_STATUSES.map(() => '?').join(', ')})
       ORDER BY created_at`
    )
    .all(...RUNNING_STATUSES) as any[];
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    createdAt: row.created_at,
  }));
}

export function insertToolCall(input: { runId: string; name: string; args: string }): ToolCallDto {
  const id = uuid();
  const stamp = now();
  db.prepare(
    `INSERT INTO assistant_tool_calls(id, run_id, name, arguments, risk, status, preview, result, undo, created_at, updated_at)
     VALUES(?, ?, ?, ?, 'read', 'running', '{}', '{}', '{}', ?, ?)`
  ).run(id, input.runId, input.name, input.args, stamp, stamp);
  const row = db.prepare(`SELECT * FROM assistant_tool_calls WHERE id = ?`).get(id) as any;
  return toToolCall(row);
}

/** 收口一条工具卡：按行 id 定位（runner 用 dsh 的 callId → 行 id 映射） */
export function finishToolCallById(id: string, input: { ok: boolean; text: string }): ToolCallDto | null {
  db.prepare(`UPDATE assistant_tool_calls SET status = ?, result = ?, updated_at = ? WHERE id = ?`).run(
    input.ok ? 'completed' : 'failed',
    JSON.stringify({ ok: input.ok, text: input.text.slice(0, 20000) }),
    now(),
    id
  );
  const row = db.prepare(`SELECT * FROM assistant_tool_calls WHERE id = ?`).get(id) as any;
  return row ? toToolCall(row) : null;
}

/** 兜底：没有 callId 映射时，认该 run 下最近一条仍在 running 的工具卡 */
export function latestRunningToolCall(runId: string): ToolCallDto | null {
  const row = db
    .prepare(
      `SELECT * FROM assistant_tool_calls WHERE run_id = ? AND status = 'running'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(runId) as any;
  return row ? toToolCall(row) : null;
}

export function listToolCalls(sessionId: string): ToolCallDto[] {
  const rows = db
    .prepare(
      `SELECT c.* FROM assistant_tool_calls c
       JOIN assistant_runs r ON r.id = c.run_id
       WHERE r.session_id = ? ORDER BY c.created_at`
    )
    .all(sessionId) as any[];
  return rows.map(toToolCall);
}

/* ---------- Agent 提问（MCP ask_user：对话最下侧弹选项，点选后那次工具调用才返回） ---------- */

/** 提问状态：pending 等用户点选 / answered 已答复 / expired 超时作废 / cancelled 本轮被停 */
export type QuestionStatus = 'pending' | 'answered' | 'expired' | 'cancelled';

/** 一个可点选的选项（description 是给用户看的一句权衡说明，可为空） */
export interface QuestionOptionDto {
  label: string;
  description?: string;
}

export interface QuestionDto {
  id: string;
  sessionId: string;
  runId: string;
  /** 卡片上的小标题（如「名称核验」），可为空 */
  header: string;
  question: string;
  options: QuestionOptionDto[];
  multiSelect: boolean;
  status: QuestionStatus;
  /** 用户点选的选项原文（单选恒为 0 或 1 个） */
  selected: string[];
  /** 用户自己填的补充答复（可空） */
  custom: string;
  createdAt: string;
  answeredAt?: string;
}

function parseArray<T>(raw: unknown): T[] {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function toQuestion(row: any): QuestionDto {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id || '',
    header: row.header || '',
    question: row.question || '',
    options: parseArray<QuestionOptionDto>(row.options),
    multiSelect: Number(row.multi_select) === 1,
    status: (row.status as QuestionStatus) || 'pending',
    selected: parseArray<string>(row.selected).map((item) => String(item)),
    custom: row.custom || '',
    createdAt: row.created_at,
    answeredAt: row.answered_at || undefined,
  };
}

export function insertQuestion(input: {
  sessionId: string;
  runId: string;
  header?: string;
  question: string;
  options?: QuestionOptionDto[];
  multiSelect?: boolean;
}): QuestionDto {
  const id = uuid();
  db.prepare(
    `INSERT INTO assistant_questions(id, session_id, run_id, header, question, options, multi_select,
       status, selected, custom, created_at, answered_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, 'pending', '[]', '', ?, NULL)`
  ).run(
    id,
    input.sessionId,
    input.runId,
    input.header || '',
    input.question,
    JSON.stringify(input.options || []),
    input.multiSelect ? 1 : 0,
    now()
  );
  return getQuestion(id)!;
}

export function getQuestion(id: string): QuestionDto | null {
  const row = db.prepare(`SELECT * FROM assistant_questions WHERE id = ?`).get(String(id || '')) as any;
  return row ? toQuestion(row) : null;
}

/** 收口一条提问：只有还在 pending 的才会被改写（先到的那次生效，重复答复幂等忽略） */
export function settleQuestion(
  id: string,
  patch: { status: QuestionStatus; selected?: string[]; custom?: string }
): QuestionDto | null {
  const info = db
    .prepare(
      `UPDATE assistant_questions SET status = ?, selected = ?, custom = ?, answered_at = ?
       WHERE id = ? AND status = 'pending'`
    )
    .run(
      patch.status,
      JSON.stringify(patch.selected || []),
      patch.custom || '',
      patch.status === 'answered' ? now() : null,
      id
    );
  if (!info.changes) return null;
  return getQuestion(id);
}

/** 该会话还在等答复的提问（快照带出去，界面据此渲染底部弹窗） */
export function listPendingQuestions(sessionId: string): QuestionDto[] {
  const rows = db
    .prepare(`SELECT * FROM assistant_questions WHERE session_id = ? AND status = 'pending' ORDER BY created_at, rowid`)
    .all(sessionId) as any[];
  return rows.map(toQuestion);
}

/** 该轮还在等答复的提问（本轮收口时统一作废） */
export function listPendingQuestionsForRun(runId: string): QuestionDto[] {
  if (!runId) return [];
  const rows = db
    .prepare(`SELECT * FROM assistant_questions WHERE run_id = ? AND status = 'pending' ORDER BY created_at, rowid`)
    .all(runId) as any[];
  return rows.map(toQuestion);
}

/* ---------- 子代理（dsh 的 subagent / subagent_fork / workflow / ralph 子会话） ---------- */

/** 一条子代理卡最多留多少步过程：够看清它在干什么，也不会把快照撑爆 */
const SUBAGENT_ACTIVITY_LIMIT = 40;
/** 子代理结果/任务原文的落库上限（界面按需展示，超出部分截断） */
const SUBAGENT_TEXT_LIMIT = 20000;

export function insertSubagent(input: {
  sessionId: string;
  runId?: string;
  parentCallId?: string;
  parentSessionId: string;
  childSessionId: string;
  prompt?: string;
}): SubagentDto {
  const id = uuid();
  const stamp = now();
  db.prepare(
    `INSERT INTO assistant_subagents(id, session_id, run_id, parent_session_id, child_session_id, parent_call_id,
       label, mode, provider, prompt, status, stop_reason, result, activity, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, '', '', '', ?, 'running', '', '', '[]', ?, ?)`
  ).run(
    id,
    input.sessionId,
    input.runId ?? null,
    input.parentSessionId,
    input.childSessionId,
    input.parentCallId ?? null,
    (input.prompt || '').slice(0, SUBAGENT_TEXT_LIMIT),
    stamp,
    stamp
  );
  return getSubagent(id)!;
}

export function getSubagent(id: string): SubagentDto | null {
  const row = db.prepare(`SELECT * FROM assistant_subagents WHERE id = ?`).get(id) as any;
  return row ? toSubagent(row) : null;
}

/** 按子会话 id 找卡（dsh 的通知只带会话 id，卡自己带 row id） */
export function findSubagentByChildSession(childSessionId: string): SubagentDto | null {
  const row = db
    .prepare(`SELECT * FROM assistant_subagents WHERE child_session_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(childSessionId) as any;
  return row ? toSubagent(row) : null;
}

/** 子会话 id → 卡（同一次会话树里一个子会话只会有一张卡） */
export function updateSubagent(
  id: string,
  patch: Partial<Pick<SubagentDto, 'label' | 'mode' | 'provider' | 'prompt' | 'status' | 'stopReason' | 'result' | 'parentCallId' | 'parentSessionId'>>
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  const assign = (column: string, value: unknown, limit = SUBAGENT_TEXT_LIMIT) => {
    sets.push(`${column} = ?`);
    values.push(typeof value === 'string' ? value.slice(0, limit) : value);
  };
  if (patch.label !== undefined) assign('label', patch.label, 200);
  if (patch.mode !== undefined) assign('mode', patch.mode, 40);
  if (patch.provider !== undefined) assign('provider', patch.provider, 80);
  if (patch.prompt !== undefined) assign('prompt', patch.prompt);
  if (patch.status !== undefined) assign('status', patch.status, 40);
  if (patch.stopReason !== undefined) assign('stop_reason', patch.stopReason, 200);
  if (patch.result !== undefined) assign('result', patch.result);
  if (patch.parentCallId !== undefined) assign('parent_call_id', patch.parentCallId, 80);
  if (patch.parentSessionId !== undefined) assign('parent_session_id', patch.parentSessionId, 120);
  if (!sets.length) return;
  sets.push('updated_at = ?');
  values.push(now(), id);
  db.prepare(`UPDATE assistant_subagents SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * 追加/收口一步过程。
 * callId 命中已有条目就更新它（工具结果回填），否则追加一条；超过上限丢最旧的。
 *
 * 结果事件只带 callId（工具名与摘要在调用事件里），所以空字段一律「保持原值」而不是覆盖成空，
 * 否则界面上的过程行会退化成一行没有名字的「工具调用」。
 */
export function recordSubagentActivity(
  id: string,
  activity: SubagentActivityDto & { callId?: string }
): void {
  const row = db.prepare(`SELECT activity FROM assistant_subagents WHERE id = ?`).get(id) as any;
  if (!row) return;
  let list: Array<SubagentActivityDto & { callId?: string }> = [];
  try {
    const parsed = JSON.parse(row.activity || '[]');
    if (Array.isArray(parsed)) list = parsed as Array<SubagentActivityDto & { callId?: string }>;
  } catch {
    /* 坏 JSON 当空 */
  }
  const key = activity.callId || '';
  const index = key ? list.findIndex((item) => item.callId === key) : -1;
  if (index >= 0) {
    const previous = list[index];
    list[index] = {
      ...previous,
      ...(activity.name ? { name: activity.name } : {}),
      ...(activity.summary ? { summary: activity.summary } : {}),
      status: activity.status,
      ...(activity.text ? { text: activity.text.slice(0, 2000) } : {}),
      at: activity.at,
    };
  } else {
    list.push({
      name: activity.name,
      summary: activity.summary,
      status: activity.status,
      ...(activity.text ? { text: activity.text.slice(0, 2000) } : {}),
      at: activity.at,
      ...(key ? { callId: key } : {}),
    });
  }
  const trimmed = list.slice(-SUBAGENT_ACTIVITY_LIMIT);
  db.prepare(`UPDATE assistant_subagents SET activity = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(trimmed), now(), id);
}

/** 本轮结束时仍在跑的子代理：标成 background（后台继续跑，结束通知可能落在后面某轮里） */
export function markSubagentsBackground(runId: string): void {
  db.prepare(
    `UPDATE assistant_subagents SET status = 'background', updated_at = ?
     WHERE run_id = ? AND status = 'running'`
  ).run(now(), runId);
}

/**
 * 停止一轮时收掉它的子代理：取消会关掉 dsh 运行时，子代理是同一进程里的子会话，
 * 一起被带走——标成 background（「仍在后台跑」）是假的，据实记成失败并写明原因。
 */
export function stopSubagentsForRun(runId: string, reason: string): void {
  db.prepare(
    `UPDATE assistant_subagents SET status = 'failed', stop_reason = ?, updated_at = ?
     WHERE run_id = ? AND status IN ('running', 'background')`
  ).run(reason.slice(0, 200), now(), runId);
}

export function listSubagents(sessionId: string): SubagentDto[] {
  const rows = db
    .prepare(`SELECT * FROM assistant_subagents WHERE session_id = ? ORDER BY created_at`)
    .all(sessionId) as any[];
  return rows.map(toSubagent);
}

export function snapshot(sessionId: string): Snapshot | null {
  const session = getSession(sessionId);
  if (!session) return null;
  const messages = (db
    .prepare(`SELECT * FROM assistant_messages WHERE session_id = ? ORDER BY created_at`)
    .all(sessionId) as any[]).map(toMessage);
  return {
    session,
    messages: messages.filter((m) => !(m.metadata as any).hidden),
    runs: listRuns(sessionId),
    toolCalls: listToolCalls(sessionId),
    subagents: listSubagents(sessionId),
    questions: listPendingQuestions(sessionId),
  };
}

/** 内置 Agent 专用的 MCP token（与「Agent 接入」给外部 harness 的 token 分开存放） */
export function ensureAgentToken(name = 'dsh-agent'): string {
  const existing = (db.prepare(`SELECT token FROM mcp_tokens WHERE name = ?`).get(name) as any)?.token;
  if (existing) return existing;
  const token = `lwiki_${crypto.randomBytes(24).toString('hex')}`;
  db.prepare(`INSERT INTO mcp_tokens(token, name, created_at) VALUES(?, ?, ?)`).run(token, name, now());
  return token;
}
