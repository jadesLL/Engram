import crypto from 'node:crypto';
import { db, getSetting, newId, now, setSetting } from '../lib/db.js';
import { enqueue, enqueuePagePipeline } from '../jobQueue.js';
import { readPage, writePage } from '../lib/vault.js';
import { isEntity } from '../lib/pageTypes.js';
import { ensureEntityStructure } from './knowledgePage.js';
import { backfillLegacyCandidates } from './candidateLedger.js';

export interface SourceVersion {
  id: string;
  path: string;
  content_hash: string;
  previous_id: string | null;
  status: string;
}

export interface ContributionInput {
  pageId: string;
  sourceVersionId: string;
  runId: string;
  contributionKey: string;
  factIds: string[];
  relations?: unknown[];
  content: string;
  summary: string;
  domain: string;
  confidence: string;
  sourceRef: string;
  managed?: boolean;
  active?: boolean;
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

export function contributionKey(sourcePath: string, pageId: string): string {
  return crypto.createHash('sha256').update(`${sourcePath}\0${pageId}`).digest('hex').slice(0, 24);
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
  ).run(version.id, path, contentHash, version.previous_id, version.status, now());
  return version;
}

export function storeContribution(input: ContributionInput): void {
  const timestamp = now();
  db.prepare(
    `INSERT INTO page_contributions(
       id,page_id,source_version_id,run_id,contribution_key,fact_ids,relations,content,
       summary,domain,confidence,source_ref,managed,active,created_at,updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(page_id,source_version_id) DO UPDATE SET
       run_id=excluded.run_id, contribution_key=excluded.contribution_key,
       fact_ids=excluded.fact_ids, relations=excluded.relations, content=excluded.content,
       summary=excluded.summary, domain=excluded.domain, confidence=excluded.confidence,
       source_ref=excluded.source_ref, managed=excluded.managed, updated_at=excluded.updated_at`
  ).run(
    newId(), input.pageId, input.sourceVersionId, input.runId, input.contributionKey,
    JSON.stringify(input.factIds), JSON.stringify(input.relations || []), input.content,
    input.summary, input.domain, input.confidence, input.sourceRef,
    input.managed === false ? 0 : 1, input.active ? 1 : 0, timestamp, timestamp
  );
}

export function contributionsForProjection(pageId: string, pendingVersionId?: string): StoredContribution[] {
  const pending = pendingVersionId
    ? db.prepare(`SELECT path FROM source_versions WHERE id=?`).get(pendingVersionId) as { path: string } | undefined
    : undefined;
  if (!pendingVersionId || !pending) {
    return db.prepare(
      `SELECT pc.*, sv.path source_path FROM page_contributions pc
       JOIN source_versions sv ON sv.id=pc.source_version_id
       WHERE pc.page_id=? AND pc.active=1 ORDER BY pc.created_at`
    ).all(pageId) as StoredContribution[];
  }
  return db.prepare(
    `SELECT pc.*, sv.path source_path FROM page_contributions pc
     JOIN source_versions sv ON sv.id=pc.source_version_id
     WHERE pc.page_id=? AND (
       pc.source_version_id=? OR (pc.active=1 AND sv.path<>?)
     ) ORDER BY pc.created_at`
  ).all(pageId, pendingVersionId, pending.path) as StoredContribution[];
}

export function allPageContributions(pageId: string): StoredContribution[] {
  return db.prepare(
    `SELECT pc.*, sv.path source_path FROM page_contributions pc
     JOIN source_versions sv ON sv.id=pc.source_version_id
     WHERE pc.page_id=? ORDER BY pc.created_at`
  ).all(pageId) as StoredContribution[];
}

export function affectedPagesForSource(path: string, pendingVersionId: string): string[] {
  const rows = db.prepare(
    `SELECT DISTINCT pc.page_id FROM page_contributions pc
     JOIN source_versions sv ON sv.id=pc.source_version_id
     WHERE sv.path=? OR pc.source_version_id=?`
  ).all(path, pendingVersionId) as { page_id: string }[];
  return rows.map((row) => row.page_id);
}

export function activateSourceVersion(versionId: string, runId: string): void {
  const version = db.prepare(`SELECT path FROM source_versions WHERE id=?`).get(versionId) as { path: string } | undefined;
  if (!version) throw new Error('来源版本不存在');
  const timestamp = now();
  db.transaction(() => {
    db.prepare(
      `UPDATE page_contributions SET active=0 WHERE source_version_id IN (
         SELECT id FROM source_versions WHERE path=?
       )`
    ).run(version.path);
    db.prepare(`UPDATE page_contributions SET active=1 WHERE source_version_id=?`).run(versionId);
    db.prepare(`UPDATE source_versions SET status='superseded' WHERE path=? AND id<>? AND status='active'`).run(version.path, versionId);
    db.prepare(`UPDATE source_versions SET status='active', activated_at=?, error=NULL WHERE id=?`).run(timestamp, versionId);
    db.prepare(
      `UPDATE ingest_runs SET status='completed', commit_status='committed', derived_status='pending', finished_at=?
       WHERE id=?`
    ).run(timestamp, runId);
  })();
}

