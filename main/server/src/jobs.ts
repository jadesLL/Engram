import { db, getSetting, newId, now, setSetting } from './lib/db.js';
import { indexPage, indexFileText, rebuildAll } from './pipeline/indexer.js';
import { extractEntities } from './graph/entities.js';
import { organizePage } from './ai/organize.js';
import { ingestRawFile } from './pipeline/ingest.js';
import { runUpgrades } from './pipeline/mentions.js';
import { regenerateIndex, regenerateRelationships } from './pipeline/indexFile.js';
import {
  applyReportDecisions,
  claimReports,
  releaseReports,
  type ReportActionKind,
  type ReportDecision,
} from './dream/apply.js';
import { enqueue, enqueuePagePipeline } from './jobQueue.js';
import { allPageContributions, finalizeDerivedRun, recoverIngestCommits } from './pipeline/sourceLedger.js';
import { recoverKnowledgeCommit } from './pipeline/knowledgeCommit.js';
import { runDreamCycle } from './dream/tasks.js';
import {
  applyCandidateReviewBatch,
  claimCandidateReviewBatch,
  reconcileCandidateReports,
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
import { releaseCandidateReports } from './pipeline/candidateLedger.js';
import { resolveJobTarget } from './lib/jobTarget.js';

export { enqueue, enqueuePagePipeline } from './jobQueue.js';

export type JobProgress = {
  stage: string;
  progress: number;
  detail?: string;
};

type JobHandler = (
  payload: any,
  update: (progress: Partial<JobProgress>) => void,
  context: { jobId: number; signal: AbortSignal },
) => Promise<void>;

function jobColumns(): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[]).map((column) => column.name));
}

function updateJob(id: number, values: Partial<JobProgress>, runToken?: string) {
  const columns = jobColumns();
  const assignments: string[] = [];
  const params: unknown[] = [];
  if (columns.has('stage') && values.stage !== undefined) { assignments.push('stage = ?'); params.push(values.stage); }
  if (columns.has('progress') && values.progress !== undefined) { assignments.push('progress = ?'); params.push(Math.max(0, Math.min(100, Math.round(values.progress)))); }
  if (columns.has('detail') && values.detail !== undefined) { assignments.push('detail = ?'); params.push(values.detail); }
  if (columns.has('updated_at')) { assignments.push('updated_at = ?'); params.push(now()); }
  if (!assignments.length) return;
  const tokenClause = runToken ? ` AND run_token = ? AND status = 'running'` : '';
  db.prepare(`UPDATE jobs SET ${assignments.join(', ')} WHERE id = ?${tokenClause}`)
    .run(...params, id, ...(runToken ? [runToken] : []));
}

