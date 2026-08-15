import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { BRAIN_DIR, normalizeDir, isPageDir } from '../config.js';
import { db, newId, now } from './db.js';
import { ftsSegment } from './fts.js';
import { emit } from './events.js';

export interface PageMeta {
  id: string;
  path: string;
  title: string;
  type: string;
  tags: string[];
  summary: string;
  created_at: string;
  updated_at: string;
  deleted: number;
  word_count: number;
}

/** 防路径穿越：把相对路径解析到 brain 内，越界抛错 */
export function safeJoin(rel: string): string {
  const clean = rel.replace(/^[/\\]+/, '');
  const abs = path.resolve(BRAIN_DIR, clean);
  if (abs !== BRAIN_DIR && !abs.startsWith(BRAIN_DIR + path.sep)) {
    throw new Error('路径无效');
  }
  return abs;
}

export function toRel(abs: string): string {
  return path.relative(BRAIN_DIR, abs).split(path.sep).join('/');
}

/** 顶层目录固定展示顺序 */
const TOP_ORDER = ['原始资料', 'Wiki', 'AIWorks'];
/** 子目录固定顺序 */
const SUB_ORDER: Record<string, string[]> = {
  Wiki: ['概念', '实体', '查询', '归档'],
  AIWorks: ['index', 'log', 'scheme'],
};
/** 系统目录不在文件树展示 */
const HIDDEN = new Set(['.trash', 'assets']);

/** 递归列出 brain 目录树（页面 + 文件） */
export function listTree() {
  function walk(dir: string, orderList?: string[]): any[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: any[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (HIDDEN.has(e.name) && orderList === TOP_ORDER) continue;
      const abs = path.join(dir, e.name);
      const rel = toRel(abs);
      if (e.isDirectory()) {
        out.push({ kind: 'dir', name: e.name, path: rel, children: walk(abs, SUB_ORDER[e.name]) });
      } else if (e.name.toLowerCase().endsWith('.md')) {
        const page = db
          .prepare(`SELECT id, title, type, tags, updated_at FROM pages WHERE path = ? AND deleted = 0`)
          .get(rel) as any;
        out.push({
          kind: 'page',
          name: e.name,
          path: rel,
          id: page?.id,
          title: page?.title || e.name.replace(/\.md$/i, ''),
          type: page?.type || 'note',
          tags: page ? JSON.parse(page.tags) : [],
          updated_at: page?.updated_at,
        });
      } else {
        const stat = fs.statSync(abs);
        out.push({
          kind: 'file',
          name: e.name,
          path: rel,
          ext: path.extname(e.name).slice(1).toLowerCase(),
          size: stat.size,
        });
      }
    }
    // 固定顺序目录按预定义排序，其余目录在前、按名称排序
    return out.sort((a, b) => {
      if (orderList) {
        const ia = orderList.indexOf(a.name);
        const ib = orderList.indexOf(b.name);
        if (ia !== -1 || ib !== -1) {
          return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        }
      }
      return a.kind === b.kind
        ? a.name.localeCompare(b.name, 'zh-CN')
        : a.kind === 'dir' ? -1 : b.kind === 'dir' ? 1 : 0;
    });
  }
  return walk(BRAIN_DIR, TOP_ORDER);
}

/** frontmatter 字段规范化读取：中文规范键优先，同时兼容历史英文键。 */
export function normalizeFrontmatter(data: Record<string, any>): Record<string, any> {
  const normalized = { ...data };
  const aliases: Record<string, string[]> = {
    title: ['标题', 'title'],
    type: ['类型', 'type'],
    tags: ['标签', 'tags'],
    sources: ['来源', 'sources', 'source'],
    confidence: ['置信度', 'confidence'],
    domain: ['领域', 'domain'],
    retrieved: ['获取日期', 'retrieved'],
    created: ['创建日期', 'created'],
    updated: ['更新日期', 'updated'],
    summary: ['摘要', 'summary'],
    reviewed_at: ['最后复核日期', 'reviewed_at'],
  };
  for (const [key, keys] of Object.entries(aliases)) {
    const value = keys.map((candidate) => data[candidate]).find((candidate) => candidate !== undefined);
    if (value !== undefined) normalized[key] = value;
  }
  if (normalized.tags !== undefined && !Array.isArray(normalized.tags)) {
    normalized.tags = normalized.tags == null || normalized.tags === '' ? [] : [String(normalized.tags)];
  }
  if (normalized.sources !== undefined && !Array.isArray(normalized.sources)) {
    normalized.sources = normalized.sources == null || normalized.sources === '' ? [] : [normalized.sources];
  }
  return normalized;
}

/** 读取页面 frontmatter，并返回规范化字段。 */
export function readPageMeta(relPath: string): Record<string, any> {
  try {
    const abs = safeJoin(relPath);
    if (!fs.existsSync(abs)) return {};
    return normalizeFrontmatter(matter(fs.readFileSync(abs, 'utf8')).data as Record<string, any>);
  } catch {
    return {};
  }
}

