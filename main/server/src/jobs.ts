import { db, getSetting, newId, now, setSetting } from './lib/db.js';
import { indexPage, indexFileText, rebuildAll } from './pipeline/indexer.js';
import { appendWikiLog } from './pipeline/indexFile.js';
import { enqueuePagePipeline, saveIdeaDistillResult } from './jobQueue.js';
import { resolveJobTarget } from './lib/jobTarget.js';
import { missingFtsPageIds } from './pipeline/sourceLedger.js';

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

/*
 * 惰性模块：本模块会被大量 routes 静态 import（只为 enqueue/进度查询），启动时不能
 * 把 handler 依赖的整条重链打进模块图——pipeline/fileExtraction 静态加载 pdfjs，
 * pipeline/inboxConvert 经 pipeline/office 加载 xlsx/mammoth，pipeline/inboxVideo
 * 加载模型客户端。统一改成「任务首次真正执行时才 import」，Promise 缓存复用。
 */
let fileExtractionModule: Promise<typeof import('./pipeline/fileExtraction.js')> | null = null;
let inboxConvertModule: Promise<typeof import('./pipeline/inboxConvert.js')> | null = null;
let inboxVideoModule: Promise<typeof import('./pipeline/inboxVideo.js')> | null = null;
let inboxConversationModule: Promise<typeof import('./pipeline/inboxConversation.js')> | null = null;
let ideaDistillModule: Promise<typeof import('./lib/ideaDistill.js')> | null = null;

function loadFileExtraction() {
  return (fileExtractionModule ??= import('./pipeline/fileExtraction.js'));
}
function loadInboxConvert() {
  return (inboxConvertModule ??= import('./pipeline/inboxConvert.js'));
}
function loadInboxVideo() {
  return (inboxVideoModule ??= import('./pipeline/inboxVideo.js'));
}
function loadInboxConversation() {
  return (inboxConversationModule ??= import('./pipeline/inboxConversation.js'));
}
function loadIdeaDistill() {
  return (ideaDistillModule ??= import('./lib/ideaDistill.js'));
}

/**
 * 收口收集箱转换对话。启动恢复 / 取消 / 超时兜底这些同步路径不能 await 动态 import，
 * 而收口只是补一条对话消息、不影响任务状态：这里异步补完，失败只记日志（与原来的
 * try/catch 行为一致，只是从同步改到微任务后执行）。
 */
function finishInboxConversationSoon(jobId: number): void {
  void loadInboxConversation()
    .then(({ finishInboxConversation }) => finishInboxConversation(jobId))
    .catch((error) => console.warn('[inbox] 对话记录收口失败', error));
}

