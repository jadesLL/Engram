import { db, now } from './lib/db.js';
import { indexPage, indexFileText, rebuildAll } from './pipeline/indexer.js';
import { extractEntities } from './graph/entities.js';
import { organizePage } from './ai/organize.js';
import { ingestRawFile } from './pipeline/ingest.js';
import { runUpgrades } from './pipeline/mentions.js';
import { regenerateIndex, regenerateRelationships } from './pipeline/indexFile.js';
import { applyReportDecisions, releaseReports, type ReportActionKind, type ReportDecision } from './dream/apply.js';
import { enqueue, enqueuePagePipeline } from './jobQueue.js';
import { finalizeDerivedRun, recoverIngestCommits } from './pipeline/sourceLedger.js';
import { recoverKnowledgeCommit } from './pipeline/knowledgeCommit.js';
import { runDreamCycle } from './dream/tasks.js';
import {
  finalizeCandidateReconciliation,
  releaseCandidateReports,
} from './pipeline/candidateLedger.js';
import {
  applyCandidateReviewBatch,
  releaseCandidateReviewBatch,
  type CandidateReviewDecision,
} from './pipeline/candidateReview.js';
import {
  completeIngestQuestionJob,
  failIngestQuestionJob,
  recoverIngestQuestionJobs,
} from './pipeline/ingestQuestions.js';
import { recomposePage } from './pipeline/pageSynthesis.js';
import { extractFile } from './pipeline/fileExtraction.js';

export { enqueue, enqueuePagePipeline } from './jobQueue.js';

export type JobProgress = {
  stage: string;
  progress: number;
  detail?: string;
};

type JobHandler = (
  payload: any,
  update: (progress: Partial<JobProgress>) => void,
  jobId: number,
) => Promise<void>;

function jobColumns(): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[]).map((column) => column.name));
}

function updateJob(id: number, values: Partial<JobProgress>) {
  const columns = jobColumns();
  const assignments: string[] = [];
  const params: unknown[] = [];
  if (columns.has('stage') && values.stage !== undefined) { assignments.push('stage = ?'); params.push(values.stage); }
  if (columns.has('progress') && values.progress !== undefined) { assignments.push('progress = ?'); params.push(Math.max(0, Math.min(100, Math.round(values.progress)))); }
  if (columns.has('detail') && values.detail !== undefined) { assignments.push('detail = ?'); params.push(values.detail); }
  if (columns.has('updated_at')) { assignments.push('updated_at = ?'); params.push(now()); }
  if (!assignments.length) return;
  db.prepare(`UPDATE jobs SET ${assignments.join(', ')} WHERE id = ?`).run(...params, id);
}

const handlers: Record<string, JobHandler> = {
  embed: async ({ pageId }) => {
    await indexPage(pageId);
  },
  index_file: async ({ fileId }) => {
    await indexFileText(fileId);
  },
  extract_file: async ({ path, mode, pages, ingestAfter, forceIngest }, update) => {
    await extractFile(path, (progress) => update(progress), {
      mode,
      pages,
      ingestAfter: ingestAfter !== false,
      forceIngest: Boolean(forceIngest),
    });
  },
  extract: async ({ pageId }) => {
    await extractEntities(pageId);
  },
  summarize: async ({ pageId }) => {
    await organizePage(pageId);
  },
  ingest: async ({ path, force, questionId }, update, jobId) => {
    await ingestRawFile(path, (progress) => update(progress), { force: Boolean(force) });
    if (questionId) completeIngestQuestionJob(String(questionId), jobId);
  },
  mentions: async () => {
    await runUpgrades();
  },
  metagen: async () => {
    regenerateIndex();
    regenerateRelationships();
  },
  /** 单页全流程：索引+抽取+整理一步到位（减少队列任务数） */
  process: async ({ pageId }) => {
    await indexPage(pageId);
    await extractEntities(pageId);
    await organizePage(pageId);
  },
  page_recompose: async ({ pageId, synthesisId, inputHash }, update) => {
    update({ stage: '跨来源整页综合', progress: 15, detail: pageId });
    const result = await recomposePage(String(pageId), String(synthesisId), String(inputHash));
    if (result.changed) {
      update({ stage: '整页综合已写入', progress: 90, detail: result.synthesisId });
      enqueue('process', { pageId: String(pageId), synthesisId: result.synthesisId });
      enqueue('metagen', {});
    }
  },
  ingest_finalize: async ({ runId }) => {
    finalizeDerivedRun(runId);
  },
  ingest_recover: async ({ runId }) => {
    recoverKnowledgeCommit(runId);
  },
  candidate_reconcile: async ({ path, candidateIds, reportIds }, update) => {
    update({ stage: '重新核对候选', progress: 10, detail: path });
    try {
      await ingestRawFile(path, (progress) => update(progress), { force: true });
      if (!finalizeCandidateReconciliation(candidateIds || [], reportIds || [])) {
        throw new Error('重新整理后候选仍未满足自动入库条件');
      }
      update({ stage: '候选已动态更新', progress: 100, detail: path });
    } catch (error) {
      releaseCandidateReports(reportIds || []);
      throw error;
    }
  },
  candidate_review_batch: async ({ decisions }, update) => {
    try {
      await applyCandidateReviewBatch(decisions as CandidateReviewDecision[], (progress) => update(progress));
    } catch (error) {
      releaseCandidateReviewBatch(decisions as CandidateReviewDecision[]);
      throw error;
    }
  },
  /** 分类批量处理：只执行请求中显式选择的报告和动作。 */
  dream_apply: async ({ kind, decisions }, update) => {
    try {
      await applyReportDecisions(kind as ReportActionKind, decisions as ReportDecision[], (p) => update(p));
    } catch (error) {
      releaseReports(decisions as ReportDecision[]);
      throw error;
    }
  },
  dream: async (_payload, update) => {
    update({ stage: '运行 Dream Cycle', progress: 10, detail: '扫描知识库问题' });
    const result = await runDreamCycle();
    update({ stage: 'Dream Cycle 已完成', progress: 100, detail: JSON.stringify(result) });
  },
  rebuild: async (_payload, update) => {
    let progress = 10;
    await rebuildAll((message) => {
      progress = Math.min(95, progress + 5);
      update({ stage: '重建索引', progress, detail: message });
    });
  },
};