const handlers: Record<string, JobHandler> = {
  embed: async ({ pageId }, _update, context) => {
    await indexPage(pageId, context.signal);
  },
  index_file: async ({ fileId }, _update, context) => {
    await indexFileText(fileId, context.signal);
  },
  extract_file: async ({ path, mode, pages, ingestAfter, forceIngest }, update, context) => {
    await extractFile(path, (progress) => update(progress), {
      mode,
      pages,
      ingestAfter: ingestAfter !== false,
      forceIngest: Boolean(forceIngest),
      signal: context.signal,
    });
  },
  extract: async ({ pageId }, _update, context) => {
    await extractEntities(pageId, context.signal);
  },
  summarize: async ({ pageId }, _update, context) => {
    await organizePage(pageId, context.signal);
  },
  ingest: async ({ path, force, reextract, questionId }, update, context) => {
    await ingestRawFile(path, (progress) => update(progress), {
      force: Boolean(force),
      reextract: Boolean(reextract),
      signal: context.signal,
    });
    if (questionId) completeIngestQuestionJob(String(questionId), context.jobId);
  },
  mentions: async () => {
    await runUpgrades();
  },
  metagen: async () => {
    regenerateIndex();
    regenerateRelationships();
  },
  /** 单页全流程：索引+抽取+整理一步到位（减少队列任务数） */
  process: async ({ pageId }, _update, context) => {
    await indexPage(pageId, context.signal);
    await extractEntities(pageId, context.signal);
    await organizePage(pageId, context.signal);
  },
  page_recompose: async ({ pageId, synthesisId, inputHash }, update, context) => {
    update({ stage: '跨来源整页综合', progress: 15, detail: pageId });
    const result = await recomposePage(
      String(pageId),
      String(synthesisId),
      String(inputHash),
      context.signal,
    );
    if (result.changed) {
      update({ stage: '整页综合已写入', progress: 90, detail: result.synthesisId });
      enqueue('process', { pageId: String(pageId), synthesisId: result.synthesisId });
      enqueue('metagen', {});
    }
  },
  ingest_finalize: async ({ runId }) => {
    finalizeDerivedRun(runId);
  },
  /** 按页面重新提炼：反查该页依赖的来源，逐个强制重跑 ingest 管线 */
  page_reextract: async ({ pageId }, update) => {
    update({ stage: '按页面重新提炼', progress: 5, detail: String(pageId) });
    const contribs = allPageContributions(String(pageId));
    const paths = [...new Set(contribs.map((item) => item.source_path))];
    if (!paths.length) {
      update({ stage: '按页面重新提炼', progress: 100, detail: '无可重新提炼的来源' });
      return;
    }
    for (const p of paths) enqueue('ingest', { path: p, force: true, reextract: true });
    update({ stage: '按页面重新提炼', progress: 50, detail: `已入队 ${paths.length} 份来源` });
  },
  ingest_recover: async ({ runId }) => {
    recoverKnowledgeCommit(runId);
  },
  candidate_reconcile: async ({ path, candidateIds, reportIds }, update, context) => {
    update({
      stage: '准备局部候选对账',
      progress: 5,
      detail: `${path} · ${(candidateIds || []).length} 个候选`,
    });
    try {
      const result = await reconcileCandidateReports(
        reportIds || [],
        (progress) => update(progress),
        context.signal,
      );
      if (!result.completed) {
        throw new Error(result.errors.join('；') || '候选仍未满足自动入库条件');
      }
    } catch (error) {
      releaseCandidateReports(reportIds || []);
      throw error;
    }
  },
  candidate_review_batch: async ({ decisions }, update, context) => {
    try {
      await applyCandidateReviewBatch(
        decisions as CandidateReviewDecision[],
        (progress) => update(progress),
        context.signal,
      );
    } catch (error) {
      releaseCandidateReviewBatch(decisions as CandidateReviewDecision[]);
      throw error;
    }
  },
  /** 分类批量处理：只执行请求中显式选择的报告和动作。 */
  dream_apply: async ({ kind, decisions }, update, context) => {
    try {
      await applyReportDecisions(
        kind as ReportActionKind,
        decisions as ReportDecision[],
        (progress) => update(progress),
        context.signal,
      );
    } catch (error) {
      releaseReports(decisions as ReportDecision[]);
      throw error;
    }
  },
  dream: async (_payload, update, context) => {
    update({ stage: '运行 Dream Cycle', progress: 10, detail: '扫描知识库问题' });
    const result = await runDreamCycle(context.signal);
    update({ stage: 'Dream Cycle 已完成', progress: 100, detail: JSON.stringify(result) });
  },
  rebuild: async (_payload, update, context) => {
    let progress = 10;
    await rebuildAll((message) => {
      progress = Math.min(95, progress + 5);
      update({ stage: '重建索引', progress, detail: message });
    }, context.signal);
  },
};

let running = false;
type JobLane = 'default' | 'document';
type ActiveExecution = {
  controller: AbortController;
  lane: JobLane;
  runToken: string;
  targetKey: string;
};

const LANE_LIMITS: Record<JobLane, number> = { default: 2, document: 1 };
const JOB_QUEUE_ENABLED_SETTING = 'job_queue_enabled';
const activeExecutions = new Map<number, ActiveExecution>();
const polling = { default: false, document: false };
const idleWaiters = new Set<() => void>();
let maintenanceDepth = 0;
let maintenanceTail: Promise<void> = Promise.resolve();

export function getJobQueueState(): { running: boolean } {
  return { running: (getSetting(JOB_QUEUE_ENABLED_SETTING) ?? '1') !== '0' };
}

