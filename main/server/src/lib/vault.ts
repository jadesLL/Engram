import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { BRAIN_DIR, normalizeDir, isPageDir } from '../config.js';
import { isInboxPath } from './brainPaths.js';
import { RAW_SECTION_NAMES } from './rawSections.js';
import { db, newId, now } from './db.js';
import { ftsSegment } from './fts.js';
import { emit } from './events.js';
import { noteAppWrite } from './appWrites.js';

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
const TOP_ORDER = ['原始资料', 'Wiki', 'AIWorks', '同步冲突'];
/** 子目录固定顺序（原始资料的二级分类见 lib/rawSections.ts） */
const SUB_ORDER: Record<string, string[]> = {
  原始资料: [...RAW_SECTION_NAMES],
  Wiki: ['概念', '实体', '查询', '归档'],
  AIWorks: ['index', 'log', 'scheme'],
};
/** 系统目录不在文件树展示（任意层级都隐藏）。
 *  原先的判定写成 `HIDDEN.has(name) && orderList === TOP_ORDER`——靠数组引用相等
 *  表达「只在根层」，嵌套的 assets/ 会漏出来，语义也脆弱；这里直接按名字隐藏。 */
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
      if (HIDDEN.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = toRel(abs);
      // 收集箱是待纳入资产的暂存区，不是知识库目录树的一部分（入口在图标栏）
      if (isInboxPath(rel)) continue;
      if (e.isDirectory()) {
        out.push({ kind: 'dir', name: e.name, path: rel, children: walk(abs, SUB_ORDER[e.name]) });
      } else if (e.name.toLowerCase().endsWith('.md')) {
        const page = db
          .prepare(`SELECT id, title, type, tags, updated_at, guide_version FROM pages WHERE path = ? AND deleted = 0`)
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
          guide_version: page?.guide_version ?? 0,
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
    // 登记为「应用自己写的」：文件系统监听据此跳过回声（见 lib/appWrites.ts）
    noteAppWrite(abs);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* already moved or absent */ }
    throw error;
  }
}

/** 写入来源：local=本端业务写入（进入同步链路）；sync=多端同步写入（防回声，不再入队） */
export type WriteOrigin = 'local' | 'sync';

/**
 * 通知同步层一次本端内容变更。动态 import 解耦：同步模块不可用/未启用时静默跳过，
 * 也避免 lib ↔ sync 形成静态循环依赖。同步故障绝不阻塞业务写入。
 */
export function notifySyncChange(
  kind: 'page' | 'file' | 'delete' | 'move',
  target: string,
  extra?: { oldPath?: string }
): void {
  import('../sync/index.js')
    .then((m) => m.recordLocalChange(kind, target, extra))
    .catch(() => { /* 同步模块不可用时忽略 */ });
}

/** 解析 md 文件并 upsert 到 pages 表；无 id 时生成并回写 frontmatter。
 *  frontmatter 写入用中文字段名（标题/创建日期/更新日期/类型/来源/置信度/领域），
 *  读取兼容旧英文键。 */
/**
 * 页面行 id 变更时，把按页面 id 引用旧 id 的子表记录一并迁到新 id。
 * page_contributions / page_syntheses 带 FK（ON DELETE CASCADE 对 UPDATE 无级联），
 * 不先迁移会让 `UPDATE pages SET id` 撞 SQLITE_CONSTRAINT_FOREIGNKEY，启动
 * scanVault 阶段直接崩溃进入重启循环（2026-08/09 已三次）。chunks / edges /
 * ingest_candidates 无 FK 但按页面 id 逻辑引用，不同步迁移会让向量检索与
 * 关联图谱静默丢失。调用方负责包事务。
 */
