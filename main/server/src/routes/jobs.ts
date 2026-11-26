import { FastifyInstance } from 'fastify';
import { db } from '../lib/db.js';
import { requireAuth } from './auth.js';
import { acknowledgeFailedJobs, getJobQueueState } from '../jobs.js';
import { resolveJobTarget } from '../lib/jobTarget.js';

/**
 * 失败告警窗口：只有最近这些天内的失败才计入首页「N 项失败」并出现在失败清单里。
 * 更早的失败仍留在 jobs 表（启动时统一 30 天清理），但不再占用首页的告警位——
 * 「一台设备三周前失败过一次」不该永远显示成待处理。
 *
 * 计数与清单共用同一个 WHERE，避免「徽标说有 N 条、点开只看到 M 条」。
 */
const FAILED_ALARM_DAYS = 7;
const FAILED_ALARM_WHERE = `status = 'failed' AND acknowledged_at IS NULL
  AND julianday(COALESCE(NULLIF(updated_at, ''), created_at)) > julianday('now', '-${FAILED_ALARM_DAYS} days')`;

const KIND_LABELS: Record<string, string> = {
  process: '页面索引',
  index_file: '文件索引',
  extract_file: '文档提取',
  metagen: '索引生成',
  rebuild: '重建全部索引',
  inbox_convert: '收集箱转换',
  idea_distill: '灵感提炼',
};

function safeJson(value: unknown, fallback: any = null) {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

let cachedJobSelect: string | null = null;

function jobSelect(): string {
  if (cachedJobSelect) return cachedJobSelect;
  const columns = new Set((db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[]).map((column) => column.name));
  cachedJobSelect = ['id', 'kind', 'payload', 'status', 'error', 'created_at', 'run_at',
    columns.has('updated_at') ? 'updated_at' : `NULL AS updated_at`,
    columns.has('stage') ? 'stage' : `NULL AS stage`,
    columns.has('progress') ? 'progress' : `NULL AS progress`,
    columns.has('detail') ? 'detail' : `NULL AS detail`,
    columns.has('acknowledged_at') ? 'acknowledged_at' : `NULL AS acknowledged_at`,
  ].join(', ');
  return cachedJobSelect;
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
    // 需要用户处理的失败（未忽略、在告警窗口内）：首页「去处理」点开的就是这份清单。
    // recent 只有最近 20 条终态任务，老失败会被后续成功任务挤出窗口，所以单独查。
    const failureRows = db
      .prepare(`SELECT ${jobSelect()} FROM jobs WHERE ${FAILED_ALARM_WHERE} ORDER BY id DESC LIMIT 50`)
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
        acknowledged: Boolean(r.acknowledged_at),
        created_at: r.created_at,
        run_at: r.run_at,
        updated_at: r.updated_at || r.created_at,
      };
    };
    const counts = db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) AS paused,
           SUM(CASE WHEN ${FAILED_ALARM_WHERE} THEN 1 ELSE 0 END) AS failed
         FROM jobs`
      )
      .get() as any;
    return {
      active: activeRows.map(fmt),
      recent: recentRows.map(fmt),
      failures: failureRows.map(fmt),
      pending: counts.pending || 0,
      running: counts.running || 0,
      paused: counts.paused || 0,
      failed: counts.failed || 0,
      queueRunning: getJobQueueState().running,
    };
  });

  /**
   * 忽略失败任务（已读）：body `{ ids?: number[] }`，不传 ids = 全部忽略。
   * 忽略后不再计入 /api/jobs 的 failed，也不再出现在 failures 清单里。
   */
  app.post('/api/jobs/acknowledge', async (request, reply) => {
    const body = (request.body || {}) as { ids?: unknown };
    if (body.ids !== undefined && !Array.isArray(body.ids)) {
      return reply.code(400).send({ error: 'ids 必须是任务编号数组' });
    }
    const ids = Array.isArray(body.ids) ? body.ids.map(Number) : undefined;
    return { acknowledged: acknowledgeFailedJobs(ids) };
  });
}
