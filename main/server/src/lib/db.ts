import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { DB_FILE, ensureDirs } from '../config.js';
import { deriveReportIdentity } from '../dream/reportIdentity.js';

ensureDirs();

export const db: Database.Database = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
sqliteVec.load(db);

/** 当前向量维度（随 embedding 模型配置变化；变化时需重建 vec 表与索引） */
export function getVecDim(): number {
  let row: { value: string } | undefined;
  try {
    row = db.prepare(`SELECT value FROM settings WHERE key = 'embedding_dim'`).get() as { value: string } | undefined;
  } catch (error: any) {
    if (String(error?.message || error).includes('no such table: settings')) return 1536;
    throw error;
  }
  const dim = Number(row?.value);
  return Number.isInteger(dim) && dim > 0 ? dim : 1536;
}

export function migrate() {
  const migrateSchema = db.transaction(() => {
    db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'note',
    tags TEXT NOT NULL DEFAULT '[]',
    summary TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    word_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
    title, content, tags, page_id UNINDEXED, tokenize = 'unicode61'
  );

  -- 非 md 文件（docx/pdf/...），文本被提取后参与索引
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    ext TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
    name, content, file_id UNINDEXED, tokenize = 'unicode61'
  );

  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref_type TEXT NOT NULL,          -- 'page' | 'file'
    ref_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    heading TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chunks_ref ON chunks(ref_type, ref_id);

  CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL DEFAULT 'concept'
  );

  CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    src_page TEXT NOT NULL,          -- page id
    dst_page TEXT,                   -- 已解析的 wikilink 目标 page id
    dst_title TEXT,                  -- 未解析的 wikilink 目标标题（死链）
    entity_id INTEGER,               -- LLM 抽取的实体
    rel TEXT NOT NULL,               -- 'link' | 'tag' | 类型化关系
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_page);
  CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_page);

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at TEXT NOT NULL,
    kind TEXT NOT NULL,              -- duplicate|deadlink|contradiction|enrich|stale
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open'   -- open|resolved|dismissed
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,              -- embed|extract|summarize|index_file
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    created_at TEXT NOT NULL,
    run_at TEXT
  );

  CREATE TABLE IF NOT EXISTS mcp_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL DEFAULT 'default',
    created_at TEXT NOT NULL
  );

  -- 原始资料消化记录（保留旧 API 的 at 字段，并增加内容幂等状态）
  CREATE TABLE IF NOT EXISTS ingest_log (
    path TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    content_hash TEXT,
    status TEXT NOT NULL DEFAULT 'completed',
    run_id TEXT,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS ingest_runs (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source_version_id TEXT,
    status TEXT NOT NULL,
    commit_status TEXT NOT NULL DEFAULT 'pending',
    derived_status TEXT NOT NULL DEFAULT 'pending',
    started_at TEXT NOT NULL,
    finished_at TEXT,
    stats TEXT NOT NULL DEFAULT '{}',
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ingest_runs_path ON ingest_runs(path, started_at DESC);

  CREATE TABLE IF NOT EXISTS ingest_facts (
    run_id TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    statement TEXT NOT NULL,
    sources TEXT NOT NULL,
    PRIMARY KEY(run_id, fact_id),
    FOREIGN KEY(run_id) REFERENCES ingest_runs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ingest_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    at TEXT NOT NULL,
    input_hash TEXT,
    payload TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES ingest_runs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_ingest_audit_run ON ingest_audit(run_id, id);

  CREATE TABLE IF NOT EXISTS source_versions (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    previous_id TEXT,
    status TEXT NOT NULL DEFAULT 'processing',
    created_at TEXT NOT NULL,
    activated_at TEXT,
    error TEXT,
    UNIQUE(path, content_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_source_versions_path ON source_versions(path, created_at DESC);

  CREATE TABLE IF NOT EXISTS page_contributions (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    source_version_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    contribution_key TEXT NOT NULL,
    fact_ids TEXT NOT NULL DEFAULT '[]',
    relations TEXT NOT NULL DEFAULT '[]',
    content TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    domain TEXT NOT NULL DEFAULT '',
    confidence TEXT NOT NULL DEFAULT '中',
    source_ref TEXT NOT NULL DEFAULT '',
    managed INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(page_id, source_version_id),
    FOREIGN KEY(page_id) REFERENCES pages(id) ON DELETE CASCADE,
    FOREIGN KEY(source_version_id) REFERENCES source_versions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_page_contributions_page ON page_contributions(page_id, active);
  CREATE INDEX IF NOT EXISTS idx_page_contributions_source ON page_contributions(source_version_id, active);

  CREATE TABLE IF NOT EXISTS page_syntheses (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    evidence_hash TEXT NOT NULL,
    trigger_run_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    summary TEXT NOT NULL DEFAULT '',
    domain TEXT NOT NULL DEFAULT '',
    confidence TEXT NOT NULL DEFAULT '中',
    current_content TEXT NOT NULL DEFAULT '',
    related_content TEXT NOT NULL DEFAULT '',
    timeline_content TEXT NOT NULL DEFAULT '',
    evidence_map TEXT NOT NULL DEFAULT '{}',
    source_version_ids TEXT NOT NULL DEFAULT '[]',
    manual_changed INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(page_id, input_hash),
    FOREIGN KEY(page_id) REFERENCES pages(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_page_syntheses_page
    ON page_syntheses(page_id, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_page_syntheses_run
    ON page_syntheses(trigger_run_id, status);

  CREATE TABLE IF NOT EXISTS ingest_questions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    source_version_id TEXT,
    path TEXT NOT NULL,
    question TEXT NOT NULL,
    fact_ids TEXT NOT NULL DEFAULT '[]',
    acceptance TEXT NOT NULL DEFAULT '[]',
    answer TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    job_id INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES ingest_runs(id) ON DELETE CASCADE,
    FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ingest_questions_path ON ingest_questions(path, status, created_at DESC);

  CREATE TABLE IF NOT EXISTS ingest_candidates (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    source_version_id TEXT,
    source_path TEXT NOT NULL,
    source_name TEXT NOT NULL DEFAULT '',
    normalized_name TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT '',
    confidence TEXT NOT NULL DEFAULT '中',
    summary TEXT NOT NULL DEFAULT '',
    fact_ids TEXT NOT NULL DEFAULT '[]',
    relations TEXT NOT NULL DEFAULT '[]',
    content TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    evidence_eligible INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    target_page_id TEXT,
    preview_token TEXT,
    preview_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(run_id, normalized_name, kind),
    FOREIGN KEY(run_id) REFERENCES ingest_runs(id) ON DELETE CASCADE,
    FOREIGN KEY(source_version_id) REFERENCES source_versions(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ingest_candidates_identity
    ON ingest_candidates(normalized_name, kind, status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ingest_candidates_source
    ON ingest_candidates(source_path, source_version_id, status);

  CREATE TABLE IF NOT EXISTS semantic_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    ref_id TEXT NOT NULL DEFAULT '',
    stage TEXT NOT NULL,
    model_tag TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'succeeded',
    output TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_semantic_events_ref
    ON semantic_events(scope, ref_id, stage, created_at DESC);

  CREATE TABLE IF NOT EXISTS office_edit_sessions (
    document_key TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    base_hash TEXT NOT NULL,
    version_id TEXT,
    status TEXT NOT NULL DEFAULT 'editing',
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_office_sessions_path ON office_edit_sessions(path, updated_at DESC);

  CREATE TABLE IF NOT EXISTS office_versions (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    file_id TEXT NOT NULL,
    stored_path TEXT UNIQUE NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    reason TEXT NOT NULL,
    session_key TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_office_versions_path ON office_versions(path, created_at DESC);

  CREATE TABLE IF NOT EXISTS assistant_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_assistant_sessions_updated
    ON assistant_sessions(archived, updated_at DESC);

  CREATE TABLE IF NOT EXISTS assistant_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    run_id TEXT,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES assistant_sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_assistant_messages_session
    ON assistant_messages(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_assistant_messages_run
    ON assistant_messages(run_id, created_at);

  CREATE TABLE IF NOT EXISTS assistant_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    user_message_id TEXT NOT NULL,
    assistant_message_id TEXT,
    status TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '{}',
    step_count INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    ingested_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY(session_id) REFERENCES assistant_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY(user_message_id) REFERENCES assistant_messages(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_assistant_runs_session
    ON assistant_runs(session_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_assistant_runs_status
    ON assistant_runs(status, updated_at);

  CREATE TABLE IF NOT EXISTS assistant_tool_calls (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    name TEXT NOT NULL,
    arguments TEXT NOT NULL DEFAULT '{}',
    risk TEXT NOT NULL,
    status TEXT NOT NULL,
    preview TEXT NOT NULL DEFAULT '{}',
    result TEXT NOT NULL DEFAULT '{}',
    undo TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES assistant_runs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_assistant_tool_calls_run
    ON assistant_tool_calls(run_id, created_at);
  `);

  ensureColumn('ingest_log', 'content_hash', 'TEXT');
  ensureColumn('ingest_log', 'status', `TEXT NOT NULL DEFAULT 'completed'`);
  ensureColumn('ingest_log', 'run_id', 'TEXT');
  ensureColumn('ingest_log', 'error', 'TEXT');
  ensureColumn('ingest_runs', 'source_version_id', 'TEXT');
  ensureColumn('ingest_runs', 'commit_status', `TEXT NOT NULL DEFAULT 'pending'`);
  ensureColumn('ingest_runs', 'derived_status', `TEXT NOT NULL DEFAULT 'pending'`);
  ensureColumn('ingest_questions', 'job_id', 'INTEGER');
  ensureColumn('ingest_questions', 'error', 'TEXT');
  ensureColumn('ingest_candidates', 'evidence_eligible', `INTEGER NOT NULL DEFAULT 0`);
  ensureColumn('semantic_events', 'status', `TEXT NOT NULL DEFAULT 'succeeded'`);
  ensureColumn('semantic_events', 'error', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn('semantic_events', 'duration_ms', `INTEGER NOT NULL DEFAULT 0`);
  ensureColumn('jobs', 'stage', `TEXT NOT NULL DEFAULT '等待执行'`);
  ensureColumn('jobs', 'progress', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('jobs', 'detail', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn('reports', 'issue_key', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn('reports', 'fingerprint', `TEXT NOT NULL DEFAULT ''`);
  backfillReportIdentity();
  dedupeReportIdentity();
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reports_issue ON reports(kind, issue_key)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_fingerprint ON reports(kind, issue_key, fingerprint)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ingest_questions_job ON ingest_questions(job_id)`);
  db.prepare(
    `UPDATE assistant_runs
     SET status = 'interrupted',
         error = COALESCE(error, '服务重启导致运行中断，可安全重试'),
         updated_at = ?
     WHERE status IN ('queued', 'running', 'executing')`
  ).run(now());
  });
  migrateSchema();

  ensureVecTable(getVecDim());
}

function dedupeReportIdentity() {
  const duplicates = db.prepare(
    `SELECT kind, issue_key, fingerprint, GROUP_CONCAT(id) ids
     FROM reports WHERE issue_key != '' AND fingerprint != ''
     GROUP BY kind, issue_key, fingerprint HAVING COUNT(*) > 1`
  ).all() as { ids: string }[];
  const remove = db.prepare(`DELETE FROM reports WHERE id = ?`);
  for (const duplicate of duplicates) {
    const ids = duplicate.ids.split(',').map(Number).sort((a, b) => b - a);
    ids.slice(1).forEach((id) => remove.run(id));
  }
}

function backfillReportIdentity() {
  const rows = db.prepare(
    `SELECT id, kind, payload FROM reports WHERE issue_key = '' OR fingerprint = ''`
  ).all() as { id: number; kind: string; payload: string }[];
  if (!rows.length) return;
  const update = db.prepare(`UPDATE reports SET issue_key = ?, fingerprint = ? WHERE id = ?`);
  for (const row of rows) {
    let payload: Record<string, any> = {};
    try { payload = JSON.parse(row.payload); } catch { /* retain fallback identity */ }
    const identity = deriveReportIdentity(row.kind, payload);
    update.run(identity.issueKey || `${row.kind}:${row.id}`, identity.fingerprint, row.id);
  }
}

function ensureColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((entry) => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/** 创建/校验 vec0 虚表；维度变化时重建（调用方负责重建索引） */
export function ensureVecTable(dim: number) {
  if (!Number.isInteger(dim) || dim <= 0 || dim > 65536) throw new Error(`无效的 embedding 维度：${dim}`);
  const existing = db
    .prepare(`SELECT sql FROM sqlite_master WHERE name = 'vec_chunks' AND type = 'table'`)
    .get() as { sql: string } | undefined;
  if (existing) {
    const m = existing.sql.match(/float\[(\d+)\]/);
    if (m && Number(m[1]) !== dim) {
      db.exec(`DROP TABLE vec_chunks`);
      db.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[${dim}])`);
    }
    return;
  }
  db.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[${dim}])`);
}

// ---------- settings helpers ----------
export function getSetting(key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string) {
  db.prepare(
    `INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

export function now(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return crypto.randomUUID();
}
