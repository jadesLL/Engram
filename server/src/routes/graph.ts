import { FastifyInstance } from 'fastify';
import { db } from '../lib/db.js';
import { requireAuth } from './auth.js';

export async function graphRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /**
   * 图谱数据：全局（?scope=global）或单页局部（?scope=page&id=xxx&depth=2）
   * 返回 vis-network 格式的 nodes/edges
   */
  app.get('/api/graph', async (req) => {
    const { scope, id, depth } = req.query as { scope?: string; id?: string; depth?: string };

    let pageIds: Set<string>;
    if (scope === 'page' && id) {
      // BFS 扩展
      pageIds = new Set([id]);
      let frontier = [id];
      const maxDepth = Math.min(Number(depth) || 2, 3);
      for (let d = 0; d < maxDepth; d++) {
        const next: string[] = [];
        for (const pid of frontier) {
          const rows = db
            .prepare(
              `SELECT dst_page AS p FROM edges WHERE src_page = ? AND dst_page IS NOT NULL
               UNION SELECT src_page AS p FROM edges WHERE dst_page = ?`
            )
            .all(pid, pid) as any[];
          for (const r of rows) {
            if (!pageIds.has(r.p)) {
              pageIds.add(r.p);
              next.push(r.p);
            }
          }
        }
        frontier = next;
        if (frontier.length === 0 || pageIds.size > 200) break;
      }
    } else {
      pageIds = new Set(
        (db.prepare(`SELECT id FROM pages WHERE deleted = 0 LIMIT 500`).all() as any[]).map((r) => r.id)
      );
    }

    const ids = [...pageIds];
    if (ids.length === 0) return { nodes: [], edges: [] };
    const ph = ids.map(() => '?').join(',');

    const pages = db
      .prepare(`SELECT id, title, type, word_count FROM pages WHERE deleted = 0 AND id IN (${ph})`)
      .all(...ids) as any[];

    const edges = db
      .prepare(
        `SELECT src_page, dst_page, dst_title, rel FROM edges
         WHERE src_page IN (${ph}) AND rel IN ('link')`
      )
      .all(...ids) as any[];

    const entityEdges = db
      .prepare(
        `SELECT e.src_page, e.rel, en.id AS entity_id, en.name, en.type
         FROM edges e JOIN entities en ON en.id = e.entity_id
         WHERE e.src_page IN (${ph}) AND e.entity_id IS NOT NULL`
      )
      .all(...ids) as any[];

    const TYPE_COLORS: Record<string, string> = {
      note: '#64748b', concept: '#16a34a', person: '#ea580c', project: '#7c3aed', doc: '#2563eb', org: '#0891b2',
    };

    const nodes: any[] = pages.map((p) => ({
      id: p.id,
      label: p.title,
      group: p.type,
      title: `${p.title}（${p.type}）`,
      color: TYPE_COLORS[p.type] || TYPE_COLORS.note,
      value: Math.max(1, Math.min(10, Math.log2((p.word_count || 1) + 1))),
    }));

    const vEdges: any[] = [];
    const deadSet = new Set<string>();
    for (const e of edges) {
      if (e.dst_page && pageIds.has(e.dst_page)) {
        vEdges.push({ from: e.src_page, to: e.dst_page, arrows: 'to', color: { color: '#94a3b8' } });
      } else if (e.dst_title) {
        // 死链显示为红色小圆点（虚线边连接）
        const deadId = `dead:${e.dst_title}`;
        if (!deadSet.has(deadId)) {
          deadSet.add(deadId);
          nodes.push({
            id: deadId, label: e.dst_title, group: 'dead',
            color: { background: '#fca5a5', border: '#ef4444' },
            borderWidth: 1.5,
            value: 1,
            font: { color: '#b91c1c', size: 12 },
          });
        }
        vEdges.push({ from: e.src_page, to: deadId, arrows: 'to', dashes: true, color: { color: '#fca5a5' } });
      }
    }

    // 实体节点（仅在单页模式下展开，避免全局图过密）
    if (scope === 'page') {
      const ENT_COLORS: Record<string, string> = {
        person: '#f59e0b', concept: '#22c55e', project: '#a855f7', org: '#06b6d4', tech: '#3b82f6',
      };
      const entSet = new Set<number>();
      for (const e of entityEdges) {
        const nid = `ent:${e.entity_id}`;
        if (!entSet.has(e.entity_id)) {
          entSet.add(e.entity_id);
          nodes.push({
            id: nid, label: e.name, group: `entity-${e.type}`, shape: 'ellipse',
            color: ENT_COLORS[e.type] || '#a3a3a3', font: { size: 12 },
          });
        }
        vEdges.push({
          from: e.src_page, to: nid, arrows: 'to', label: e.rel,
          font: { size: 10, color: '#94a3b8' }, color: { color: '#d4d4d8' }, dashes: [2, 4],
        });
      }
    }

    return { nodes, edges: vEdges };
  });
}
