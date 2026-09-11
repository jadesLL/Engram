import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { db } from '../lib/db.js';
import { readPage, writePage, safeJoin } from '../lib/vault.js';
import { RELATION_WORDS } from './extractor.js';

/**
 * AIWorks 系统区自维护文件（服务端生成，Agent 只读；检索权重 0，不挤占知识证据）：
 * - AIWorks/log/log.md：操作流水
 * - AIWorks/index/index.md：全库索引（概念 / 实体按类型细分）
 * - AIWorks/scheme/relationships.md：关系结构（词表关系 + 双链关联 + 待建页面）
 * 每次操作日志追加后同步重建索引与关系结构，系统区始终与知识库一致。
 */

export const LOG_PAGE = 'AIWorks/log/log.md';
const INDEX_PAGE = 'AIWorks/index/index.md';
const RELATIONSHIPS_PAGE = 'AIWorks/scheme/relationships.md';

/** 历史版本的系统文件位置：启动迁移并入新位置后删除 */
const LEGACY_SYSTEM_PAGES = ['Wiki/index.md', 'Wiki/log.md', 'Wiki/关系/relationships.md'];

/** 实体页类型 → 索引分组标签（与指南五类实体词表一致；数组顺序即展示顺序） */
const ENTITY_TYPE_GROUPS: Array<{ type: string; label: string }> = [
  { type: 'person', label: '人员' },
  { type: 'customer', label: '客户' },
  { type: 'org', label: '组织' },
  { type: 'project', label: '项目' },
  { type: 'other', label: '其他' },
];

const zhCompare = (a: string, b: string) => a.localeCompare(b, 'zh-CN');

/**
 * 索引/关系库共用的页面归类：概念独立成组，实体按 frontmatter 类型细分。
 * 历史类型（place/work/doc/note 等）按目录兜底归组，保证任何页面都不漏出索引。
 */
function classifyPage(type: unknown, relPath: string): { group: '概念' | '实体' | '未分类'; label?: string } {
  const t = String(type || '').toLowerCase();
  if (t === 'concept') return { group: '概念' };
  const entity = ENTITY_TYPE_GROUPS.find((g) => g.type === t);
  if (entity) return { group: '实体', label: entity.label };
  if (relPath.startsWith('Wiki/概念/')) return { group: '概念' };
  if (relPath.startsWith('Wiki/实体/')) return { group: '实体', label: '其他' };
  return { group: '未分类' };
}

/** 索引收录范围：Wiki 树下的知识页（归档/查询/关系为历史遗留区，不进索引） */
function wikiIndexPages(): Array<{ title: string; type: string; path: string }> {
  return db
    .prepare(
      `SELECT title, type, path FROM pages
       WHERE deleted = 0 AND path LIKE 'Wiki/%'
         AND path NOT LIKE 'Wiki/归档/%' AND path NOT LIKE 'Wiki/查询/%'
         AND path NOT LIKE 'Wiki/关系/%'`
    )
    .all() as any[];
}

