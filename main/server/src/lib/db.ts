import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { DB_FILE, ensureDirs } from '../config.js';
import { deriveReportIdentity } from './reportIdentity.js';

ensureDirs();

export const db: Database.Database = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// sqlite-vec：Electron asar 打包下 load 内部 require.resolve 返回 app.asar 虚拟路径，
// better-sqlite3 的 loadExtension 直接走 native dlopen 不经 asar fs 转换会失败；
// 转成 app.asar.unpacked 真实路径。非 asar 环境（Docker/dev）路径不含 app.asar，原样工作。
{
  let vecPath = (sqliteVec as any).getLoadablePath() as string;
  if (vecPath.includes('app.asar') && !vecPath.includes('app.asar.unpacked')) {
    vecPath = vecPath.replace(/app\.asar([\\/])/g, 'app.asar.unpacked$1');
  }
  db.loadExtension(vecPath);
}

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

  CREATE TABLE IF NOT EXISTS file_extractions (
    file_id TEXT PRIMARY KEY,
    source_hash TEXT NOT NULL DEFAULT '',
    text_hash TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    method TEXT NOT NULL DEFAULT '',
    page_count INTEGER NOT NULL DEFAULT 0,
    extracted_pages INTEGER NOT NULL DEFAULT 0,
    ocr_pages INTEGER NOT NULL DEFAULT 0,
    skipped_pages INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_file_extractions_status
    ON file_extractions(status, updated_at DESC);

  CREATE TABLE IF NOT EXISTS file_extraction_pages (
    file_id TEXT NOT NULL,
    page_number INTEGER NOT NULL,
    method TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    text TEXT NOT NULL DEFAULT '',
    error TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(file_id, page_number),
    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_file_extraction_pages_status
    ON file_extraction_pages(file_id, status, page_number);

  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref_type TEXT NOT NULL,          -- 'page' | 'file'
    ref_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    heading TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chunks_ref ON chunks(ref_type, ref_id);

  CREATE TABLE IF NOT EXISTS index_states (
    ref_type TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    model_key TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(ref_type, ref_id)
  );

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

  -- 桌面端远端连接令牌：远端服务器签发，桌面端凭 token 免密兑换 JWT cookie
  CREATE TABLE IF NOT EXISTS desktop_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL DEFAULT 'default',
    created_at TEXT NOT NULL,
    expires_at TEXT,
    revoked INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT
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

  CREATE TABLE IF NOT EXISTS ingest_history_hidden (
    run_id TEXT PRIMARY KEY,
    hidden_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES ingest_runs(id) ON DELETE CASCADE
  );

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

  CREATE TABLE IF NOT EXISTS llm_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    operation TEXT NOT NULL DEFAULT 'chat',
    tag TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT '',
    ref_id TEXT NOT NULL DEFAULT '',
    stage TEXT NOT NULL DEFAULT '',
    prefix_hash TEXT NOT NULL DEFAULT '',
    history_messages INTEGER NOT NULL DEFAULT 0,
    prompt_version TEXT NOT NULL DEFAULT '',
    cache_scope TEXT NOT NULL DEFAULT '',
    dependency_hash TEXT NOT NULL DEFAULT '',
    result_cache_hit INTEGER NOT NULL DEFAULT 0,
    retry_reason TEXT NOT NULL DEFAULT '',
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
    cache_reported INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    raw_usage TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_llm_usage_created
    ON llm_usage(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_llm_usage_tag
    ON llm_usage(tag, created_at DESC);

  CREATE TABLE IF NOT EXISTS semantic_cache (
    cache_key TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    stage TEXT NOT NULL,
    model_key TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    dependency_hash TEXT NOT NULL DEFAULT '',
    output TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    hits INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_semantic_cache_used
    ON semantic_cache(last_used_at DESC);

  CREATE TABLE IF NOT EXISTS embedding_cache (
    text_hash TEXT NOT NULL,
    model_key TEXT NOT NULL,
    embedding BLOB NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    PRIMARY KEY (text_hash, model_key)
  );
  CREATE INDEX IF NOT EXISTS idx_embedding_cache_used ON embedding_cache(last_used_at DESC);

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

  CREATE TABLE IF NOT EXISTS assistant_artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    tool_call_id TEXT,
    kind TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES assistant_runs(id) ON DELETE CASCADE,
    FOREIGN KEY(tool_call_id) REFERENCES assistant_tool_calls(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_assistant_artifacts_run
    ON assistant_artifacts(run_id, created_at);

  CREATE TABLE IF NOT EXISTS im_sessions (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(platform, chat_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_im_sessions_lookup
    ON im_sessions(platform, chat_id, user_id);

  -- 模型配置条目（chat/embedding/document 三池），取代 settings 表里的 JSON 大字段；
  -- 读取与迁移逻辑见 modelConfig.ts
  CREATE TABLE IF NOT EXISTS model_entries (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,               -- 'chat' | 'embedding' | 'document'
    name TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT 'custom',
    line TEXT,
    base_url TEXT NOT NULL DEFAULT '',
    models_url TEXT,
    logo TEXT,
    model TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL DEFAULT '',
    protocol TEXT NOT NULL DEFAULT 'openai',  -- 'openai' | 'anthropic'
    thinking_level TEXT,             -- 用户选择：'low' | 'high' | 'max'
    dim INTEGER,
    supports_dimensions INTEGER NOT NULL DEFAULT 0,
    image_input TEXT,
    image_input_source TEXT,
    image_input_checked_at TEXT,
    dialect TEXT NOT NULL DEFAULT '{}',       -- 供应商参数降级记忆 JSON
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_model_entries_kind
    ON model_entries(kind, sort_order);
  `);

  // model_entries 增量列（1.1.17：跨协议模型列表/免鉴权线路标志；存量库补列，新库由上方 DDL 含 models_protocol 等列时也不会重复）
  ensureColumn('model_entries', 'models_protocol', 'TEXT');
  ensureColumn('model_entries', 'auth_optional', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('model_entries', 'models_anonymous', 'INTEGER NOT NULL DEFAULT 0');
  // 1.1.18：思考等级（GLM reasoning_effort 档位，空=自动）
  ensureColumn('model_entries', 'thinking_level', 'TEXT');
  ensureColumn('ingest_log', 'content_hash', 'TEXT');
  ensureColumn('ingest_log', 'status', `TEXT NOT NULL DEFAULT 'completed'`);
  ensureColumn('ingest_log', 'run_id', 'TEXT');
  ensureColumn('ingest_log', 'error', 'TEXT');
  ensureColumn('ingest_runs', 'source_version_id', 'TEXT');
  ensureColumn('ingest_runs', 'commit_status', `TEXT NOT NULL DEFAULT 'pending'`);
  ensureColumn('ingest_runs', 'derived_status', `TEXT NOT NULL DEFAULT 'pending'`);
  ensureColumn('ingest_runs', 'input_signature', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn('ingest_runs', 'llm_prompt_tokens', `INTEGER NOT NULL DEFAULT 0`);
  ensureColumn('ingest_questions', 'job_id', 'INTEGER');
  ensureColumn('ingest_questions', 'error', 'TEXT');
  ensureColumn('assistant_sessions', 'chat_anchor_id', 'TEXT');
  ensureColumn('ingest_candidates', 'evidence_eligible', `INTEGER NOT NULL DEFAULT 0`);
  ensureColumn('semantic_events', 'status', `TEXT NOT NULL DEFAULT 'succeeded'`);
  ensureColumn('semantic_events', 'error', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn('semantic_events', 'duration_ms', `INTEGER NOT NULL DEFAULT 0`);
  ensureColumn('llm_usage', 'scope', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn('llm_usage', 'ref_id', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn('llm_usage', 'stage', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn('llm_usage', 'prefix_hash', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn('llm_usage', 'history_messages', `INTEGER NOT NULL DEFAULT 0`);
  ensureColumn('llm_usage', 'prompt_version', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn('llm_usage', 'cache_scope', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn('llm_usage', 'dependency_hash', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn('llm_usage', 'result_cache_hit', `INTEGER NOT NULL DEFAULT 0`);
  ensureColumn('llm_usage', 'retry_reason', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn('semantic_cache', 'prompt_tokens', `INTEGER NOT NULL DEFAULT 0`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_llm_usage_ref
     ON llm_usage(scope, ref_id, stage, created_at DESC)`
  );
  ensureColumn('jobs', 'stage', `TEXT NOT NULL DEFAULT '等待执行'`);
  ensureColumn('jobs', 'progress', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('jobs', 'detail', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn('jobs', 'updated_at', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn('jobs', 'cancel_requested', `INTEGER NOT NULL DEFAULT 0`);
  ensureColumn('jobs', 'run_token', `TEXT NOT NULL DEFAULT ''`);
  // 多端同步：本端已知的每页 hub 版本号（仅 hub 上必然等于当前版本；节点上是最后已知值）
  ensureColumn('pages', 'sync_revision', 'INTEGER NOT NULL DEFAULT 0');
  // jobs 表 status 索引：job runner 每秒 tick 查 WHERE status='pending'/'running'，
  // 无索引时全表扫描；大量 failed/done 行积累后拖慢 DB、争用磁盘 I/O 致事件循环间歇阻塞。
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_kind_status ON jobs(kind, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_run_token ON jobs(run_token)`);
  ensureColumn('reports', 'issue_key', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn('reports', 'fingerprint', `TEXT NOT NULL DEFAULT ''`);
  backfillReportIdentity();
  normalizeIdentityAmbiguityPairs();
  closeStaleIdentityAmbiguityReports();
  dedupeReportIdentity();
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reports_issue ON reports(kind, issue_key)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_fingerprint ON reports(kind, issue_key, fingerprint)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ingest_questions_job ON ingest_questions(job_id)`);
  db.prepare(
    `UPDATE jobs SET updated_at = COALESCE(NULLIF(updated_at, ''), run_at, created_at)
     WHERE updated_at = ''`
  ).run();
  db.prepare(
    `UPDATE assistant_runs
     SET status = 'interrupted',
         error = COALESCE(error, '服务重启导致运行中断，可安全重试'),
         updated_at = ?
     WHERE status IN ('queued', 'running', 'executing')`
  ).run(now());
  });
  migrateSchema();
  const usageCutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`DELETE FROM llm_usage WHERE created_at < ?`).run(usageCutoff);
  const semanticCacheCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`DELETE FROM semantic_cache WHERE last_used_at < ?`).run(semanticCacheCutoff);
  db.prepare(
    `DELETE FROM semantic_cache WHERE cache_key IN (
       SELECT cache_key FROM semantic_cache ORDER BY last_used_at DESC LIMIT -1 OFFSET 5000
     )`
  ).run();
  const embeddingCacheCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`DELETE FROM embedding_cache WHERE last_used_at < ?`).run(embeddingCacheCutoff);
  db.prepare(
    `DELETE FROM embedding_cache WHERE rowid IN (
       SELECT rowid FROM embedding_cache ORDER BY last_used_at DESC LIMIT -1 OFFSET 10000
     )`
  ).run();

  // ---------- 多端同步 ----------
  // hub 全局变更日志：成员按 seq 游标拉增量；定期裁剪，落后过多走全量对账
  db.prepare(`CREATE TABLE IF NOT EXISTS sync_oplog (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    old_path TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 0,
    node_id TEXT NOT NULL DEFAULT '',
    ts TEXT NOT NULL
  )`).run();
  // 每页版本快照（保留最近 10 版）：三方合并的祖先来源
  db.prepare(`CREATE TABLE IF NOT EXISTS page_revisions (
    path TEXT NOT NULL,
    revision INTEGER NOT NULL,
    content TEXT NOT NULL,
    node_id TEXT NOT NULL DEFAULT '',
    ts TEXT NOT NULL,
    PRIMARY KEY(path, revision)
  )`).run();
  // 同步群组成员（中枢端）：为每个成员设备命名并签发专属 token
  db.prepare(`CREATE TABLE IF NOT EXISTS sync_peers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    node_label TEXT NOT NULL DEFAULT '',
    last_seen_at TEXT,
    last_seq INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`).run();

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

/**
 * 存量 identity_ambiguity 报告按页面对归一:旧 issueKey 只含歧义页自身 id,
 * A→B 与 B→A 会各留一条。按新算法重算后,同一对只保留最早一条,其余删除
 * (归档页上的旧镜像不再有意义);迁移后 dedupeReportIdentity 兜底去重。
 */
function normalizeIdentityAmbiguityPairs() {
  const rows = db.prepare(
    `SELECT id, payload FROM reports WHERE kind = 'identity_ambiguity'`
  ).all() as { id: number; payload: string }[];
  if (!rows.length) return;
  const update = db.prepare(`UPDATE reports SET issue_key = ?, fingerprint = ? WHERE id = ?`);
  const remove = db.prepare(`DELETE FROM reports WHERE id = ?`);
  const byIssue = new Map<string, { id: number; fingerprint: string }[]>();
  for (const row of rows) {
    let payload: Record<string, any> = {};
    try { payload = JSON.parse(row.payload); } catch { /* keep row as-is */ }
    const identity = deriveReportIdentity('identity_ambiguity', payload);
    const key = identity.issueKey || `identity_ambiguity:${row.id}`;
    const entry = { id: row.id, fingerprint: identity.fingerprint };
    const list = byIssue.get(key);
    if (list) list.push(entry);
    else byIssue.set(key, [entry]);
  }
  for (const [key, entries] of byIssue) {
    // 保留最早一条(时间序最自然),镜像删除;先删后更避开唯一索引冲突
    entries.sort((a, b) => a.id - b.id);
    entries.slice(1).forEach((entry) => remove.run(entry.id));
    update.run(key, entries[0].fingerprint, entries[0].id);
  }
}

/**
 * 清扫陈旧歧义报告:open 的 identity_ambiguity 若涉页(歧义页或建议目标页)
 * 已不是活跃知识页(被合并归档/删除),继续挂着只会与死链等报告互相矛盾,
 * 统一标 dismissed(dismissed 可重开,误关有救济)。启动迁移与身份扫描前调用。
 */
export function closeStaleIdentityAmbiguityReports(): number {
  const rows = db.prepare(
    `SELECT id, payload FROM reports WHERE kind = 'identity_ambiguity' AND status = 'open'`
  ).all() as { id: number; payload: string }[];
  if (!rows.length) return 0;
  const activePage = db.prepare(
    `SELECT 1 FROM pages WHERE id = ? AND deleted = 0
       AND (path LIKE 'Wiki/概念/%' OR path LIKE 'Wiki/实体/%') LIMIT 1`
  );
  const close = db.prepare(
    `UPDATE reports SET status = 'dismissed' WHERE id = ? AND status = 'open'`
  );
  let closed = 0;
  for (const row of rows) {
    let payload: Record<string, any> = {};
    try { payload = JSON.parse(row.payload); } catch { continue; }
    const pageId = String(payload.pageId || '');
    const targetId = String(payload.suggestedTargetId || '');
    const pageActive = pageId && activePage.get(pageId);
    const targetActive = !targetId || activePage.get(targetId);
    if (!pageActive || !targetActive) {
      close.run(row.id);
      closed++;
    }
  }
  return closed;
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
