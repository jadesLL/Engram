import { z } from 'zod';
import { db, now } from '../lib/db.js';
import { invalidateGraphCache } from '../lib/graphCache.js';
import { llmReady } from '../lib/llm.js';
import { createSemanticCacheSession, runSemanticStage } from '../lib/semanticStage.js';
import { readPage } from '../lib/vault.js';
import { entitiesSystem, entitiesUser, type EntityItem } from '../prompts/entities.js';
import { RELATION_WORDS } from '../pipeline/extractor.js';
import {
  classifyEntityName,
  entityIdentityHistory,
  type EntityAmbiguity,
  type EntityRosterEntry,
} from '../pipeline/entityAmbiguity.js';

const entityItemsSchema = z.array(z.object({
  name: z.string().min(1),
  type: z.enum(['person', 'concept', 'project', 'org', 'tech']),
  relation: z.string(),
})).max(8);

/**
 * LLM 实体抽取（GBrain 自布线图谱的 LLM 部分）：
 * 从页面提取实体（人物/概念/项目/组织）及与页面的类型化关系，写入 entities/edges。
 * 对齐：携带已有实体名录（优先链接）、关系向六词表靠拢。
 */
export async function extractEntities(pageId: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!llmReady()) return;
  const page = db.prepare(`SELECT * FROM pages WHERE id = ? AND deleted = 0`).get(pageId) as any;
  if (!page) return;
  const rd = readPage(page.path);
  if (!rd || !rd.content.trim()) return;

  // 实体名录：已有实体/概念标题（便于优先链接、减少孤立实体）
  const rows = db
    .prepare(`SELECT id, title, type, summary FROM pages WHERE deleted = 0 AND path LIKE 'Wiki/%' ORDER BY updated_at DESC LIMIT 500`)
    .all() as EntityRosterEntry[];
  const roster = rows.map((r) => `- ${r.title}`).join('\n');
  const exactPages = new Map(rows.map((row) => [row.title.trim().toLowerCase(), row]));
  const system = entitiesSystem();

  let items: EntityItem[];
  try {
    items = await runSemanticStage({
      scope: 'page-graph',
      refId: pageId,
      stage: 'entity-and-relation-extraction',
      tag: 'entities',
      schema: entityItemsSchema,
      system,
      cacheContext: { roster },
      cacheContextMode: 'always',
      history: createSemanticCacheSession(`page-graph-entities:${pageId}`, system),
      maxHistoryChars: 96_000,
      promptVersion: 'page-graph-entities:2',
      cacheScope: 'page-graph:entities',
      resultCache: true,
      input: entitiesUser(page.title, rd.content.slice(0, 6000)),
      temperature: 0.1,
      maxTokens: 1200,
      retries: 1,
      signal,
    });
  } catch (e: any) {
    console.warn(`[entities] ${page.title} 抽取失败: ${e.message}`);
    return;
  }
  if (!Array.isArray(items)) return;

  db.prepare(`DELETE FROM edges WHERE src_page = ? AND entity_id IS NOT NULL`).run(pageId);

  const findEntity = db.prepare(`SELECT id FROM entities WHERE name = ?`);
  const insEntity = db.prepare(`INSERT INTO entities(name, type) VALUES(?, ?)`);
  const insEdge = db.prepare(
    `INSERT INTO edges(src_page, dst_page, dst_title, entity_id, rel, created_at) VALUES(?, ?, ?, ?, ?, ?)`
  );
  const findByTitle = db.prepare(`SELECT id FROM pages WHERE deleted = 0 AND lower(title) = lower(?)`);
  const findTypedEdge = db.prepare(
    `SELECT id FROM edges WHERE src_page=? AND dst_page=? AND rel=? AND entity_id IS NULL LIMIT 1`
  );
  const ts = now();
  const identityHistory = entityIdentityHistory('page-graph');
  for (let index = 0; index < items.slice(0, 8).length; index++) {
    signal?.throwIfAborted();
    const it = items[index];
    if (!it?.name) continue;
    const exact = exactPages.get(it.name.trim().toLowerCase());
    let identity: {
      ambiguity: EntityAmbiguity | null;
      mergeTarget: string;
      canonicalName: string;
    } | null = exact ? {
      ambiguity: null,
      mergeTarget: exact.title,
      canonicalName: exact.title,
    } : null;
    if (!identity) {
      try {
        identity = await classifyEntityName(
          it.name,
          it.type === 'tech' ? 'concept' : it.type,
          rows,
          rd.content,
          `${pageId}:${it.name}`,
          identityHistory,
          {
            cacheContextMode: index === 0 ? 'always' : 'once',
            contextInCache: true,
            maxHistoryChars: 96_000,
          },
          signal,
        );
      } catch {
        continue;
      }
    }
    if (identity.ambiguity && !identity.mergeTarget) continue;
    const canonical = identity.mergeTarget
      ? rows.find((row) => row.title === identity.mergeTarget)
      : null;
    const entityName = canonical?.title || identity.canonicalName || it.name;
    const entityType = canonical?.type || it.type || 'concept';
    let entity = findEntity.get(entityName) as any;
    if (!entity) {
      const r = insEntity.run(entityName, entityType);
      entity = { id: Number(r.lastInsertRowid) };
    }
    // 六词表关系：写成类型化边（dst 指向已存在页，否则留 dst_title 死链态）
    const rel = (it.relation || '提及').slice(0, 50);
    if ((RELATION_WORDS as readonly string[]).includes(rel)) {
      const dst = findByTitle.get(entityName) as any;
      insEdge.run(pageId, dst?.id ?? null, dst ? null : entityName, entity.id, rel, ts);
      // 正文显式关系由 wirePageEdges 先行建立；仅补充尚不存在的 LLM 推断实边。
      if (dst && !findTypedEdge.get(pageId, dst.id, rel)) {
        insEdge.run(pageId, dst.id, null, null, rel, ts);
      }
    } else {
      insEdge.run(pageId, null, null, entity.id, rel, ts);
    }
  }
  db.prepare(`DELETE FROM entities WHERE id NOT IN (SELECT DISTINCT entity_id FROM edges WHERE entity_id IS NOT NULL)`).run();
  // 实体边已重建，图谱缓存失效（实体仅在单页模式展示，但缓存 key 含 scope）
  invalidateGraphCache();
}