/** 重新生成 AIWorks/index/index.md（全量重写，幂等；按分类建组） */
export function regenerateIndex() {
  const pages = wikiIndexPages();

  const concepts: string[] = [];
  const entities = new Map<string, string[]>(ENTITY_TYPE_GROUPS.map((g) => [g.label, []]));
  const uncategorized: string[] = [];
  for (const p of pages) {
    const title = String(p.title);
    const { group, label } = classifyPage(p.type, String(p.path));
    if (group === '概念') concepts.push(title);
    else if (group === '实体') entities.get(label!)!.push(title);
    else uncategorized.push(title);
  }
  concepts.sort(zhCompare);
  for (const list of entities.values()) list.sort(zhCompare);
  uncategorized.sort(zhCompare);

  const entityTotal = [...entities.values()].reduce((n, list) => n + list.length, 0);
  const total = concepts.length + entityTotal + uncategorized.length;
  const counts = `概念 ${concepts.length} · 实体 ${entityTotal}${uncategorized.length ? ` · 未分类 ${uncategorized.length}` : ''}`;

  const lines = ['# Engram 索引', ''];
  if (!total) {
    lines.push('（暂无页面）', '');
  } else {
    lines.push(`> 共 ${total} 个条目（${counts}）· 每次写入后自动重建`, '');
    if (concepts.length) lines.push(`## 概念（${concepts.length}）`, '', ...concepts.map((t) => `- [[${t}]]`), '');
    if (entityTotal) {
      lines.push(`## 实体（${entityTotal}）`, '');
      for (const [label, list] of entities) {
        if (!list.length) continue;
        lines.push(`### ${label}（${list.length}）`, '', ...list.map((t) => `- [[${t}]]`), '');
      }
    }
    if (uncategorized.length) {
      lines.push(`## 未分类（${uncategorized.length}）`, '', ...uncategorized.map((t) => `- [[${t}]]`), '');
    }
  }
  writePage(INDEX_PAGE, lines.join('\n'), {
    title: 'Engram 索引',
    type: 'doc',
    summary: total ? `共 ${total} 个条目（${counts}）` : '暂无条目',
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

/**
 * 重建关系库 AIWorks/scheme/relationships.md：
 * - 词表关系：正文显式声明的 [[A]]::关系词::[[B]]
 * - 双链关联：Wiki 页之间的 [[双链]] 结构（按分类 + 源页面聚合，死链标注「待建」）
 * - 待建页面：被双链指向但尚未建页的目标（反向索引到来源页）
 * 只读 Wiki 页之间的真实边；系统页自身不参与建边，不会自我污染。
 */
export function regenerateRelationships() {
  const ph = RELATION_WORDS.map(() => '?').join(',');

  const typed = db
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
  for (const r of typed) {
    const dst = r.dst || r.dst_title || '?';
    if (!byRel.has(r.rel)) byRel.set(r.rel, []);
    byRel.get(r.rel)!.push(`- [[${r.src}]]::${r.rel}::[[${dst}]]`);
  }

  const links = db
    .prepare(
      `SELECT p.title AS src, p.type AS type, p.path AS path,
              p2.title AS dst, e.dst_title AS dead
       FROM edges e
       JOIN pages p ON p.id = e.src_page AND p.deleted = 0
       LEFT JOIN pages p2 ON p2.id = e.dst_page
       WHERE e.rel = 'link' AND p.path LIKE 'Wiki/%'
         AND p.path NOT LIKE 'Wiki/归档/%' AND p.path NOT LIKE 'Wiki/查询/%'
         AND p.path NOT LIKE 'Wiki/关系/%'`
    )
    .all() as any[];

  const outlinks = new Map<
    string,
    { group: string; label?: string; live: string[]; dead: string[] }
  >();
  const deadRefs = new Map<string, Set<string>>();
  let selfLinks = 0;
  for (const r of links) {
    const src = String(r.src);
    if (!outlinks.has(src)) {
      const { group, label } = classifyPage(r.type, String(r.path));
      outlinks.set(src, { group, label, live: [], dead: [] });
    }
    const entry = outlinks.get(src)!;
    if (r.dst) {
      // 自环无意义：词表关系写法 [[A]]::关系::[[B]] 也会被 wikilink 抽取当成 [[A]]，这里剔掉
      const dst = String(r.dst);
      if (dst === src) selfLinks++;
      else entry.live.push(dst);
    } else if (r.dead) {
      const dead = String(r.dead);
      entry.dead.push(dead);
      if (!deadRefs.has(dead)) deadRefs.set(dead, new Set());
      deadRefs.get(dead)!.add(src);
    }
  }

  const pageRows = wikiIndexPages();
  const entityTotal = pageRows.filter((p) => classifyPage(p.type, p.path).group === '实体').length;
  const conceptTotal = pageRows.filter((p) => classifyPage(p.type, p.path).group === '概念').length;
  const uncategorizedTotal = pageRows.length - entityTotal - conceptTotal;
  const deadEdges = [...deadRefs.values()].reduce((n, s) => n + s.size, 0);
  const linkTotal = links.length - selfLinks;

  const lines = ['# 关系库', '', `> 词表：${RELATION_WORDS.join(' / ')}（每次写入后自动生成）`, ''];
  lines.push('## 概览', '');
  lines.push(
    `- 页面 ${pageRows.length} 个（概念 ${conceptTotal} · 实体 ${entityTotal}${uncategorizedTotal ? ` · 未分类 ${uncategorizedTotal}` : ''}）`
  );
  lines.push(
    `- 词表关系 ${typed.length} 条 · 双链关联 ${linkTotal} 条（已解析 ${linkTotal - deadEdges} / 待建 ${deadRefs.size} 个目标）`
  );
  lines.push('');

  if (typed.length) {
    lines.push(`## 词表关系（${typed.length}）`, '');
    for (const w of RELATION_WORDS) {
      const items = byRel.get(w) || [];
      if (!items.length) continue;
      lines.push(`### ${w}（${items.length}）`, '', ...items, '');
    }
  }

  if (outlinks.size) {
    lines.push(`## 双链关联（${linkTotal}）`, '');
    const groups: Array<{ key: string; title: string }> = [
      { key: '概念', title: '概念' },
      { key: '实体', title: '实体' },
      { key: '未分类', title: '未分类' },
    ];
    for (const g of groups) {
      const rows = [...outlinks.entries()]
        .filter(([, v]) => v.group === g.key)
        .sort((a, b) => zhCompare(a[0], b[0]));
      if (!rows.length) continue;
      lines.push(`### ${g.title}（${rows.length}）`, '');
      for (const [src, v] of rows) {
        const targets = [
          ...v.live.sort(zhCompare).map((t) => `[[${t}]]`),
          ...v.dead.sort(zhCompare).map((t) => `[[${t}]]（待建）`),
        ];
        if (!targets.length) continue;
        lines.push(`- [[${src}]] → ${targets.join('、')}`);
      }
      lines.push('');
    }
  }

  if (deadRefs.size) {
    lines.push(`## 待建页面（${deadRefs.size}）`, '');
    for (const [dead, refs] of [...deadRefs.entries()].sort((a, b) => zhCompare(a[0], b[0]))) {
      const from = [...refs].sort(zhCompare).map((s) => `[[${s}]]`).join('、');
      lines.push(`- [[${dead}]] ← ${from}`);
    }
    lines.push('');
  }

  writePage(RELATIONSHIPS_PAGE, lines.join('\n'), {
    title: '关系库',
    type: 'doc',
    summary: typed.length || linkTotal
      ? `词表关系 ${typed.length} 条 · 双链关联 ${linkTotal} 条`
      : '暂无关系',
  });
}

/** 静态系统页清单：缺失即建（每次启动检查，新库开库即有，不等内容用到才补） */
const STATIC_SYSTEM_PAGES: Array<{ path: string; title: string; body: string }> = [
  { path: LOG_PAGE, title: '操作日志', body: '# 操作日志\n' },
  { path: 'AIWorks/log/conflict.md', title: '同步冲突记录', body: '# 同步冲突记录\n' },
  {
    path: '同步冲突/说明.md',
    title: '同步冲突备份',
    body: [
      '# 同步冲突备份',
      '',
      '> 多端同步两端同时修改同一页面且无法自动合并时，后到方的完整内容会自动备份为',
      '> 本目录下的独立页面（不丢内容，线上页面以先到方为准）；AIWorks/log/conflict.md',
      '> 只保留冲突流水记录。',
      '',
      '请人工核对后把内容合并回原页面，再删除对应备份页。本说明页由系统维护，可随时删除，',
      '下次启动会自动重建。',
      '',
    ].join('\n'),
  },
];

/** 预置系统区页面（静态页缺失即建；索引与关系结构无条件重建），每次启动都会执行 */
export function ensureSystemFiles() {
  for (const p of STATIC_SYSTEM_PAGES) {
    // 按「文件是否存在」判断，而不是 readPage()：readPage 依赖 pages 表行，
    // 行缺失（迁移误删行、DB 重建）时会把磁盘上仍有内容的系统页覆盖成空模板。
    // 文件已存在时的 DB 行由启动顺序中的 scanVault() 负责补齐。
    if (!fs.existsSync(safeJoin(p.path))) writePage(p.path, p.body, { title: p.title, type: 'doc' });
  }
  regenerateIndex();
  regenerateRelationships();
}

/**
 * 一次性迁移：历史版本把系统文件放在 Wiki 根与 Wiki/关系/ 下、Dream Cycle 运行日志
 * 放在 AIWorks/log/ 独立文件里。统一并入 AIWorks 系统区新位置：
 * - Wiki/log.md 与 AIWorks/log/ 下「除当前日志页外」的历史日志，条目原始并入
 *   AIWorks/log/log.md（时间倒序，新的在上，逐行去重）
 * - Wiki/index.md、Wiki/关系/relationships.md 直接删除（ensureSystemFiles 在新位置重新生成）
 * 幂等：无历史文件时直接返回。启动时调用一次。
 */
export function migrateLegacySystemFiles() {
  const logDir = safeJoin('AIWorks/log');
  // 必须排除当前操作日志页本身：它自 b4abda3 起就住在 AIWorks/log/ 下，
  // 若把它当作历史遗留文件，每次启动都会先重写再 unlink，操作日志永远为空。
  const currentLogName = path.posix.basename(LOG_PAGE);
  const legacyDirEntries = fs.existsSync(logDir)
    ? fs.readdirSync(logDir).filter((f) => f.endsWith('.md') && f !== currentLogName)
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
