import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-cleanup-'));
process.env.DATA_DIR = temp;

let db: any;
let migrate: () => void;
let setSetting: (key: string, value: string) => void;
let ensureDirs: () => void;
let createPage: (dir: string, title: string) => any;
let writePage: (relPath: string, content: string, extra?: Record<string, any>) => any;
let readPage: (relPath: string) => any;
let safeJoin: (relPath: string) => string;
let indexPage: (pageId: string) => Promise<any>;
let regenerateRelationships: () => void;
let wipeKnowledgeData: () => Promise<any>;
let wipeAiLogsAndRelations: () => Promise<any>;

before(async () => {
  ({ db, migrate, setSetting } = await import('./db.js'));
  ({ ensureDirs } = await import('../config.js'));
  ({ createPage, writePage, readPage, safeJoin } = await import('./vault.js'));
  ({ indexPage } = await import('../pipeline/indexer.js'));
  ({ regenerateRelationships } = await import('../pipeline/indexFile.js'));
  ({ wipeKnowledgeData, wipeAiLogsAndRelations } = await import('./dataCleanup.js'));
  migrate();
});

beforeEach(() => {
  db.exec(`
    DELETE FROM vec_chunks;
    DELETE FROM chunks;
    DELETE FROM index_states;
    DELETE FROM edges;
    DELETE FROM entities;
    DELETE FROM reports;
    DELETE FROM jobs;
    DELETE FROM ingest_facts;
    DELETE FROM ingest_audit;
    DELETE FROM ingest_questions;
    DELETE FROM ingest_candidates;
    DELETE FROM semantic_events;
    DELETE FROM semantic_cache;
    DELETE FROM llm_usage;
    DELETE FROM page_syntheses;
    DELETE FROM page_contributions;
    DELETE FROM ingest_runs;
    DELETE FROM source_versions;
    DELETE FROM ingest_log;
    DELETE FROM office_edit_sessions;
    DELETE FROM office_versions;
    DELETE FROM pages_fts;
    DELETE FROM files_fts;
    DELETE FROM file_extraction_pages;
    DELETE FROM file_extractions;
    DELETE FROM pages;
    DELETE FROM files;
    DELETE FROM mcp_tokens;
    DELETE FROM settings;
  `);
  fs.rmSync(path.join(temp, 'brain'), { recursive: true, force: true });
  ensureDirs();
});

