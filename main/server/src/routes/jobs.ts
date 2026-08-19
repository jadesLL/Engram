import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { db } from '../lib/db.js';
import { requireAuth } from './auth.js';
import {
  candidateSourceSummary,
  claimCandidateReviewBatch,
  commitCandidateReview,
  ignoreCandidateReview,
  previewCandidateReview,
  releaseCandidateReviewBatch,
  resolveTarget,
  validateCandidateReviewDecisions,
  type CandidateReviewDecision,
} from '../pipeline/candidateReview.js';
import { ensureCandidateFromReport } from '../pipeline/candidateLedger.js';
import { pendingCandidateList } from '../dream/reportCards.js';
import {
  cancelJob,
  enqueue,
  getJobQueueState,
  retryFailedJobs,
  retryJob,
  startJobQueue,
  stopJobQueue,
} from '../jobs.js';
import {
  applyIngestQuestionAction,
  IngestQuestionRequestError,
  type IngestQuestionAction,
} from '../pipeline/ingestQuestions.js';
import { resolveJobTarget } from '../lib/jobTarget.js';

const KIND_LABELS: Record<string, string> = {
  ingest: 'AI 整理',
  process: '页面处理',
  embed: '索引向量化',
  extract: '实体抽取',
  summarize: '自动整理',
  index_file: '文件索引',
  extract_file: '文档识别',
  mentions: '升级扫描',
  metagen: '索引生成',
  ingest_finalize: '整理派生校验',
  page_recompose: '整页综合',
  ingest_recover: '整理提交恢复',
  candidate_reconcile: '候选动态对账',
  candidate_review_batch: '批量审核候选',
  dream_apply: '分类批量处理',
  dream: '智能整理',
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
    columns.has('updated_at') ? 'updated_at' : `NULL AS updated_at`,
    columns.has('stage') ? 'stage' : `NULL AS stage`,
    columns.has('progress') ? 'progress' : `NULL AS progress`,
    columns.has('detail') ? 'detail' : `NULL AS detail`,
  ].join(', ');
}

const FALLBACK_DURATION_SECONDS: Record<string, number> = {
  ingest: 75,
  candidate_reconcile: 5,
  candidate_review_batch: 25,
  extract_file: 90,
  page_recompose: 15,
  process: 8,
  embed: 8,
  index_file: 8,
  extract: 5,
  summarize: 5,
  dream_apply: 15,
  dream: 120,
  rebuild: 180,
  mentions: 5,
  metagen: 2,
  ingest_finalize: 2,
  ingest_recover: 10,
};

function jobPriority(kind: string): number {
  if (['ingest', 'candidate_review_batch', 'dream_apply'].includes(kind)) return 0;
  if (kind === 'candidate_reconcile') return 1;
  if (['page_recompose', 'process'].includes(kind)) return 2;
  return 3;
}

function durationEstimates(): Map<string, number> {
  const rows = db.prepare(
    `SELECT kind,
       AVG((julianday(updated_at)-julianday(run_at))*86400.0) seconds
     FROM (
       SELECT kind,run_at,updated_at FROM jobs
       WHERE status='done' AND run_at IS NOT NULL AND updated_at<> ''
       ORDER BY id DESC LIMIT 200
     )
     GROUP BY kind`
  ).all() as Array<{ kind: string; seconds: number }>;
  const estimates = new Map(rows.map((row) => [
    row.kind,
    Math.max(1, Math.round(row.seconds || FALLBACK_DURATION_SECONDS[row.kind] || 10)),
  ]));
  // 动态对账已改为本地事实复用，旧版完整重提炼的历史耗时不再具有参考价值。
  estimates.set('candidate_reconcile', FALLBACK_DURATION_SECONDS.candidate_reconcile);
  return estimates;
}

function enrichQueueEstimates(rows: any[]): any[] {
  const estimates = durationEstimates();
  const sorted = [...rows].sort((left, right) =>
    jobPriority(left.kind) - jobPriority(right.kind) || left.id - right.id
  );
  const laneAvailability: Record<'default' | 'document', number[]> = {
    default: [0, 0],
    document: [0],
  };
  for (const row of sorted.filter((item) => item.status === 'running')) {
    const lane = row.kind === 'extract_file' ? 'document' : 'default';
    const duration = estimates.get(row.kind) || FALLBACK_DURATION_SECONDS[row.kind] || 10;
    const remaining = Math.max(1, Math.round(duration * (1 - Math.min(95, row.progress || 5) / 100)));
    const slot = laneAvailability[lane].indexOf(Math.min(...laneAvailability[lane]));
    laneAvailability[lane][slot] = remaining;
    row.estimatedDurationSeconds = duration;
    row.estimatedRemainingSeconds = remaining;
    row.estimatedWaitSeconds = 0;
    row.queuePosition = 0;
    row.lane = lane;
  }
  const positions = { default: 0, document: 0 };
  for (const row of sorted.filter((item) => item.status === 'pending')) {
    const lane = row.kind === 'extract_file' ? 'document' : 'default';
    const duration = estimates.get(row.kind) || FALLBACK_DURATION_SECONDS[row.kind] || 10;
    const available = laneAvailability[lane];
    const slot = available.indexOf(Math.min(...available));
    row.estimatedDurationSeconds = duration;
    row.estimatedRemainingSeconds = duration;
    row.estimatedWaitSeconds = Math.max(0, Math.round(available[slot]));
    row.queuePosition = ++positions[lane];
    row.lane = lane;
    available[slot] += duration;
  }
  return rows;
}

