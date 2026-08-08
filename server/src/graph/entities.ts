import { db, now } from '../lib/db.js';
import { invalidateGraphCache } from '../lib/graphCache.js';
import { chatJson, llmReady } from '../lib/llm.js';
import { readPage } from '../lib/vault.js';
import { entitiesSystem, entitiesUser, type EntityItem } from '../prompts/entities.js';
import { RELATION_WORDS } from '../pipeline/extractor.js';
import { classifyEntityName, type EntityRosterEntry } from '../pipeline/entityAmbiguity.js';

/**
 * LLM 实体抽取（GBrain 自布线图谱的 LLM 部分）：
 * 从页面提取实体（人物/概念/项目/组织）及与页面的类型化关系，写入 entities/edges。
 * 对齐：携带已有实体名录（优先链接）、关系向六词表靠拢。
 */
export async function extractEntities(pageId: string): Promise<void> {
  if (!llmReady()) return;
  const page = db.prepare(`SELECT * FROM pages WHERE id = ? AND deleted = 0`).get(pageId) as any;
  if (!page) return;
  const rd = readPage(page.path);
  if (!rd || rd.content.length < 30) return;

  // 实体名录：已有实体/概念标题（便于优先链接、减少孤立实体）
  const rows = db
    .prepare(`SELECT id, title, type, summary FROM pages WHERE deleted = 0 AND path LIKE 'Wiki/%' ORDER BY updated_at DESC LIMIT 500`)
    .all() as EntityRosterEntry[];
  const roster = rows.map((r) => `- ${r.title}`).join('\n');

  let items: EntityItem[];
  try {
    items = await chatJson<EntityItem[]>(
      [
        { role: 'system', content: entitiesSystem(roster) },
        { role: 'user', content: entitiesUser(page.title, rd.content.slice(0, 3000)) },
      ],
      { temperature: 0.1, maxTokens: 500, retries: 0, tag: 'entities' }
    );
  } catch (e: any) {
    console.warn(`[entities] ${page.title} 抽取失败: ${e.message}`);
    return;
  }
  if (!Array.isArray(items)) return;

  db.prepare(`DELETE FROM edges WHERE src_page = ? AND entity_id IS NOT NULL`).run(pageId);
  // 六词表关系边也清掉重建（避免与 extractor 的正则关系边重复堆积）
  db.prepare(
    `DELETE FROM edges WHERE src_page = ? AND rel IN (${RELATION_WORDS.map(() => '?').join(',')})`
  ).run(pageId, ...RELATION_WORDS);

  const findEntity = db.prepare(`SELECT id FROM entities WHERE name = ?`);
  const insEntity = db.prepare(`INSERT INTO entities(name, type) VALUES(?, ?)`);
  const insEdge = db.prepare(
    `INSERT INTO edges(src_page, dst_page, dst_title, entity_id, rel, created_at) VALUES(?, ?, ?, ?, ?, ?)`
  );
  const findByTitle = db.prepare(`SELECT id FROM pages WHERE deleted = 0 AND lower(title) = lower(?)`);
  const ts = now();
  for (const it of items.slice(0, 8)) {
    if (!it?.name) continue;
    const ambiguity = classifyEntityName(it.name, it.type === 'tech' ? 'concept' : it.type, rows, rd.content);
    if (ambiguity?.category === 'role_title') continue;
    const canonical = ambiguity?.suggestions.length === 1 && ambiguity.suggestions[0].score >= 0.9
      ? ambiguity.suggestions[0]
      : null;
    if (ambiguity && !canonical) continue;
    const entityName = canonical?.title || it.name;
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
      // 同时建到目标页的实边（若存在）
      if (dst) {
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