/** 启动时恢复：把上次被中断、卡在 running 的任务重置回 pending；超过 5 分钟的僵尸标记失败 */
function recoverStaleJobs() {
  db.prepare(
    `UPDATE jobs SET status = 'pending', run_token='', cancel_requested=0, updated_at = ?
     WHERE status = 'running'
       AND julianday(COALESCE(NULLIF(updated_at,''),run_at,created_at)) > julianday('now', '-5 minutes')`
  ).run(now());
  db.prepare(
    `UPDATE jobs SET status = 'failed', error = '执行超时（超过5分钟无进度，疑似中断未恢复）',
       run_token='', cancel_requested=0, updated_at = ?
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

function releaseJobClaims(job: any): void {
  let payload: any = {};
  try { payload = JSON.parse(job.payload); } catch { return; }
  if (job.kind === 'candidate_reconcile') {
    releaseCandidateReports(payload.reportIds || []);
  } else if (job.kind === 'candidate_review_batch') {
    releaseCandidateReviewBatch(payload.decisions || []);
  } else if (job.kind === 'dream_apply') {
    releaseReports(payload.decisions || []);
  }
}

function claimJobReports(job: any): void {
  let payload: any = {};
  try { payload = JSON.parse(job.payload); } catch { return; }
  if (job.kind === 'candidate_reconcile') {
    const reportIds = (payload.reportIds || []).map(Number).filter(Number.isInteger);
    const claim = db.prepare(
      `UPDATE reports SET status='applying'
       WHERE id=? AND kind='pending_review' AND status='open'`
    );
    db.transaction(() => {
      for (const reportId of reportIds) {
        if (claim.run(reportId).changes !== 1) {
          throw new Error(`候选 #${reportId} 已处理或不存在`);
        }
      }
    })();
  } else if (job.kind === 'candidate_review_batch') {
    claimCandidateReviewBatch(payload.decisions || []);
  } else if (job.kind === 'dream_apply') {
    claimReports(payload.kind, payload.decisions || []);
  }
}

function activeLaneCount(lane: JobLane): number {
  return [...activeExecutions.values()].filter((execution) => execution.lane === lane).length;
}

function notifyIdleWaiters(): void {
  if (activeExecutions.size) return;
  for (const resolve of idleWaiters) resolve();
  idleWaiters.clear();
}

function waitForActiveExecutions(): Promise<void> {
  if (!activeExecutions.size) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.add(resolve));
}

function targetKey(job: any): string {
  return resolveJobTarget(job.payload).targetKey || `global:${job.kind}`;
}

function nextJob(lane: JobLane): any | undefined {
  const activeTargets = new Set([...activeExecutions.values()].map((execution) => execution.targetKey));
  const rows = db.prepare(
    `SELECT * FROM jobs
     WHERE status='pending'
       AND ${lane === 'document' ? `kind='extract_file'` : `kind<>'extract_file'`}
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
     LIMIT 50`
  ).all() as any[];
  return rows.find((job) => !activeTargets.has(targetKey(job)));
}

async function executeJob(job: any, execution: ActiveExecution): Promise<void> {
  const { controller, runToken } = execution;
  const payload = JSON.parse(job.payload);
  try {
    const handler = handlers[job.kind];
    updateJob(job.id, { stage: '执行中', progress: 5 }, runToken);
    if (!handler) throw new Error(`未知任务类型：${job.kind}`);
    await handler(
      payload,
      (progress) => updateJob(job.id, progress, runToken),
      { jobId: job.id, signal: controller.signal },
    );
    const state = db.prepare(
      `SELECT status,cancel_requested FROM jobs WHERE id=? AND run_token=?`
    ).get(job.id, runToken) as { status: string; cancel_requested: number } | undefined;
    if (state?.status !== 'running') return;
    if (controller.signal.aborted || state.cancel_requested) {
      db.prepare(
        `UPDATE jobs SET status='cancelled',stage='已取消',detail='',
           error=NULL,run_token='',updated_at=? WHERE id=? AND run_token=?`
      ).run(now(), job.id, runToken);
      releaseJobClaims(job);
      return;
    }
    const completed = db.prepare(
      `UPDATE jobs SET status='done',stage='已完成',progress=100,
         run_token='',cancel_requested=0,updated_at=?
       WHERE id=? AND run_token=? AND status='running'`
    ).run(now(), job.id, runToken);
    if (!completed.changes) return;
  } catch (error: any) {
    const state = db.prepare(
      `SELECT status,cancel_requested FROM jobs WHERE id=? AND run_token=?`
    ).get(job.id, runToken) as { status: string; cancel_requested: number } | undefined;
    if (state?.status === 'running') {
      const cancelled = controller.signal.aborted || Boolean(state.cancel_requested);
      db.prepare(
        `UPDATE jobs SET status=?,stage=?,detail=?,error=?,run_token='',
           cancel_requested=0,updated_at=? WHERE id=? AND run_token=?`
      ).run(
        cancelled ? 'cancelled' : 'failed',
        cancelled ? '已取消' : '失败',
        cancelled ? '' : String(error?.message || error).slice(0, 500),
        cancelled ? null : String(error?.message || error).slice(0, 500),
        now(),
        job.id,
        runToken,
      );
    }
    releaseJobClaims(job);
    if (job.kind === 'ingest' && payload.questionId && state?.status !== 'paused') {
      failIngestQuestionJob(String(payload.questionId), job.id, error);
    }
  } finally {
    activeExecutions.delete(job.id);
    notifyIdleWaiters();
    if (!maintenanceDepth && getJobQueueState().running) resumePausedJobs();
    // 任务完成后的下一轮调度延迟到下一个事件循环 tick，避免同步 DB 写密集冻结主线程。
    setImmediate(() => pollLane(execution.lane));
  }
}

