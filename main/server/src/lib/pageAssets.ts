import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ASSETS_DIR, BRAIN_DIR } from '../config.js';
import { db } from './db.js';

/**
 * 页面图片资产（图片 = md 父项的私有资产）。
 *
 * 归属规则只有一条：父项正文里的 `/media/<parentId>/<file>` 引用。
 *  - 父项 = 任何有 pages 行的 md 文件（Wiki 页面 + 原始资料里的 md）；非 md 资料没有图片资产，
 *    docx/pdf/pptx 的内嵌图不抽取。
 *  - 磁盘位置 `assets/<parentId>/<file>` 与 URL `/media/<parentId>/<file>` 一一对应，
 *    所以「打开父项的图片抽屉」是一次 readdir，不需要索引表；wiki.db 丢了也能从正文重建归属。
 *  - 目录名用页面 id（UUID）而不是路径：父项改名/移动/归档都不影响归属，也不需要搬目录。
 *  - 用户不能独立上传裸图（图片只能插进某个内容里）。历史遗留的散图收在
 *    `assets/_unassigned/`，只能在 设置 → 存储空间 里查看、挂载或删除，不进左栏。
 */

export const MEDIA_PREFIX = '/media/';
/** 未归属图片池：没有父项的存量散图收容所（不是页面 id，所以单独放行） */
export const UNASSIGNED_PARENT = '_unassigned';

const ASSET_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
};

export const ASSET_EXTENSIONS = new Set(Object.keys(ASSET_MIME));

/** 目录名白名单：页面 id（UUID）或未归属池。同时挡掉 `..`、绝对路径等穿越写法 */
const PARENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function assetExtension(name: string): string {
  return path.extname(name).slice(1).toLowerCase();
}

export function isAssetFile(name: string): boolean {
  return ASSET_EXTENSIONS.has(assetExtension(name));
}

export function assetMime(name: string): string | null {
  return ASSET_MIME[assetExtension(name)] ?? null;
}

export function isParentId(value: string): boolean {
  return PARENT_ID_RE.test(value);
}

/** 资产根目录内解析（防穿越）；不依赖 lib/vault 的 safeJoin，避免 lib ↔ lib 循环依赖 */
export function safeAssetJoin(rel: string): string {
  const clean = rel.replace(/^[/\\]+/, '');
  const abs = path.resolve(ASSETS_DIR, clean);
  if (abs !== ASSETS_DIR && !abs.startsWith(ASSETS_DIR + path.sep)) throw new Error('路径无效');
  return abs;
}

export function assetRelPath(parentId: string, name: string): string {
  return `assets/${parentId}/${name}`;
}

export function mediaUrl(parentId: string, name: string): string {
  return `${MEDIA_PREFIX}${parentId}/${encodeURIComponent(name)}`;
}

/** 从 /media/<parentId>/<file> 反解归属；不是本库媒体路径时返回 null */
export function parseMediaUrl(url: string): { parentId: string; name: string } | null {
  const trimmed = url.trim();
  if (!trimmed.startsWith(MEDIA_PREFIX)) return null;
  const rest = trimmed.slice(MEDIA_PREFIX.length).split(/[?#]/)[0];
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const parentId = rest.slice(0, slash);
  if (!isParentId(parentId)) return null;
  let name = rest.slice(slash + 1);
  try {
    name = decodeURIComponent(name);
  } catch {
    return null;
  }
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  return { parentId, name };
}

const MD_IMAGE_RE = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+["']([^"']*)["'])?\s*\)/g;
const HTML_IMAGE_RE = /<img\b[^>]*?src\s*=\s*["']([^"']+)["'][^>]*>/gi;

export interface AssetRef {
  parentId: string;
  name: string;
  /** 引用写在哪段正文里（这里恒为传入 markdown 的归属父项，仅作上下文） */
  url: string;
  /** markdown 图片的 title：外链本地化时用来记原出处 */
  title?: string;
}

