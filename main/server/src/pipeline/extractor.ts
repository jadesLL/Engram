import { db, now } from '../lib/db.js';

/** 封闭关系词表（SKILL 规范）：[[A]]::关系词::[[B]] */
export const RELATION_WORDS = ['主责', '目标', '管理', '政委', '带教', '攻坚'] as const;

export interface TypedRelation {
  src: string;
  rel: string;
  dst: string;
}

/** 提取六词表类型化关系：[[A]]::主责::[[B]] */
export function extractTypedRelations(markdown: string): TypedRelation[] {
  const re = new RegExp(
    `\\[\\[([^\\]]+)\\]\\]::(${RELATION_WORDS.join('|')})::\\[\\[([^\\]]+)\\]\\]`,
    'g'
  );
  const out: TypedRelation[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    out.push({ src: m[1].trim(), rel: m[2], dst: m[3].trim() });
  }
  return out;
}

/** 从 markdown 中提取 [[wikilink]]（支持 [[标题|别名]]） */
export function extractWikiLinks(markdown: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    const t = m[1].trim();
    if (t) out.add(t);
  }
  return [...out];
}

/** 提取正文中的 #标签（排除标题行的 # 与代码块） */
export function extractInlineTags(markdown: string): string[] {
  const noCode = markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  const out = new Set<string>();
  const re = /(?<=^|\s)#([\p{L}\p{N}_/-]+)/gmu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noCode))) {
    out.add(m[1]);
  }
  return [...out];
}

/**
 * 全局死链重解析：新页面创建后，把指向其标题的未解析 wikilink 边回填为实边。
 * 在每次索引时顺带执行（代价极低），模拟 GBrain 的持续自布线。
 */
export function resolveDeadLinks() {
  db.exec(`
    UPDATE edges SET
      dst_page = (SELECT id FROM pages WHERE deleted = 0 AND lower(title) = lower(edges.dst_title)),
      dst_title = NULL
    WHERE rel = 'link' AND dst_page IS NULL AND dst_title IS NOT NULL
      AND EXISTS (SELECT 1 FROM pages WHERE deleted = 0 AND lower(title) = lower(edges.dst_title))
  `);
}
export function wirePageEdges(pageId: string, markdown: string) {
  const del = db.prepare(`DELETE FROM edges WHERE src_page = ? AND rel IN ('link', 'tag')`);
  del.run(pageId);
  // 六词表关系边也要清掉重建（rel 属于词表）
  db.prepare(
    `DELETE FROM edges WHERE src_page = ? AND rel IN (${RELATION_WORDS.map(() => '?').join(',')})`
  ).run(pageId, ...RELATION_WORDS);

  const links = extractWikiLinks(markdown);
  const findByTitle = db.prepare(
    `SELECT id, title FROM pages WHERE deleted = 0 AND lower(title) = lower(?)`
  );
  const ins = db.prepare(
    `INSERT INTO edges(src_page, dst_page, dst_title, entity_id, rel, created_at) VALUES(?, ?, ?, NULL, ?, ?)`
  );
  const ts = now();
  for (const target of links) {
    let hit = findByTitle.get(target) as { id: string } | undefined;
    // 链接文本带 .md 后缀(指向文件名)时剥离后缀重试,避免"页面明明存在却成死链"
    if (!hit && target.toLowerCase().endsWith('.md')) {
      hit = findByTitle.get(target.slice(0, -3)) as { id: string } | undefined;
    }
    ins.run(pageId, hit?.id ?? null, hit ? null : target, 'link', ts);
  }

  for (const tag of extractInlineTags(markdown)) {
    ins.run(pageId, null, `#${tag}`, 'tag', ts);
  }

  // 六词表类型化关系：[[A]]::关系::[[B]] → 边（src=当前页，dst=关系目标页）
  const myTitle = (db.prepare(`SELECT title FROM pages WHERE id = ?`).get(pageId) as any)?.title;
  for (const r of extractTypedRelations(markdown)) {
    // 仅当 A 就是当前页时，关系方向才有意义
    if (myTitle && r.src !== myTitle) continue;
    const dst = findByTitle.get(r.dst) as { id: string } | undefined;
    ins.run(pageId, dst?.id ?? null, dst ? null : r.dst, r.rel, ts);
  }
}
