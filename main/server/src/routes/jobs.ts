import { FastifyInstance } from 'fastify';
import { db, now } from '../lib/db.js';
import { requireAuth } from './auth.js';
import { enqueue } from '../jobQueue.js';
import {
  candidateSourceSummary,
  commitCandidateReview,
  ignoreCandidateReview,
  previewCandidateReview,
} from '../pipeline/candidateReview.js';
import { ensureCandidateFromReport } from '../pipeline/candidateLedger.js';
import { reconcilePendingCandidates } from '../pipeline/candidateLedger.js';

const KIND_LABELS: Record<string, string> = {
  ingest: 'AI 整理',
  process: '页面处理',
  embed: '索引向量化',
  extract: '实体抽取',
  summarize: '自动整理',
  index_file: '文件索引',
  mentions: '升级扫描',
  metagen: '索引生成',
  ingest_finalize: '整理派生校验',
  ingest_recover: '整理提交恢复',
  candidate_reconcile: '候选动态对账',
  candidate_review_batch: '批量审核候选',
  dream_apply: '分类批量处理',
  dream: 'Dream Cycle',
  rebuild: '重建全部索引',
};

function safeJson(value: unknown, fallback: any = null) {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function tableExists(name: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
}

function jobSelect(): string {
  const columns = new Set((db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[]).map((column) => column.name));
  return ['id', 'kind', 'payload', 'status', 'error', 'created_at', 'run_at',
    columns.has('stage') ? 'stage' : `NULL AS stage`,
    columns.has('progress') ? 'progress' : `NULL AS progress`,
    columns.has('detail') ? 'detail' : `NULL AS detail`,
  ].join(', ');
}

/** 把 payload 翻译成可读目标（页面标题/文件名） */
function describe(kind: string, payloadStr: string): string {
  try {
    const p = JSON.parse(payloadStr);
    if (p.path) return p.path.split('/').pop() || p.path;
    if (p.pageId) {
      const page = db.prepare(`SELECT title FROM pages WHERE id = ?`).get(p.pageId) as any;
      return page?.title || p.pageId;
    }
    if (p.fileId) {
      const file = db.prepare(`SELECT name FROM files WHERE id = ?`).get(p.fileId) as any;
      return file?.name || p.fileId;
    }
  } catch { /* ignore */ }
  return '';
}

export async function jobRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/jobs', async () => {
    const fmt = (r: any) => ({
      id: r.id,
      kind: r.kind,
      label: KIND_LABELS[r.kind] || r.kind,
      target: describe(r.kind, r.payload),
      payload: safeJson(r.payload, {}),
      status: r.status,
      stage: r.stage || (r.status === 'pending' ? '等待执行' : r.status === 'running' ? '执行中' : r.status === 'done' ? '已完成' : '失败'),
      progress: r.progress ?? (r.status === 'done' ? 100 : r.status === 'running' ? 5 : 0),
      detail: r.detail || '',
      error: r.error,
      created_at: r.created_at,
      run_at: r.run_at,
    });
    const active = db
      .prepare(`SELECT ${jobSelect()} FROM jobs WHERE status IN ('pending', 'running') ORDER BY id LIMIT 50`)
      .all()
      .map(fmt);
    const recent = db
      .prepare(`SELECT ${jobSelect()} FROM jobs WHERE status IN ('done', 'failed') ORDER BY id DESC LIMIT 20`)
      .all()
      .map(fmt);
    const counts = db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM jobs`
      )
      .get() as any;
    return {
      active,
      recent,
      pending: counts.pending || 0,
      running: counts.running || 0,
      failed: counts.failed || 0,
    };
  });

  /** 失败任务重试 */
  app.post('/api/jobs/:id/retry', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as any;
    if (!job) return reply.code(404).send({ error: '任务不存在' });
    if (job.status !== 'failed') return reply.code(400).send({ error: '仅失败任务可重试' });
    db.prepare(`UPDATE jobs SET status = 'pending', error = NULL, run_at = NULL, stage = '等待执行', progress = 0, detail = '' WHERE id = ?`).run(id);
    return { ok: true };
  });

  /** 整理运行、阶段审计及候选证据；旧数据库缺表时返回空集合而非启动失败。 */
  app.get('/api/ingest/runs', async (req) => {
    if (!tableExists('ingest_runs')) return { runs: [] };
    const { limit = '30', path } = req.query as { limit?: string; path?: string };
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
    const rows = path
      ? db.prepare(`SELECT * FROM ingest_runs WHERE path=? ORDER BY started_at DESC LIMIT ?`).all(path, safeLimit)
      : db.prepare(`SELECT * FROM ingest_runs ORDER BY started_at DESC LIMIT ?`).all(safeLimit);
    return { runs: (rows as any[]).map((row) => ({ ...row, stats: safeJson(row.stats, {}) })) };
  });

  app.get('/api/ingest/runs/:id', async (req, reply) => {
    if (!tableExists('ingest_runs')) return reply.code(404).send({ error: '整理运行记录尚未初始化' });
    const { id } = req.params as { id: string };
    const run = db.prepare(`SELECT * FROM ingest_runs WHERE id=?`).get(id) as any;
    if (!run) return reply.code(404).send({ error: '整理运行不存在' });
    const facts = tableExists('ingest_facts')
      ? (db.prepare(`SELECT fact_id, statement, sources FROM ingest_facts WHERE run_id=? ORDER BY fact_id`).all(id) as any[]).map((fact) => ({ ...fact, sources: safeJson(fact.sources, []) }))
      : [];
    const audit = tableExists('ingest_audit')
      ? (db.prepare(`SELECT id, stage, at, payload FROM ingest_audit WHERE run_id=? ORDER BY id`).all(id) as any[]).map((item) => ({ ...item, payload: safeJson(item.payload, item.payload) }))
      : [];
    const sourceVersion = run.source_version_id && tableExists('source_versions')
      ? db.prepare(`SELECT * FROM source_versions WHERE id=?`).get(run.source_version_id)
      : null;
    const contributions = tableExists('page_contributions')
      ? (db.prepare(
        `SELECT pc.*, p.title, p.path FROM page_contributions pc
         JOIN pages p ON p.id=pc.page_id WHERE pc.run_id=? ORDER BY pc.created_at`
      ).all(id) as any[]).map((item) => ({
        ...item,
        fact_ids: safeJson(item.fact_ids, []),
        relations: safeJson(item.relations, []),
      }))
      : [];
    const questions = tableExists('ingest_questions')
      ? (db.prepare(`SELECT * FROM ingest_questions WHERE run_id=? ORDER BY created_at`).all(id) as any[]).map((item) => ({
        ...item,
        fact_ids: safeJson(item.fact_ids, []),
        acceptance: safeJson(item.acceptance, []),
      }))
      : [];
    return { run: { ...run, stats: safeJson(run.stats, {}) }, sourceVersion, facts, contributions, questions, audit };
  });

  app.get('/api/ingest/questions', async (req) => {
    if (!tableExists('ingest_questions')) return { questions: [] };
    const { status = 'open', path } = req.query as { status?: string; path?: string };
    const rows = path
      ? db.prepare(`SELECT * FROM ingest_questions WHERE status=? AND path=? ORDER BY created_at DESC`).all(status, path)
      : db.prepare(`SELECT * FROM ingest_questions WHERE status=? ORDER BY created_at DESC LIMIT 200`).all(status);
    return {
      questions: (rows as any[]).map((item) => ({
        ...item,
        fact_ids: safeJson(item.fact_ids, []),
        acceptance: safeJson(item.acceptance, []),
      })),
    };
  });

  app.post('/api/ingest/questions/:id/answer', async (req, reply) => {
    if (!tableExists('ingest_questions')) return reply.code(404).send({ error: '整理追问尚未初始化' });
    const { id } = req.params as { id: string };
    const { answer = '', action = 'reprocess' } = req.body as {
      answer?: string;
      action?: 'reprocess' | 'acknowledge' | 'ignore';
    };
    if (!['reprocess', 'acknowledge', 'ignore'].includes(action)) {
      return reply.code(400).send({ error: '追问处理动作无效' });
    }
    const question = db.prepare(`SELECT * FROM ingest_questions WHERE id=?`).get(id) as any;
    if (!question) return reply.code(404).send({ error: '整理追问不存在' });
    if (action === 'reprocess' && !answer.trim()) {
      return reply.code(400).send({ error: '重新整理前请填写回答' });
    }
    const status = action === 'ignore' ? 'ignored' : action === 'acknowledge' ? 'accepted' : 'answered';
    db.prepare(`UPDATE ingest_questions SET answer=?, status=?, updated_at=? WHERE id=?`)
      .run(answer.trim(), status, now(), id);

    const reports = db.prepare(
      `SELECT id,payload FROM reports WHERE kind='ingest_questions' AND status='open'`
    ).all() as Array<{ id: number; payload: string }>;
    for (const report of reports) {
      const payload = safeJson(report.payload, {});
      const ids = (payload.questions || []).map((item: any) => item.id).filter(Boolean);
      if (!ids.includes(id)) continue;
      const remaining = ids.filter((questionId: string) => {
        const row = db.prepare(`SELECT status FROM ingest_questions WHERE id=?`).get(questionId) as { status: string } | undefined;
        return row?.status === 'open';
      });
      if (!remaining.length) db.prepare(`UPDATE reports SET status='resolved' WHERE id=?`).run(report.id);
    }

    const jobId = action === 'reprocess'
      ? enqueue('ingest', { path: question.path, force: true, questionId: id, nonce: Date.now() })
      : undefined;
    return { ok: true, status, jobId: jobId || null };
  });

  /** 待审候选沿用 reports，兼容当前 ingest 核心表且携带可追溯事实。 */
  app.get('/api/ingest/candidates', async (req) => {
    const { status = 'open' } = req.query as { status?: string };
    if (!tableExists('reports')) return { candidates: [] };
    if (status === 'open') reconcilePendingCandidates();
    const reports = db.prepare(`SELECT * FROM reports WHERE kind='pending_review' AND status=? ORDER BY id DESC LIMIT 200`).all(status) as any[];
    return { candidates: reports.map((report) => {
      const payload = safeJson(report.payload, {});
      const candidate = ensureCandidateFromReport(report);
      if (candidate && payload.candidateId !== candidate.id) payload.candidateId = candidate.id;
      const runId = payload.runId || null;
      const facts = runId && tableExists('ingest_facts')
        ? (db.prepare(`SELECT fact_id, statement, sources FROM ingest_facts WHERE run_id=?`).all(runId) as any[])
          .filter((fact) => !payload.factIds?.length || payload.factIds.includes(fact.fact_id))
          .map((fact) => ({ ...fact, sources: safeJson(fact.sources, []) }))
        : [];
      const evidence = candidate
        ? candidateSourceSummary(candidate.id)
        : { sourceCount: payload.sourcePath || payload.source ? 1 : 0, factCount: facts.length, sources: [payload.sourcePath || payload.source].filter(Boolean) };
      return {
        ...report,
        payload,
        confidence: payload.confidence || '中',
        target: payload.target || payload.name || '',
        draft: payload.content || payload.summary || '',
        facts,
        evidence,
      };
    }) };
  });

  app.post('/api/ingest/candidates/:id/preview', async (req, reply) => {
    const reportId = Number((req.params as { id: string }).id);
    const { action, kind, name, target } = req.body as {
      action?: 'approve' | 'merge';
      kind?: 'concept' | 'person' | 'project' | 'org';
      name?: string;
      target?: string;
    };
    if (!Number.isInteger(reportId) || reportId <= 0) return reply.code(400).send({ error: '待审候选 ID 无效' });
    if (!action || !['approve', 'merge'].includes(action)) return reply.code(400).send({ error: '请选择批准或并入已有页面' });
    if (!kind || !['concept', 'person', 'project', 'org'].includes(kind)) return reply.code(400).send({ error: '请选择有效页面类型' });
    try {
      return { preview: await previewCandidateReview(reportId, { action, kind, name, target }) };
    } catch (error: any) {
      return reply.code(400).send({ error: error?.message || '无法生成审核预览' });
    }
  });

  app.post('/api/ingest/candidates/:id/commit', async (req, reply) => {
    const reportId = Number((req.params as { id: string }).id);
    const { token } = req.body as { token?: string };
    if (!token) return reply.code(400).send({ error: '审核预览已失效，请重新生成' });
    try {
      const target = commitCandidateReview(reportId, token);
      return { ok: true, target: target.id };
    } catch (error: any) {
      return reply.code(409).send({ error: error?.message || '审核提交失败' });
    }
  });

  app.post('/api/ingest/candidates/:id/ignore', async (req, reply) => {
    const reportId = Number((req.params as { id: string }).id);
    const { note = '' } = (req.body || {}) as { note?: string };
    try {
      ignoreCandidateReview(reportId, note);
      return { ok: true };
    } catch (error: any) {
      return reply.code(409).send({ error: error?.message || '忽略候选失败' });
    }
  });

  /** 旧客户端兼容：批准仍执行局部再提炼，但不展示中间预览；新界面使用 preview + commit。 */
  app.post('/api/ingest/candidates/:id/review', async (req, reply) => {
    const reportId = Number((req.params as { id: string }).id);
    const { decision, target, note, kind, name } = req.body as {
      decision?: 'approved' | 'dismissed'; target?: string; note?: string; name?: string;
      kind?: 'concept' | 'person' | 'project' | 'org';
    };
    if (!['approved', 'dismissed'].includes(decision || '')) return reply.code(400).send({ error: '审核决定无效' });
    if (decision === 'dismissed') {
      try {
        ignoreCandidateReview(reportId, note);
        return { ok: true, target: null };
      } catch (error: any) {
        return reply.code(409).send({ error: error?.message || '忽略候选失败' });
      }
    }
    const report = db.prepare(`SELECT payload FROM reports WHERE id=? AND kind='pending_review' AND status='open'`).get(reportId) as { payload: string } | undefined;
    if (!report) return reply.code(404).send({ error: '待审候选不存在或已处理' });
    const original = safeJson(report.payload, {});
    const resolvedKind = kind || original.kind;
    if (!resolvedKind || !['concept', 'person', 'project', 'org'].includes(resolvedKind)) {
      return reply.code(400).send({ error: '批准候选时必须提供有效 kind' });
    }
    try {
      const preview = await previewCandidateReview(reportId, {
        action: target ? 'merge' : 'approve',
        kind: resolvedKind,
        name,
        target,
      });
      const applied = commitCandidateReview(reportId, preview.token);
      return { ok: true, target: applied.id };
    } catch (error: any) {
      return reply.code(409).send({ error: error?.message || '审核失败' });
    }
  });

  /** 清理已完成/失败历史 */
  app.post('/api/jobs/clear', async () => {
    db.prepare(`DELETE FROM jobs WHERE status IN ('done', 'failed')`).run();
    return { ok: true };
  });
}