function migratePageReferences(oldId: string, newId: string): void {
  if (oldId === newId) return;
  db.prepare(`UPDATE page_contributions SET page_id = ? WHERE page_id = ?`).run(newId, oldId);
  db.prepare(`UPDATE page_syntheses SET page_id = ? WHERE page_id = ?`).run(newId, oldId);
  db.prepare(`UPDATE chunks SET ref_id = ? WHERE ref_type = 'page' AND ref_id = ?`).run(newId, oldId);
  db.prepare(`UPDATE edges SET src_page = ? WHERE src_page = ?`).run(newId, oldId);
  db.prepare(`UPDATE edges SET dst_page = ? WHERE dst_page = ?`).run(newId, oldId);
  db.prepare(`UPDATE ingest_candidates SET target_page_id = ? WHERE target_page_id = ?`).run(newId, oldId);
}

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

  // frontmatter 携带的 id 可能已被其他路径占用（文件复制带 id / 并发同步竞态）。
  // 优先按路径 upsert；仅当 id 撞上别的路径的行（含回收站软删行）时换新 id 重写
  // frontmatter，不再整页 500。
  const clash = db.prepare(`SELECT path FROM pages WHERE id = ? AND path != ?`).get(meta.id, relPath) as { path: string } | undefined;
  if (clash) {
    const effId = newId();
    data.id = effId;
    data['更新日期'] = now();
    atomicWrite(abs, matter.stringify(parsed.content, data));
    meta.id = effId;
  }

  // 同路径已有行但 id 不同（active-copy 顶替 trash 软删行、或手动改过 frontmatter id）：
  // 行 id 跟随 frontmatter（唯一行唯一路径不变量）。迁移中子表引用先指向新 id、
  // 而新 id 的 pages 行最后一步才出现，无论先改哪边都会撞 SQLite 的立即 FK 检查
  // ——事务内打开 defer_foreign_keys，把一致性检查统一推迟到 COMMIT 时刻，
  // 任何一步失败整体回滚，不留下半迁移状态。
  const samePathRow = db.prepare(`SELECT id FROM pages WHERE path = ? AND id != ?`).get(relPath, meta.id) as { id: string } | undefined;
  if (samePathRow) {
    db.transaction(() => {
      db.pragma('defer_foreign_keys = ON');
      migratePageReferences(samePathRow.id, meta.id);
      db.prepare(`DELETE FROM pages_fts WHERE page_id = ?`).run(samePathRow.id);
      db.prepare(`UPDATE pages SET id = ? WHERE path = ?`).run(meta.id, relPath);
    })();
  }

  db.prepare(
    `INSERT INTO pages(id, path, title, type, tags, summary, created_at, updated_at, deleted, word_count)
     VALUES(@id, @path, @title, @type, @tags, @summary, @created_at, @updated_at, 0, @word_count)
     ON CONFLICT(path) DO UPDATE SET
       title=excluded.title, type=excluded.type, tags=excluded.tags, summary=excluded.summary,
       updated_at=excluded.updated_at, deleted=0, word_count=excluded.word_count,
       id=excluded.id`
  ).run({ ...meta, tags: JSON.stringify(tags) });

  db.prepare(`DELETE FROM pages_fts WHERE page_id = ?`).run(meta.id);
  db.prepare(`INSERT INTO pages_fts(title, content, tags, page_id) VALUES(?, ?, ?, ?)`).run(
    ftsSegment(meta.title),
    ftsSegment(parsed.content),
    ftsSegment(tags.join(' ')),
    meta.id
  );
  // 外链图片本地化：syncPageFile 是「磁盘上的正文变了」的唯一收口——编辑器保存、REST、
  // Agent write_page、导入 .md、多端同步拉回、启动扫描、Agent 直接写文件系统全经过它。
  // 只挂在 writePage 上会漏掉导入与同步（首版就是这么漏的）。异步不阻塞，抓不到就保留外链。
  import('./remoteImages.js')
    .then((m) => m.scheduleRemoteImageLocalization(meta.id, parsed.content))
    .catch(() => { /* 模块不可用时忽略 */ });
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
  extra?: Record<string, any>,
  origin: WriteOrigin = 'local'
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
  if (origin === 'local') notifySyncChange('page', relPath);
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

/**
 * 目标路径是否已被文件或 pages 记录占用（含回收站软删除行——pages.path 唯一约束不含 deleted 条件，
 * 软删除行同样占位）。rename / move 的撞名判定统一走这里，绕过它会撞 UNIQUE 约束 500。
 */
export function pagePathTaken(rel: string): boolean {
  if (fs.existsSync(safeJoin(rel))) return true;
  return !!db.prepare(`SELECT 1 FROM pages WHERE path = ?`).get(rel);
}

/** 目标路径已被占用（文件或 pages 行）时由 movePage 抛出：调用方先处理撞名再搬移 */
export class PagePathTakenError extends Error {
  constructor(public relPath: string) {
    super(`目标路径已被占用：${relPath}`);
    this.name = 'PagePathTakenError';
  }
}

/**
 * 重命名/移动（文件与 DB 同步）。
 *
 * 撞名防线必须在任何文件系统改动之前：renameSync 会覆盖目标文件，而 pages.path 的
 * 唯一约束报错发生在覆盖之后——旧路径的行会停在 deleted = 0 却没有文件（幽灵页：
 * 侧栏列出、点开报「文件不存在」，只有重启扫描才清），目标页正文同时被顶替。
 * 同步链路重放历史 move 时目标路径往往已由全量对账落位，这条路径必然被走到；
 * 本地 rename/move 入口同样可能撞上回收站软删行占位。
 */
