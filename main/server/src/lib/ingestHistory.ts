import { db } from './db.js';

export type IngestTraceStatus = 'completed' | 'current' | 'failed' | 'pending';

export interface IngestRunRecord {
  id: string;
  path: string;
  content_hash: string;
  source_version_id?: string | null;
  status: string;
  commit_status: string;
  derived_status: string;
  started_at: string;
  finished_at?: string | null;
  stats: string | Record<string, unknown>;
  error?: string | null;
  llm_prompt_tokens?: number;
}

export interface IngestAuditRecord {
  id: number;
  stage: string;
  at: string;
  input_hash?: string | null;
  payload?: unknown;
}

export interface SemanticEventRecord {
  id: number;
  stage: string;
  model_tag: string;
  status: string;
  output?: string;
  error?: string;
  duration_ms?: number;
  created_at: string;
}

export interface IngestTraceStage {
  id: string;
  label: string;
  description: string;
  status: IngestTraceStatus;
  eventCount: number;
  durationMs: number;
  startedAt: string | null;
  finishedAt: string | null;
}

const TRACE_DEFINITIONS = [
  { id: 'parse', label: '解析', description: '读取原始笔记并建立来源版本。' },
  { id: 'map', label: 'Map', description: '分段扫描笔记，提取候选实体、概念与事实。' },
  { id: 'normalize', label: 'Normalize', description: '合并重复候选并校验来源引文。' },
  { id: 'retrieve', label: 'Retrieve', description: '检索知识库中可用于判断的相关页面。' },
  { id: 'plan', label: 'Plan', description: '决定新建、合并、跳过或转人工审核。' },
  { id: 'critic', label: 'Critic 1', description: '首次审查计划覆盖度、证据和冲突。' },
  { id: 'critic_review', label: 'Critic 2', description: '根据首次审查结果修订并复核计划。' },
  { id: 'compose', label: 'Compose', description: '基于已核实事实生成页面贡献内容。' },
  { id: 'questions', label: 'Questions', description: '识别仍需用户确认的歧义和缺口。' },
  { id: 'verify', label: 'Verify', description: '逐项验证正文是否被事实和引文支持。' },
  { id: 'commit', label: 'Commit', description: '提交事实、页面贡献、追问和最终统计。' },
] as const;

