import { FastifyInstance } from 'fastify';
import { db } from '../lib/db.js';
import { requireAuth } from './auth.js';
import { getGraphCache, setGraphCache } from '../lib/graphCache.js';

export async function graphRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /**
   * 图谱数据：全局（?scope=global）或单页局部（?scope=page&id=xxx&depth=2）
   * 返回精简 nodes/edges，渲染样式（颜色/大小/虚线）由前端统一负责。
   * 节点字段：id/label/group/raw/words；边字段：from/to（实体边额外带 label）。
   */
  app.get('/api/graph', async (req) => {
    const { scope, id, depth } = req.query as { scope?: string; id?: string; depth?: string };

    // 读取多写少，命中缓存直接返回（保存页面时由 indexer 失效）
    const cacheKey = `${scope || ''}|${id || ''}|${depth || ''}`;
    const cached = getGraphCache(cacheKey);
    if (cached) return cached;

    let pageIds: Set<string>;
    if (scope === 'page' && id) {
      // BFS 扩展
      pageIds = new Set([id]);
      let frontier = [id];
      const maxDepth = Math.min(Number(depth) || 2, 3);
      for (let d = 0; d < maxDepth; d++) {
        if (frontier.length === 0) break;
        // 批量取整层邻居，消除 N+1（原来逐页一条 SQL）
        const ph2 = frontier.map(() => '?').join(',');
        const rows = db
          .prepare(
            `SELECT dst_page AS p FROM edges WHERE src_page IN (${ph2}) AND dst_page IS NOT NULL AND rel='link'
             UNION
             SELECT src_page AS p FROM edges WHERE dst_page IN (${ph2}) AND rel='link'`
          )
          .all(...frontier, ...frontier) as any[];
        const next: string[] = [];
        for (const r of rows) {
          if (!pageIds.has(r.p)) {
            pageIds.add(r.p);
            next.push(r.p);
          }
        }
        frontier = next;
        if (pageIds.size > 200) break;
      }
    } else {
      // 全局：按度数（参与的 link 边数）排序取核心 150 个节点，避免随节点增长沦为毛线团
      pageIds = new Set(
        (db
          .prepare(
            `SELECT id FROM (
               SELECT p.id AS id,
                 (SELECT COUNT(*) FROM edges e WHERE e.rel='link' AND (e.src_page=p.id OR e.dst_page=p.id)) AS deg
               FROM pages p WHERE p.deleted=0
             ) t ORDER BY deg DESC, id LIMIT 150`
          )
          .all() as any[]).map((r) => r.id)
      );
    }

    const ids = [...pageIds];
    if (ids.length === 0) {
      const empty = { nodes: [], edges: [] };
      setGraphCache(cacheKey, empty);
      return empty;
    }
    const ph = ids.map(() => '?').join(',');

    const pages = db
      .prepare(`SELECT id, title, type, path, word_count FROM pages WHERE deleted = 0 AND id IN (${ph})`)
      .all(...ids) as any[];

    const edges = db
      .prepare(
        `SELECT src_page, dst_page, dst_title, rel FROM edges
         WHERE src_page IN (${ph}) AND rel IN ('link')`
      )
      .all(...ids) as any[];

    const nodes: any[] = pages.map((p) => ({
      id: p.id,
      label: p.title,
      group: p.type,
      raw: p.path.startsWith('原始资料/'),
      words: p.word_count || 0,
    }));

    const vEdges: any[] = [];
    const deadSet = new Set<string>();
    for (const e of edges) {
      if (e.dst_page && pageIds.has(e.dst_page)) {
        vEdges.push({ from: e.src_page, to: e.dst_page });
      } else if (e.dst_title) {
        // 死链节点（前端画成红色空心点，虚线边连接）
        const deadId = `dead:${e.dst_title}`;
        if (!deadSet.has(deadId)) {
          deadSet.add(deadId);
          nodes.push({ id: deadId, label: e.dst_title, group: 'dead', raw: false, words: 0 });
        }
        vEdges.push({ from: e.src_page, to: deadId });
      }
    }

    // 实体节点（仅在单页模式下展开，避免全局图过密；全局模式不跑此 JOIN）
    if (scope === 'page') {
      const entityEdges = db
        .prepare(
          `SELECT e.src_page, e.rel, en.id AS entity_id, en.name, en.type
           FROM edges e JOIN entities en ON en.id = e.entity_id
           WHERE e.src_page IN (${ph}) AND e.entity_id IS NOT NULL`
        )
        .all(...ids) as any[];
      const entSet = new Set<number>();
      for (const e of entityEdges) {
        const nid = `ent:${e.entity_id}`;
        if (!entSet.has(e.entity_id)) {
          entSet.add(e.entity_id);
          nodes.push({ id: nid, label: e.name, group: `entity-${e.type}`, raw: false, words: 0 });
        }
        vEdges.push({ from: e.src_page, to: nid, label: e.rel });
      }
    }

    const result = { nodes, edges: vEdges };
    setGraphCache(cacheKey, result);
    return result;
  });
}