export function movePage(oldRel: string, newRel: string, origin: WriteOrigin = 'local'): PageMeta | null {
  const oldAbs = safeJoin(oldRel);
  const newAbs = safeJoin(newRel);
  if (!fs.existsSync(oldAbs)) return null;
  if (pagePathTaken(newRel)) throw new PagePathTakenError(newRel);
  fs.mkdirSync(path.dirname(newAbs), { recursive: true });
  fs.renameSync(oldAbs, newAbs);
  noteAppWrite(newAbs);
  // deleted = 0：与 reconcileMissingPages 竞态时自愈（对账可能正好在 rename 之后、
  // 本语句之前看到旧路径已消失，把行标成 deleted；这里复位回来）
  db.prepare(`UPDATE pages SET path = ?, updated_at = ?, deleted = 0 WHERE path = ?`).run(newRel, now(), oldRel);
  const meta = syncPageFile(newRel);
  if (meta) emit('page-moved', { oldPath: oldRel, newPath: newRel, id: meta.id });
  if (origin === 'local') notifySyncChange('move', newRel, { oldPath: oldRel });
  return meta;
}

/**
 * 把「索引行还在、磁盘文件已消失」的页面标为 deleted。
 *
 * 文件可能被服务端之外的路径移走（Agent 用 shell/文件工具裸移、外部程序删除、
 * 同步冲突残留），这类带外删除不会经过 moveToTrash，行会一直停在 deleted = 0，
 * 于是侧栏继续列出、点开报「文件不存在」。启动扫描与页面列表都会对账一次。
 * ponytail: 全量 stat 每行，页面数上万后再改增量（记录目录 mtime / 落盘事件）。
 */
export function reconcileMissingPages(): number {
  const rows = db.prepare(`SELECT id, path FROM pages WHERE deleted = 0`).all() as { id: string; path: string }[];
  let marked = 0;
  for (const row of rows) {
    if (fs.existsSync(safeJoin(row.path))) continue;
    markPageDeleted(row.path);
    marked++;
  }
  return marked;
}

/** 单个路径落删除标记（文件缺失时的兜底：对账、删除 op 找不到文件时调用；不写 updated_at） */
export function markPageDeleted(relPath: string): void {
  db.prepare(`UPDATE pages SET deleted = 1 WHERE path = ? AND deleted = 0`).run(relPath);
}

/** 全量扫描 brain 目录：同步 pages/files 表（用于启动时与索引重建） */
export async function scanVault() {
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
      // 收集箱里的 .md（原件或转换产物）不是页面：不建 pages 行、不写 FTS
      if (isInboxPath(rel)) continue;
      if (e.isDirectory()) {
        walk(abs);
      } else if (e.name.toLowerCase().endsWith('.md')) {
        syncPageFile(rel);
      }
    }
  }
  walk(BRAIN_DIR);
  reconcileMissingPages();

  // 原始资料补齐提取：递归扫描直接拷入目录/历史遗留的 PDF/图片，自动入队文本提取。
  // （office/txt/md 建议经 UI/CLI 导入以建立文本索引；md 由上方 syncPageFile 处理）
  try {
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
            scheduleFileExtraction(child, { mode: 'auto' });
          }
        }
      }
    };
    walkRaw('原始资料');
  } catch { /* 原始资料目录为空或不存在时忽略 */ }

  // 图片资产模型迁移（一次性）：历史正文里的 /api/files/... 内嵌写法归位。
  // 必须排在页面扫描之后——迁移要按 pages 行的 id 建 assets/<pageId>/ 目录。
  // 迁移直接改文件而不走 writePage，所以要手动补索引刷新与同步通知。
  try {
    const { assetMigrationDone, markAssetMigrationDone, migrateLegacyAssets, sweepLooseAssetsOnly } =
      await import('./pageAssets.js');
    if (!assetMigrationDone()) {
      const result = migrateLegacyAssets();
      markAssetMigrationDone();
      for (const rel of result.touchedPaths) {
        syncPageFile(rel);
        notifySyncChange('page', rel);
      }
      if (result.filesMoved || result.refsRewritten || result.unassigned) {
        console.log(
          `[assets] 图片资产迁移完成：搬移 ${result.filesMoved} 个文件，改写 ${result.refsRewritten} 处引用`
          + `（${result.pagesTouched} 个页面），${result.unassigned} 张无归属图片收进未归属池`
        );
      }
    } else {
      // 每次都扫：用户可能绕过应用直接把图片拷进 原始资料/，不收容就成了看不见的死文件
      const parked = sweepLooseAssetsOnly();
      if (parked) console.log(`[assets] ${parked} 张无归属图片收进未归属池（设置 → 存储空间 可清理）`);
    }
  } catch (error: any) {
    // 不写标记 → 下次启动重试；迁移失败绝不能阻塞启动
    console.warn(`[assets] 图片资产迁移失败，下次启动重试：${error?.message || error}`);
  }
}
