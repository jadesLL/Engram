import crypto from 'node:crypto';
import { db, now } from '../lib/db.js';

/**
 * 内置 Agent 的持久层：复用库里既有的 assistant_* 表（v1.1 聊天功能的表结构，
 * v1.2.0 移除内置 AI 时按「数据零破坏」保留至今），只补一列 dsh_session_id 用于续聊。
 */

export interface SessionDto {
  id: string;
  title: string;
  dshSessionId: string;
  createdAt: string;
  updatedAt: string;
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

export interface Snapshot {
  session: SessionDto;
  messages: MessageDto[];
  runs: RunDto[];
  toolCalls: ToolCallDto[];
}

const ACTIVE_STATUSES = ['queued', 'running'];

function uuid(): string {
  return crypto.randomUUID();
}

function toSession(row: any): SessionDto {
  return {
    id: row.id,
    title: row.title,
    dshSessionId: row.dsh_session_id || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

function toRun(row: any): RunDto {
  return {
    id: row.id,
    sessionId: row.session_id,
    userMessageId: row.user_message_id,
    ...(row.assistant_message_id ? { assistantMessageId: row.assistant_message_id } : {}),
    status: row.status,
    ...(row.error ? { error: row.error } : {}),
    ...(row.ingested_path ? { ingestedPath: row.ingested_path } : {}),
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

export function listSessions(): SessionDto[] {
  const rows = db
    .prepare(`SELECT * FROM assistant_sessions ORDER BY updated_at DESC`)
    .all() as any[];
  return rows.map(toSession);
}

export function getSession(id: string): SessionDto | null {
  const row = db.prepare(`SELECT * FROM assistant_sessions WHERE id = ?`).get(id) as any;
  return row ? toSession(row) : null;
}

export function createSession(title?: string): SessionDto {
  const stamp = now();
  const id = uuid();
  db.prepare(
    `INSERT INTO assistant_sessions(id, title, summary, archived, dsh_session_id, created_at, updated_at)
     VALUES(?, ?, '', 0, ?, ?, ?)`
  ).run(id, (title || '').trim() || '新对话', `session-${uuid()}`, stamp, stamp);
  return getSession(id)!;
}

export function renameSession(id: string, title: string): void {
  db.prepare(`UPDATE assistant_sessions SET title = ?, updated_at = ? WHERE id = ?`)
    .run(title.trim() || '新对话', now(), id);
}

export function touchSession(id: string): void {
  db.prepare(`UPDATE assistant_sessions SET updated_at = ? WHERE id = ?`).run(now(), id);
}

export function deleteSession(id: string): void {
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

export function setMessageContent(id: string, content: string): void {
  db.prepare(`UPDATE assistant_messages SET content = ? WHERE id = ?`).run(content, id);
}

export function createRun(input: { sessionId: string; userMessageId: string; context: unknown }): RunDto {
  const id = uuid();
  const stamp = now();
  db.prepare(
    `INSERT INTO assistant_runs(id, session_id, user_message_id, status, context, created_at, updated_at)
     VALUES(?, ?, ?, 'running', ?, ?, ?)`
  ).run(id, input.sessionId, input.userMessageId, JSON.stringify(input.context ?? {}), stamp, stamp);
  // 用户消息回填 run_id：前端靠它把"乐观插入的本地消息"与快照里的同一条对齐
  db.prepare(`UPDATE assistant_messages SET run_id = ? WHERE id = ?`).run(id, input.userMessageId);
  return getRun(id)!;
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

export function activeRunForSession(sessionId: string): RunDto | null {
  const row = db
    .prepare(
      `SELECT * FROM assistant_runs WHERE session_id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')})
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(sessionId, ...ACTIVE_STATUSES) as any;
  return row ? toRun(row) : null;
}

export function listRuns(sessionId: string): RunDto[] {
  const rows = db
    .prepare(`SELECT * FROM assistant_runs WHERE session_id = ? ORDER BY created_at`)
    .all(sessionId) as any[];
  return rows.map(toRun);
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