/** 标题提取：frontmatter 标题 > 文件名（不用 H1，H1 属于正文内容） */
function extractTitle(data: Record<string, any>, _content: string, fallback: string): string {
  const fmTitle = data['标题'] ?? data.title;
  if (typeof fmTitle === 'string' && fmTitle.trim()) return fmTitle.trim();
  return fallback.replace(/\.md$/i, '');
}

function wordCount(text: string): number {
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const words = (text.replace(/[一-鿿]/g, ' ').match(/\S+/g) || []).length;
  return cjk + words;
}

function atomicWrite(abs: string, content: string | Buffer): void {
  const temp = `${abs}.${newId()}.tmp`;
  try {
    fs.writeFileSync(temp, content);
    fs.renameSync(temp, abs);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* already moved or absent */ }
    throw error;
  }
}

/** 解析 md 文件并 upsert 到 pages 表；无 id 时生成并回写 frontmatter。
 *  frontmatter 写入用中文字段名（标题/创建日期/更新日期/类型/来源/置信度/领域），
 *  读取兼容旧英文键。 */
export function syncPageFile(relPath: string): PageMeta | null {
  const abs = safeJoin(relPath);
  if (!fs.existsSync(abs)) return null;
  const raw = fs.readFileSync(abs, 'utf8');
  let parsed = matter(raw);
  let data = parsed.data as Record<string, any>;
  let changed = false;

  if (!data.id || typeof data.id !== 'string') {
    data.id = newId();
    changed = true;
  }
  const filename = path.basename(relPath).replace(/\.md$/i, '');
  const fmTitle = data['标题'] ?? data.title;
  const title = extractTitle({ title: fmTitle }, parsed.content, filename);
  if (fmTitle !== title) {
    data['标题'] = title;
    delete data.title;
    changed = true;
  }
  if (!data['创建日期'] && !data.created) {
    data['创建日期'] = now();
    changed = true;
  }
  // 统一中文键：迁移旧英文键
  if (data.created !== undefined) {
    if (!data['创建日期']) data['创建日期'] = data.created;
    delete data.created;
    changed = true;
  }
  if (data.updated !== undefined) {
    data['更新日期'] = data.updated;
    delete data.updated;
    changed = true;
  }
  if (data.type !== undefined) {
    if (!data['类型']) data['类型'] = data.type;
    delete data.type;
    changed = true;
  }
  if (changed) {
    data['更新日期'] = now();
    atomicWrite(abs, matter.stringify(parsed.content, data));
  }
  const fileMtime = fs.statSync(abs).mtime.toISOString();

  const normalized = normalizeFrontmatter(data);
  const tags = (normalized.tags || []).map(String);
  const meta: PageMeta = {
    id: String(data.id),
    path: relPath,
    title,
    type: String(normalized.type || 'note'),
    tags,
    summary: typeof normalized.summary === 'string' ? normalized.summary : '',
    created_at: String(normalized.created || now()),
    updated_at: String(normalized.updated || fileMtime),
    deleted: 0,
    word_count: wordCount(parsed.content),
  };

  db.prepare(
    `INSERT INTO pages(id, path, title, type, tags, summary, created_at, updated_at, deleted, word_count)
     VALUES(@id, @path, @title, @type, @tags, @summary, @created_at, @updated_at, 0, @word_count)
     ON CONFLICT(path) DO UPDATE SET
       title=excluded.title, type=excluded.type, tags=excluded.tags, summary=excluded.summary,
       updated_at=excluded.updated_at, deleted=0, word_count=excluded.word_count`
  ).run({ ...meta, tags: JSON.stringify(tags) });

  db.prepare(`DELETE FROM pages_fts WHERE page_id = ?`).run(meta.id);
  db.prepare(`INSERT INTO pages_fts(title, content, tags, page_id) VALUES(?, ?, ?, ?)`).run(
    ftsSegment(meta.title),
    ftsSegment(parsed.content),
    ftsSegment(tags.join(' ')),
    meta.id
  );
  return meta;
}

export function readPage(relPath: string): { meta: PageMeta; content: string } | null {
  const abs = safeJoin(relPath);
  if (!fs.existsSync(abs)) return null;
  const raw = fs.readFileSync(abs, 'utf8');
  const parsed = matter(raw);
  const meta = db.prepare(`SELECT * FROM pages WHERE path = ? AND deleted = 0`).get(relPath) as
    | PageMeta
    | undefined;
  if (!meta) return null;
  return { meta: { ...meta, tags: JSON.parse(meta.tags as any) }, content: parsed.content.trim() };
}

/** 写入映射：外部传入的英文字段 → 中文 frontmatter 键 */
const FM_KEY_MAP: Record<string, string> = {
  title: '标题',
  type: '类型',
  tags: '标签',
  sources: '来源',
  confidence: '置信度',
  domain: '领域',
  retrieved: '获取日期',
  created: '创建日期',
  updated: '更新日期',
  reviewed_at: '最后复核日期',
};

