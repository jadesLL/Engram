import { FastifyInstance } from 'fastify';
import { db, getSetting } from '../lib/db.js';
import { requireAuth } from './auth.js';
import { runDreamCycle } from '../dream/tasks.js';
import { scheduleDreamCycle } from '../dream/scheduler.js';
import { enqueue } from '../jobs.js';
import {
  REPORT_ACTION_KINDS, claimReports, previewReportActions, releaseReports,
  validateDecisions, type ReportActionKind, type ReportDecision,
} from '../dream/apply.js';
import { reconcilePendingCandidates } from '../pipeline/candidateLedger.js';
import {
  hydrateIngestQuestionPayload,
  setActionableQuestionsForPath,
  syncAllIngestQuestionReports,
  syncIngestQuestionReport,
} from '../pipeline/ingestQuestions.js';

export async function dreamRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/dream/reports', async (req) => {
    const { status } = req.query as { status?: string };
    const open = !status || status === 'open';
    if (open) {
      reconcilePendingCandidates();
      syncAllIngestQuestionReports();
    }
    const rows = db
      .prepare(`SELECT * FROM reports WHERE status = ? ORDER BY id DESC LIMIT 200`)
      .all(status || 'open') as any[];
    return {
      reports: rows.map((r) => {
        const payload = JSON.parse(r.payload);
        return {
          ...r,
          payload: open && r.kind === 'ingest_questions'
            ? hydrateIngestQuestionPayload(payload)
            : payload,
        };
      }),
      lastRun: getSetting('dream_last_run') || null,
      cron: getSetting('dream_cron') || '0 3 * * *',
      enabled: (getSetting('dream_enabled') ?? '1') !== '0',
    };
  });

  app.post('/api/dream/run', async () => {
    const result = await runDreamCycle();
    return { ok: true, result };
  });

  app.post('/api/dream/reports/:id/status', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { status } = req.body as { status?: 'resolved' | 'dismissed' | 'open' };
    if (!status || !['resolved', 'dismissed', 'open'].includes(status)) {
      return reply.code(400).send({ error: '报告状态无效' });
    }
    const report = db.prepare(`SELECT kind,payload FROM reports WHERE id=?`).get(id) as any;
    const result = db.prepare(`UPDATE reports SET status = ? WHERE id = ?`).run(status, id);
    if (result.changes !== 1) return reply.code(404).send({ error: '报告不存在' });
    if (report?.kind === 'ingest_questions' && ['resolved', 'dismissed'].includes(status)) {
      let payload: any = {};
      try { payload = JSON.parse(report.payload); } catch { /* legacy malformed report */ }
      const questionStatus = status === 'resolved' ? 'accepted' : 'ignored';
      const path = String(payload.path || '');
      setActionableQuestionsForPath(path, questionStatus);
      syncIngestQuestionReport(path);
    }
    return { ok: true };
  });

  app.get('/api/dream/reports/actions/:kind/preview', async (req, reply) => {
    const { kind } = req.params as { kind: string };
    if (!REPORT_ACTION_KINDS.includes(kind as ReportActionKind)) {
      return reply.code(404).send({ error: '报告分类不存在' });
    }
    if (kind === 'pending_review') reconcilePendingCandidates();
    return previewReportActions(kind as ReportActionKind);
  });

  app.post('/api/dream/reports/actions/:kind', async (req, reply) => {
    const { kind } = req.params as { kind: string };
    if (!REPORT_ACTION_KINDS.includes(kind as ReportActionKind)) {
      return reply.code(404).send({ error: '报告分类不存在' });
    }
    if (kind === 'pending_review') {
      return reply.code(409).send({ error: '待审候选必须逐条生成预览并确认，不能批量审批' });
    }
    let decisions: ReportDecision[];
    try {
      decisions = validateDecisions(kind as ReportActionKind, (req.body as any)?.decisions);
      claimReports(kind as ReportActionKind, decisions);
    } catch (error: any) {
      return reply.code(409).send({ error: error?.message || '报告无法处理' });
    }
    const jobId = enqueue('dream_apply', { kind, decisions, nonce: Date.now() });
    if (!jobId) {
      releaseReports(decisions);
      return reply.code(409).send({ error: '批量任务无法入队，请稍后重试' });
    }
    return { ok: true, queued: decisions.length, jobId };
  });

  app.post('/api/dream/schedule', async (req) => {
    const { cron, enabled } = req.body as { cron?: string; enabled?: boolean };
    if (cron) {
      const { setSetting } = await import('../lib/db.js');
      setSetting('dream_cron', cron);
    }
    if (enabled !== undefined) {
      const { setSetting } = await import('../lib/db.js');
      setSetting('dream_enabled', enabled ? '1' : '0');
    }
    scheduleDreamCycle();
    return { ok: true };
  });
}