function startJob(job: any, lane: JobLane): boolean {
  const runToken = newId();
  const claimed = db.prepare(
    `UPDATE jobs SET status='running',run_at=?,run_token=?,cancel_requested=0,updated_at=?
     WHERE id=? AND status='pending'`
  ).run(now(), runToken, now(), job.id);
  if (claimed.changes !== 1) return false;
  const execution: ActiveExecution = {
    controller: new AbortController(),
    lane,
    runToken,
    targetKey: targetKey(job),
  };
  activeExecutions.set(job.id, execution);
  void executeJob(job, execution);
  return true;
}

/** 文档识别单并发；普通 AI 任务最多双并发，同一目标仍保持串行。 */
function pollLane(lane: JobLane) {
  if (maintenanceDepth || !getJobQueueState().running || polling[lane]) return;
  polling[lane] = true;
  try {
    while (activeLaneCount(lane) < LANE_LIMITS[lane]) {
      const job = nextJob(lane);
      if (!job || !startJob(job, lane)) break;
    }
  } finally {
    polling[lane] = false;
  }
}

export function cancelJob(jobId: number): { status: string } {
  const job = db.prepare(`SELECT * FROM jobs WHERE id=?`).get(jobId) as any;
  if (!job) throw new Error('任务不存在');
  if (['pending', 'paused'].includes(job.status)) {
    db.prepare(
      `UPDATE jobs SET status='cancelled',stage='已取消',error=NULL,
       cancel_requested=0,run_token='',updated_at=?
       WHERE id=? AND status IN ('pending','paused')`
    ).run(now(), jobId);
    releaseJobClaims(job);
    return { status: 'cancelled' };
  }
  if (job.status !== 'running') return { status: job.status };
  const execution = activeExecutions.get(jobId);
  if (!execution) {
    db.prepare(
      `UPDATE jobs SET status='cancelled',stage='已取消',error=NULL,
       cancel_requested=0,run_token='',updated_at=? WHERE id=? AND status='running'`
    ).run(now(), jobId);
    releaseJobClaims(job);
    return { status: 'cancelled' };
  }
  db.prepare(
    `UPDATE jobs SET cancel_requested=1,stage='正在取消',updated_at=?
     WHERE id=? AND status='running'`
  ).run(now(), jobId);
  execution.controller.abort();
  return { status: 'cancelling' };
}

function cancelActiveJobs(): number[] {
  const jobs = db.prepare(
    `SELECT id FROM jobs WHERE status IN ('pending', 'running', 'paused') ORDER BY id`
  ).all() as { id: number }[];
  for (const job of jobs) cancelJob(job.id);
  return jobs.map((job) => job.id);
}

/**
 * 数据维护期间暂停调度并停止现有任务，避免清理完成后被旧任务重新写入。
 * 同期新加入的任务也会在恢复调度前取消。
 */
export async function withJobsStopped<T>(
  action: () => Promise<T>,
): Promise<{ result: T; cancelledJobs: number }> {
  const previous = maintenanceTail;
  let releaseMaintenance!: () => void;
  maintenanceTail = new Promise<void>((resolve) => {
    releaseMaintenance = resolve;
  });
  await previous;

  maintenanceDepth++;
  const cancelled = new Set<number>();
  const cancelCurrent = () => {
    for (const id of cancelActiveJobs()) cancelled.add(id);
  };

  try {
    cancelCurrent();
    await waitForActiveExecutions();
    cancelCurrent();
    const result = await action();
    cancelCurrent();
    return { result, cancelledJobs: cancelled.size };
  } finally {
    try {
      cancelCurrent();
    } finally {
      maintenanceDepth--;
      releaseMaintenance();
      if (!maintenanceDepth) {
        pollLane('default');
        pollLane('document');
      }
    }
  }
}

