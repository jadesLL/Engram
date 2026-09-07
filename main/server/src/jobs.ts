import { db, getSetting, newId, now, setSetting } from './lib/db.js';
import { indexPage, indexFileText, rebuildAll } from './pipeline/indexer.js';
import { appendWikiLog } from './pipeline/indexFile.js';
import { enqueue, enqueuePagePipeline } from './jobQueue.js';
import { extractFile } from './pipeline/fileExtraction.js';
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

const handlers: Record<string, JobHandler> = {
  extract_file: async ({ path, mode, pages }, update, context) => {
    await extractFile(path, (progress) => update(progress), {
      mode,
      pages,
      signal: context.signal,
    });
  },
  index_file: async ({ fileId }, _update, context) => {
    await indexFileText(fileId, context.signal);
  },
  /** 页面处理：FTS 兜底 + 图谱边重建 */
  process: async ({ pageId }, _update, context) => {
    await indexPage(pageId, context.signal);
  },
  rebuild: async (_payload, update, context) => {
    let progress = 10;
    await rebuildAll((message) => {
      progress = Math.min(95, progress + 5);
      update({ stage: '重建索引', progress, detail: message });
    }, context.signal);
    try { appendWikiLog('重建索引', '全量重建完成'); } catch { /* 日志失败不阻塞 */ }
  },
};

/** 现存任务类型（启动清理时用于识别已移除的提炼类残留任务） */
const KNOWN_KINDS = new Set(Object.keys(handlers));

let running = false;
type JobLane = 'default' | 'document';
type ActiveExecution = {
  controller: AbortController;
  lane: JobLane;
  runToken: string;
  targetKey: string;
};
const LANE_LIMITS: Record<JobLane, number> = { default: 4, document: 1 };
const activeExecutions = new Map<number, ActiveExecution>();
const polling = { default: false, document: false };
const idleWaiters = new Set<() => void>();
let maintenanceDepth = 0;
let maintenanceTail: Promise<void> = Promise.resolve();
const JOB_QUEUE_ENABLED_SETTING = 'job_queue_enabled';

export function getJobQueueState(): { running: boolean } {
  return { running: (getSetting(JOB_QUEUE_ENABLED_SETTING) ?? '1') !== '0' };
}

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

