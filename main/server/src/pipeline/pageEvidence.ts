import crypto from 'node:crypto';
import { db } from '../lib/db.js';
import { isSynthesizable } from '../lib/pageTypes.js';
import { contributionsForProjection } from './sourceLedger.js';

/**
 * 页面证据账本的只读视图：来源（原始资料路径）→ 版本 → 事实（含逐字引文）。
 * 提炼管线已外移给外部 Agent；本模块只读取 Agent 写入与历史管线留下的
 * page_contributions / source_versions / ingest_facts，供编辑器证据抽屉与
 * MCP page_evidence 工具消费。
 */

export interface PageEvidenceFact {
  id: string;
  runId: string;
  factId: string;
  statement: string;
  sourcePath: string;
  sourceRef: string;
  sourceVersionId: string;
  quotes: Array<{ chunkId: string; quote: string }>;
}

function parseArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function evidenceId(runId: string, factId: string): string {
  return `${runId}:${factId}`;
}

/** 批量预取本页证据事实（按 run_id 分组查询，避免 N+1） */
function preloadEvidenceFacts(
  contributions: ReadonlyArray<{ run_id: string; fact_ids: string; relations: string }>,
): Map<string, { runId: string; factId: string; statement: string; sources: string }> {
  const byRun = new Map<string, Set<string>>();
  const add = (runId: string, factId: string) => {
    if (!runId || !factId) return;
    let set = byRun.get(runId);
    if (!set) { set = new Set(); byRun.set(runId, set); }
    set.add(factId);
  };
  for (const c of contributions) {
    for (const fid of parseArray<string>(c.fact_ids)) {
      add(c.run_id, fid);
      const sep = fid.indexOf(':');
      if (sep > 0) add(fid.slice(0, sep), fid.slice(sep + 1));
    }
    for (const rel of parseArray<{ src: string; word: string; dst: string; factId: string }>(c.relations)) {
      if (!rel.factId) continue;
      add(c.run_id, rel.factId);
    }
  }
  const map = new Map<string, { runId: string; factId: string; statement: string; sources: string }>();
  for (const [runId, fids] of byRun) {
    const idList = [...fids];
    if (!idList.length) continue;
    const ph = idList.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT run_id runId,fact_id factId,statement,sources
       FROM ingest_facts WHERE run_id=? AND fact_id IN (${ph})`
    ).all(runId, ...idList) as Array<{ runId: string; factId: string; statement: string; sources: string }>;
    for (const r of rows) map.set(`${r.runId}\0${r.factId}`, r);
  }
  return map;
}

export function pageEvidenceResponse(pageId: string): Record<string, unknown> | null {
  const row = db.prepare(
    `SELECT id,path,title,type,tags FROM pages WHERE id=? AND deleted=0`
  ).get(pageId) as { id: string; path: string; title: string; type: string; tags: string | null } | undefined;
  if (!row || !isSynthesizable(row.type)) return null;
  const page = {
    id: row.id,
    path: row.path,
    title: row.title,
    type: row.type,
    tags: parseArray<string>(row.tags || '[]'),
  };
  const contributions = contributionsForProjection(pageId);
  const factMap = preloadEvidenceFacts(contributions);
  const factRow = (runId: string, rawFactId: string) => {
    const direct = factMap.get(`${runId}\0${rawFactId}`);
    if (direct) return direct;
    const sep = rawFactId.indexOf(':');
    if (sep <= 0) return null;
    return factMap.get(`${rawFactId.slice(0, sep)}\0${rawFactId.slice(sep + 1)}`) || null;
  };

  const facts = new Map<string, PageEvidenceFact>();
  const relations: Array<{ src: string; word: string; dst: string; evidenceId: string }> = [];
  for (const contribution of contributions) {
    for (const rawFactId of parseArray<string>(contribution.fact_ids)) {
      const found = factRow(contribution.run_id, rawFactId);
      if (!found) continue;
      const id = evidenceId(found.runId, found.factId);
      if (!facts.has(id)) {
        facts.set(id, {
          id,
          runId: found.runId,
          factId: found.factId,
          statement: found.statement,
          sourcePath: contribution.source_path,
          sourceRef: contribution.source_ref || contribution.source_path,
          sourceVersionId: contribution.source_version_id,
          quotes: parseArray<{ chunkId: string; quote: string }>(found.sources)
            .filter((source) => source.chunkId && source.quote),
        });
      }
    }
    for (const relation of parseArray<{ src: string; word: string; dst: string; factId: string }>(contribution.relations)) {
      const fact = factRow(contribution.run_id, relation.factId);
      if (!fact || !relation.src || !relation.word || !relation.dst) continue;
      relations.push({
        src: relation.src,
        word: relation.word,
        dst: relation.dst,
        evidenceId: evidenceId(fact.runId, fact.factId),
      });
    }
  }

  const sourcePageIds = new Map(
    (db.prepare(
      `SELECT id,path FROM pages WHERE deleted=0 AND path LIKE '原始资料/%'`
    ).all() as Array<{ id: string; path: string }>).map((p) => [p.path, p.id]),
  );
  const sources = new Map<string, {
    path: string;
    ref: string;
    pageId: string | null;
    versionIds: Set<string>;
    runIds: Set<string>;
    factIds: string[];
    active: boolean;
  }>();
  for (const fact of facts.values()) {
    const source = sources.get(fact.sourcePath) || {
      path: fact.sourcePath,
      ref: fact.sourceRef,
      pageId: sourcePageIds.get(fact.sourcePath) || null,
      versionIds: new Set<string>(),
      runIds: new Set<string>(),
      factIds: [],
      active: false,
    };
    source.versionIds.add(fact.sourceVersionId);
    source.runIds.add(fact.runId);
    source.factIds.push(fact.id);
    source.active = true;
    sources.set(fact.sourcePath, source);
  }

  return {
    page,
    // 综合状态已随提炼管线移除：固定 null，前端徽章不再展示
    latestSynthesis: null,
    synthesis: null,
    evidenceMap: { sections: [], related: [], timeline: [] },
    facts: [...facts.values()],
    sources: [...sources.values()].map((source) => ({
      ...source,
      versionIds: [...source.versionIds],
      runIds: [...source.runIds],
      factIds: [...new Set(source.factIds)],
    })),
    evidenceHash: crypto.createHash('sha256')
      .update(JSON.stringify([...facts.keys()]))
      .digest('hex'),
  };
}
