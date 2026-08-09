import { db, newId, now } from '../lib/db.js';
import type { KnowledgeItem } from './knowledgeCommit.js';
import { enqueue } from '../jobQueue.js';

export type CandidateStatus = 'open' | 'ignored' | 'approved' | 'merged' | 'consumed';

export interface CandidateOccurrence {
  id: string;
  run_id: string;
  source_version_id: string | null;
  source_path: string;
  source_name: string;
  normalized_name: string;
  name: string;
  kind: string;
  domain: string;
  confidence: string;
  summary: string;
  fact_ids: string;
  relations: string;
  content: string;
  reason: string;
  evidence_eligible: number;
  status: CandidateStatus;
  target_page_id: string | null;
  preview_token: string | null;
  preview_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface CandidateContext {
  runId: string;
  sourceVersionId: string;
  sourcePath: string;
  sourceName: string;
}

export interface CandidateFact {
  id: string;
  evidenceId: string;
  statement: string;
  sources: Array<{ chunkId: string; quote: string }>;
  runId: string;
  sourcePath: string;
}

function parseArray<T>(value: string | null | undefined): T[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function normalizeCandidateName(value: string): string {
  return String(value || '').trim().replace(/[\s·•・]+/g, '').toLowerCase();
}

export function upsertCandidateOccurrence(
  item: KnowledgeItem,
  context: CandidateContext,
  status: CandidateStatus = 'open',
): CandidateOccurrence {
  const normalized = normalizeCandidateName(item.name);
  const timestamp = now();
  const existing = db.prepare(
    `SELECT * FROM ingest_candidates WHERE run_id=? AND normalized_name=? AND kind=?`
  ).get(context.runId, normalized, item.kind) as CandidateOccurrence | undefined;
  const id = existing?.id || newId();
  db.prepare(
    `INSERT INTO ingest_candidates(
       id,run_id,source_version_id,source_path,source_name,normalized_name,name,kind,
       domain,confidence,summary,fact_ids,relations,content,reason,evidence_eligible,status,created_at,updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(run_id,normalized_name,kind) DO UPDATE SET
       source_version_id=excluded.source_version_id, source_path=excluded.source_path,
       source_name=excluded.source_name, name=excluded.name, domain=excluded.domain,
       confidence=excluded.confidence, summary=excluded.summary, fact_ids=excluded.fact_ids,
       relations=excluded.relations, content=excluded.content, reason=excluded.reason,
       evidence_eligible=excluded.evidence_eligible, status=excluded.status, updated_at=excluded.updated_at`
  ).run(
    id,
    context.runId,
    context.sourceVersionId,
    context.sourcePath,
    context.sourceName,
    normalized,
    item.name,
    item.kind,
    item.domain || '',
    item.confidence || '中',
    item.summary || '',
    JSON.stringify(item.factIds || []),
    JSON.stringify(item.relations || []),
    item.content || '',
    item.reason || '',
    item.evidenceEligible ? 1 : 0,
    status,
    existing?.created_at || timestamp,
    timestamp,
  );
  return db.prepare(`SELECT * FROM ingest_candidates WHERE id=?`).get(id) as CandidateOccurrence;
}

export function getCandidate(id: string): CandidateOccurrence | undefined {
  return db.prepare(`SELECT * FROM ingest_candidates WHERE id=?`).get(id) as CandidateOccurrence | undefined;
}

export function findSupportingCandidates(
  name: string,
  kind: string,
  currentSourcePath: string,
): CandidateOccurrence[] {
  const rows = db.prepare(
    `SELECT ic.* FROM ingest_candidates ic
     JOIN source_versions sv ON sv.id=ic.source_version_id
     WHERE ic.normalized_name=? AND ic.kind=? AND ic.source_path<>?
       AND ic.status IN ('open','ignored')
       AND ic.evidence_eligible=1
       AND sv.status='active'
     ORDER BY ic.updated_at DESC`
  ).all(normalizeCandidateName(name), kind, currentSourcePath) as CandidateOccurrence[];
  const paths = new Set<string>();
  return rows.filter((row) => {
    if (
      !parseArray<string>(row.fact_ids).length ||
      paths.has(row.source_path)
    ) return false;
    paths.add(row.source_path);
    return true;
  });
}

export function relatedCandidateOccurrences(
  candidate: CandidateOccurrence,
  sameKind = true,
): CandidateOccurrence[] {
  const kindClause = sameKind ? 'AND ic.kind=?' : '';
  const rows = db.prepare(
    `SELECT ic.* FROM ingest_candidates ic
     JOIN source_versions sv ON sv.id=ic.source_version_id
     WHERE ic.normalized_name=? ${kindClause} AND sv.status='active'
       AND ic.status IN ('open','ignored','consumed','approved','merged')
     ORDER BY ic.updated_at DESC`
  ).all(...(sameKind ? [candidate.normalized_name, candidate.kind] : [candidate.normalized_name])) as CandidateOccurrence[];
  const paths = new Set<string>();
  return rows.filter((row) => {
    if (!parseArray<string>(row.fact_ids).length || paths.has(row.source_path)) return false;
    paths.add(row.source_path);
    return true;
  });
}

export function loadCandidateFacts(candidate: CandidateOccurrence): CandidateFact[] {
  const ids = parseArray<string>(candidate.fact_ids);
  if (!ids.length) return [];
  const rows = db.prepare(
    `SELECT fact_id,statement,sources FROM ingest_facts WHERE run_id=?`
  ).all(candidate.run_id) as Array<{ fact_id: string; statement: string; sources: string }>;
  return rows.filter((row) => ids.includes(row.fact_id)).map((row) => ({
    id: row.fact_id,
    evidenceId: `${candidate.run_id}:${row.fact_id}`,
    statement: row.statement,
    sources: parseArray(row.sources),
    runId: candidate.run_id,
    sourcePath: candidate.source_path,
  }));
}

export function setCandidateStatus(
  id: string,
  status: CandidateStatus,
  targetPageId?: string,
): void {
  db.prepare(
    `UPDATE ingest_candidates
     SET status=?, target_page_id=COALESCE(?,target_page_id), preview_token=NULL,
         preview_json=NULL, updated_at=? WHERE id=?`
  ).run(status, targetPageId || null, now(), id);
}

export function storeCandidatePreview(id: string, token: string, preview: unknown): void {
  db.prepare(
    `UPDATE ingest_candidates SET preview_token=?,preview_json=?,updated_at=? WHERE id=?`
  ).run(token, JSON.stringify(preview), now(), id);
}

export function candidatePreview(id: string, token: string): unknown | null {
  const row = db.prepare(
    `SELECT preview_json FROM ingest_candidates WHERE id=? AND preview_token=?`
  ).get(id, token) as { preview_json: string | null } | undefined;
  if (!row?.preview_json) return null;
  try { return JSON.parse(row.preview_json); } catch { return null; }
}

export function resolveCandidateReports(candidateId: string, status: 'resolved' | 'dismissed'): void {
  const rows = db.prepare(
    `SELECT id,payload FROM reports WHERE kind='pending_review' AND status IN ('open','applying')`
  ).all() as Array<{ id: number; payload: string }>;
  for (const row of rows) {
    try {
      if (JSON.parse(row.payload)?.candidateId === candidateId) {
        db.prepare(`UPDATE reports SET status=? WHERE id=?`).run(status, row.id);
      }
    } catch { /* legacy malformed report */ }
  }
}

export function consumeCandidateIdentity(
  name: string,
  kind: string,
  pageId: string,
): void {
  const candidates = db.prepare(
    `SELECT id FROM ingest_candidates
     WHERE normalized_name=? AND kind=? AND status IN ('open','ignored')`
  ).all(normalizeCandidateName(name), kind) as Array<{ id: string }>;
  for (const candidate of candidates) {
    setCandidateStatus(candidate.id, 'consumed', pageId);
    resolveCandidateReports(candidate.id, 'resolved');
  }
}

function exactPage(candidate: CandidateOccurrence): { id: string } | undefined {
  return db.prepare(
    `SELECT id FROM pages WHERE deleted=0 AND lower(title)=lower(?)
     AND (path LIKE 'Wiki/概念/%' OR path LIKE 'Wiki/实体/%')`
  ).get(candidate.name) as { id: string } | undefined;
}

export function releaseCandidateReports(reportIds: number[]): void {
  if (!reportIds.length) return;
  const release = db.prepare(
    `UPDATE reports SET status='open' WHERE id=? AND kind='pending_review' AND status='applying'`
  );
  db.transaction(() => reportIds.forEach((id) => release.run(id)))();
}

export function finalizeCandidateReconciliation(
  candidateIds: string[],
  reportIds: number[],
): boolean {
  let resolved = false;
  for (const candidateId of candidateIds) {
    const candidate = getCandidate(candidateId);
    if (!candidate) continue;
    const page = candidate.target_page_id
      ? { id: candidate.target_page_id }
      : exactPage(candidate);
    if (page || ['approved', 'merged', 'consumed'].includes(candidate.status)) {
      if (page) consumeCandidateIdentity(candidate.name, candidate.kind, page.id);
      resolved = true;
    }
  }
  if (!resolved) releaseCandidateReports(reportIds);
  return resolved;
}

export function reconcilePendingCandidates(): number {
  const reports = db.prepare(
    `SELECT id,status,payload FROM reports
     WHERE kind='pending_review' AND status='open' ORDER BY id`
  ).all() as Array<{ id: number; status: string; payload: string }>;
  let queued = 0;
  for (const report of reports) {
    const candidate = ensureCandidateFromReport(report);
    if (!candidate) continue;
    const sourceCount = relatedCandidateOccurrences(candidate).length;
    const page = exactPage(candidate);
    if (!page && sourceCount < 2) continue;
    const claimed = db.prepare(
      `UPDATE reports SET status='applying'
       WHERE id=? AND kind='pending_review' AND status='open'`
    ).run(report.id);
    if (claimed.changes !== 1) continue;
    const jobId = enqueue('candidate_reconcile', {
      path: candidate.source_path,
      candidateIds: [candidate.id],
      reportIds: [report.id],
      nonce: Date.now(),
    });
    if (!jobId) {
      releaseCandidateReports([report.id]);
      continue;
    }
    queued++;
  }
  return queued;
}

export function ensureCandidateFromReport(report: {
  id: number;
  status: string;
  payload: string;
}): CandidateOccurrence | undefined {
  let payload: Record<string, any>;
  try { payload = JSON.parse(report.payload); } catch { return undefined; }
  if (payload.candidateId) {
    const existing = getCandidate(String(payload.candidateId));
    if (existing) return existing;
  }
  const runId = String(payload.runId || '');
  const name = String(payload.name || '').trim();
  const kind = String(payload.kind || 'concept');
  if (!runId || !name || !['concept', 'person', 'project', 'org'].includes(kind)) return undefined;
  const run = db.prepare(
    `SELECT source_version_id,path FROM ingest_runs WHERE id=?`
  ).get(runId) as { source_version_id?: string; path: string } | undefined;
  if (!run?.source_version_id) return undefined;
  const item = {
    name,
    kind,
    action: 'review',
    target: String(payload.target || ''),
    domain: String(payload.domain || ''),
    confidence: String(payload.confidence || '中'),
    summary: String(payload.summary || ''),
    factIds: Array.isArray(payload.factIds) ? payload.factIds : [],
    relations: Array.isArray(payload.relations) ? payload.relations : [],
    reason: String(payload.reason || ''),
    content: String(payload.content || payload.summary || ''),
  } as KnowledgeItem;
  const status: CandidateStatus =
    report.status === 'dismissed' ? 'ignored' :
    report.status === 'resolved' ? 'approved' : 'open';
  const candidate = upsertCandidateOccurrence(item, {
    runId,
    sourceVersionId: run.source_version_id,
    sourcePath: String(payload.sourcePath || run.path),
    sourceName: String(payload.source || payload.sourcePath || run.path),
  }, status);
  payload.candidateId = candidate.id;
  db.prepare(`UPDATE reports SET payload=? WHERE id=?`).run(JSON.stringify(payload), report.id);
  return candidate;
}

export function backfillLegacyCandidates(): void {
  const reports = db.prepare(
    `SELECT id,status,payload FROM reports WHERE kind='pending_review'`
  ).all() as Array<{ id: number; status: string; payload: string }>;
  for (const report of reports) ensureCandidateFromReport(report);
}
