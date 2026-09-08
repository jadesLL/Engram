import fs from 'node:fs';
import matter from 'gray-matter';
import { db } from '../lib/db.js';
import { readPage, writePage, safeJoin } from '../lib/vault.js';
import { RELATION_WORDS } from './extractor.js';

/**
 * AIWorks 系统区自维护文件（服务端生成，Agent 只读；检索权重 0，不挤占知识证据）：
 * - AIWorks/log/log.md：操作流水
 * - AIWorks/index/index.md：全库索引
 * - AIWorks/scheme/relationships.md：关系词表关系结构
 * 每次操作日志追加后同步重建索引与关系结构，系统区始终与知识库一致。
 */

export const LOG_PAGE = 'AIWorks/log/log.md';
const INDEX_PAGE = 'AIWorks/index/index.md';
const RELATIONSHIPS_PAGE = 'AIWorks/scheme/relationships.md';

/** 历史版本的系统文件位置：启动迁移并入新位置后删除 */
const LEGACY_SYSTEM_PAGES = ['Wiki/index.md', 'Wiki/log.md', 'Wiki/关系/relationships.md'];

/** 重新生成 AIWorks/index/index.md（全量重写，幂等） */
export function regenerateIndex() {
  const pages = db
    .prepare(
      `SELECT title, type, path FROM pages
       WHERE deleted = 0 AND path LIKE 'Wiki/%'
         AND path NOT LIKE 'Wiki/归档/%' AND path NOT LIKE 'Wiki/查询/%'
         AND path NOT LIKE 'Wiki/关系/%'
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

  const lines = ['# Engram 索引', ''];
  for (const [g, items] of Object.entries(groups)) {
    lines.push(`## ${g}`, '');
    lines.push(...(items.length ? items : ['（暂无）']));
    lines.push('');
  }
  const total = pages.length;
  writePage(INDEX_PAGE, lines.join('\n'), {
    title: 'Engram 索引',
    type: 'doc',
    summary: total ? `共 ${total} 个条目（实体 ${groups['实体'].length} / 概念 ${groups['概念'].length} / 其他 ${groups['其他'].length}）` : '暂无条目',
  });
}

/** 写操作日志到 AIWorks/log/log.md（带年月日时分秒；时间倒序：新的在上） */
export function appendWikiLog(action: string, detail: string) {
  const rd = readPage(LOG_PAGE);
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const line = `- ${stamp} ${action}：${detail}`;
  // 剥掉正文开头的标题行，把新条目插到标题正下方（倒序：新的在上），再接旧条目
  const HEADER = '# 操作日志';
  const body = rd ? String(rd.content).replace(/^#\s*操作日志\s*/, '').replace(/^[\s\r\n]+/, '') : '';
  const content = body ? `${HEADER}\n\n${line}\n${body}` : `${HEADER}\n\n${line}`;
  writePage(LOG_PAGE, content + '\n', { title: '操作日志', type: 'doc' });
  // 每次写操作都伴随日志追加，顺带重建索引与关系结构（全量重写，量级毫秒）
  try { regenerateIndex(); } catch { /* 索引重建失败不阻塞日志 */ }
  try { regenerateRelationships(); } catch { /* 关系结构重建失败不阻塞日志 */ }
}

/** 重建关系库 AIWorks/scheme/relationships.md（按词表分组） */
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

  const lines = ['# 关系库', '', `> 词表：${RELATION_WORDS.join(' / ')}（每次写入后自动生成）`, ''];
  for (const w of RELATION_WORDS) {
    const items = byRel.get(w) || [];
    if (!items.length) continue;
    lines.push(`## ${w}`, '');
    lines.push(...items);
    lines.push('');
  }
  writePage(RELATIONSHIPS_PAGE, lines.join('\n'), {
    title: '关系库',
    type: 'doc',
    summary: rows.length ? `共 ${rows.length} 条词表关系` : '暂无关系',
  });
}

/** 预置系统区三件套（新库首读不报「页面不存在」）并立即生成索引与关系结构 */
export function ensureSystemFiles() {
  if (!readPage(LOG_PAGE)) writePage(LOG_PAGE, '# 操作日志\n', { title: '操作日志', type: 'doc' });
  regenerateIndex();
  regenerateRelationships();
}

