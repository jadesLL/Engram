import { db, newId, now } from '../lib/db.js';
import crypto from 'node:crypto';
import { agentContextPrompt } from './prompts.js';
import type {
  AssistantArtifact,
  AssistantContext,
  AssistantMessage,
  AssistantMessageRole,
  AssistantRun,
  AssistantRunStatus,
  AssistantSession,
  AssistantSnapshot,
  AssistantToolCall,
  ToolCallStatus,
  ToolPreview,
  ToolRisk,
} from './types.js';

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return (value as T) ?? fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function sessionRow(row: any): AssistantSession {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary || '',
    archived: Boolean(row.archived),
    chatAnchorId: row.chat_anchor_id || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function messageRow(row: any): AssistantMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id || undefined,
    role: row.role,
    content: row.content || '',
    metadata: json(row.metadata, {}),
    createdAt: row.created_at,
  };
}

function runRow(row: any): AssistantRun {
  return {
    id: row.id,
    sessionId: row.session_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id || undefined,
    status: row.status,
    context: json(row.context, {}),
    stepCount: Number(row.step_count || 0),
    cancelRequested: Boolean(row.cancel_requested),
    error: row.error || undefined,
    ingestedPath: row.ingested_path || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || undefined,
  };
}

function toolCallRow(row: any): AssistantToolCall {
  return {
    id: row.id,
    runId: row.run_id,
    name: row.name,
    arguments: json(row.arguments, {}),
    risk: row.risk,
    status: row.status,
    preview: json(row.preview, {}),
    result: json(row.result, {}),
    undo: json(row.undo, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function artifactRow(row: any): AssistantArtifact {
  return {
    id: row.id,
    runId: row.run_id,
    toolCallId: row.tool_call_id || undefined,
    kind: row.kind,
    contentHash: row.content_hash,
    content: row.content,
    createdAt: row.created_at,
  };
}

export function createSession(title = '新对话'): AssistantSession {
  const id = newId();
  const at = now();
  db.prepare(
    `INSERT INTO assistant_sessions(id, title, summary, archived, created_at, updated_at)
     VALUES(?, ?, '', 0, ?, ?)`
  ).run(id, title.trim().slice(0, 80) || '新对话', at, at);
  return getSession(id)!;
}

export function listSessions(includeArchived = false): AssistantSession[] {
  const rows = includeArchived
    ? db.prepare(`SELECT * FROM assistant_sessions ORDER BY updated_at DESC LIMIT 100`).all()
    : db.prepare(`SELECT * FROM assistant_sessions WHERE archived = 0 ORDER BY updated_at DESC LIMIT 100`).all();
  return (rows as any[]).map(sessionRow);
}

export function getSession(id: string): AssistantSession | null {
  const row = db.prepare(`SELECT * FROM assistant_sessions WHERE id = ?`).get(id) as any;
  return row ? sessionRow(row) : null;
}

export function updateSession(
  id: string,
  patch: { title?: string; archived?: boolean; summary?: string; chatAnchorId?: string }
): AssistantSession | null {
  const current = getSession(id);
  if (!current) return null;
  db.prepare(
    `UPDATE assistant_sessions SET title = ?, archived = ?, summary = ?, chat_anchor_id = ?, updated_at = ? WHERE id = ?`
  ).run(
    patch.title !== undefined ? (patch.title.trim().slice(0, 80) || current.title) : current.title,
    patch.archived !== undefined ? Number(patch.archived) : Number(current.archived),
    patch.summary !== undefined ? patch.summary.slice(0, 20_000) : current.summary,
    patch.chatAnchorId !== undefined ? patch.chatAnchorId : (current.chatAnchorId ?? null),
    now(),
    id
  );
  return getSession(id);
}

export function deleteSession(id: string): boolean {
  return db.prepare(`DELETE FROM assistant_sessions WHERE id = ?`).run(id).changes === 1;
}

export function appendMessage(input: {
  sessionId: string;
  runId?: string;
  role: AssistantMessageRole;
  content?: string;
  metadata?: Record<string, any>;
}): AssistantMessage {
  const id = newId();
  const at = now();
  db.prepare(
    `INSERT INTO assistant_messages(id, session_id, run_id, role, content, metadata, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.sessionId,
    input.runId || null,
    input.role,
    input.content || '',
    JSON.stringify(input.metadata || {}),
    at
  );
  db.prepare(`UPDATE assistant_sessions SET updated_at = ? WHERE id = ?`).run(at, input.sessionId);
  return getMessage(id)!;
}

export function getMessage(id: string): AssistantMessage | null {
  const row = db.prepare(`SELECT * FROM assistant_messages WHERE id = ?`).get(id) as any;
  return row ? messageRow(row) : null;
}

export function updateMessage(
  id: string,
  patch: { content?: string; metadata?: Record<string, any> }
): AssistantMessage | null {
  const current = getMessage(id);
  if (!current) return null;
  db.prepare(`UPDATE assistant_messages SET content = ?, metadata = ? WHERE id = ?`).run(
    patch.content !== undefined ? patch.content : current.content,
    JSON.stringify(patch.metadata !== undefined ? patch.metadata : current.metadata),
    id
  );
  return getMessage(id);
}

export function listMessages(sessionId: string, limit = 200): AssistantMessage[] {
  const rows = db.prepare(
    `SELECT * FROM (
       SELECT assistant_messages.*, rowid AS _rowid
       FROM assistant_messages WHERE session_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT ?
     ) ORDER BY created_at, _rowid`
  ).all(sessionId, Math.max(1, Math.min(500, limit))) as any[];
  return rows.map(messageRow);
}

export function createRun(
  sessionId: string,
  message: string,
  context: AssistantContext
): AssistantRun {
  const session = getSession(sessionId);
  if (!session) throw new Error('会话不存在');
  const at = now();
  const id = newId();
  // 界面上下文随消息入库（metadata，不进正文）：请求时按「首次发送形态」重建，
  // 使下一轮历史里的这条消息与上一轮请求字节一致，provider 前缀缓存得以延续。
  const contextPrompt = agentContextPrompt(context || {});
  const userMessage = appendMessage({
    sessionId,
    runId: id,
    role: 'user',
    content: message,
    metadata: contextPrompt ? { contextPrompt } : {},
  });
  db.prepare(
    `INSERT INTO assistant_runs(
       id, session_id, user_message_id, status, context, step_count,
       cancel_requested, created_at, updated_at
     ) VALUES(?, ?, ?, 'queued', ?, 0, 0, ?, ?)`
  ).run(id, sessionId, userMessage.id, JSON.stringify(context || {}), at, at);
  if (session.title === '新对话') {
    updateSession(sessionId, { title: message.replace(/\s+/g, ' ').slice(0, 40) || '新对话' });
  }
  return getRun(id)!;
}

export function getRun(id: string): AssistantRun | null {
  const row = db.prepare(`SELECT * FROM assistant_runs WHERE id = ?`).get(id) as any;
  return row ? runRow(row) : null;
}

export function listRuns(sessionId: string, limit = 50): AssistantRun[] {
  const rows = db.prepare(
    `SELECT * FROM assistant_runs WHERE session_id = ? ORDER BY created_at, rowid LIMIT ?`
  ).all(sessionId, Math.max(1, Math.min(200, limit))) as any[];
  return rows.map(runRow);
}

export function updateRun(
  id: string,
  patch: {
    status?: AssistantRunStatus;
    assistantMessageId?: string | null;
    stepCount?: number;
    cancelRequested?: boolean;
    error?: string | null;
    ingestedPath?: string | null;
    completedAt?: string | null;
  }
): AssistantRun | null {
  const current = getRun(id);
  if (!current) return null;
  const updatedAt = now();
  db.prepare(
    `UPDATE assistant_runs SET
       status = ?, assistant_message_id = ?, step_count = ?, cancel_requested = ?,
       error = ?, ingested_path = ?, completed_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    patch.status ?? current.status,
    patch.assistantMessageId !== undefined ? patch.assistantMessageId : (current.assistantMessageId || null),
    patch.stepCount ?? current.stepCount,
    patch.cancelRequested !== undefined ? Number(patch.cancelRequested) : Number(current.cancelRequested),
    patch.error !== undefined ? patch.error : (current.error || null),
    patch.ingestedPath !== undefined ? patch.ingestedPath : (current.ingestedPath || null),
    patch.completedAt !== undefined ? patch.completedAt : (current.completedAt || null),
    updatedAt,
    id
  );
  db.prepare(`UPDATE assistant_sessions SET updated_at = ? WHERE id = ?`).run(updatedAt, current.sessionId);
  return getRun(id);
}

export function createToolCall(input: {
  id?: string;
  runId: string;
  name: string;
  arguments: Record<string, any>;
  risk: ToolRisk;
  status: ToolCallStatus;
  preview?: ToolPreview;
}): AssistantToolCall {
  const id = input.id || newId();
  const at = now();
  db.prepare(
    `INSERT INTO assistant_tool_calls(
       id, run_id, name, arguments, risk, status, preview, result, undo, created_at, updated_at
     ) VALUES(?, ?, ?, ?, ?, ?, ?, '{}', '{}', ?, ?)`
  ).run(
    id,
    input.runId,
    input.name,
    JSON.stringify(input.arguments || {}),
    input.risk,
    input.status,
    JSON.stringify(input.preview || {}),
    at,
    at
  );
  return getToolCall(id)!;
}

export function getToolCall(id: string): AssistantToolCall | null {
  const row = db.prepare(`SELECT * FROM assistant_tool_calls WHERE id = ?`).get(id) as any;
  return row ? toolCallRow(row) : null;
}

export function listToolCalls(runId: string): AssistantToolCall[] {
  const rows = db.prepare(
    `SELECT * FROM assistant_tool_calls WHERE run_id = ? ORDER BY created_at, rowid`
  ).all(runId) as any[];
  return rows.map(toolCallRow);
}

export function updateToolCall(
  id: string,
  patch: {
    status?: ToolCallStatus;
    preview?: ToolPreview;
    result?: Record<string, any>;
    undo?: Record<string, any>;
  }
): AssistantToolCall | null {
  const current = getToolCall(id);
  if (!current) return null;
  db.prepare(
    `UPDATE assistant_tool_calls
     SET status = ?, preview = ?, result = ?, undo = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    patch.status ?? current.status,
    JSON.stringify(patch.preview ?? current.preview),
    JSON.stringify(patch.result ?? current.result),
    JSON.stringify(patch.undo ?? current.undo),
    now(),
    id
  );
  return getToolCall(id);
}

export function createArtifact(input: {
  runId: string;
  toolCallId?: string;
  kind: string;
  content: string;
}): AssistantArtifact {
  const id = newId();
  const at = now();
  const contentHash = crypto.createHash('sha256').update(input.content).digest('hex');
  db.prepare(
    `INSERT INTO assistant_artifacts(
       id,run_id,tool_call_id,kind,content_hash,content,created_at
     ) VALUES(?,?,?,?,?,?,?)`
  ).run(
    id,
    input.runId,
    input.toolCallId || null,
    input.kind,
    contentHash,
    input.content,
    at,
  );
  return getArtifact(id)!;
}

export function getArtifact(id: string): AssistantArtifact | null {
  const row = db.prepare(`SELECT * FROM assistant_artifacts WHERE id=?`).get(id) as any;
  return row ? artifactRow(row) : null;
}

export function getSnapshotBySession(sessionId: string): AssistantSnapshot | null {
  const session = getSession(sessionId);
  if (!session) return null;
  const runs = listRuns(sessionId);
  return {
    session,
    messages: listMessages(sessionId),
    runs,
    toolCalls: runs.flatMap((run) => listToolCalls(run.id)),
  };
}

export function getSnapshotByRun(runId: string): AssistantSnapshot | null {
  const run = getRun(runId);
  return run ? getSnapshotBySession(run.sessionId) : null;
}

export function activeRunForSession(sessionId: string): AssistantRun | null {
  const row = db.prepare(
    `SELECT * FROM assistant_runs
     WHERE session_id = ? AND status IN ('queued', 'running', 'executing', 'waiting_approval')
     ORDER BY created_at DESC LIMIT 1`
  ).get(sessionId) as any;
  return row ? runRow(row) : null;
}
