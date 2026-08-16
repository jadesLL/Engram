import fs from 'node:fs';
import { db, now } from '../lib/db.js';
import { createPage, readPage, readPageMeta, safeJoin, writePage } from '../lib/vault.js';
import { TYPE_DIR, isEntity, isSynthesizable } from '../lib/pageTypes.js';
import { enqueuePagePipeline } from '../jobQueue.js';
import { addReports } from '../dream/reports.js';
import type { ComposedItem } from './ingestModel.js';
import {
  activateSourceVersion,
  affectedPagesForSource,
  allPageContributions,
  contributionKey,
  contributionsForProjection,
  enqueueDerivedFinalize,
  failSourceVersion,
  markCommitStarted,
  storeContribution,
  type SourceVersion,
} from './sourceLedger.js';
import { ensureEntityStructure, renderKnowledgeProjection, type KnowledgeRelation } from './knowledgePage.js';
import { hasActivePageSynthesis, queuePageRecompose } from './pageSynthesis.js';
import {
  findSupportingCandidates,
  consumeCandidateIdentity,
  getCandidate,
  reconcilePendingCandidates,
  resolveCandidateReports,
  setCandidateStatus,
  upsertCandidateOccurrence,
} from './candidateLedger.js';

export interface IngestStats {
  created: number;
  merged: number;
  skipped: number;
  pending: number;
}

export interface KnowledgeCommitContext {
  runId: string;
  sourceVersion: SourceVersion;
  sourcePath: string;
  sourceName: string;
  sourceRef: string;
  manualApproval?: boolean;
}

export type KnowledgeItem = ComposedItem & {
  relations?: KnowledgeRelation[];
  candidateId?: string;
  supportingCandidateIds?: string[];
  evidenceEligible?: boolean;
  unsupportedSections?: string[];
  verified?: boolean;
};

const EMPTY: IngestStats = { created: 0, merged: 0, skipped: 0, pending: 0 };

function activeWikiTitleQuery(): string {
  return `deleted=0 AND (path LIKE 'Wiki/概念/%' OR path LIKE 'Wiki/实体/%')`;
}

function knownTitles(items: KnowledgeItem[]): Set<string> {
  const rows = db.prepare(`SELECT lower(title) title FROM pages WHERE ${activeWikiTitleQuery()}`).all() as { title: string }[];
  const result = new Set(rows.map((row) => row.title));
  for (const item of items) {
    if (item.action === 'create') result.add(item.name.toLowerCase());
    if (item.action === 'merge' && item.target) result.add(item.target.toLowerCase());
  }
  return result;
}

function stripDeadLinks(content: string, known: Set<string>): string {
  return content.replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (full, target: string, alias?: string) =>
    known.has(target.trim().toLowerCase()) ? full : (alias || target).trim()
  );
}

function pending(item: KnowledgeItem, context: KnowledgeCommitContext, reason: string) {
  const candidate = item.candidateId
    ? getCandidate(item.candidateId)
    : upsertCandidateOccurrence({ ...item, reason }, {
      runId: context.runId,
      sourceVersionId: context.sourceVersion.id,
      sourcePath: context.sourcePath,
      sourceName: context.sourceName,
    });
  addReports([{
    kind: 'pending_review',
    payload: {
      candidateId: candidate?.id,
      name: item.name,
      kind: item.kind,
      source: context.sourceName,
      sourcePath: context.sourcePath,
      sourceVersionId: context.sourceVersion.id,
      reason,
      runId: context.runId,
      confidence: item.confidence,
      target: item.target,
      summary: item.summary,
      content: item.content,
      factIds: item.factIds,
      relations: item.relations || [],
      ambiguity: item.ambiguity,
      reviewOnly: true,
    },
  }]);
}

function parseArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function enforceCrossSourceGate(
  items: KnowledgeItem[],
  context: KnowledgeCommitContext,
): KnowledgeItem[] {
  if (context.manualApproval) return items;
  return items.map((item) => {
    if (item.action !== 'create') return item;
    const supporting = findSupportingCandidates(item.name, item.kind, context.sourcePath);
    const totalFacts = item.factIds.length + supporting.reduce(
      (sum, candidate) => sum + parseArray<string>(candidate.fact_ids).length,
      0,
    );
    // 必须满足：≥2 个不同原始资料来源且总事实≥2 且无歧义，才允许自动建页。
    // 单来源候选一律降级为 review（挂账等待第二个独立来源出现后自动对账），人工不再审批首次入库。
    if (supporting.length && totalFacts >= 2 && !item.ambiguity) {
      return { ...item, supportingCandidateIds: supporting.map((candidate) => candidate.id) };
    }
    return {
      ...item,
      action: 'review' as const,
      evidenceEligible: true,
      reason: [...new Set([
        item.reason,
        item.ambiguity
          ? '候选身份仍有歧义，需要人工确认'
          : '需要至少两个不同原始资料来源支持才能自动建页',
      ].filter(Boolean))].join('；'),
    };
  });
}

