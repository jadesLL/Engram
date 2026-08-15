import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs } from '../config.js';
import { RELATION_WORDS } from '../pipeline/extractor.js';
import { appendWikiLog, regenerateIndex, regenerateRelationships } from '../pipeline/indexFile.js';
import { rebuildAll } from '../pipeline/indexer.js';
import { db, ensureVecTable, getVecDim } from './db.js';
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

/** 是否在清除后立即全量重建索引；默认 true，HTTP 路由将其关掉以快速返回。 */
export interface WipeOptions {
  rebuild?: boolean;
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

/**
 * Better-sqlite3 的同步调用会独占 Node 主线程，大库清除期间无法响应 HTTP 健康探针。
 * 在每步删除之间让出一次事件循环，使探针等服务有机会被处理。
 */
const yieldEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * vec0 虚表（vec_chunks）与 FTS5 虚表（pages_fts/files_fts）不支持 `DELETE ... LIMIT`，
 * 且 vec0 逐行删除代价随表规模线性增长。DROP + 重建空表是清空它们最彻底、占比最低的方式。
 */
function dropVectorAndFtsTables() {
  db.exec('DROP TABLE IF EXISTS vec_chunks');
  ensureVecTable(getVecDim());
  db.exec('DROP TABLE IF EXISTS pages_fts');
  db.exec(
    `CREATE VIRTUAL TABLE pages_fts USING fts5(title, content, tags, page_id UNINDEXED, tokenize = 'unicode61')`
  );
  db.exec('DROP TABLE IF EXISTS files_fts');
  db.exec(
    `CREATE VIRTUAL TABLE files_fts USING fts5(name, content, file_id UNINDEXED, tokenize = 'unicode61')`
  );
}

/** chunks 是与知识页/文件一一对应的中间表，可能很大；分批删除并在批之间让出事件循环。 */
const CHUNK_DELETE_BATCH = 1000;

/**
 * 其余普通表，按子→父顺序排列，避免删除父表时触发外键级联（schema 中 foreign_keys = ON）。
 * files 放最后：此时已无 file_extractions/file_extraction_pages 子行产生级联删除。
 */
const TABLES_TO_WIPE = [
  'file_extraction_pages',
  'file_extractions',
  'ingest_questions',
  'ingest_candidates',
  'ingest_facts',
  'ingest_audit',
  'ingest_history_hidden',
  'source_versions',
  'semantic_events',
  'semantic_cache',
  'llm_usage',
  'page_syntheses',
  'page_contributions',
  'ingest_log',
  'office_edit_sessions',
  'office_versions',
  'index_states',
  'edges',
  'entities',
  'files',
] as const;

/** 清除知识正文及其所有派生数据库状态，保留配置、认证、MCP Token、系统日志和回收站。 */
export async function wipeKnowledgeData(options: WipeOptions = {}): Promise<KnowledgeWipeResult> {
  const { rebuild = true } = options;

  let fileCount = 0;
  for (const relPath of KNOWLEDGE_DIRS) fileCount += clearDirectory(relPath);
  fileCount += clearDirectory('.history/office');
  ensureDirs();
  await yieldEventLoop();

  // vec0/FTS5 虚表不支持 LIMIT 删除，直接 DROP 重建空表，规避随表规模线性增长的逐行删除。
  dropVectorAndFtsTables();
  await yieldEventLoop();

  // chunks 分批删除，每批之间让出事件循环。
  const deleteChunkBatch = db.prepare(
    `DELETE FROM chunks WHERE rowid IN (SELECT rowid FROM chunks LIMIT ${CHUNK_DELETE_BATCH})`
  );
  let changed = 0;
  do {
    changed = deleteChunkBatch.run().changes;
    if (changed > 0) await yieldEventLoop();
  } while (changed > 0);

  // 需要计数的表单独删除，保留 changes。
  const reportCount = db.prepare('DELETE FROM reports').run().changes;
  await yieldEventLoop();
  const jobCount = db.prepare('DELETE FROM jobs').run().changes;
  await yieldEventLoop();
  const ingestRunCount = db.prepare('DELETE FROM ingest_runs').run().changes;
  await yieldEventLoop();

  // 其余普通表逐表清空，表与表之间让出事件循环。
  for (const table of TABLES_TO_WIPE) {
    db.prepare(`DELETE FROM ${table}`).run();
    await yieldEventLoop();
  }

  // pages 表只清知识目录下的行（保留 AIWorks 系统区页面）。
  db.prepare(
    `DELETE FROM pages
     WHERE path LIKE '原始资料/%'
        OR path LIKE 'Wiki/概念/%'
        OR path LIKE 'Wiki/实体/%'
        OR path LIKE 'Wiki/归档/%'
        OR path LIKE 'Wiki/查询/%'`
  ).run();
  await yieldEventLoop();
  db.prepare(
    `DELETE FROM settings WHERE key IN (
       'dream_last_run','ingest_ledger_v2_migrated','ingest_candidate_ledger_migrated'
     )`
  ).run();

  invalidateGraphCache();
  regenerateIndex();
  regenerateRelationships();
  appendWikiLog(
    '清除',
    `一键清除 ${fileCount} 个文件、${reportCount} 条整理报告，已重置知识索引与入库记录`
  );

  if (rebuild) {
    try {
      await rebuildAll();
    } catch {
      // 系统页已由 writePage 刷新；重建失败不回滚已经完成的数据清理。
    }
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
    try { db.prepare(`DELETE FROM embedding_cache`).run(); } catch { /* 表可能尚未创建 */ }
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