import crypto from 'node:crypto';
import { db, now } from '../lib/db.js';
import { enqueue } from '../jobQueue.js';
import { addReports } from '../dream/reports.js';

export type IngestQuestionAction = 'reprocess' | 'acknowledge' | 'ignore';
export type IngestQuestionStatus =
  | 'open'
  | 'answered'
  | 'accepted'
  | 'ignored'
  | 'failed'
  | 'superseded';

interface IngestQuestionRow {
  id: string;
  run_id: string;
  source_version_id: string | null;
  path: string;
  question: string;
  fact_ids: string;
  acceptance: string;
  answer: string;
  status: IngestQuestionStatus;
  job_id: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface IngestQuestionView {
  id: string;
  question: string;
  factIds: string[];
  acceptance: string[];
  answer: string;
  status: IngestQuestionStatus;
  jobId: number | null;
  error: string;
  createdAt: string;
  updatedAt: string;
}

export interface IngestQuestionActionResult {
  ok: true;
  status: IngestQuestionStatus;
  jobId: number | null;
  idempotent: boolean;
}

export class IngestQuestionRequestError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
  }
}

const TERMINAL_STATUSES = new Set<IngestQuestionStatus>(['accepted', 'ignored', 'superseded']);

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function serializeQuestion(row: IngestQuestionRow): IngestQuestionView {
  return {
    id: row.id,
    question: row.question,
    factIds: parseList(row.fact_ids),
    acceptance: parseList(row.acceptance),
    answer: row.answer || '',
    status: row.status,
    jobId: row.job_id ?? null,
    error: row.error || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function questionById(id: string): IngestQuestionRow | undefined {
  return db.prepare(`SELECT * FROM ingest_questions WHERE id=?`).get(id) as IngestQuestionRow | undefined;
}

export function activeQuestionsForPath(path: string): IngestQuestionView[] {
  const rows = db.prepare(
    `SELECT * FROM ingest_questions
     WHERE path=? AND status IN ('open','answered','failed')
     ORDER BY created_at, id`
  ).all(path) as IngestQuestionRow[];
  return rows.map(serializeQuestion);
}

export function hydrateIngestQuestionPayload(payload: Record<string, any>): Record<string, any> {
  const path = String(payload.path || '');
  if (!path) return payload;
  const active = activeQuestionsForPath(path);
  if (active.length) return { ...payload, questions: active };
  const legacy = (payload.questions || []).filter((question: any) => !question.id);
  return {
    ...payload,
    questions: legacy.map((question: any) => ({ ...question, status: 'open' })),
  };
}

export function syncIngestQuestionReport(path: string): void {
  if (!path) return;
  const active = activeQuestionsForPath(path);
  const openReports = db.prepare(
    `SELECT id FROM reports
     WHERE kind='ingest_questions' AND issue_key=? AND status IN ('open','applying')
     ORDER BY id DESC`
  ).all(path) as Array<{ id: number }>;

  if (!active.length) {
    const hasLegacyQuestions = openReports.some((report) => {
      const row = db.prepare(`SELECT payload FROM reports WHERE id=?`).get(report.id) as { payload: string };
      try {
        return (JSON.parse(row.payload).questions || []).some((question: any) => !question.id);
      } catch {
        return false;
      }
    });
    if (hasLegacyQuestions) return;
    db.prepare(
      `UPDATE reports SET status='resolved'
       WHERE kind='ingest_questions' AND issue_key=? AND status IN ('open','applying')`
    ).run(path);
    return;
  }
  if (openReports.length) return;

  const previous = db.prepare(
    `SELECT id FROM reports WHERE kind='ingest_questions' AND issue_key=? ORDER BY id DESC LIMIT 1`
  ).get(path) as { id: number } | undefined;
  if (previous) {
    db.prepare(`UPDATE reports SET status='open' WHERE id=?`).run(previous.id);
    return;
  }

  const latest = db.prepare(
    `SELECT q.run_id, q.source_version_id, r.content_hash
     FROM ingest_questions q
     LEFT JOIN ingest_runs r ON r.id=q.run_id
     WHERE q.path=? ORDER BY q.created_at DESC LIMIT 1`
  ).get(path) as { run_id: string; source_version_id: string | null; content_hash?: string } | undefined;
  addReports([{
    kind: 'ingest_questions',
    payload: {
      path,
      runId: latest?.run_id || '',
      sourceVersionId: latest?.source_version_id || null,
      contentHash: latest?.content_hash || '',
      questions: active,
    },
  }]);
}

export function syncAllIngestQuestionReports(): void {
  const rows = db.prepare(
    `SELECT path FROM ingest_questions WHERE status IN ('open','answered','failed')
     UNION
     SELECT issue_key AS path FROM reports
     WHERE kind='ingest_questions' AND status IN ('open','applying')`
  ).all() as Array<{ path: string }>;
  for (const row of rows) syncIngestQuestionReport(row.path);
}

export function setActionableQuestionsForPath(path: string, status: 'accepted' | 'ignored'): number {
  const result = db.prepare(
    `UPDATE ingest_questions
     SET status=?, error=NULL, updated_at=?
     WHERE path=? AND status IN ('open','failed')`
  ).run(status, now(), path);
  syncIngestQuestionReport(path);
  return result.changes;
}

export function reconcileQuestionsAfterRun(path: string, runId: string): number {
  const result = db.prepare(
    `UPDATE ingest_questions
     SET status='superseded', error=NULL, updated_at=?
     WHERE path=? AND run_id<>? AND status IN ('open','failed')`
  ).run(now(), path, runId);
  return result.changes;
}

export function completeIngestQuestionJob(questionId: string, jobId: number): void {
  const question = questionById(questionId);
  if (!question) return;
  db.prepare(
    `UPDATE ingest_questions
     SET status='accepted', error=NULL, updated_at=?
     WHERE id=? AND job_id=? AND status='answered'`
  ).run(now(), questionId, jobId);
  syncIngestQuestionReport(question.path);
}

export function failIngestQuestionJob(questionId: string, jobId: number, error: unknown): void {
  const question = questionById(questionId);
  if (!question) return;
  db.prepare(
    `UPDATE ingest_questions
     SET status='failed', error=?, updated_at=?
     WHERE id=? AND job_id=? AND status='answered'`
  ).run(String((error as any)?.message || error).slice(0, 500), now(), questionId, jobId);
  syncIngestQuestionReport(question.path);
}

export function recoverIngestQuestionJobs(): void {
  const rows = db.prepare(
    `SELECT q.id, q.path, q.job_id, j.status AS job_status, j.error AS job_error
     FROM ingest_questions q
     LEFT JOIN jobs j ON j.id=q.job_id
     WHERE q.status='answered'`
  ).all() as Array<{
    id: string;
    path: string;
    job_id: number | null;
    job_status: string | null;
    job_error: string | null;
  }>;
  const affected = new Set<string>();
  for (const row of rows) {
    if (row.job_status === 'pending' || row.job_status === 'running') continue;
    const message = row.job_error || (row.job_id
      ? '重新整理任务已结束，但问题状态未能确认，请重试'
      : '重新整理任务缺失，请重试');
    db.prepare(
      `UPDATE ingest_questions SET status='failed', error=?, updated_at=? WHERE id=? AND status='answered'`
    ).run(message, now(), row.id);
    affected.add(row.path);
  }
  for (const path of affected) syncIngestQuestionReport(path);
}

function activeJobId(payload: Record<string, any>): number | undefined {
  const row = db.prepare(
    `SELECT id FROM jobs
     WHERE kind='ingest' AND payload=? AND status IN ('pending','running')
     ORDER BY id DESC LIMIT 1`
  ).get(JSON.stringify(payload)) as { id: number } | undefined;
  return row?.id;
}

export function applyIngestQuestionAction(
  id: string,
  answer: string,
  action: IngestQuestionAction,
): IngestQuestionActionResult {
  const question = questionById(id);
  if (!question) throw new IngestQuestionRequestError('整理追问不存在', 404);

  if (action !== 'reprocess') {
    if (question.status === 'answered') {
      throw new IngestQuestionRequestError('该问题正在重新整理，请等待任务完成', 409);
    }
    if (TERMINAL_STATUSES.has(question.status)) {
      return { ok: true, status: question.status, jobId: question.job_id, idempotent: true };
    }
    const status: IngestQuestionStatus = action === 'ignore' ? 'ignored' : 'accepted';
    const result = db.prepare(
      `UPDATE ingest_questions
       SET answer=?, status=?, job_id=NULL, error=NULL, updated_at=?
       WHERE id=? AND status IN ('open','failed')`
    ).run(answer.trim(), status, now(), id);
    if (result.changes !== 1) throw new IngestQuestionRequestError('追问状态已变化，请刷新后重试', 409);
    syncIngestQuestionReport(question.path);
    return { ok: true, status, jobId: null, idempotent: false };
  }

  const trimmed = answer.trim();
  if (!trimmed) throw new IngestQuestionRequestError('重新整理前请填写回答');
  if (question.status === 'answered') {
    return { ok: true, status: question.status, jobId: question.job_id, idempotent: true };
  }
  if (TERMINAL_STATUSES.has(question.status)) {
    return { ok: true, status: question.status, jobId: question.job_id, idempotent: true };
  }
  if (!['open', 'failed'].includes(question.status)) {
    throw new IngestQuestionRequestError('追问状态已变化，请刷新后重试', 409);
  }

  const payload = {
    path: question.path,
    force: true,
    questionId: id,
    answerHash: crypto.createHash('sha256').update(trimmed).digest('hex'),
  };
  const submit = db.transaction(() => {
    const updated = db.prepare(
      `UPDATE ingest_questions
       SET answer=?, status='answered', job_id=NULL, error=NULL, updated_at=?
       WHERE id=? AND status IN ('open','failed')`
    ).run(trimmed, now(), id);
    if (updated.changes !== 1) {
      const current = questionById(id);
      if (current?.status === 'answered') return current.job_id || activeJobId(payload) || null;
      throw new IngestQuestionRequestError('追问状态已变化，请刷新后重试', 409);
    }
    const jobId = enqueue('ingest', payload) || activeJobId(payload);
    if (!jobId) throw new IngestQuestionRequestError('无法创建重新整理任务，请稍后重试', 409);
    db.prepare(`UPDATE ingest_questions SET job_id=? WHERE id=?`).run(jobId, id);
    return jobId;
  });
  const jobId = submit();
  if (!jobId) throw new IngestQuestionRequestError('重新整理任务状态异常，请刷新后重试', 409);
  syncIngestQuestionReport(question.path);
  return { ok: true, status: 'answered', jobId, idempotent: false };
}