function sourceBaseName(raw: string): string {
  if (!raw) return '';
  const normalized = path.posix.normalize(raw.split('\\').join('/'));
  return path.posix.basename(normalized) || normalized;
}

function formatSourceLabel(sources: string[]): string {
  const unique = [...new Set(sources)].filter(Boolean);
  if (!unique.length) return '';
  if (unique.length === 1) return `派生自 ${unique[0]}`;
  return `派生自 ${unique.length} 份资料`;
}

/** 追溯派生任务的源文件：page_recompose/process 经 page_contributions→source_versions，
 *  ingest_finalize 经 ingest_runs。批量查询后按 jobId 返回展示文案。 */
function buildSourceLabelMap(rows: any[]): Map<number, string> {
  const pageIds = new Set<string>();
  const runIds = new Set<string>();
  for (const r of rows) {
    const payload = safeJson(r.payload, null);
    if (!payload || typeof payload !== 'object') continue;
    if (typeof payload.pageId === 'string' && payload.pageId) pageIds.add(payload.pageId);
    if (typeof payload.runId === 'string' && payload.runId) runIds.add(payload.runId);
  }
  const pageToSources = new Map<string, string[]>();
  if (pageIds.size && tableExists('page_contributions') && tableExists('source_versions')) {
    const placeholders = [...pageIds].map(() => '?').join(',');
    const contributionRows = db
      .prepare(
        `SELECT pc.page_id, sv.path
         FROM page_contributions pc
         JOIN source_versions sv ON sv.id = pc.source_version_id
         WHERE pc.page_id IN (${placeholders})`
      )
      .all(...pageIds) as Array<{ page_id: string; path: string }>;
    for (const row of contributionRows) {
      const base = sourceBaseName(row.path);
      if (!base) continue;
      const arr = pageToSources.get(row.page_id) || [];
      if (!arr.includes(base)) arr.push(base);
      pageToSources.set(row.page_id, arr);
    }
  }
  const runToPath = new Map<string, string>();
  if (runIds.size && tableExists('ingest_runs')) {
    const placeholders = [...runIds].map(() => '?').join(',');
    const runRows = db
      .prepare(`SELECT id, path FROM ingest_runs WHERE id IN (${placeholders})`)
      .all(...runIds) as Array<{ id: string; path: string }>;
    for (const row of runRows) runToPath.set(row.id, sourceBaseName(row.path));
  }
  const result = new Map<number, string>();
  for (const r of rows) {
    const payload = safeJson(r.payload, null);
    if (!payload || typeof payload !== 'object') { result.set(r.id, ''); continue; }
    let label = '';
    if (typeof payload.pageId === 'string' && payload.pageId) {
      label = formatSourceLabel(pageToSources.get(payload.pageId) || []);
    } else if (typeof payload.runId === 'string' && payload.runId) {
      const base = runToPath.get(payload.runId);
      label = base ? `派生自 ${base}` : '';
    }
    result.set(r.id, label);
  }
  return result;
}