/** 启动时恢复：清理已移除的提炼类残留任务，恢复可安全续跑的近期任务。 */
export function recoverStaleJobs() {
  const kinds = [...KNOWN_KINDS];
  db.prepare(
    `UPDATE jobs SET status='failed',stage='启动清理',error='任务类型已随提炼管线移除',
       run_token='',cancel_requested=0,updated_at=?
     WHERE status IN ('pending','running','paused') AND kind NOT IN (${kinds.map(() => '?').join(',')})`
  ).run(now(), ...kinds);
  db.prepare(
    `UPDATE jobs SET status = 'pending', run_token='', cancel_requested=0, updated_at = ?
     WHERE status = 'running'
       AND julianday(COALESCE(NULLIF(updated_at,''),run_at,created_at)) > julianday('now', '-20 minutes')`
  ).run(now());
  db.prepare(
    `UPDATE jobs SET status = 'failed', error = '执行超时（超过20分钟无进度，疑似中断未恢复）',
       run_token='', cancel_requested=0, updated_at = ?
     WHERE status = 'running'`
  ).run(now());
  // FTS 兜底：从未进过 pages_fts 的页面（历史向量时代数据）补一次索引任务
  const rows = db.prepare(
    `SELECT p.id FROM pages p
     WHERE p.deleted = 0
       AND NOT EXISTS (SELECT 1 FROM pages_fts f WHERE f.page_id = p.id)
     LIMIT 500`
  ).all() as { id: string }[];
  for (const row of rows) enqueuePagePipeline(row.id);
  if (rows.length) {
    console.log(`[jobs] 启动 FTS 兜底：重新入队 ${rows.length} 个缺索引页面`);
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
       ORDER BY id
       LIMIT 50`
  ).all() as any[];
  return rows.find((job) => KNOWN_KINDS.has(job.kind) && !activeTargets.has(targetKey(job)));
}

async function executeJob(job: any, execution: ActiveExecution): Promise<void> {
  const { controller, runToken } = execution;
  try {
    const handler = handlers[job.kind];
    updateJob(job.id, { stage: '执行中', progress: 5 }, runToken);
    if (!handler) throw new Error(`未知任务类型：${job.kind}`);
    await handler(
      JSON.parse(job.payload),
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
           error=NULL,run_token='',cancel_requested=0,updated_at=? WHERE id=? AND run_token=?`
      ).run(now(), job.id, runToken);
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
      const errorMsg = String(error?.message || error).slice(0, 500);
      if (cancelled) {
        db.prepare(
          `UPDATE jobs SET status='cancelled',stage='已取消',detail='',error=NULL,
             run_token='',cancel_requested=0,updated_at=? WHERE id=? AND run_token=?`
        ).run(now(), job.id, runToken);
      } else {
        db.prepare(
          `UPDATE jobs SET status='failed',stage='失败',detail=?,error=?,
             run_token='',cancel_requested=0,updated_at=? WHERE id=? AND run_token=?`
        ).run(errorMsg, errorMsg, now(), job.id, runToken);
      }
    }
  } finally {
    activeExecutions.delete(job.id);
    notifyIdleWaiters();
    if (!maintenanceDepth && getJobQueueState().running) resumePausedJobs();
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

/** 文档解析单并发（CPU 密集）；其余任务默认车道并发。同一目标保持串行。 */
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
    return { status: 'cancelled' };
  }
  if (job.status !== 'running') return { status: job.status };
  const execution = activeExecutions.get(jobId);
  if (!execution) {
    db.prepare(
      `UPDATE jobs SET status='cancelled',stage='已取消',error=NULL,
       cancel_requested=0,run_token='',updated_at=? WHERE id=? AND status='running'`
    ).run(now(), jobId);
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
  if (!KNOWN_KINDS.has(job.kind)) throw new Error('该任务类型已随提炼管线移除，无法重试');
  if (!['failed', 'cancelled'].includes(job.status)) {
    throw new Error('仅失败或已取消任务可重试');
  }
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
    if (!KNOWN_KINDS.has(job.kind)) {
      db.prepare(
        `UPDATE jobs SET status='failed',stage='失败',error='任务类型已随提炼管线移除',
         cancel_requested=0,run_token='',updated_at=? WHERE id=? AND status='paused'`
      ).run(now(), job.id);
      failed++;
      continue;
    }
    const resumed = db.prepare(
      `UPDATE jobs SET status='pending',stage='等待执行',progress=0,detail='',
       error=NULL,cancel_requested=0,run_token='',run_at=NULL,updated_at=?
       WHERE id=? AND status='paused'`
    ).run(now(), job.id);
    started += resumed.changes;
  }
  return { started, failed, errors };
}

export function stopJobQueue(): { status: 'stopped'; stopped: number } {
  setSetting(JOB_QUEUE_ENABLED_SETTING, '0');
  const jobs = db.prepare(`SELECT * FROM jobs WHERE status IN ('pending','running') ORDER BY id`).all() as any[];
  let stopped = 0;
  for (const job of jobs) {
    const updated = db.prepare(
      `UPDATE jobs SET status='paused',stage='已停止',detail='',
       cancel_requested=?,updated_at=?
       WHERE id=? AND status=?`
    ).run(job.status === 'running' ? 1 : 0, now(), job.id, job.status);
    if (!updated.changes) continue;
    stopped++;
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
  const jobs = db.prepare(`SELECT id, kind FROM jobs WHERE status='failed' ORDER BY id`).all() as Array<{ id: number; kind: string }>;
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
       <= julianday('now','-20 minutes')`
  ).all() as any[];
  for (const job of stale) {
    activeExecutions.get(job.id)?.controller.abort();
    db.prepare(
      `UPDATE jobs SET status='failed',stage='失败',
       error='执行超时（超过20分钟无进度）',
       detail='执行超时（超过20分钟无进度）',
       run_token='',cancel_requested=0,updated_at=?
       WHERE id=? AND status='running'`
    ).run(now(), job.id);
  }
}

export function startJobRunner() {
  if (running) return;
  running = true;
  recoverStaleJobs();
  const tick = () => {
    abortStaleJobs();
    pollLane('default');
    pollLane('document');
  };
  tick();
  setInterval(tick, 1000);
}