export function failSourceVersion(versionId: string, runId: string, error: string): void {
  db.prepare(`UPDATE source_versions SET status='failed', error=? WHERE id=?`).run(error, versionId);
  db.prepare(
    `UPDATE ingest_runs SET status='failed', commit_status='failed', derived_status='failed', finished_at=?, error=? WHERE id=?`
  ).run(now(), error, runId);
}

export function markCommitStarted(runId: string): void {
  db.prepare(`UPDATE ingest_runs SET commit_status='committing' WHERE id=?`).run(runId);
}

export function enqueueDerivedFinalize(runId: string): void {
  enqueue('ingest_finalize', { runId, nonce: Date.now() });
}

export function finalizeDerivedRun(runId: string): void {
  const pages = db.prepare(
    `SELECT DISTINCT page_id FROM page_contributions WHERE run_id=? AND active=1`
  ).all(runId) as { page_id: string }[];
  const missing = pages.filter((page) => !db.prepare(
    `SELECT 1 FROM chunks WHERE ref_type='page' AND ref_id=? LIMIT 1`
  ).get(page.page_id));
  db.prepare(`UPDATE ingest_runs SET derived_status=? WHERE id=?`).run(missing.length ? 'failed' : 'completed', runId);
  if (missing.length) throw new Error(`${missing.length} 个页面尚未生成检索分块`);
}

export function recordQuestions(
  runId: string,
  sourceVersionId: string,
  path: string,
  questions: Array<{ question: string; factIds: string[]; acceptance: string[] }>,
): Array<{ id: string; question: string; factIds: string[]; acceptance: string[] }> {
  const insert = db.prepare(
    `INSERT INTO ingest_questions(id,run_id,source_version_id,path,question,fact_ids,acceptance,status,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,'open',?,?)`
  );
  const timestamp = now();
  return questions.map((question) => {
    const id = newId();
    insert.run(
      id, runId, sourceVersionId, path, question.question,
      JSON.stringify(question.factIds), JSON.stringify(question.acceptance), timestamp, timestamp
    );
    return { id, ...question };
  });
}

export function supplementalAnswers(path: string): Array<{ id: string; answer: string }> {
  return db.prepare(
    `SELECT id, answer FROM ingest_questions
     WHERE path=? AND status IN ('answered','accepted') AND answer<>'' ORDER BY updated_at`
  ).all(path) as Array<{ id: string; answer: string }>;
}

export function recoverIngestCommits(): void {
  const runs = db.prepare(
    `SELECT id, source_version_id FROM ingest_runs WHERE commit_status='committing'`
  ).all() as Array<{ id: string; source_version_id?: string }>;
  for (const run of runs) {
    if (!run.source_version_id) {
      db.prepare(`UPDATE ingest_runs SET status='failed', commit_status='failed', error='提交恢复缺少来源版本' WHERE id=?`).run(run.id);
      continue;
    }
    const contributions = db.prepare(
      `SELECT COUNT(*) count FROM page_contributions WHERE source_version_id=?`
    ).get(run.source_version_id) as { count: number };
    if (!contributions.count) {
      failSourceVersion(run.source_version_id, run.id, '提交中断且没有可恢复的页面贡献');
      continue;
    }
    enqueue('ingest_recover', { runId: run.id });
  }
}

function backfillSourceVersions(): void {
  const runs = db.prepare(
    `SELECT id,path,content_hash,status,started_at,finished_at,source_version_id
     FROM ingest_runs ORDER BY started_at`
  ).all() as Array<Record<string, any>>;
  const paths = new Set<string>();
  for (const run of runs) {
    paths.add(run.path);
    let version = db.prepare(
      `SELECT id FROM source_versions WHERE path=? AND content_hash=?`
    ).get(run.path, run.content_hash) as { id: string } | undefined;
    if (!version) {
      version = { id: newId() };
      db.prepare(
        `INSERT INTO source_versions(id,path,content_hash,status,created_at,error)
         VALUES(?,?,?,?,?,?)`
      ).run(
        version.id,
        run.path,
        run.content_hash,
        run.status === 'failed' ? 'failed' : 'superseded',
        run.started_at,
        run.status === 'failed' ? '历史运行失败' : null
      );
    }
    if (run.source_version_id !== version.id) {
      db.prepare(`UPDATE ingest_runs SET source_version_id=? WHERE id=?`).run(version.id, run.id);
    }
  }

  for (const path of paths) {
    const latest = db.prepare(
      `SELECT source_version_id, COALESCE(finished_at,started_at) at
       FROM ingest_runs WHERE path=? AND status='completed' AND source_version_id IS NOT NULL
       ORDER BY at DESC LIMIT 1`
    ).get(path) as { source_version_id: string; at: string } | undefined;
    if (!latest) continue;
    db.prepare(`UPDATE source_versions SET status='superseded' WHERE path=? AND status<>'failed'`).run(path);
    db.prepare(`UPDATE source_versions SET status='active', activated_at=? WHERE id=?`)
      .run(latest.at, latest.source_version_id);
  }
}

