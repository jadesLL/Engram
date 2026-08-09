import { FastifyInstance } from 'fastify';
import { db, now } from '../lib/db.js';
import { requireAuth } from './auth.js';
import { applyReviewedCandidate } from '../pipeline/ingest.js';

const KIND_LABELS: Record<string, string> = {
  ingest: 'AI 整理',
  process: '页面处理',
  embed: '索引向量化',
  extract: '实体抽取',
  summarize: '自动整理',
  index_file: '文件索引',
  mentions: '升级扫描',
  metagen: '索引生成',
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
    return { run: { ...run, stats: safeJson(run.stats, {}) }, facts, audit };
  });

  /** 待审候选沿用 reports，兼容当前 ingest 核心表且携带可追溯事实。 */
  app.get('/api/ingest/candidates', async (req) => {
    const { status = 'open' } = req.query as { status?: string };
    if (!tableExists('reports')) return { candidates: [] };
    const reports = db.prepare(`SELECT * FROM reports WHERE kind='pending_review' AND status=? ORDER BY id DESC LIMIT 200`).all(status) as any[];
    return { candidates: reports.map((report) => {
      const payload = safeJson(report.payload, {});
      const runId = payload.runId || null;
      const facts = runId && tableExists('ingest_facts')
        ? (db.prepare(`SELECT fact_id, statement, sources FROM ingest_facts WHERE run_id=?`).all(runId) as any[])
          .filter((fact) => !payload.factIds?.length || payload.factIds.includes(fact.fact_id))
          .map((fact) => ({ ...fact, sources: safeJson(fact.sources, []) }))
        : [];
      return { ...report, payload, confidence: payload.confidence || '中', target: payload.target || payload.name || '', draft: payload.content || payload.summary || '', facts };
    }) };
  });

  app.post('/api/ingest/candidates/:id/review', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { decision, target, note, kind, name } = req.body as {
      decision?: 'approved' | 'dismissed'; target?: string; note?: string; name?: string;
      kind?: 'concept' | 'person' | 'project' | 'org';
    };
    if (!['approved', 'dismissed'].includes(decision || '')) return reply.code(400).send({ error: '审核决定无效' });
    const report = db.prepare(`SELECT * FROM reports WHERE id=? AND kind='pending_review' AND status='open'`).get(id) as any;
    if (!report) return reply.code(404).send({ error: '待审候选不存在或已处理' });
    const original = safeJson(report.payload, {});
    let appliedTarget = '';
    if (decision === 'approved') {
      const resolvedKind = kind || original.kind;
      if (!resolvedKind || !['concept', 'person', 'project', 'org'].includes(resolvedKind)) {
        return reply.code(400).send({ error: '批准候选时必须提供有效 kind' });
      }
      const claim = db.prepare(`UPDATE reports SET status='applying' WHERE id=? AND status='open'`).run(id);
      if (claim.changes !== 1) return reply.code(409).send({ error: '候选已被其他操作处理' });
      try {
        const applied = applyReviewedCandidate(original, resolvedKind, { target, name });
        appliedTarget = applied.id;
      } catch (error) {
        db.prepare(`UPDATE reports SET status='open' WHERE id=? AND status='applying'`).run(id);
        throw error;
      }
    }
    const payload = { ...original, review: { decision, target: appliedTarget, note: note || '', at: now() } };
    const expectedStatus = decision === 'approved' ? 'applying' : 'open';
    const result = db.prepare(`UPDATE reports SET payload=?, status=? WHERE id=? AND status=?`).run(
      JSON.stringify(payload), decision === 'approved' ? 'resolved' : 'dismissed', id, expectedStatus
    );
    if (result.changes !== 1) {
      if (expectedStatus === 'applying') db.prepare(`UPDATE reports SET status='open' WHERE id=? AND status='applying'`).run(id);
      return reply.code(409).send({ error: '候选已被其他操作处理' });
    }
    return { ok: true, target: appliedTarget || null };
  });

  /** 清理已完成/失败历史 */
  app.post('/api/jobs/clear', async () => {
    db.prepare(`DELETE FROM jobs WHERE status IN ('done', 'failed')`).run();
    return { ok: true };
  });
}