/** 允许写入 frontmatter 的扩展字段（映射后的键） */
const EXTRA_FM_KEYS = [
  '标题', '类型', '标签', 'summary',
  '领域', '置信度', '获取日期', '来源', '更新日期',
  'mention_count', 'status', 'next_upgrade_at', 'last_upgraded',
  'upgrade_evidence_hash', 'upgrade_rationale',
  'organized_content_hash', 'organize_rationale',
  '最后复核日期',
];

/** 写页面（保留 frontmatter 中的 id/创建日期，刷新更新日期；中文字段名） */
export function writePage(
  relPath: string,
  content: string,
  extra?: Record<string, any>
): PageMeta {
  const abs = safeJoin(relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  let data: Record<string, any> = {};
  if (fs.existsSync(abs)) {
    data = matter(fs.readFileSync(abs, 'utf8')).data;
  }
  if (!data.id) data.id = newId();
  if (!data['创建日期'] && !data.created) data['创建日期'] = now();
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      const ck = FM_KEY_MAP[k] || k;
      if (EXTRA_FM_KEYS.includes(ck) && v !== undefined) {
        data[ck] = v;
        // 清掉对应的旧英文键
        if (ck !== k) delete data[k];
      }
    }
  }

  atomicWrite(abs, matter.stringify(content, data));
  const meta = syncPageFile(relPath)!;
  emit('page-changed', { path: relPath, id: meta.id });
  return meta;
}

export function createPage(dir: string, title: string): PageMeta {
  // 固定目录约束：页面只能建在 Wiki 树内，空目录默认 Wiki 根
  const target = normalizeDir(dir || '') || 'Wiki';
  const finalDir = isPageDir(target) ? target : 'Wiki';
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '-').trim() || '未命名页面';
  let rel = path.posix.join(finalDir, `${safeTitle}.md`);
  let i = 1;
  while (fs.existsSync(safeJoin(rel))) {
    rel = path.posix.join(finalDir, `${safeTitle}-${i++}.md`);
  }
  return writePage(rel, `# ${safeTitle}\n\n`, { title: safeTitle });
}

/** 重命名/移动（文件与 DB 同步） */
export function movePage(oldRel: string, newRel: string): PageMeta | null {
  const oldAbs = safeJoin(oldRel);
  const newAbs = safeJoin(newRel);
  if (!fs.existsSync(oldAbs)) return null;
  fs.mkdirSync(path.dirname(newAbs), { recursive: true });
  fs.renameSync(oldAbs, newAbs);
  db.prepare(`UPDATE pages SET path = ?, updated_at = ? WHERE path = ?`).run(newRel, now(), oldRel);
  const meta = syncPageFile(newRel);
  if (meta) emit('page-moved', { oldPath: oldRel, newPath: newRel, id: meta.id });
  return meta;
}

export function mkdir(rel: string) {
  fs.mkdirSync(safeJoin(rel), { recursive: true });
}

/** 全量扫描 brain 目录：同步 pages/files 表（用于启动时与索引重建） */
export async function scanVault() {
  const seen = new Set<string>();
  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      const rel = toRel(abs);
      if (e.isDirectory()) {
        walk(abs);
      } else if (e.name.toLowerCase().endsWith('.md')) {
        seen.add(rel);
        syncPageFile(rel);
      }
    }
  }
  walk(BRAIN_DIR);
  // 标记已不存在的文件为 deleted
  const rows = db.prepare(`SELECT path FROM pages WHERE deleted = 0`).all() as { path: string }[];
  for (const r of rows) {
    if (!seen.has(r.path)) {
      db.prepare(`UPDATE pages SET deleted = 1 WHERE path = ?`).run(r.path);
    }
  }

  // 原始资料补齐消化：递归扫描直接拷入目录/历史遗留文件，自动入队。
  try {
    const { llmReady } = await import('./llm.js');
    const { enqueue } = await import('../jobQueue.js');
    const {
      extractionDetails,
      extractionIsCurrent,
      scheduleFileExtraction,
      supportsFileExtraction,
    } = await import('../pipeline/fileExtraction.js');
    const walkRaw = (relative: string) => {
      const entries = fs.readdirSync(safeJoin(relative), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const child = `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
          walkRaw(child);
          continue;
        }
        if (supportsFileExtraction(child)) {
          const extraction = extractionDetails(child);
          if (!extraction || extraction.status !== 'completed' || !extractionIsCurrent(child)) {
            scheduleFileExtraction(child, { mode: 'auto', ingestAfter: true });
          }
          continue;
        }
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (!llmReady() || !['md', 'markdown', 'txt', 'docx', 'xlsx', 'pptx'].includes(ext)) continue;
        const done = db.prepare(`SELECT path FROM ingest_log WHERE path = ? AND status = 'completed'`).get(child);
        if (!done) enqueue('ingest', { path: child });
      }
    };
    walkRaw('原始资料');
  } catch { /* 原始资料目录为空或不存在时忽略 */ }
}