function attachSupportingCandidates(
  pageId: string,
  item: KnowledgeItem,
  known: Set<string>,
  evidenceOnly = false,
): void {
  for (const candidateId of item.supportingCandidateIds || []) {
    const candidate = getCandidate(candidateId);
    if (!candidate?.source_version_id) continue;
    storeContribution({
      pageId,
      sourceVersionId: candidate.source_version_id,
      runId: candidate.run_id,
      contributionKey: contributionKey(candidate.source_path, pageId),
      factIds: parseArray(candidate.fact_ids),
      relations: parseArray(candidate.relations),
      content: stripDeadLinks(candidate.content, known),
      summary: candidate.summary,
      domain: candidate.domain,
      confidence: candidate.confidence,
      sourceRef: candidate.source_path,
      managed: !evidenceOnly,
      active: true,
    });
    setCandidateStatus(candidate.id, 'consumed', pageId);
    resolveCandidateReports(candidate.id, 'resolved');
  }
}

function pageSources(
  pagePath: string,
  allManaged: ReturnType<typeof allPageContributions>,
  active: ReturnType<typeof contributionsForProjection>,
): string[] {
  const existing = readPageMeta(pagePath).sources;
  const managedPaths = new Set(allManaged.map((contribution) => contribution.source_path));
  return [...new Set([
    ...(Array.isArray(existing) ? existing.map(String).filter((source) => !managedPaths.has(source)) : []),
    ...active.map((contribution) => contribution.source_path),
  ])];
}

function projectPage(pageId: string, pendingVersionId?: string): void {
  const page = db.prepare(`SELECT id,path,title,type FROM pages WHERE id=? AND deleted=0`).get(pageId) as any;
  if (!page) return;
  const current = readPage(page.path);
  if (!current) return;
  const allManaged = allPageContributions(pageId);
  const active = contributionsForProjection(pageId, pendingVersionId);
  if (isEntity(page.type) && hasActivePageSynthesis(pageId)) {
    writePage(page.path, ensureEntityStructure(current.content, page.title), {
      type: page.type,
      summary: current.meta.summary,
      retrieved: new Date().toISOString().slice(0, 10),
      sources: pageSources(page.path, allManaged, active),
    });
    return;
  }
  const projected = renderKnowledgeProjection(
    current.content,
    page.title,
    isEntity(page.type),
    allManaged,
    active,
  );
  const latest = active.at(-1);
  writePage(page.path, projected, {
    type: page.type,
    summary: latest?.summary || current.meta.summary,
    domain: latest?.domain,
    confidence: latest?.confidence,
    retrieved: new Date().toISOString().slice(0, 10),
    sources: pageSources(page.path, allManaged, active),
  });
}

function finishCommit(context: KnowledgeCommitContext, pageIds: string[]): void {
  const revision = `${context.runId}:${Date.now()}`;
  for (const pageId of pageIds) projectPage(pageId, context.sourceVersion.id);
  activateSourceVersion(context.sourceVersion.id, context.runId);
  for (const pageId of pageIds) {
    projectPage(pageId);
    const page = db.prepare(`SELECT type FROM pages WHERE id=? AND deleted=0`).get(pageId) as { type: string } | undefined;
    const synthesisId = page && isSynthesizable(page.type)
      ? queuePageRecompose(pageId, { triggerRunId: context.runId })
      : undefined;
    if (!synthesisId) enqueuePagePipeline(pageId, { ingestRunId: context.runId, revision });
  }
  enqueueDerivedFinalize(context.runId);
}

