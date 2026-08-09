import path from 'node:path';
import { db, now } from './lib/db.js';

export interface PagePipelineOptions {
  ingestRunId?: string;
  revision?: string;
}

export function enqueue(kind: string, payload: unknown): number | undefined {
  const payloadStr = JSON.stringify(payload);
  const duplicate = db
    .prepare(`SELECT id FROM jobs WHERE kind = ? AND payload = ? AND status = 'pending'`)
    .get(kind, payloadStr);
  if (duplicate) return undefined;

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

export function enqueuePagePipeline(pageId: string, options: PagePipelineOptions = {}): void {
  const page = db.prepare(`SELECT path FROM pages WHERE id = ?`).get(pageId) as { path?: string } | undefined;
  const pagePath = page?.path || '';
  const payload = options.ingestRunId
    ? { pageId, ingestRunId: options.ingestRunId, ...(options.revision ? { revision: options.revision } : {}) }
    : { pageId };

  if (pagePath.startsWith('原始资料/')) {
    enqueue('embed', payload);
    const ext = path.posix.extname(pagePath).slice(1).toLowerCase();
    if (['md', 'markdown', 'txt'].includes(ext)) enqueue('ingest', { path: pagePath });
  } else if (pagePath.startsWith('AIWorks/')) {
    enqueue('embed', payload);
  } else {
    enqueue('process', payload);
  }
  enqueue('mentions', {});
  enqueue('metagen', {});
}
