import { FastifyInstance } from 'fastify';
import { db } from '../lib/db.js';
import { requireAuth } from './auth.js';
import { getJobQueueState } from '../jobs.js';
import { resolveJobTarget } from '../lib/jobTarget.js';

const KIND_LABELS: Record<string, string> = {
  process: '页面索引',
  index_file: '文件索引',
  extract_file: '文档提取',
  metagen: '索引生成',
  rebuild: '重建全部索引',
};

function safeJson(value: unknown, fallback: any = null) {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
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

export async function jobRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/jobs', async () => {
    const activeRows = db
      .prepare(
        `SELECT ${jobSelect()} FROM jobs WHERE status IN ('pending', 'running', 'paused')
         ORDER BY id
         LIMIT 100`
      )
      .all();
    const recentRows = db
      .prepare(`SELECT ${jobSelect()} FROM jobs WHERE status IN ('done', 'failed', 'cancelled') ORDER BY id DESC LIMIT 20`)
      .all();
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
        created_at: r.created_at,
        run_at: r.run_at,
      };
    };
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
      active: activeRows.map(fmt),
      recent: recentRows.map(fmt),
      pending: counts.pending || 0,
      running: counts.running || 0,
      paused: counts.paused || 0,
      failed: counts.failed || 0,
      queueRunning: getJobQueueState().running,
    };
  });
}
