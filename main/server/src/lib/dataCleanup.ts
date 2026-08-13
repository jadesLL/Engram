import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs } from '../config.js';
import { RELATION_WORDS } from '../pipeline/extractor.js';
import { appendWikiLog, regenerateIndex, regenerateRelationships } from '../pipeline/indexFile.js';
import { rebuildAll } from '../pipeline/indexer.js';
import { db } from './db.js';
import { invalidateGraphCache } from './graphCache.js';
import { safeJoin, writePage } from './vault.js';

const KNOWLEDGE_DIRS = ['原始资料', 'Wiki/概念', 'Wiki/实体', 'Wiki/归档', 'Wiki/查询'];
const SYSTEM_PAGE_PATHS = ['Wiki/index.md', 'Wiki/log.md', 'Wiki/关系/relationships.md'];

export interface KnowledgeWipeResult {
  fileCount: number;
  reportCount: number;
  jobCount: number;
  ingestRunCount: number;
}

export interface AiLogWipeResult {
  fileCount: number;
  relationCount: number;
}

function clearDirectory(relPath: string): number {
  const root = safeJoin(relPath);
  if (!fs.existsSync(root)) return 0;

  let fileCount = 0;
  const removeEntries = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        removeEntries(abs);
        fs.rmdirSync(abs);
      } else {
        fs.unlinkSync(abs);
        fileCount++;
      }
    }
  };
  removeEntries(root);
  return fileCount;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(',');
}

function currentStamp(): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = new Date();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function clearStaleSystemPageIndexes() {
  const rows = db
    .prepare(
      `SELECT id FROM pages
       WHERE deleted = 0 AND path IN (${placeholders(SYSTEM_PAGE_PATHS)})`
    )
    .all(...SYSTEM_PAGE_PATHS) as { id: string }[];
  if (!rows.length) return;
  const ids = rows.map((row) => row.id);
  const ph = placeholders(ids);
  const clearIndexes = db.transaction(() => {
    db.prepare(
      `DELETE FROM vec_chunks WHERE rowid IN (
         SELECT id FROM chunks WHERE ref_type = 'page' AND ref_id IN (${ph})
       )`
    ).run(...ids);
    db.prepare(`DELETE FROM chunks WHERE ref_type = 'page' AND ref_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM edges WHERE src_page IN (${ph})`).run(...ids);
  });
  clearIndexes();
}

/** 清除知识正文及其所有派生数据库状态，保留配置、认证、MCP Token、系统日志和回收站。 */
export async function wipeKnowledgeData(): Promise<KnowledgeWipeResult> {
  let fileCount = 0;
  for (const relPath of KNOWLEDGE_DIRS) fileCount += clearDirectory(relPath);
  fileCount += clearDirectory('.history/office');
  ensureDirs();

  let reportCount = 0;
  let jobCount = 0;
  let ingestRunCount = 0;
  const clearDb = db.transaction(() => {
    db.prepare(`DELETE FROM vec_chunks`).run();
    db.prepare(`DELETE FROM chunks`).run();
    db.prepare(`DELETE FROM index_states`).run();
    db.prepare(`DELETE FROM edges`).run();
    db.prepare(`DELETE FROM entities`).run();
    reportCount = db.prepare(`DELETE FROM reports`).run().changes;
    jobCount = db.prepare(`DELETE FROM jobs`).run().changes;
    db.prepare(`DELETE FROM ingest_questions`).run();
    db.prepare(`DELETE FROM ingest_candidates`).run();
    db.prepare(`DELETE FROM semantic_events`).run();
    db.prepare(`DELETE FROM semantic_cache`).run();
    db.prepare(`DELETE FROM llm_usage`).run();
    db.prepare(`DELETE FROM page_syntheses`).run();
    db.prepare(`DELETE FROM page_contributions`).run();
    db.prepare(`DELETE FROM ingest_facts`).run();
    db.prepare(`DELETE FROM ingest_audit`).run();
    db.prepare(`DELETE FROM ingest_history_hidden`).run();
    ingestRunCount = db.prepare(`DELETE FROM ingest_runs`).run().changes;
    db.prepare(`DELETE FROM source_versions`).run();
    db.prepare(`DELETE FROM ingest_log`).run();
    db.prepare(`DELETE FROM office_edit_sessions`).run();
    db.prepare(`DELETE FROM office_versions`).run();
    db.prepare(`DELETE FROM files`).run();
    db.prepare(`DELETE FROM pages_fts`).run();
    db.prepare(`DELETE FROM files_fts`).run();
    db.prepare(
      `DELETE FROM pages
       WHERE path LIKE '原始资料/%'
          OR path LIKE 'Wiki/概念/%'
          OR path LIKE 'Wiki/实体/%'
          OR path LIKE 'Wiki/归档/%'
          OR path LIKE 'Wiki/查询/%'`
    ).run();
    db.prepare(
      `DELETE FROM settings WHERE key IN (
         'dream_last_run','ingest_ledger_v2_migrated','ingest_candidate_ledger_migrated'
       )`
    ).run();
  });
  clearDb();
  invalidateGraphCache();

  regenerateIndex();
  regenerateRelationships();
  appendWikiLog(
    '清除',
    `一键清除 ${fileCount} 个文件、${reportCount} 条整理报告，已重置知识索引与入库记录`
  );

  try {
    await rebuildAll();
  } catch {
    // 系统页已由 writePage 刷新；重建失败不回滚已经完成的数据清理。
  }

  return { fileCount, reportCount, jobCount, ingestRunCount };
}