const handlers: Record<string, JobHandler> = {
  extract_file: async ({ path, mode, pages }, update, context) => {
    // 文档提取链路（pdfjs）只在任务真正开跑时加载
    const { extractFile } = await loadFileExtraction();
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
  /**
   * 灵感后台提炼：原文在 `POST /api/ideas` 里就已经落盘，这里只做勘误/精炼/拟标题/改名/写成品。
   * 结果必须回填到任务行（saveIdeaDistillResult）——`GET /api/ideas/:id/distill` 的
   * staged/fixes/refined 都从那里读；失败靠抛错让执行器把任务标成 failed，
   * 侧栏据此显示「提炼失败」，而原文一个字都没动。
   */
  idea_distill: async ({ id, path: relPath, hash }, update, context) => {
    // 提炼链路（模型客户端）只在任务真正开跑时加载
    const { distillIdeaNote, ideaDistillProgress } = await loadIdeaDistill();
    const result = await distillIdeaNote(
      { id, path: relPath, hash },
      {
        // 取消信号要透进去：模型跑完发现任务已被取消（数据维护/手动取消）就不再落笔
        signal: context.signal,
        onProgress: (stage, detail) => update({ stage, progress: ideaDistillProgress(stage), detail }),
      }
    );
    saveIdeaDistillResult(context.jobId, result);
    if (result.staged === 'failed') throw new Error(result.error || '提炼没有完成');
    update({
      stage: '已完成',
      progress: 100,
      detail: result.staged === 'skipped-edit' ? '正文已被改动，跳过了改写' : `「${result.title}」`,
    });
  },
  rebuild: async (_payload, update, context) => {
    let progress = 10;
    await rebuildAll((message) => {
      progress = Math.min(95, progress + 5);
      update({ stage: '重建索引', progress, detail: message });
    }, context.signal);
    try { appendWikiLog('重建索引', '全量重建完成'); } catch { /* 日志失败不阻塞 */ }
  },
  /**
   * 收集箱语义转换：把一份原件按内容重写成 Markdown，产物写进 收集箱/转换结果/。
   * payload 用 `path`（vault 相对路径），这样同一份文件天然串行、不同文件可并行。
   */
  inbox_convert: async ({ path: relPath }, update, context) => {
    // 转换链路（pdfjs / xlsx / mammoth / 模型客户端）只在任务真正开跑时加载
    const [
      { convertCapability, convertInboxItem },
      { recordInboxConversionStep },
    ] = await Promise.all([loadInboxConvert(), loadInboxConversation()]);
    // 视频（链接占位稿 / 音视频原件）走视频理解管线，其余仍走文档语义转换：
    // 两者产物位置与「入库」流程完全一致，只是内容来源不同。
    if (convertCapability(relPath) === 'video') {
      const { convertVideoInboxItem } = await loadInboxVideo();
      const result = await convertVideoInboxItem(relPath, {
        signal: context.signal,
        onProgress: (stage, detail) => {
          const progress =
            stage === '解析链接' ? 8
              : stage === '获取视频' ? 32
                : stage === '准备请求' ? 55
                  : stage === '视频理解' ? 68
                    : stage === '提炼文件名' ? 88
                      : 95;
          update({ stage, progress, detail });
          recordInboxConversionStep(context.jobId, stage, detail);
        },
      });
      update({ stage: '写入结果', progress: 95, detail: result.derivedPath });
      return;
    }
    const result = await convertInboxItem(relPath, {
      signal: context.signal,
      onProgress: (stage, detail) => {
        update({ stage, progress: stage === '读取原件' ? 15 : stage === '提炼文件名' ? 85 : 60, detail });
        recordInboxConversionStep(context.jobId, stage, detail);
      },
    });
    update({ stage: '写入结果', progress: 95, detail: result.derivedPath });
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

/** jobs 表列集合：只在首次用到时查一次 PRAGMA——updateJob 每次进度回调都调它，
 * 而 updateJob 是热路径（长任务每秒多次），表结构运行期不会变，反复查纯属浪费 */
let jobColumnNames: Set<string> | null = null;

function jobColumns(): Set<string> {
  if (!jobColumnNames) {
    jobColumnNames = new Set(
      (db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[]).map((column) => column.name)
    );
  }
  return jobColumnNames;
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
  // 收口上次进程没写完的收集箱转换对话。
  // 原写法在外层用「NOT EXISTS (assistant_messages WHERE metadata LIKE ...)」做相关子查询：
  // 每条候选 job 都要把整张 assistant_messages 扫一遍（metadata 无索引，LIKE 只能全表），
  // 真实库上启动时实测 ~1s。改成先只按 jobs 上的索引取候选（idx_jobs_kind_status），
  // 再用 session_id 逐条查——assistant_messages(session_id, created_at) 有索引，
  // 每个会话消息数很少，语义完全不变（finishInboxConversation 内部还会再校验一次 final 标记，
  // 因此这里只是预筛，重复调用也安全）。
  const unfinishedConversations = db.prepare(
    `SELECT id, assistant_session_id FROM jobs
      WHERE kind = 'inbox_convert' AND status IN ('failed', 'cancelled')
        AND assistant_session_id IS NOT NULL
      LIMIT 500`
  ).all() as { id: number; assistant_session_id: string }[];
  if (unfinishedConversations.length) {
    const hasFinalMessage = db.prepare(
      `SELECT 1 FROM assistant_messages WHERE session_id = ?
         AND metadata LIKE '%"inboxConversionFinal":true%' LIMIT 1`
    );
    for (const row of unfinishedConversations) {
      if (!hasFinalMessage.get(row.assistant_session_id)) finishInboxConversationSoon(row.id);
    }
  }
  // FTS 兜底：从未进过 pages_fts 的页面（历史向量时代数据）补一次索引任务。
  // 原写法逐页 NOT EXISTS 会为每一页全扫一遍 FTS 虚拟表（O(页面数²)）；改为一次性取
  // pages_fts.page_id 集合后在内存比对（与 queueMissingDerivedPages 共用集合式实现）。
  const rows = missingFtsPageIds()
    .slice(0, 500)
    .map((id) => ({ id }));
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
    if (job.kind === 'inbox_convert') {
      const { recordInboxConversionStep } = await loadInboxConversation();
      recordInboxConversionStep(job.id, '执行中');
    }
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
    if (job.kind === 'inbox_convert') {
      try {
        const { finishInboxConversation } = await loadInboxConversation();
        finishInboxConversation(job.id);
      } catch (error) { console.warn('[inbox] 对话记录收口失败', error); }
    }
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
    if (job.kind === 'inbox_convert') finishInboxConversationSoon(jobId);
    return { status: 'cancelled' };
  }
  if (job.status !== 'running') return { status: job.status };
  const execution = activeExecutions.get(jobId);
  if (!execution) {
    db.prepare(
      `UPDATE jobs SET status='cancelled',stage='已取消',error=NULL,
       cancel_requested=0,run_token='',updated_at=? WHERE id=? AND status='running'`
    ).run(now(), jobId);
    if (job.kind === 'inbox_convert') finishInboxConversationSoon(jobId);
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

/**
 * 是否正在做数据维护（清库 / 恢复等 withJobsStopped 区间）。
 * 维护期间不要起新的后台作业（例如「梦境思考」的一轮 Agent）：清理完成后它会把内容又写回来。
 */
export function isMaintenanceActive(): boolean {
  return maintenanceDepth > 0;
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
    if (job.kind === 'inbox_convert') finishInboxConversationSoon(job.id);
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