export function retryJob(jobId: number): { status: string } {
  const job = db.prepare(`SELECT * FROM jobs WHERE id=?`).get(jobId) as any;
  if (!job) throw new Error('任务不存在');
  if (!['failed', 'cancelled'].includes(job.status)) {
    throw new Error('仅失败或已取消任务可重试');
  }
  claimJobReports(job);
  db.prepare(
    `UPDATE jobs SET status='pending',error=NULL,run_at=NULL,
     stage='等待执行',progress=0,detail='',cancel_requested=0,
     run_token='',updated_at=? WHERE id=? AND status IN ('failed','cancelled')`
  ).run(now(), jobId);
  return { status: 'pending' };
}

function resumePausedJobs(): { started: number; failed: number; errors: string[] } {
  const paused = db.prepare(`SELECT * FROM jobs WHERE status='paused' ORDER BY id`).all() as any[];
  let started = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const job of paused) {
    if (activeExecutions.has(job.id)) continue;
    try {
      claimJobReports(job);
      const resumed = db.prepare(
        `UPDATE jobs SET status='pending',stage='等待执行',progress=0,detail='',
         error=NULL,cancel_requested=0,run_token='',run_at=NULL,updated_at=?
         WHERE id=? AND status='paused'`
      ).run(now(), job.id);
      started += resumed.changes;
    } catch (error: any) {
      const message = String(error?.message || error || '任务恢复失败').slice(0, 500);
      db.prepare(
        `UPDATE jobs SET status='failed',stage='失败',detail=?,error=?,
         cancel_requested=0,run_token='',updated_at=?
         WHERE id=? AND status='paused'`
      ).run(message, message, now(), job.id);
      failed++;
      errors.push(`#${job.id} ${message}`);
    }
  }
  return { started, failed, errors };
}

export function stopJobQueue(): { status: 'stopped'; stopped: number } {
  setSetting(JOB_QUEUE_ENABLED_SETTING, '0');
  const jobs = db.prepare(
    `SELECT * FROM jobs WHERE status IN ('pending','running') ORDER BY id`
  ).all() as any[];
  let stopped = 0;
  for (const job of jobs) {
    const updated = db.prepare(
      `UPDATE jobs SET status='paused',stage='已停止',detail='',
       cancel_requested=?,updated_at=?
       WHERE id=? AND status=?`
    ).run(job.status === 'running' ? 1 : 0, now(), job.id, job.status);
    if (!updated.changes) continue;
    stopped++;
    releaseJobClaims(job);
    if (job.status === 'running') activeExecutions.get(job.id)?.controller.abort();
  }
  return { status: 'stopped', stopped };
}

export function startJobQueue(): {
  status: 'running';
  started: number;
  failed: number;
  errors: string[];
} {
  setSetting(JOB_QUEUE_ENABLED_SETTING, '1');
  const result = resumePausedJobs();
  if (running) {
    pollLane('default');
    pollLane('document');
  }
  return { status: 'running', ...result };
}

export function retryFailedJobs(): { retried: number; failed: number; errors: string[] } {
  const jobs = db.prepare(`SELECT id FROM jobs WHERE status='failed' ORDER BY id`).all() as Array<{ id: number }>;
  let retried = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const job of jobs) {
    try {
      retryJob(job.id);
      retried++;
    } catch (error: any) {
      failed++;
      errors.push(`#${job.id} ${String(error?.message || error || '重试失败')}`);
    }
  }
  if (running && getJobQueueState().running) {
    pollLane('default');
    pollLane('document');
  }
  return { retried, failed, errors };
}

function abortStaleJobs(): void {
  const stale = db.prepare(
    `SELECT * FROM jobs WHERE status='running'
     AND julianday(COALESCE(NULLIF(updated_at,''),run_at,created_at))
       <= julianday('now','-5 minutes')`
  ).all() as any[];
  for (const job of stale) {
    activeExecutions.get(job.id)?.controller.abort();
    db.prepare(
      `UPDATE jobs SET status='failed',stage='失败',
       error='执行超时（超过5分钟无进度）',
       detail='执行超时（超过5分钟无进度）',
       run_token='',cancel_requested=0,updated_at=?
       WHERE id=? AND status='running'`
    ).run(now(), job.id);
    releaseJobClaims(job);
  }
}

export function startJobRunner() {
  if (running) return;
  running = true;
  recoverStaleJobs();
  const tick = () => {
    abortStaleJobs();
    recoverIngestQuestionJobs();
    pollLane('default');
    pollLane('document');
  };
  tick();
  setInterval(tick, 1000);
}