/** 清空 AI 日志、操作日志和六词表关系库，不删除知识正文。 */
export async function wipeAiLogsAndRelations(): Promise<AiLogWipeResult> {
  const fileCount = clearDirectory('AIWorks/log');
  const logIds = db.prepare(`SELECT id FROM pages WHERE path LIKE 'AIWorks/log/%'`).all() as {
    id: string;
  }[];
  let relationCount = 0;

  const clearDb = db.transaction(() => {
    if (logIds.length) {
      const ids = logIds.map((row) => row.id);
      const ph = placeholders(ids);
      db.prepare(
        `DELETE FROM vec_chunks WHERE rowid IN (
           SELECT id FROM chunks WHERE ref_type = 'page' AND ref_id IN (${ph})
         )`
      ).run(...ids);
      db.prepare(`DELETE FROM chunks WHERE ref_type = 'page' AND ref_id IN (${ph})`).run(...ids);
      db.prepare(`DELETE FROM pages_fts WHERE page_id IN (${ph})`).run(...ids);
      db.prepare(`DELETE FROM edges WHERE src_page IN (${ph}) OR dst_page IN (${ph})`).run(
        ...ids,
        ...ids
      );
      db.prepare(`DELETE FROM pages WHERE id IN (${ph})`).run(...ids);
    }

    const relationPh = placeholders(RELATION_WORDS);
    relationCount = db
      .prepare(`DELETE FROM edges WHERE rel IN (${relationPh})`)
      .run(...RELATION_WORDS).changes;
    db.prepare(`DELETE FROM llm_usage`).run();
    db.prepare(`DELETE FROM semantic_cache`).run();
    db.prepare(
      `DELETE FROM entities
       WHERE id NOT IN (SELECT DISTINCT entity_id FROM edges WHERE entity_id IS NOT NULL)`
    ).run();
  });
  clearDb();
  invalidateGraphCache();

  const details = [
    fileCount ? `清空 ${fileCount} 个残留 AI 日志文件` : '',
    relationCount ? `清空 ${relationCount} 条关系记录` : '',
  ].filter(Boolean);
  const resetLog = `# 操作日志\n\n- ${currentStamp()} 清除：重置操作日志与关系库${details.length ? `（${details.join('，')}）` : ''}\n`;
  writePage('Wiki/log.md', resetLog, { title: '操作日志', type: 'doc' });
  regenerateRelationships();
  regenerateIndex();
  clearStaleSystemPageIndexes();

  return { fileCount, relationCount };
}