export async function jobRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/jobs', async () => {
    const activeRows = db
      .prepare(
        `SELECT ${jobSelect()} FROM jobs WHERE status IN ('pending', 'running', 'paused')
         ORDER BY
           CASE kind
             WHEN 'ingest' THEN 0
             WHEN 'candidate_review_batch' THEN 0
             WHEN 'dream_apply' THEN 0
             WHEN 'candidate_reconcile' THEN 1
             WHEN 'page_recompose' THEN 2
             WHEN 'process' THEN 2
             ELSE 3
           END,
           id
         LIMIT 100`
      )
      .all();
    const recentRows = db
      .prepare(`SELECT ${jobSelect()} FROM jobs WHERE status IN ('done', 'failed', 'cancelled') ORDER BY id DESC LIMIT 20`)
      .all();
    const sourceLabelMap = buildSourceLabelMap([...activeRows, ...recentRows]);
    const fmt = (r: any) => {
      const target = resolveJobTarget(r.payload);
      return {
        id: r.id,
        kind: r.kind,
        label: KIND_LABELS[r.kind] || r.kind,
        target: target.targetLabel,
        targetKey: target.targetKey,
        targetLabel: target.targetLabel,
        payload: safeJson(r.payload, {}),
        status: r.status,
        stage: r.stage || (r.status === 'pending' ? '等待执行' : r.status === 'running' ? '执行中' : r.status === 'done' ? '已完成' : '失败'),
        progress: r.progress ?? (r.status === 'done' ? 100 : r.status === 'running' ? 5 : 0),
        detail: r.detail || '',
        error: r.error,
        sourceLabel: sourceLabelMap.get(r.id) || '',
        created_at: r.created_at,
        run_at: r.run_at,
      };
    };
    const active = enrichQueueEstimates(activeRows.map(fmt));
    const recent = recentRows.map(fmt);
    const counts = db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) AS paused,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM jobs`
      )
      .get() as any;
    return {
      active: enrichQueueEstimates(active),
      recent,
      pending: counts.pending || 0,
      running: counts.running || 0,
      paused: counts.paused || 0,
      failed: counts.failed || 0,
      queueRunning: getJobQueueState().running,
    };
  });

  app.post('/api/jobs/queue/start', async () => ({ ok: true, ...startJobQueue() }));

  app.post('/api/jobs/queue/stop', async () => ({ ok: true, ...stopJobQueue() }));

  app.post('/api/jobs/retry-failed', async () => ({ ok: true, ...retryFailedJobs() }));

  /** 失败任务重试 */
  app.post('/api/jobs/:id/retry', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: '任务 ID 无效' });
    try {
      return { ok: true, ...retryJob(id) };
    } catch (error: any) {
      const message = error?.message || '任务无法重试';
      return reply.code(message === '任务不存在' ? 404 : 409).send({ error: message });
    }
  });

  app.post('/api/jobs/:id/cancel', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: '任务 ID 无效' });
    try {
      return { ok: true, ...cancelJob(id) };
    } catch (error: any) {
      return reply.code(404).send({ error: error?.message || '任务不存在' });
    }
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
    try {
      const result = applyIngestQuestionAction(id, answer, action as IngestQuestionAction);
      return reply.code(result.status === 'answered' ? 202 : 200).send(result);
    } catch (error) {
      if (error instanceof IngestQuestionRequestError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  /** 待审候选沿用 reports，兼容当前 ingest 核心表且携带可追溯事实。 */
  app.get('/api/ingest/candidates', async (req) => {
    const { status = 'open' } = req.query as { status?: string };
    if (!tableExists('reports')) return { candidates: [] };
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

  /** 待入库清单:聚合候选证据/来源数/自动对账就绪标记,供新界面的独立分区展示。 */
  app.get('/api/ingest/candidates/pending-list', async () => {
    if (!tableExists('reports')) return { candidates: [] };
    return { candidates: pendingCandidateList() };
  });

  app.post('/api/ingest/candidates/:id/preview', async (req, reply) => {
    const reportId = Number((req.params as { id: string }).id);
    const { action, kind, name, target } = req.body as {
      action?: 'approve' | 'merge';
      kind?: 'concept' | 'person' | 'customer' | 'org' | 'place' | 'work' | 'project' | 'other';
      name?: string;
      target?: string;
    };
    if (!Number.isInteger(reportId) || reportId <= 0) return reply.code(400).send({ error: '待审候选 ID 无效' });
    if (!action || !['approve', 'merge'].includes(action)) return reply.code(400).send({ error: '请选择批准或并入已有页面' });
    if (!kind || !['concept', 'person', 'customer', 'org', 'place', 'work', 'project', 'other'].includes(kind)) return reply.code(400).send({ error: '请选择有效页面类型' });
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

  /** AI 提炼入库:一步式后台执行局部再提炼+提交,不弹预览;claim 原子置 applying 防重复触发。
   *  body 带 target 时为并入已有页面模式(同样后台一步式)。 */
  app.post('/api/ingest/candidates/:id/auto-commit', async (req, reply) => {
    const reportId = Number((req.params as { id: string }).id);
    const { kind, target } = (req.body || {}) as { kind?: string; target?: string };
    if (!Number.isInteger(reportId) || reportId <= 0) return reply.code(400).send({ error: '待审候选 ID 无效' });
    const report = db.prepare(
      `SELECT payload FROM reports WHERE id=? AND kind='pending_review' AND status='open'`
    ).get(reportId) as { payload: string } | undefined;
    if (!report) return reply.code(409).send({ error: '候选不存在或已在处理中' });
    const payload = safeJson(report.payload, {});
    const resolvedKind = kind || payload.kind || 'concept';
    const action = target ? `merge:${resolvedKind}` : `approve:${resolvedKind}`;
    let decisions: CandidateReviewDecision[];
    try {
      decisions = validateCandidateReviewDecisions([{ reportId, action, target }]);
      // 并入目标提前校验,无效目标直接报错而非任务后台失败
      if (target) resolveTarget(target);
      claimCandidateReviewBatch(decisions);
    } catch (error: any) {
      return reply.code(409).send({ error: error?.message || '候选无法处理' });
    }
    const jobId = enqueue('candidate_review_batch', { kind: 'pending_review', decisions, nonce: Date.now() });
    if (!jobId) {
      releaseCandidateReviewBatch(decisions);
      return reply.code(409).send({ error: '入库任务无法入队，请稍后重试' });
    }
    return { ok: true, jobId };
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
    if (!resolvedKind || !['concept', 'person', 'customer', 'org', 'place', 'work', 'project', 'other'].includes(resolvedKind)) {
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
    db.prepare(`DELETE FROM jobs WHERE status IN ('done', 'failed', 'cancelled')`).run();
    return { ok: true };
  });
}