export function commitKnowledgeItems(items: KnowledgeItem[], context: KnowledgeCommitContext): {
  stats: IngestStats;
  pageIds: string[];
} {
  const stats = { ...EMPTY };
  const gatedItems = enforceCrossSourceGate(items, context);
  const known = knownTitles(gatedItems);
  const find = db.prepare(`SELECT id,path,title,type FROM pages WHERE ${activeWikiTitleQuery()} AND lower(title)=lower(?)`);
  const createdPageIds: string[] = [];

  for (const item of gatedItems) {
    if (item.action === 'skip') {
      stats.skipped++;
      continue;
    }
    if (item.action === 'review') {
      pending(item, context, item.reason || '需要人工确认');
      stats.pending++;
      continue;
    }

    const targetName = item.action === 'merge' ? item.target : item.name;
    let page = find.get(targetName) as any;
    const existed = Boolean(page);
    if (item.action === 'merge' && !page) {
      pending(item, context, `合并目标「${targetName}」不存在`);
      stats.pending++;
      continue;
    }
    if (!page) {
      const dir = TYPE_DIR[item.kind];
      if (!dir) {
        pending(item, context, '类型不清');
        stats.pending++;
        continue;
      }
      page = createPage(dir, item.name);
      writePage(page.path, `# ${item.name}\n`, { type: item.kind });
      page = db.prepare(`SELECT id,path,title,type FROM pages WHERE id=?`).get(page.id);
      createdPageIds.push(page.id);
      stats.created++;
    } else {
      stats.merged++;
    }

    storeContribution({
      pageId: page.id,
      sourceVersionId: context.sourceVersion.id,
      runId: context.runId,
      contributionKey: contributionKey(context.sourcePath, page.id),
      factIds: item.factIds,
      relations: item.relations || [],
      content: stripDeadLinks(item.content, known),
      summary: item.summary,
      domain: item.domain,
      confidence: item.confidence,
      sourceRef: context.sourceRef,
    });
    attachSupportingCandidates(page.id, item, known, Boolean(context.manualApproval));
    // 无依据内容已被 Verifier 清理，但记录为 enrich 报告提示后续补充依据，不阻塞入库。
    if (item.unsupportedSections?.length) {
      addReports([{
        kind: 'enrich',
        issueKey: `ingest-unsupported:${page.id}`,
        fingerprint: `${context.runId}:${item.name}`,
        payload: {
          pageId: page.id,
          title: targetName,
          pageUpdated: now(),
          unsupportedSections: item.unsupportedSections,
          source: context.sourceName,
          runId: context.runId,
          detail: `整理时清理了 ${item.unsupportedSections.length} 项无依据内容，可补充来源后完善`,
        },
      }]);
    }
    if (item.candidateId) {
      setCandidateStatus(item.candidateId, item.action === 'merge' || existed ? 'merged' : 'approved', page.id);
      resolveCandidateReports(item.candidateId, 'resolved');
    } else {
      const candidate = upsertCandidateOccurrence(item, {
        runId: context.runId,
        sourceVersionId: context.sourceVersion.id,
        sourcePath: context.sourcePath,
        sourceName: context.sourceName,
      }, item.action === 'merge' || existed ? 'merged' : 'approved');
      setCandidateStatus(candidate.id, candidate.status, page.id);
    }
    if (existed || item.action === 'merge') consumeCandidateIdentity(targetName, page.type, page.id);
  }

  const pageIds = affectedPagesForSource(context.sourcePath, context.sourceVersion.id);
  markCommitStarted(context.runId);
  try {
    finishCommit(context, pageIds);
  } catch (error: any) {
    db.prepare(`DELETE FROM page_contributions WHERE source_version_id=?`).run(context.sourceVersion.id);
    for (const pageId of pageIds) {
      try { projectPage(pageId); } catch { /* best-effort rollback to active contributions */ }
    }
    for (const pageId of createdPageIds) {
      const page = db.prepare(`SELECT path FROM pages WHERE id=?`).get(pageId) as { path: string } | undefined;
      if (page && !allPageContributions(pageId).length) {
        try { fs.unlinkSync(safeJoin(page.path)); } catch { /* page may not have reached disk */ }
        db.prepare(`DELETE FROM pages_fts WHERE page_id=?`).run(pageId);
        db.prepare(`DELETE FROM pages WHERE id=?`).run(pageId);
      }
    }
    failSourceVersion(context.sourceVersion.id, context.runId, String(error?.message || error));
    throw error;
  }
  reconcilePendingCandidates();
  return { stats, pageIds };
}

export function recoverKnowledgeCommit(runId: string): void {
  const run = db.prepare(
    `SELECT id,path,source_version_id FROM ingest_runs WHERE id=? AND commit_status='committing'`
  ).get(runId) as { id: string; path: string; source_version_id?: string } | undefined;
  if (!run?.source_version_id) throw new Error('没有可恢复的整理提交');
  const sourceVersion = db.prepare(
    `SELECT id,path,content_hash,previous_id,status FROM source_versions WHERE id=?`
  ).get(run.source_version_id) as SourceVersion | undefined;
  if (!sourceVersion) throw new Error('恢复提交时来源版本不存在');
  const pageIds = affectedPagesForSource(run.path, sourceVersion.id);
  try {
    finishCommit({
      runId,
      sourceVersion,
      sourcePath: run.path,
      sourceName: run.path.split('/').pop() || run.path,
      sourceRef: run.path,
    }, pageIds);
  } catch (error: any) {
    failSourceVersion(sourceVersion.id, runId, String(error?.message || error));
    throw error;
  }
}