function parseJson(value: unknown, fallback: any = null): any {
  if (typeof value !== 'string') return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function baseStage(stage: string): string {
  return stage.replace(/^ingest-/, '').split(':')[0];
}

function traceStageId(stage: string): string | null {
  const base = baseStage(stage);
  if (base === 'map' || base === 'map_split' || base === 'map_failed') return 'map';
  if (base === 'normalize') return 'normalize';
  if (base === 'retrieve') return 'retrieve';
  if (base === 'plan') return 'plan';
  if (base === 'critic') return 'critic';
  if (base === 'critic_review') return 'critic_review';
  if (base === 'compose') return 'compose';
  if (base === 'questions') return 'questions';
  if (base === 'verify') return 'verify';
  if (base === 'commit') return 'commit';
  return null;
}

function completedStages(run: IngestRunRecord, audit: IngestAuditRecord[]): Set<string> {
  if (run.status === 'completed') {
    return new Set(TRACE_DEFINITIONS.map((stage) => stage.id));
  }
  const exact = new Set(audit.map((event) => event.stage));
  const completed = new Set<string>();
  if (audit.length || run.status !== 'failed') completed.add('parse');
  for (const id of ['map', 'normalize', 'retrieve', 'plan', 'critic_review', 'compose', 'questions', 'verify', 'commit']) {
    if (exact.has(id)) completed.add(id);
  }
  if (
    [...exact].some((stage) => stage.startsWith('critic_review:')) ||
    exact.has('critic_review')
  ) {
    completed.add('critic');
  }
  return completed;
}

function eventTimes(events: Array<{ at?: string; created_at?: string }>): {
  startedAt: string | null;
  finishedAt: string | null;
} {
  const times = events
    .map((event) => event.at || event.created_at || '')
    .filter(Boolean)
    .sort();
  return {
    startedAt: times[0] || null,
    finishedAt: times[times.length - 1] || null,
  };
}

export function buildIngestTrace(
  run: IngestRunRecord,
  audit: IngestAuditRecord[],
  semanticEvents: SemanticEventRecord[] = [],
): IngestTraceStage[] {
  const completed = completedStages(run, audit);
  const failedSemantic = [...semanticEvents]
    .reverse()
    .find((event) => event.status === 'failed' && traceStageId(event.stage));
  let failureStage = failedSemantic ? traceStageId(failedSemantic.stage) : null;
  if (!failureStage && ['failed', 'cancelled'].includes(run.status)) {
    failureStage = TRACE_DEFINITIONS.find((stage) => !completed.has(stage.id))?.id || 'commit';
  }
  const currentStage = run.status === 'running'
    ? TRACE_DEFINITIONS.find((stage) => !completed.has(stage.id))?.id || 'commit'
    : null;

  return TRACE_DEFINITIONS.map((definition) => {
    const auditEvents = audit.filter((event) => traceStageId(event.stage) === definition.id);
    const modelEvents = semanticEvents.filter((event) => traceStageId(event.stage) === definition.id);
    const times = eventTimes([...auditEvents, ...modelEvents]);
    let status: IngestTraceStatus = 'pending';
    if (completed.has(definition.id)) status = 'completed';
    if (definition.id === currentStage) status = 'current';
    if (definition.id === failureStage) status = 'failed';
    return {
      ...definition,
      status,
      eventCount: auditEvents.length + modelEvents.length,
      durationMs: modelEvents.reduce((sum, event) => sum + Number(event.duration_ms || 0), 0),
      startedAt: definition.id === 'parse' ? run.started_at : times.startedAt,
      finishedAt: definition.id === 'parse' ? (audit[0]?.at || run.finished_at || null) : times.finishedAt,
    };
  });
}

function runWhere(query: { q?: string; status?: string }, params: unknown[]): string {
  const clauses = [
    `NOT EXISTS (SELECT 1 FROM ingest_history_hidden h WHERE h.run_id = r.id)`,
  ];
  const q = query.q?.trim();
  if (q) {
    clauses.push(`(r.path LIKE ? OR r.id LIKE ?)`);
    params.push(`%${q}%`, `%${q}%`);
  }
  if (query.status && ['running', 'completed', 'failed', 'cancelled'].includes(query.status)) {
    clauses.push(`r.status = ?`);
    params.push(query.status);
  }
  return clauses.join(' AND ');
}

function loadTraceInputs(runIds: string[]): {
  audit: Map<string, IngestAuditRecord[]>;
  semantic: Map<string, SemanticEventRecord[]>;
} {
  const audit = new Map<string, IngestAuditRecord[]>();
  const semantic = new Map<string, SemanticEventRecord[]>();
  if (!runIds.length) return { audit, semantic };
  const placeholders = runIds.map(() => '?').join(',');
  const auditRows = db.prepare(
    `SELECT run_id,id,stage,at,input_hash FROM ingest_audit
     WHERE run_id IN (${placeholders}) ORDER BY id`
  ).all(...runIds) as Array<IngestAuditRecord & { run_id: string }>;
  for (const row of auditRows) {
    const list = audit.get(row.run_id) || [];
    list.push(row);
    audit.set(row.run_id, list);
  }
  const semanticRows = db.prepare(
    `SELECT ref_id,id,stage,model_tag,status,error,duration_ms,created_at
     FROM semantic_events WHERE scope='ingest' AND ref_id IN (${placeholders})
     ORDER BY id`
  ).all(...runIds) as Array<SemanticEventRecord & { ref_id: string }>;
  for (const row of semanticRows) {
    const list = semantic.get(row.ref_id) || [];
    list.push(row);
    semantic.set(row.ref_id, list);
  }
  return { audit, semantic };
}

export function listIngestHistory(query: {
  limit?: number;
  offset?: number;
  q?: string;
  status?: string;
} = {}) {
  const limit = Math.max(1, Math.min(100, Number(query.limit) || 40));
  const offset = Math.max(0, Number(query.offset) || 0);
  const countParams: unknown[] = [];
  const where = runWhere(query, countParams);
  const total = (db.prepare(
    `SELECT COUNT(*) total FROM ingest_runs r WHERE ${where}`
  ).get(...countParams) as { total: number }).total;
  const rowParams: unknown[] = [];
  const rowWhere = runWhere(query, rowParams);
  const rows = db.prepare(
    `SELECT r.*,
       (SELECT COUNT(*) FROM ingest_facts f WHERE f.run_id=r.id) fact_count,
       (SELECT COUNT(*) FROM page_contributions pc WHERE pc.run_id=r.id) contribution_count,
       (SELECT COUNT(*) FROM ingest_questions iq WHERE iq.run_id=r.id) question_count
     FROM ingest_runs r
     WHERE ${rowWhere}
     ORDER BY CASE WHEN r.status='running' THEN 0 ELSE 1 END, r.started_at DESC
     LIMIT ? OFFSET ?`
  ).all(...rowParams, limit, offset) as Array<IngestRunRecord & Record<string, unknown>>;
  const traces = loadTraceInputs(rows.map((row) => row.id));
  return {
    total,
    limit,
    offset,
    runs: rows.map((row) => {
      const trace = buildIngestTrace(
        row,
        traces.audit.get(row.id) || [],
        traces.semantic.get(row.id) || [],
      );
      return {
        ...row,
        stats: parseJson(row.stats, {}),
        currentStage: trace.find((stage) => ['current', 'failed'].includes(stage.status))
          || [...trace].reverse().find((stage) => stage.status === 'completed')
          || trace[0],
        progress: Math.round(
          (trace.filter((stage) => stage.status === 'completed').length / trace.length) * 100
        ),
      };
    }),
  };
}

export function getIngestHistory(runId: string) {
  const run = db.prepare(
    `SELECT r.* FROM ingest_runs r
     WHERE r.id=? AND NOT EXISTS (
       SELECT 1 FROM ingest_history_hidden h WHERE h.run_id=r.id
     )`
  ).get(runId) as IngestRunRecord | undefined;
  if (!run) return null;
  const audit = (db.prepare(
    `SELECT id,stage,at,input_hash,payload FROM ingest_audit WHERE run_id=? ORDER BY id`
  ).all(runId) as IngestAuditRecord[]).map((event) => ({
    ...event,
    payload: parseJson(event.payload, event.payload),
  }));
  const semanticEvents = db.prepare(
    `SELECT id,stage,model_tag,status,output,error,duration_ms,created_at
     FROM semantic_events WHERE scope='ingest' AND ref_id=? ORDER BY id`
  ).all(runId) as SemanticEventRecord[];
  const facts = (db.prepare(
    `SELECT fact_id,statement,sources FROM ingest_facts WHERE run_id=? ORDER BY fact_id`
  ).all(runId) as Array<{ fact_id: string; statement: string; sources: string }>).map((fact) => ({
    ...fact,
    sources: parseJson(fact.sources, []),
  }));
  const contributions = db.prepare(
    `SELECT pc.page_id,pc.summary,pc.confidence,pc.active,pc.created_at,p.title,p.path
     FROM page_contributions pc LEFT JOIN pages p ON p.id=pc.page_id
     WHERE pc.run_id=? ORDER BY pc.created_at`
  ).all(runId);
  const questions = db.prepare(
    `SELECT id,question,status,created_at,updated_at FROM ingest_questions
     WHERE run_id=? ORDER BY created_at`
  ).all(runId);
  const sourceVersion = run.source_version_id
    ? db.prepare(
      `SELECT id,path,status,created_at,activated_at,error FROM source_versions WHERE id=?`
    ).get(run.source_version_id)
    : null;
  return {
    run: { ...run, stats: parseJson(run.stats, {}) },
    sourceVersion,
    facts,
    contributions,
    questions,
    audit,
    semanticEvents,
    trace: buildIngestTrace(run, audit, semanticEvents),
  };
}

export function clearIngestHistory(): number {
  return db.prepare(
    `INSERT OR IGNORE INTO ingest_history_hidden(run_id,hidden_at)
     SELECT id,? FROM ingest_runs
     WHERE status IN ('completed','failed','cancelled')`
  ).run(new Date().toISOString()).changes;
}