after(() => {
  try {
    db.close();
  } catch {
    /* noop */
  }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('one-click wipe removes reports, ingest history, queued jobs and nested source files', async () => {
  const source = createPage('Wiki/实体', '负责人');
  const target = createPage('Wiki/实体', '项目');
  db.prepare(
    `INSERT INTO edges(src_page, dst_page, rel, created_at) VALUES(?, ?, '主责', '2026-01-01')`
  ).run(source.id, target.id);
  regenerateRelationships();

  const nestedRaw = safeJoin('原始资料/对话/记录.md');
  fs.writeFileSync(nestedRaw, '# 记录\n', 'utf8');
  db.prepare(
    `INSERT INTO files(id, path, name, ext, size, text, updated_at, deleted)
     VALUES('raw-file', '原始资料/对话/记录.md', '记录.md', 'md', 9, '记录', '2026-01-01', 0)`
  ).run();
  db.prepare(
    `INSERT INTO file_extractions(file_id,source_hash,text_hash,status,page_count,updated_at)
     VALUES('raw-file','source-hash','text-hash','completed',1,'2026-01-01')`
  ).run();
  db.prepare(
    `INSERT INTO file_extraction_pages(file_id,page_number,method,status,text,updated_at)
     VALUES('raw-file',1,'ocr','completed','记录','2026-01-01')`
  ).run();
  db.prepare(
    `INSERT INTO reports(run_at, kind, payload, status, issue_key, fingerprint)
     VALUES('2026-01-01', 'deadlink', '{}', 'open', 'deadlink:a', 'fingerprint-a')`
  ).run();
  db.prepare(
    `INSERT INTO jobs(kind, payload, status, created_at) VALUES('ingest', '{}', 'pending', '2026-01-01')`
  ).run();
  db.prepare(
    `INSERT INTO ingest_runs(id, path, content_hash, status, started_at)
     VALUES('run-1', '原始资料/对话/记录.md', 'hash', 'completed', '2026-01-01')`
  ).run();
  db.prepare(
    `INSERT INTO ingest_facts(run_id, fact_id, statement, sources)
     VALUES('run-1', 'fact-1', '事实', '[]')`
  ).run();
  db.prepare(
    `INSERT INTO ingest_audit(run_id, stage, at, payload)
     VALUES('run-1', 'commit', '2026-01-01', '{}')`
  ).run();
  db.prepare(
    `INSERT INTO ingest_log(path, at, content_hash, status, run_id)
     VALUES('原始资料/对话/记录.md', '2026-01-01', 'hash', 'completed', 'run-1')`
  ).run();
  const officeHistory = safeJoin('.history/office/raw-file/version.docx');
  fs.mkdirSync(path.dirname(officeHistory), { recursive: true });
  fs.writeFileSync(officeHistory, 'history', 'utf8');
  db.prepare(
    `INSERT INTO office_versions(id, path, file_id, stored_path, size, sha256, reason, created_at)
     VALUES('version-1', '原始资料/对话/记录.md', 'raw-file',
            '.history/office/raw-file/version.docx', 7, 'hash', 'edit-session', '2026-01-01')`
  ).run();
  setSetting('dream_last_run', '2026-01-01T00:00:00.000Z');

  const result = await wipeKnowledgeData();

  assert.equal(result.fileCount, 4);
  assert.equal(result.reportCount, 1);
  assert.equal(result.jobCount, 1);
  assert.equal(result.ingestRunCount, 1);
  assert.equal(fs.existsSync(nestedRaw), false);
  assert.equal(fs.existsSync(officeHistory), false);
  assert.equal(fs.existsSync(safeJoin('原始资料/对话')), true);
  assert.equal(
    db.prepare(
      `SELECT count(*) n FROM pages
       WHERE path LIKE '原始资料/%'
          OR path LIKE 'Wiki/概念/%'
          OR path LIKE 'Wiki/实体/%'
          OR path LIKE 'Wiki/归档/%'
          OR path LIKE 'Wiki/查询/%'`
    ).get().n,
    0
  );
  for (const table of [
    'reports',
    'jobs',
    'ingest_facts',
    'ingest_audit',
    'ingest_questions',
    'ingest_candidates',
    'semantic_events',
    'semantic_cache',
    'llm_usage',
    'page_syntheses',
    'page_contributions',
    'ingest_runs',
    'source_versions',
    'ingest_log',
    'office_versions',
    'file_extractions',
    'file_extraction_pages',
    'edges',
    'entities',
  ]) {
    assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0, table);
  }
  assert.equal(
    db.prepare(`SELECT count(*) n FROM index_states WHERE ref_id IN (?, ?)`)
      .get(source.id, target.id).n,
    0,
  );
  assert.equal(
    db.prepare(`SELECT count(*) n FROM settings WHERE key = 'dream_last_run'`).get().n,
    0
  );
  assert.doesNotMatch(readPage('Wiki/关系/relationships.md').content, /\[\[负责人\]\]::主责::\[\[项目\]\]/);
  assert.match(readPage('Wiki/log.md').content, /1 条整理报告/);
});

test('AI log wipe removes typed relations while preserving knowledge pages and ordinary links', async () => {
  const source = createPage('Wiki/实体', '负责人');
  const target = createPage('Wiki/实体', '项目');
  writePage(
    source.path,
    '# 负责人\n\n[[负责人]]::主责::[[项目]]\n\n相关页面：[[项目]]\n',
    { type: 'person' }
  );
  await indexPage(source.id);
  regenerateRelationships();

  const aiLog = writePage('AIWorks/log/2026-01-01.md', '# Dream Cycle\n\n旧日志\n', {
    title: '旧日志',
    type: 'doc',
  });
  await indexPage(aiLog.id);

  assert.equal(db.prepare(`SELECT count(*) n FROM edges WHERE rel = '主责'`).get().n, 1);
  assert.ok(db.prepare(`SELECT count(*) n FROM edges WHERE rel = 'link' AND src_page = ?`).get(source.id).n > 0);
  assert.match(readPage('Wiki/关系/relationships.md').content, /\[\[负责人\]\]::主责::\[\[项目\]\]/);
  db.prepare(
    `INSERT INTO llm_usage(provider,model,operation,tag,prompt_tokens,created_at)
     VALUES('test','test','chat','cleanup-test',10,'2026-01-01')`
  ).run();

  const result = await wipeAiLogsAndRelations();

  assert.equal(result.fileCount, 1);
  assert.equal(result.relationCount, 1);
  assert.equal(db.prepare(`SELECT count(*) n FROM edges WHERE rel = '主责'`).get().n, 0);
  assert.ok(db.prepare(`SELECT count(*) n FROM edges WHERE rel = 'link' AND src_page = ?`).get(source.id).n > 0);
  assert.equal(db.prepare(`SELECT count(*) n FROM pages WHERE path LIKE 'AIWorks/log/%'`).get().n, 0);
  assert.equal(db.prepare(`SELECT count(*) n FROM llm_usage`).get().n, 0);
  assert.equal(db.prepare(`SELECT count(*) n FROM chunks WHERE ref_id = ?`).get(aiLog.id).n, 0);
  assert.equal(db.prepare(`SELECT count(*) n FROM pages WHERE id IN (?, ?)`).get(source.id, target.id).n, 2);
  assert.doesNotMatch(readPage('Wiki/关系/relationships.md').content, /\[\[负责人\]\]::主责::\[\[项目\]\]/);
  assert.match(readPage('Wiki/log.md').content, /重置操作日志与关系库/);
});