let running = false;
let defaultPolling = false;
let documentPolling = false;

/** 启动时恢复：把上次被中断、卡在 running 的任务重置回 pending；超过 5 分钟的僵尸标记失败 */
function recoverStaleJobs() {
  db.prepare(
    `UPDATE jobs SET status = 'pending', updated_at = ?
     WHERE status = 'running'
       AND julianday(COALESCE(NULLIF(updated_at,''),run_at,created_at)) > julianday('now', '-5 minutes')`
  ).run(now());
  db.prepare(
    `UPDATE jobs SET status = 'failed', error = '执行超时（超过5分钟无进度，疑似中断未恢复）',
       updated_at = ?
     WHERE status = 'running'`
  ).run(now());
  recoverApplyingReports();
  recoverIngestCommits();
  recoverIngestQuestionJobs();
}

/** 仅保留仍被 pending/running 批量任务引用的 applying 报告。 */
export function recoverApplyingReports() {
  const claimed = new Set<number>();
  const active = db.prepare(
    `SELECT payload FROM jobs
     WHERE kind IN ('dream_apply','candidate_review_batch','candidate_reconcile')
       AND status IN ('pending', 'running')`
  ).all() as { payload: string }[];
  for (const row of active) {
    try {
      const payload = JSON.parse(row.payload);
      for (const decision of payload.decisions || []) claimed.add(Number(decision.reportId));
      for (const reportId of payload.reportIds || []) claimed.add(Number(reportId));
    } catch { /* malformed jobs will fail in the runner */ }
  }
  const applying = db.prepare(`SELECT id FROM reports WHERE status = 'applying'`).all() as { id: number }[];
  const release = applying.filter((report) => !claimed.has(report.id)).map((report) => ({ reportId: report.id, action: '' }));
  releaseReports(release);
}

/** 双通道串行队列：文档识别与普通任务各自单并发，互不长时间阻塞。 */
async function pollLane(lane: 'default' | 'document') {
  if (lane === 'default' ? defaultPolling : documentPolling) return;
  if (lane === 'default') defaultPolling = true;
  else documentPolling = true;
  try {
    const job = db
      .prepare(
        `SELECT * FROM jobs
         WHERE status = 'pending'
           AND ${lane === 'document' ? `kind = 'extract_file'` : `kind != 'extract_file'`}
         ORDER BY id LIMIT 1`
      )
      .get() as any;
    if (!job) return;
    db.prepare(`UPDATE jobs SET status = 'running', run_at = ?, updated_at = ? WHERE id = ?`)
      .run(now(), now(), job.id);
    try {
      const handler = handlers[job.kind];
      updateJob(job.id, { stage: '执行中', progress: 5 });
      if (!handler) throw new Error(`未知任务类型：${job.kind}`);
      await handler(JSON.parse(job.payload), (progress) => updateJob(job.id, progress), job.id);
      const completed = db.prepare(
        `UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ? AND status = 'running'`
      ).run(now(), job.id);
      if (completed.changes) updateJob(job.id, { stage: '已完成', progress: 100 });
    } catch (e: any) {
      db.prepare(`UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`).run(
        String(e?.message || e).slice(0, 500),
        now(),
        job.id
      );
      if (job.kind === 'ingest') {
        const payload = JSON.parse(job.payload);
        if (payload.questionId) failIngestQuestionJob(String(payload.questionId), job.id, e);
      }
      updateJob(job.id, { stage: '失败', detail: String(e?.message || e).slice(0, 500) });
    }
  } finally {
    if (lane === 'default') defaultPolling = false;
    else documentPolling = false;
  }
}

export function startJobRunner() {
  if (running) return;
  running = true;
  recoverStaleJobs();
  setInterval(() => {
    db.prepare(
      `UPDATE jobs SET status = 'failed', error = '执行超时（超过5分钟无进度）', updated_at = ?
       WHERE status = 'running'
         AND julianday(COALESCE(NULLIF(updated_at,''),run_at,created_at)) <= julianday('now', '-5 minutes')`
    ).run(now());
    recoverIngestQuestionJobs();
    void pollLane('default');
    void pollLane('document');
  }, 2000);
}
