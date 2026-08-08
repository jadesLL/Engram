import { db } from '../lib/db.js';
import { readPage, writePage } from '../lib/vault.js';
import { RELATION_WORDS } from './extractor.js';

/**
 * Wiki 自维护文件生成（SKILL 规范）：
 * - Wiki/index.md：按类型分组的 [[双链]] 目录
 * - Wiki/log.md：操作流水
 * - Wiki/关系/relationships.md：六词表关系落库
 * 这些文件参与索引但不参与分区展示（系统页）。
 */

/** 重新生成 Wiki/index.md（全量重写，幂等） */
export function regenerateIndex() {
  const pages = db
    .prepare(
      `SELECT title, type, path FROM pages
       WHERE deleted = 0 AND path LIKE 'Wiki/%'
         AND path NOT LIKE 'Wiki/归档/%' AND path NOT LIKE 'Wiki/查询/%'
         AND path NOT LIKE 'Wiki/关系/%'
         AND path != 'Wiki/index.md' AND path != 'Wiki/log.md'
       ORDER BY updated_at DESC`
    )
    .all() as any[];

  const groups: Record<string, string[]> = { 实体: [], 概念: [], 其他: [] };
  for (const p of pages) {
    const entry = `- [[${p.title}]]`;
    if (['person', 'project', 'org'].includes(p.type)) groups['实体'].push(entry);
    else if (p.type === 'concept') groups['概念'].push(entry);
    else groups['其他'].push(entry);
  }

  const lines = ['# LLM Wiki 索引', ''];
  for (const [g, items] of Object.entries(groups)) {
    lines.push(`## ${g}`, '');
    lines.push(...(items.length ? items : ['（暂无）']));
    lines.push('');
  }
  const total = pages.length;
  writePage('Wiki/index.md', lines.join('\n'), {
    title: 'LLM Wiki 索引',
    type: 'doc',
    summary: total ? `共 ${total} 个条目（实体 ${groups['实体'].length} / 概念 ${groups['概念'].length} / 其他 ${groups['其他'].length}）` : '暂无条目',
  });
}

/** 追加操作日志到 Wiki/log.md（带年月日时分秒） */
export function appendWikiLog(action: string, detail: string) {
  const rel = 'Wiki/log.md';
  const rd = readPage(rel);
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const line = `- ${stamp} ${action}：${detail}`;
  const content = rd ? `${rd.content}\n${line}` : `# 操作日志\n\n${line}`;
  writePage(rel, content + '\n', { title: '操作日志', type: 'doc' });
}

/** 重建六词表关系库 Wiki/关系/relationships.md */
export function regenerateRelationships() {
  const ph = RELATION_WORDS.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT e.rel, p1.title AS src, p2.title AS dst, e.dst_title
       FROM edges e
       JOIN pages p1 ON p1.id = e.src_page
       LEFT JOIN pages p2 ON p2.id = e.dst_page
       WHERE e.rel IN (${ph}) AND p1.deleted = 0
       ORDER BY e.rel, p1.title`
    )
    .all(...RELATION_WORDS) as any[];

  const byRel = new Map<string, string[]>();
  for (const r of rows) {
    const dst = r.dst || r.dst_title || '?';
    const line = `- [[${r.src}]]::${r.rel}::[[${dst}]]`;
    if (!byRel.has(r.rel)) byRel.set(r.rel, []);
    byRel.get(r.rel)!.push(line);
  }

  const lines = ['# 关系库', '', '> 六词表：主责 / 目标 / 管理 / 政委 / 带教 / 攻坚（每次写入后自动生成）', ''];
  for (const w of RELATION_WORDS) {
    const items = byRel.get(w) || [];
    if (!items.length) continue;
    lines.push(`## ${w}`, '');
    lines.push(...items);
    lines.push('');
  }
  writePage('Wiki/关系/relationships.md', lines.join('\n'), {
    title: '关系库',
    type: 'doc',
    summary: rows.length ? `共 ${rows.length} 条六词表关系` : '暂无关系',
  });
}
