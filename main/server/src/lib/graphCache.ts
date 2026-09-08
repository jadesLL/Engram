import { db } from './db.js';

// 图谱数据内存缓存：读多写少，命中直接返回，避免重复查询+拼装。
// 由 pipeline/indexer 在页面建边后显式失效，保证保存后立即可见（无 TTL 陈旧窗口）。
const cache = new Map<string, { data: any; ts: number }>();
const TTL = 60_000;
const MAX = 8;

/** 页面关联数据：图谱邻居（出边+入边）与实体关联；REST /related 与 MCP related_pages 共用 */
export function relatedPageData(pageId: string): {
  neighbors: Array<{ id: string; title: string; path: string; type: string; direction: 'in' | 'out'; rel: string }>;
  similar: unknown[];
  entities: Array<{ name: string; type: string; rel: string }>;
} {
  const neighbors = db
    .prepare(
      `SELECT DISTINCT p.id, p.title, p.path, p.type,
              CASE WHEN e.src_page = ? THEN 'out' ELSE 'in' END AS direction, e.rel
       FROM edges e JOIN pages p ON p.id = (CASE WHEN e.src_page = ? THEN e.dst_page ELSE e.src_page END)
       WHERE (e.src_page = ? OR e.dst_page = ?) AND p.deleted = 0 AND e.dst_page IS NOT NULL`
    )
    .all(pageId, pageId, pageId, pageId) as any[];
  const entities = db
    .prepare(
      `SELECT e2.name, e2.type, e.rel FROM edges e JOIN entities e2 ON e2.id = e.entity_id
       WHERE e.src_page = ? AND e.entity_id IS NOT NULL`
    )
    .all(pageId) as any[];
  return { neighbors, similar: [], entities };
}

export function getGraphCache(key: string): any | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > TTL) {
    cache.delete(key);
    return undefined;
  }
  return entry.data;
}

export function setGraphCache(key: string, data: any): void {
  cache.delete(key); // 重新插入到末尾，维护近似 LRU 顺序
  cache.set(key, { data, ts: Date.now() });
  if (cache.size > MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
}

export function invalidateGraphCache(): void {
  cache.clear();
}