/** 扫描一段 markdown 正文里的全部本库图片引用（按出现顺序，同名去重） */
export function parseAssetRefs(markdown: string): AssetRef[] {
  const out: AssetRef[] = [];
  const seen = new Set<string>();
  const push = (rawUrl: string, title?: string) => {
    const parsed = parseMediaUrl(rawUrl);
    if (!parsed) return;
    const key = `${parsed.parentId}/${parsed.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ parentId: parsed.parentId, name: parsed.name, url: rawUrl, ...(title ? { title } : {}) });
  };
  for (const match of markdown.matchAll(MD_IMAGE_RE)) push(match[2], match[3] || undefined);
  for (const match of markdown.matchAll(HTML_IMAGE_RE)) push(match[1]);
  return out;
}

/**
 * 从图片 title 里取回外链本地化时记下的原出处。
 * 本地化写的是 `原图 https://…`（用户原有 title 会被保留在前面，用「；」隔开）；
 * 认不出这个形态就返回 undefined，免得把用户随手写的图注当成「外链已归档」。
 */
function sourceUrlFromTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const match = title.match(/原图\s+(https?:\/\/\S+)\s*$/);
  return match ? match[1] : undefined;
}

/** 正文里引用的、属于该父项的图片名 → title（原出处） */
function parentRefTitles(parentId: string, content: string): Map<string, string | undefined> {
  const map = new Map<string, string | undefined>();
  for (const ref of parseAssetRefs(content)) {
    if (ref.parentId === parentId) map.set(ref.name, sourceUrlFromTitle(ref.title));
  }
  return map;
}

export interface PageAsset {
  parentId: string;
  name: string;
  /** brain 相对路径：assets/<parentId>/<name> */
  relPath: string;
  /** 正文里该写的引用：/media/<parentId>/<name> */
  url: string;
  ext: string;
  mime: string;
  size: number;
  updatedAt: string;
  /** 父项正文是否引用了它；未引用 = 孤儿，可在设置里清理 */
  referenced: boolean;
  /** 外链本地化时记在图片 title 里的原出处 */
  sourceUrl?: string;
}

function toAsset(parentId: string, name: string, referenced: boolean, sourceUrl?: string): PageAsset | null {
  const abs = safeAssetJoin(`${parentId}/${name}`);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return {
    parentId,
    name,
    relPath: assetRelPath(parentId, name),
    url: mediaUrl(parentId, name),
    ext: assetExtension(name),
    mime: assetMime(name) || 'application/octet-stream',
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
    referenced,
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

/** 父项在 brain 内的相对路径（不是页面 / 已删除时返回 null） */
function parentPagePath(parentId: string): string | null {
  const row = db.prepare(`SELECT path FROM pages WHERE id = ? AND deleted = 0`).get(parentId) as
    | { path: string }
    | undefined;
  return row?.path ?? null;
}

/** 读父项正文原文（frontmatter 也一起读：引用只会出现在正文，多读无害） */
function parentContent(parentId: string): string {
  const rel = parentPagePath(parentId);
  if (!rel) return '';
  try {
    return fs.readFileSync(safeBrainJoin(rel), 'utf8');
  } catch {
    return '';
  }
}

function safeBrainJoin(rel: string): string {
  const clean = rel.replace(/^[/\\]+/, '');
  const abs = path.resolve(BRAIN_DIR, clean);
  if (abs !== BRAIN_DIR && !abs.startsWith(BRAIN_DIR + path.sep)) throw new Error('路径无效');
  return abs;
}

/**
 * 列出一个父项的图片资产。
 * `_unassigned` 没有父项正文，全部按未引用处理（它本来就是"还没挂到任何父项上"）。
 */
export function listParentAssets(parentId: string): PageAsset[] {
  if (!isParentId(parentId)) return [];
  let names: string[];
  try {
    names = fs.readdirSync(safeAssetJoin(parentId));
  } catch {
    return [];
  }
  const titles = parentId === UNASSIGNED_PARENT
    ? new Map<string, string | undefined>()
    : parentRefTitles(parentId, parentContent(parentId));
  const out: PageAsset[] = [];
  for (const name of names) {
    if (!isAssetFile(name)) continue;
    const asset = toAsset(parentId, name, titles.has(name), titles.get(name));
    if (asset) out.push(asset);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 父项 → 图片张数（侧栏右键菜单的徽标用）。只 readdir 有资产的父项目录，页面多时仍是 O(有图的页面数) */
let countCache: { at: number; value: Map<string, number> } | null = null;
const COUNT_TTL_MS = 3_000;

export function assetCountsByParent(): Map<string, number> {
  if (countCache && Date.now() - countCache.at < COUNT_TTL_MS) return countCache.value;
  const out = new Map<string, number>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(ASSETS_DIR, { withFileTypes: true });
  } catch {
    countCache = { at: Date.now(), value: out };
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isParentId(entry.name)) continue;
    let files: string[];
    try {
      files = fs.readdirSync(path.join(ASSETS_DIR, entry.name));
    } catch {
      continue;
    }
    const count = files.filter(isAssetFile).length;
    if (count > 0) out.set(entry.name, count);
  }
  countCache = { at: Date.now(), value: out };
  return out;
}

export function invalidateAssetCountCache(): void {
  countCache = null;
}

function safeSlug(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || 'image';
}

/**
 * 展示用文件名：磁盘上的名字带内容哈希前缀（去重与 immutable 缓存需要），
 * 但正文图注、抽屉标题这些给人看的地方应该用去掉前缀的原名。
 */
export function assetDisplayName(name: string): string {
  return name.replace(/^[0-9a-f]{8}-/, '');
}

/**
 * 内容寻址文件名：`<sha1-8>-<原名>.<ext>`。
 *  - 同一张图重复插入 → 同一个文件名，天然去重；
 *  - 同名不同图 → 哈希不同，不会互相顶替；
 *  - 文件名即内容版本，所以 /media 可以安全地用 immutable 长缓存。
 */
export function contentAddressedName(buffer: Buffer, originalName: string): string {
  const ext = assetExtension(originalName);
  const base = path.basename(originalName, path.extname(originalName));
  if (/^[0-9a-f]{8}-/.test(base)) return originalName;
  const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 8);
  return `${hash}-${safeSlug(base)}.${ext}`;
}

function atomicWrite(abs: string, buffer: Buffer): void {
  const temp = `${abs}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, buffer);
    fs.renameSync(temp, abs);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* already moved or absent */ }
    throw error;
  }
}

/**
 * 存入一个父项的图片资产。
 * 文件名带内容哈希前缀（`<sha1-8>-<原名>.<ext>`）：同一张图重复插入自动复用同一文件，
 * 同名不同图不会互相顶替，也让 /media 的 immutable 缓存成立。
 */
export function savePageAsset(
  parentId: string,
  originalName: string,
  buffer: Buffer,
  options: { sourceUrl?: string } = {},
): PageAsset {
  if (!isParentId(parentId)) throw new Error('父项无效');
  const ext = assetExtension(originalName);
  const mime = assetMime(originalName);
  if (!mime) throw new Error(`不支持的图片格式：${ext || '未知'}`);
  if (!buffer.length) throw new Error('图片内容为空');
  const name = contentAddressedName(buffer, originalName);
  const dir = safeAssetJoin(parentId);
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, name);
  if (!fs.existsSync(abs)) atomicWrite(abs, buffer);
  invalidateAssetCountCache();
  const asset = toAsset(parentId, name, false, options.sourceUrl);
  if (!asset) throw new Error('图片写入失败');
  return asset;
}

/** 删除一个图片资产；目录空了顺手删掉，避免 assets/ 下留一堆空目录 */
export function deletePageAsset(parentId: string, name: string): void {
  if (!isParentId(parentId) || !isAssetFile(name)) throw new Error('图片路径无效');
  const abs = safeAssetJoin(`${parentId}/${name}`);
  if (!fs.existsSync(abs)) throw new Error('图片不存在');
  fs.unlinkSync(abs);
  try {
    if (fs.readdirSync(safeAssetJoin(parentId)).length === 0) fs.rmdirSync(safeAssetJoin(parentId));
  } catch { /* 目录非空或被占用时保留 */ }
  invalidateAssetCountCache();
}

/** 把一个未归属图片挂到父项下（移动文件 + 返回新引用），用于存量散图的归位 */
export function attachUnassignedAsset(name: string, parentId: string): PageAsset {
  if (!isParentId(parentId) || parentId === UNASSIGNED_PARENT) throw new Error('目标父项无效');
  if (!isAssetFile(name)) throw new Error('图片路径无效');
  const source = safeAssetJoin(`${UNASSIGNED_PARENT}/${name}`);
  if (!fs.existsSync(source)) throw new Error('图片不存在');
  const buffer = fs.readFileSync(source);
  const asset = savePageAsset(parentId, name, buffer);
  fs.unlinkSync(source);
  try {
    if (fs.readdirSync(safeAssetJoin(UNASSIGNED_PARENT)).length === 0) {
      fs.rmdirSync(safeAssetJoin(UNASSIGNED_PARENT));
    }
  } catch { /* 目录非空时保留 */ }
  invalidateAssetCountCache();
  return asset;
}

/** 未归属图片池（没有父项的存量散图） */
export function listUnassignedAssets(): PageAsset[] {
  return listParentAssets(UNASSIGNED_PARENT);
}

export interface AssetOrphans {
  unassigned: PageAsset[];
  unreferenced: PageAsset[];
  totalBytes: number;
}

/** 未归属 + 未引用（父项正文已删掉引用的孤儿），供设置页清理 */
export function collectAssetOrphans(): AssetOrphans {
  const unassigned = listUnassignedAssets();
  const unreferenced: PageAsset[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(ASSETS_DIR, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isParentId(entry.name) || entry.name === UNASSIGNED_PARENT) continue;
    for (const asset of listParentAssets(entry.name)) {
      if (!asset.referenced) unreferenced.push(asset);
    }
  }
  const all = [...unassigned, ...unreferenced];
  return {
    unassigned,
    unreferenced,
    totalBytes: all.reduce((sum, asset) => sum + asset.size, 0),
  };
}

/* ------------------------------------------------------------------ *
 * 存量迁移：把历史写法与历史散图收进「图片 = 父项资产」模型
 * ------------------------------------------------------------------ */

export interface AssetMigrationResult {
  filesMoved: number;
  refsRewritten: number;
  unassigned: number;
  pagesTouched: number;
  /** 正文被改写过的页面路径：调用方据此重跑索引与同步通知 */
  touchedPaths: string[];
}

const MIGRATION_FLAG = 'asset_model_migration_v1';

/**
 * 旧引用匹配：两种历史写法一起收
 *  - 完整 URL：`/api/files/raw?path=assets%2Fx.png`（编辑器插入图片用的就是它）
 *  - 裸路径：`![](assets/x.png)`（手写或外部工具写入）
 * 裸路径分支要求前面不是 `/` 或词字符，避免把 `?path=assets%2F…` 里的片段重复匹配。
 * 前导字符用捕获组带出，替换时原样接回去。
 */
const LEGACY_REF_RE =
  /\/api\/files\/(?:raw|content)\?path=((?:assets|原始资料)(?:%2F|\/)[^\s)"'&]+)|(^|[^/\w])(assets(?:\/|%2F)[^\s)"'&]+)/gm;

/** 旧引用里的路径片段 → brain 相对路径（解码 + 反斜杠归一 + 拒绝穿越） */
function decodeAssetRef(raw: string): string | null {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const clean = decoded.replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.includes('..') || clean.includes('\u0000')) return null;
  if (!clean.startsWith('assets/') && !clean.startsWith('原始资料/')) return null;
  return clean;
}

/** assets/ 根目录下的散图（不在任何 <parentId>/ 子目录里） */
function looseAssetNames(): string[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(ASSETS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile() && isAssetFile(e.name)).map((e) => e.name);
}

/** 把文件挪到 assets/<parentId>/ 下（统一改成内容寻址名），返回新文件名 */
function moveIntoParent(sourceAbs: string, parentId: string, preferredName: string): string {
  const dir = safeAssetJoin(parentId);
  fs.mkdirSync(dir, { recursive: true });
  const buffer = fs.readFileSync(sourceAbs);
  const name = contentAddressedName(buffer, preferredName);
  const target = path.join(dir, name);
  // 目标已存在同内容文件（或同名同内容）→ 直接丢弃源文件，等效去重
  if (fs.existsSync(target)) {
    fs.unlinkSync(sourceAbs);
    return name;
  }
  fs.renameSync(sourceAbs, target);
  return name;
}

/**
 * 一次性迁移（由启动扫描调用，成功后写 setting 标记，不重复跑）：
 *  1. 正文里的旧引用（`/api/files/…?path=assets%2Fxxx` 或裸 `assets/xxx`）→ 文件挪进
 *     `assets/<pageId>/`，引用改写为 `/media/<pageId>/xxx`。已经在 `assets/<parentId>/`
 *     下的只改写引用、不再搬文件。
 *  2. 迁移后仍留在 `assets/` 根目录或 `原始资料/` 下、没有任何 md 引用的图片 →
 *     收进 `assets/_unassigned/`（设置 → 存储空间 里可挂载或删除）。
 *
 * 全程只移动、不删除；单个文件挪不动（占用/权限）就跳过，下次启动重试。
 * 替换直接在文件原文上做（含 frontmatter）：旧引用只会出现在正文，不会误伤元数据；
 * 先做文本替换再落盘，避免"读正文—写正文"把 frontmatter 格式写坏。
 */
export function migrateLegacyAssets(): AssetMigrationResult {
  const result: AssetMigrationResult = {
    filesMoved: 0, refsRewritten: 0, unassigned: 0, pagesTouched: 0, touchedPaths: [],
  };
  const pages = db.prepare(`SELECT id, path FROM pages WHERE deleted = 0`).all() as
    { id: string; path: string }[];

  /** brain 相对路径 → 新的 /media URL（同一文件被多页引用时只搬一次） */
  const relocated = new Map<string, string>();

  const resolveRef = (pageId: string, brainRel: string): string | null => {
    const memo = relocated.get(brainRel);
    if (memo) return memo;
    if (!isAssetFile(brainRel)) return null;
    const sourceAbs = safeBrainJoin(brainRel);
    if (!fs.existsSync(sourceAbs) || !fs.statSync(sourceAbs).isFile()) return null;
    // 已经在 assets/<parentId>/ 下：只改写引用，归属保持原样
    const owned = brainRel.match(/^assets\/([A-Za-z0-9_-]{1,64})\/([^/]+)$/);
    if (owned && isParentId(owned[1]) && owned[1] !== UNASSIGNED_PARENT) {
      const url = mediaUrl(owned[1], owned[2]);
      relocated.set(brainRel, url);
      return url;
    }
    try {
      const name = moveIntoParent(sourceAbs, pageId, path.basename(brainRel));
      result.filesMoved++;
      const url = mediaUrl(pageId, name);
      relocated.set(brainRel, url);
      return url;
    } catch {
      return null;
    }
  };

  for (const page of pages) {
    const abs = safeBrainJoin(page.path);
    let raw: string;
    try {
      raw = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (!LEGACY_REF_RE.test(raw)) {
      LEGACY_REF_RE.lastIndex = 0;
      continue;
    }
    LEGACY_REF_RE.lastIndex = 0;
    let changed = 0;
    const next = raw.replace(
      LEGACY_REF_RE,
      (match: string, urlForm: string | undefined, prefix: string | undefined, bareForm: string | undefined) => {
        const ref = urlForm || bareForm;
        if (!ref) return match;
        const brainRel = decodeAssetRef(ref);
        if (!brainRel) return match;
        const url = resolveRef(page.id, brainRel);
        if (!url) return match;
        changed++;
        return `${prefix || ''}${url}`;
      }
    );
    if (!changed) continue;
    fs.writeFileSync(abs, next, 'utf8');
    result.refsRewritten += changed;
    result.pagesTouched++;
    result.touchedPaths.push(page.path);
  }

  sweepLooseAssets(result);

  invalidateAssetCountCache();
  return result;
}

/**
 * 收容散图：把 `assets/` 根目录与 `原始资料/`（含对话子树）下没有任何归属的图片
 * 挪进 `assets/_unassigned/`。
 *
 * 每次启动扫描都跑（幂等）：用户可能绕过应用直接把图片拷进 `原始资料/`，
 * 那种图既不在左栏（按扩展名过滤）也不在提炼清单里，不收容就成了「看不见但占地方」
 * 的死文件——收进未归属池后，设置 → 存储空间 里至少能看到、能删、能挂载。
 */
function sweepLooseAssets(result: AssetMigrationResult): void {
  const loose: Array<{ abs: string; name: string }> = [];
  for (const name of looseAssetNames()) loose.push({ abs: safeAssetJoin(name), name });
  const walkRaw = (abs: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) walkRaw(childAbs);
      else if (isAssetFile(entry.name)) loose.push({ abs: childAbs, name: entry.name });
    }
  };
  walkRaw(path.join(BRAIN_DIR, '原始资料'));

  for (const item of loose) {
    try {
      const dir = safeAssetJoin(UNASSIGNED_PARENT);
      fs.mkdirSync(dir, { recursive: true });
      const buffer = fs.readFileSync(item.abs);
      const target = path.join(dir, contentAddressedName(buffer, item.name));
      if (fs.existsSync(target)) fs.unlinkSync(item.abs);
      else fs.renameSync(item.abs, target);
      result.unassigned++;
    } catch { /* 单个文件挪不动不阻塞整批，下次启动重试 */ }
  }
}

/** 只跑散图收容（每次启动扫描都调用；引用迁移是一次性的） */
export function sweepLooseAssetsOnly(): number {
  const counter: AssetMigrationResult = {
    filesMoved: 0, refsRewritten: 0, unassigned: 0, pagesTouched: 0, touchedPaths: [],
  };
  sweepLooseAssets(counter);
  if (counter.unassigned) invalidateAssetCountCache();
  return counter.unassigned;
}

export function assetMigrationDone(): boolean {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(MIGRATION_FLAG) as
    | { value: string }
    | undefined;
  return row?.value === 'done';
}

export function markAssetMigrationDone(): void {
  db.prepare(
    `INSERT INTO settings(key, value) VALUES(?, 'done')
     ON CONFLICT(key) DO UPDATE SET value = 'done'`
  ).run(MIGRATION_FLAG);
}
