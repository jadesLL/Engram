import { db, newId, now } from '../lib/db.js';
import { enqueuePagePipeline } from '../jobQueue.js';

/**
 * 来源版本与页面贡献账本（确定性部分）：
 * 提炼管线外移后，账本由外部 Agent 的 write_page 证据写入（pipeline/agentWrite.ts）
 * 与历史管线数据共同组成，供证据抽屉 / page_evidence 读取。
 */

export interface SourceVersion {
  id: string;
  path: string;
  content_hash: string;
  previous_id: string | null;
  status: string;
}

export interface StoredContribution {
  id: string;
  page_id: string;
  source_version_id: string;
  run_id: string;
  contribution_key: string;
  fact_ids: string;
  relations: string;
  content: string;
  summary: string;
  domain: string;
  confidence: string;
  source_ref: string;
  managed: number;
  active: number;
  source_path: string;
  created_at: string;
  updated_at: string;
}

export function beginSourceVersion(path: string, contentHash: string): SourceVersion {
  const existing = db.prepare(
    `SELECT id, path, content_hash, previous_id, status FROM source_versions WHERE path=? AND content_hash=?`
  ).get(path, contentHash) as SourceVersion | undefined;
  if (existing) {
    db.prepare(`UPDATE source_versions SET status='processing', error=NULL WHERE id=?`).run(existing.id);
    return { ...existing, status: 'processing' };
  }
  const previous = db.prepare(
    `SELECT id FROM source_versions WHERE path=? AND status='active' ORDER BY activated_at DESC LIMIT 1`
  ).get(path) as { id: string } | undefined;
  const version: SourceVersion = {
    id: newId(),
    path,
    content_hash: contentHash,
    previous_id: previous?.id || null,
    status: 'processing',
  };
  db.prepare(
    `INSERT INTO source_versions(id,path,content_hash,previous_id,status,created_at)
     VALUES(?,?,?,?,?,?)`
  ).run(version.id, version.path, version.content_hash, version.previous_id, version.status, now());
  return version;
}

/**
 * 该来源路径是否已被提炼过：存在 status='active' 的来源版本，或任一 active 页面贡献。
 * 提炼提交成功即把版本置为 active（agentWrite），这是「已提炼」的权威记录；
 * 贡献单独列出是因为同步对端可能只有版本行——产物页面被删除/从未同步时贡献挂不上页
 * （applyEvidenceSnapshot 会跳过），只按贡献判定会让对端永远显示未提炼。
 */
export function isDistilledPath(path: string): boolean {
  return !!db.prepare(
    `SELECT 1 FROM source_versions sv
     WHERE sv.path = ? AND (
       sv.status = 'active'
       OR EXISTS (SELECT 1 FROM page_contributions pc
                  WHERE pc.source_version_id = sv.id AND pc.active = 1)
     ) LIMIT 1`
  ).get(path);
}

/**
 * 全部已提炼的来源路径（isDistilledPath 的批量版，语义完全一致）：
 * 供多端同步的全量清单一次性打标，避免逐文件查库；因为标记只存在于
 * source_versions / page_contributions 而不在页面正文里，对端必须靠这个集合
 * 才能发现「内容一致但账本缺失」，进而按来源路径把账本补齐。
 */
export function distilledSourcePaths(): Set<string> {
  const rows = db.prepare(
    `SELECT DISTINCT sv.path AS path FROM source_versions sv
     WHERE sv.status = 'active'
        OR EXISTS (SELECT 1 FROM page_contributions pc
                   WHERE pc.source_version_id = sv.id AND pc.active = 1)`
  ).all() as { path: string }[];
  return new Set(rows.map((row) => row.path));
}

export function contributionsForProjection(pageId: string): StoredContribution[] {
  return db.prepare(
    `SELECT pc.*, sv.path source_path FROM page_contributions pc
     JOIN source_versions sv ON sv.id=pc.source_version_id
     WHERE pc.page_id=? AND pc.active=1 ORDER BY pc.created_at`
  ).all(pageId) as StoredContribution[];
}

/** 启动 FTS 兜底：概念/实体页缺 pages_fts 行时补一次索引任务 */
export function queueMissingDerivedPages(): void {
  const pages = db.prepare(
    `SELECT id FROM pages p WHERE p.deleted=0
     AND (p.path LIKE 'Wiki/概念/%' OR p.path LIKE 'Wiki/实体/%')
     AND NOT EXISTS (
       SELECT 1 FROM pages_fts f WHERE f.page_id = p.id
     )`
  ).all() as { id: string }[];
  for (const page of pages) enqueuePagePipeline(page.id);
}