/**
 * 一次性迁移：历史版本把系统文件放在 Wiki 根与 Wiki/关系/ 下、Dream Cycle 运行日志
 * 放在 AIWorks/log/ 独立文件里。统一并入 AIWorks 系统区新位置：
 * - Wiki/log.md 与 AIWorks/log/*.md 的日志条目原始并入 AIWorks/log/log.md（时间倒序，新的在上，逐行去重）
 * - Wiki/index.md、Wiki/关系/relationships.md 直接删除（ensureSystemFiles 在新位置重新生成）
 * 幂等：无历史文件时直接返回。启动时调用一次。
 */
export function migrateLegacySystemFiles() {
  const logDir = safeJoin('AIWorks/log');
  const legacyDirEntries = fs.existsSync(logDir)
    ? fs.readdirSync(logDir).filter((f) => f.endsWith('.md'))
    : [];
  const hasLegacyLog = fs.existsSync(safeJoin('Wiki/log.md'));
  const hasLegacyGenerated =
    fs.existsSync(safeJoin('Wiki/index.md')) || fs.existsSync(safeJoin('Wiki/关系/relationships.md'));
  if (!legacyDirEntries.length && !hasLegacyLog && !hasLegacyGenerated) return;

  const tsRe = /^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (.+)$/;
  const collected: { ts: string; line: string }[] = [];

  // 1. 现有操作日志条目（新位置 + 旧 Wiki/log.md）：fs 直读 + gray-matter 剥 frontmatter，
  //    不走 readPage，避免 DB 未索引时读空
  for (const rel of [LOG_PAGE, 'Wiki/log.md']) {
    const abs = safeJoin(rel);
    if (!fs.existsSync(abs)) continue;
    const body = String(matter(fs.readFileSync(abs, 'utf8')).content);
    for (const line of body.split(/\r?\n/)) {
      const m = line.match(tsRe);
      if (m) collected.push({ ts: m[1], line });
    }
  }

  // 2. 扫描 AIWorks/log/*.md 历史独立日志，按类型原始转条目（不蒸馏）
  for (const entry of legacyDirEntries) {
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

  // 3. 有日志条目才重建日志页；倒序去重，新的在上
  if (collected.length) {
    collected.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    const seen = new Set<string>();
    const lines = ['# 操作日志', ''];
    for (const c of collected) {
      if (seen.has(c.line)) continue;
      seen.add(c.line);
      lines.push(c.line);
    }
    lines.push('');
    writePage(LOG_PAGE, lines.join('\n'), { title: '操作日志', type: 'doc' });
  }

  // 4. 删除历史文件，并清理其 DB 行与派生索引（索引/关系结构由 ensureSystemFiles 在新位置重新生成）
  const staleIds = LEGACY_SYSTEM_PAGES
    .map((rel) => (db.prepare(`SELECT id FROM pages WHERE path = ?`).get(rel) as { id: string } | undefined)?.id)
    .filter((id): id is string => Boolean(id));
  for (const entry of legacyDirEntries) {
    const row = db.prepare(`SELECT id FROM pages WHERE path = ?`).get(`AIWorks/log/${entry}`) as { id: string } | undefined;
    if (row) staleIds.push(row.id);
  }
  if (staleIds.length) {
    const ph = staleIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM pages WHERE id IN (${ph})`).run(...staleIds);
    db.prepare(`DELETE FROM pages_fts WHERE page_id IN (${ph})`).run(...staleIds);
    db.prepare(`DELETE FROM chunks WHERE ref_type = 'page' AND ref_id IN (${ph})`).run(...staleIds);
    db.prepare(`DELETE FROM edges WHERE src_page IN (${ph}) OR dst_page IN (${ph})`).run(...staleIds, ...staleIds);
  }
  for (const rel of LEGACY_SYSTEM_PAGES) {
    try { fs.unlinkSync(safeJoin(rel)); } catch { /* 单文件失败不阻塞 */ }
  }
  for (const entry of legacyDirEntries) {
    try { fs.unlinkSync(safeJoin(`AIWorks/log/${entry}`)); } catch { /* 单文件失败不阻塞 */ }
  }
}

/** 解析 Dream Cycle 运行文件正文里的 8 项计数（死链/疑似重复/矛盾/…/实体升级） */
function parseDreamCounts(body: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const re = /^- (.+?)[:：](\d+)\s*$/gm;
  for (const m of body.matchAll(re)) counts[m[1]] = Number(m[2]);
  return counts;
}
