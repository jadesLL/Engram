import fs from 'node:fs';
import matter from 'gray-matter';
import { db } from '../lib/db.js';
import { readPage, writePage, safeJoin } from '../lib/vault.js';
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

/** 写操作日志到 Wiki/log.md（带年月日时分秒；时间倒序：新的在上） */
export function appendWikiLog(action: string, detail: string) {
  const rel = 'Wiki/log.md';
  const rd = readPage(rel);
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const line = `- ${stamp} ${action}：${detail}`;
  // 剥掉正文开头的标题行，把新条目插到标题正下方（倒序：新的在上），再接旧条目
  const HEADER = '# 操作日志';
  const body = rd ? String(rd.content).replace(/^#\s*操作日志\s*/, '').replace(/^[\s\r\n]+/, '') : '';
  const content = body ? `${HEADER}\n\n${line}\n${body}` : `${HEADER}\n\n${line}`;
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

/**
 * 一次性迁移：把 AIWorks/log/ 下的历史独立日志（Dream Cycle 运行文件 / upgrades.md /
 * merges.md / deleted.md / apply-errors.md）原始并入操作日志 Wiki/log.md（时间倒序，新的在上），
 * 并删除源文件与 DB 索引。迁移后 AIWorks/log 永久为空，Dream Cycle 也不再写它。
 * 幂等：无文件可迁移时直接返回。启动时调用一次。
 */
export function migrateAiLogsToOperationLog() {
  const dir = safeJoin('AIWorks/log');
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  if (!entries.length) return;

  const tsRe = /^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (.+)$/;
  const collected: { ts: string; line: string }[] = [];

  // 1. 现有操作日志条目（fs 直读 + gray-matter 剥 frontmatter，不走 readPage，避免 DB 未索引时读空）
  const logAbs = safeJoin('Wiki/log.md');
  if (fs.existsSync(logAbs)) {
    const body = String(matter(fs.readFileSync(logAbs, 'utf8')).content);
    for (const line of body.split(/\r?\n/)) {
      const m = line.match(tsRe);
      if (m) collected.push({ ts: m[1], line });
    }
  }

  // 2. 扫描 AIWorks/log/*.md，按类型原始转条目（不蒸馏）
  for (const entry of entries) {
    const abs = safeJoin(`AIWorks/log/${entry}`);
    let body = '';
    try {
      body = String(matter(fs.readFileSync(abs, 'utf8')).content);
    } catch {
      continue;
    }

    // Dream Cycle 每次运行独立文件：YYYY-MM-DD-HH-MM-SS.md
    const dc = entry.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})\.md$/);
    if (dc) {
      const ts = `${dc[1]}-${dc[2]}-${dc[3]} ${dc[4]}:${dc[5]}:${dc[6]}`;
      const counts = parseDreamCounts(body);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const detail = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join('｜');
      collected.push({ ts, line: `- ${ts} 智能整理：${detail}｜共 ${total} 项${total > 0 ? '，见整理报告' : '，无待处理'}` });
      continue;
    }

    // upgrades.md / merges.md / deleted.md / apply-errors.md：逐行原样并入
    for (const line of body.split(/\r?\n/)) {
      const m = line.match(tsRe);
      if (!m) continue;
      if (entry === 'upgrades.md') collected.push({ ts: m[1], line: `- ${m[1]} 实体升级：${m[2]}` });
      else collected.push({ ts: m[1], line }); // merges/deleted/apply-errors 原样保留
    }
  }

  // 3. 倒序去重，重建 Wiki/log.md
  collected.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const seen = new Set<string>();
  const lines = ['# 操作日志', ''];
  for (const c of collected) {
    if (seen.has(c.line)) continue;
    seen.add(c.line);
    lines.push(c.line);
  }
  lines.push('');
  writePage('Wiki/log.md', lines.join('\n'), { title: '操作日志', type: 'doc' });

  // 4. 删除已迁移源文件 + 清理其 DB 索引
  for (const entry of entries) {
    try { fs.unlinkSync(safeJoin(`AIWorks/log/${entry}`)); } catch { /* 单文件失败不阻塞 */ }
  }
  const logIds = db.prepare(`SELECT id FROM pages WHERE path LIKE 'AIWorks/log/%'`).all() as { id: string }[];
  if (logIds.length) {
    const ids = logIds.map((r) => r.id);
    const ph = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM pages WHERE id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM pages_fts WHERE page_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM chunks WHERE ref_type = 'page' AND ref_id IN (${ph})`).run(...ids);
    const ph2 = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM edges WHERE src_page IN (${ph}) OR dst_page IN (${ph2})`).run(...ids, ...ids);
  }
  try { regenerateIndex(); } catch { /* 索引重生成失败不阻塞 */ }
}

/** 解析 Dream Cycle 运行文件正文里的 8 项计数（死链/疑似重复/矛盾/…/实体升级） */
function parseDreamCounts(body: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const re = /^- (.+?)[:：](\d+)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) counts[m[1]] = Number(m[2]);
  return counts;
}
