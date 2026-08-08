import { db, now } from './lib/db.js';
import { indexPage, indexFileText } from './pipeline/indexer.js';
import { extractEntities } from './graph/entities.js';
import { organizePage } from './ai/organize.js';
import { ingestRawFile } from './pipeline/ingest.js';
import { runUpgrades } from './pipeline/mentions.js';
import { regenerateIndex, regenerateRelationships } from './pipeline/indexFile.js';
import { applyReportDecisions, releaseReports, type ReportActionKind, type ReportDecision } from './dream/apply.js';

export type JobProgress = {
  stage: string;
  progress: number;
  detail?: string;
};

type JobHandler = (payload: any, update: (progress: Partial<JobProgress>) => void) => Promise<void>;

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
  extract: async ({ pageId }) => {
    await extractEntities(pageId);
  },
  summarize: async ({ pageId }) => {
    await organizePage(pageId);
  },
  ingest: async ({ path }, update) => {
    await ingestRawFile(path, (progress) => update(progress));
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
  /** 分类批量处理：只执行请求中显式选择的报告和动作。 */
  dream_apply: async ({ kind, decisions }, update) => {
    try {
      applyReportDecisions(kind as ReportActionKind, decisions as ReportDecision[], (p) => update(p));
    } catch (error) {
      releaseReports(decisions as ReportDecision[]);
      throw error;
    }
  },
};

export function enqueue(kind: string, payload: unknown): number | undefined {
  const payloadStr = JSON.stringify(payload);
  // 去重1：同 kind+payload 的排队任务已存在则跳过
  const dup = db
    .prepare(`SELECT id FROM jobs WHERE kind = ? AND payload = ? AND status = 'pending'`)
    .get(kind, payloadStr);
  if (dup) return undefined;
  // 去重2：同任务 60 秒内刚完成过则跳过（防自动保存反复触发完整管线）
  const recent = db
    .prepare(
      `SELECT id FROM jobs WHERE kind = ? AND payload = ? AND status = 'done'
       AND julianday(run_at) > julianday('now', '-60 seconds')`
    )
    .get(kind, payloadStr);
  if (recent) return undefined;
  const info = db
    .prepare(`INSERT INTO jobs(kind, payload, status, created_at) VALUES(?, ?, 'pending', ?)`)
    .run(kind, payloadStr, now());
  return Number(info.lastInsertRowid);
}

let running = false;

/** 启动时恢复：把上次被中断、卡在 running 的任务重置回 pending；超过 5 分钟的僵尸标记失败 */
function recoverStaleJobs() {
  db.prepare(
    `UPDATE jobs SET status = 'pending' WHERE status = 'running' AND julianday(run_at) > julianday('now', '-5 minutes')`
  ).run();
  db.prepare(
    `UPDATE jobs SET status = 'failed', error = '执行超时（运行中超过5分钟，疑似中断未恢复）' WHERE status = 'running'`
  ).run();
  recoverApplyingReports();
}

/** 仅保留仍被 pending/running dream_apply 任务引用的 applying 报告。 */
export function recoverApplyingReports() {
  const claimed = new Set<number>();
  const active = db.prepare(
    `SELECT payload FROM jobs WHERE kind = 'dream_apply' AND status IN ('pending', 'running')`
  ).all() as { payload: string }[];
  for (const row of active) {
    try {
      const payload = JSON.parse(row.payload);
      for (const decision of payload.decisions || []) claimed.add(Number(decision.reportId));
    } catch { /* malformed jobs will fail in the runner */ }
  }
  const applying = db.prepare(`SELECT id FROM reports WHERE status = 'applying'`).all() as { id: number }[];
  const release = applying.filter((report) => !claimed.has(report.id)).map((report) => ({ reportId: report.id, action: '' }));
  releaseReports(release);
}

/** 简单串行队列：每 2s 取一个 pending 任务执行，避免打爆 LLM 速率 */
export function startJobRunner() {
  if (running) return;
  running = true;
  recoverStaleJobs();
  let polling = false;
  setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      // 看门狗：清理运行超过 5 分钟的僵尸任务
      db.prepare(
        `UPDATE jobs SET status = 'failed', error = '执行超时（运行中超过5分钟）' WHERE status = 'running' AND julianday(run_at) <= julianday('now', '-5 minutes')`
      ).run();
      const job = db
        .prepare(`SELECT * FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1`)
        .get() as any;
      if (!job) return;
      db.prepare(`UPDATE jobs SET status = 'running', run_at = ? WHERE id = ?`).run(now(), job.id);
      try {
        const handler = handlers[job.kind];
        updateJob(job.id, { stage: '执行中', progress: 5 });
        if (!handler) throw new Error(`未知任务类型：${job.kind}`);
        await handler(JSON.parse(job.payload), (progress) => updateJob(job.id, progress));
        db.prepare(`UPDATE jobs SET status = 'done' WHERE id = ?`).run(job.id);
        updateJob(job.id, { stage: '已完成', progress: 100 });
      } catch (e: any) {
        db.prepare(`UPDATE jobs SET status = 'failed', error = ? WHERE id = ?`).run(
          String(e?.message || e).slice(0, 500),
          job.id
        );
        updateJob(job.id, { stage: '失败', detail: String(e?.message || e).slice(0, 500) });
      }
    } finally {
      polling = false;
    }
  }, 2000);
}

/** 页面保存后的标准管线：合并为单个 process 任务 + 全局扫描（减少队列噪音） */
export function enqueuePagePipeline(pageId: string) {
  const page = db.prepare(`SELECT path FROM pages WHERE id = ?`).get(pageId) as any;
  const p = page?.path || '';
  const isSystem = p.startsWith('原始资料/') || p.startsWith('AIWorks/');
  if (!isSystem) {
    enqueue('process', { pageId }); // 索引+抽取+整理一步到位
  } else {
    enqueue('embed', { pageId }); // 系统区只做索引
  }
  enqueue('mentions', {}); // 升级扫描（全局，dedup 去重）
  enqueue('metagen', {});  // 重建 index.md / relationships.md（全局，dedup 去重）
}