function backfillLegacyContributions(): void {
  const pages = db.prepare(
    `SELECT id,path,title,type FROM pages WHERE deleted=0
     AND (path LIKE 'Wiki/概念/%' OR path LIKE 'Wiki/实体/%')`
  ).all() as Array<{ id: string; path: string; title: string; type: string }>;
  const marker = /<!--\s*ingest:([^;>]+);facts:([^>]*)-->/g;
  for (const page of pages) {
    const current = readPage(page.path);
    if (!current) continue;
    const matches = [...current.content.matchAll(marker)];
    for (const match of matches) {
      const runId = match[1].trim();
      const run = db.prepare(
        `SELECT source_version_id,path FROM ingest_runs WHERE id=?`
      ).get(runId) as { source_version_id?: string; path: string } | undefined;
      if (!run?.source_version_id) continue;
      storeContribution({
        pageId: page.id,
        sourceVersionId: run.source_version_id,
        runId,
        contributionKey: contributionKey(run.path, page.id),
        factIds: match[2].split(',').map((item) => item.trim()).filter(Boolean),
        content: '',
        summary: current.meta.summary || '',
        domain: '',
        confidence: '中',
        sourceRef: run.path,
        managed: false,
      });
      const version = db.prepare(`SELECT status FROM source_versions WHERE id=?`).get(run.source_version_id) as { status: string };
      db.prepare(
        `UPDATE page_contributions SET active=? WHERE page_id=? AND source_version_id=?`
      ).run(version.status === 'active' ? 1 : 0, page.id, run.source_version_id);
    }

    if (matches.length && isEntity(page.type) && (!/##\s*当前理解/.test(current.content) || !/##\s*时间线/.test(current.content))) {
      writePage(page.path, ensureEntityStructure(current.content, page.title), {});
    }
  }
}

function backfillLegacyQuestions(): void {
  const reports = db.prepare(
    `SELECT id,run_at,payload,status FROM reports WHERE kind='ingest_questions'`
  ).all() as Array<{ id: number; run_at: string; payload: string; status: string }>;
  for (const report of reports) {
    let payload: Record<string, any>;
    try { payload = JSON.parse(report.payload); } catch { continue; }
    if (!payload.runId || !Array.isArray(payload.questions)) continue;
    const run = db.prepare(`SELECT source_version_id,path FROM ingest_runs WHERE id=?`).get(payload.runId) as any;
    if (!run) continue;
    let changed = false;
    const questions = payload.questions.map((question: any) => {
      if (question.id) return question;
      const existing = db.prepare(
        `SELECT id FROM ingest_questions WHERE run_id=? AND question=? LIMIT 1`
      ).get(payload.runId, String(question.question || '')) as { id: string } | undefined;
      const id = existing?.id || newId();
      if (!existing) {
        db.prepare(
          `INSERT INTO ingest_questions(
             id,run_id,source_version_id,path,question,fact_ids,acceptance,status,created_at,updated_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?)`
        ).run(
          id,
          payload.runId,
          run.source_version_id || null,
          payload.path || run.path,
          String(question.question || ''),
          JSON.stringify(question.factIds || []),
          JSON.stringify(question.acceptance || []),
          report.status === 'open' ? 'open' : report.status === 'resolved' ? 'accepted' : 'ignored',
          report.run_at,
          report.run_at
        );
      }
      changed = true;
      return { id, ...question };
    });
    if (changed) {
      db.prepare(`UPDATE reports SET payload=? WHERE id=?`).run(JSON.stringify({ ...payload, questions }), report.id);
    }
  }
}

function queueMissingDerivedPages(): void {
  const pages = db.prepare(
    `SELECT id FROM pages p WHERE p.deleted=0
     AND (p.path LIKE 'Wiki/概念/%' OR p.path LIKE 'Wiki/实体/%')
     AND NOT EXISTS (
       SELECT 1 FROM chunks c WHERE c.ref_type='page' AND c.ref_id=p.id
     )`
  ).all() as { id: string }[];
  for (const page of pages) enqueuePagePipeline(page.id);
}

export function migrateIngestLedger(): void {
  if (getSetting('ingest_ledger_v2_migrated') !== '1') {
    backfillSourceVersions();
    backfillLegacyContributions();
    backfillLegacyQuestions();
    setSetting('ingest_ledger_v2_migrated', '1');
  }
  if (getSetting('ingest_candidate_ledger_migrated') !== '1') {
    backfillLegacyCandidates();
    setSetting('ingest_candidate_ledger_migrated', '1');
  }
  queueMissingDerivedPages();
}
