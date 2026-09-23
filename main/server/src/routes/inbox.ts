import fs from 'node:fs';
import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { safeJoin, notifySyncChange } from '../lib/vault.js';
import { moveToTrash } from '../lib/trash.js';
import { emit } from '../lib/events.js';
import { noteAppWrite } from '../lib/appWrites.js';
import { positiveInt } from '../config.js';
import {
  INBOX_DIR,
  INBOX_DERIVED_DIR,
  isInboxPath,
  isInboxDerivedPath,
  uniqueDerivedPath,
  stemOf,
} from '../lib/brainPaths.js';

/**
 * 收集箱：拖进来的任意文件先落在这里，是「待整理 / 待转换」的暂存资产。
 *
 * 与知识库的边界（统一由 lib/brainPaths.ts 判定）：
 *  - 不入 pages / files 表，不写 FTS，不参与检索，不可被 Agent 当作来源引用（入库后才是来源）；
 *  - 不在文件树里出现，也不支持内置浏览——所以本模块只给元数据、下载、系统打开，
 *    以及后续里程碑的语义转换，不提供任何预览/取正文接口。
 *
 * 上传走流式落盘：通用 /api/files/upload 是把整份文件读进内存再写（另有 200MB 硬上限），
 * 收集箱要接几百 MB 到 GB 级的录屏与压缩包，必须边收边写。
 */

/** 单文件上限（MB），可用 INBOX_MAX_FILE_MB 覆盖 */
const INBOX_MAX_FILE_MB = positiveInt(process.env.INBOX_MAX_FILE_MB, 2048);
const INBOX_MAX_FILE_BYTES = INBOX_MAX_FILE_MB * 1024 * 1024;
/** 单次请求最多文件数 */
const INBOX_MAX_FILES = 200;

/** 类型分组：只用于图标与筛选，不影响接受哪些格式（任意格式都收） */
const CATEGORY_BY_EXT: Record<string, string> = {
  doc: 'document', docx: 'document', odt: 'document', rtf: 'document',
  xls: 'spreadsheet', xlsx: 'spreadsheet', csv: 'spreadsheet', ods: 'spreadsheet',
  ppt: 'presentation', pptx: 'presentation', odp: 'presentation',
  pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  bmp: 'image', tif: 'image', tiff: 'image', heic: 'image', avif: 'image',
  txt: 'text', md: 'text', markdown: 'text', json: 'text', log: 'text', yaml: 'text', yml: 'text', xml: 'text',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', ogg: 'audio', amr: 'audio',
  mp4: 'video', mov: 'video', mkv: 'video', avi: 'video', webm: 'video', flv: 'video', wmv: 'video',
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', bz2: 'archive', xz: 'archive',
};

export interface InboxItem {
  /** vault 相对路径，如 收集箱/合同.pdf */
  path: string;
  name: string;
  /** 相对收集箱根的子路径（用于展示分组） */
  rel: string;
  ext: string;
  size: number;
  mtime: number;
  category: string;
  status: 'pending' | 'converted';
  /** 已生成的语义转换产物（Markdown）路径 */
  derivedPath: string | null;
}

function categoryOf(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return CATEGORY_BY_EXT[ext] || 'other';
}

function sanitizeName(name: string): string {
  const base = path.basename(name).replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '').trim();
  return base || `未命名-${Date.now()}`;
}

/** 同名不覆盖：`合同.pdf` → `合同 (2).pdf` */
function uniqueInboxPath(dirRel: string, name: string): string {
  const ext = path.posix.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i <= 999; i += 1) {
    const candidate = `${dirRel}/${i === 1 ? name : `${stem} (${i})${ext}`}`;
    if (!fs.existsSync(safeJoin(candidate))) return candidate;
  }
  return `${dirRel}/${stem}-${Date.now()}${ext}`;
}

/** 转换产物目录：stem → 产物文件名（`合同 (2).md` 也归到 `合同`） */
function derivedStemMap(): Map<string, string> {
  const map = new Map<string, string>();
  let names: string[];
  try {
    names = fs.readdirSync(safeJoin(INBOX_DERIVED_DIR));
  } catch {
    return map;
  }
  for (const name of names) {
    if (name.startsWith('.') || !name.toLowerCase().endsWith('.md')) continue;
    const stem = name.replace(/\.md$/i, '');
    if (!map.has(stem)) map.set(stem, name);
    const base = stem.replace(/ \(\d+\)$/, '');
    if (!map.has(base)) map.set(base, name);
  }
  return map;
}

/** 扫描收集箱：原件递归收集；转换产物只用于标记状态，本身不作为条目 */
function listInboxItems(): InboxItem[] {
  const derived = derivedStemMap();
  const files: string[] = [];

  function walk(rel: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(safeJoin(rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (isInboxDerivedPath(childRel)) continue;
        walk(childRel);
        continue;
      }
      files.push(childRel);
    }
  }
  if (!fs.existsSync(safeJoin(INBOX_DIR))) return [];
  walk(INBOX_DIR);

  return files
    .map((rel) => {
      const abs = safeJoin(rel);
      const stat = fs.statSync(abs);
      const name = path.posix.basename(rel);
      const derivedName = derived.get(stemOf(rel)) || null;
      return {
        path: rel,
        name,
        rel: rel.slice(INBOX_DIR.length + 1),
        ext: (name.split('.').pop() || '').toLowerCase(),
        size: stat.size,
        mtime: stat.mtimeMs,
        category: categoryOf(name),
        status: derivedName ? 'converted' : 'pending',
        derivedPath: derivedName ? `${INBOX_DERIVED_DIR}/${derivedName}` : null,
      } satisfies InboxItem;
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export async function inboxRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** 收集箱列表：目录实时扫描（同步落地、外部拷入都会立刻反映），不额外维护状态表 */
  app.get('/api/inbox/items', async () => {
    const items = listInboxItems();
    return {
      dir: INBOX_DIR,
      derivedDir: INBOX_DERIVED_DIR,
      maxFileMb: INBOX_MAX_FILE_MB,
      counts: {
        all: items.length,
        pending: items.filter((item) => item.status === 'pending').length,
        converted: items.filter((item) => item.status === 'converted').length,
        // 转换中/失败在接入转换任务后才有；先保留字段让前端形状稳定
        converting: 0,
        failed: 0,
      },
      items,
    };
  });

  /**
   * 拖入上传：任意格式、任意数量，流式写盘（不进内存）。
   * 可选表单字段 `dir`（收集箱下的相对子目录）；同名自动加序号，不覆盖已有文件。
   */
  app.post('/api/inbox/upload', async (req, reply) => {
    const saved: InboxItem[] = [];
    const skipped: { name: string; reason: string }[] = [];
    let subDir = INBOX_DIR;

    for await (const part of req.parts({
      limits: { fileSize: INBOX_MAX_FILE_BYTES, files: INBOX_MAX_FILES },
    })) {
      if (part.type === 'field') {
        if (part.fieldname === 'dir') {
          const raw = String(part.value || '').trim();
          if (raw) subDir = path.posix.join(INBOX_DIR, sanitizeName(raw));
        }
        continue;
      }
      const name = sanitizeName(part.filename || '');
      if (!name) {
        part.file.resume();
        continue;
      }
      const rel = uniqueInboxPath(subDir, name);
      const abs = safeJoin(rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      try {
        await streamPipeline(part.file, fs.createWriteStream(abs));
      } catch (error: any) {
        fs.rmSync(abs, { force: true });
        skipped.push({ name, reason: error?.message || '写入失败' });
        continue;
      }
      if (part.file.truncated) {
        fs.rmSync(abs, { force: true });
        skipped.push({ name, reason: `超过单文件上限 ${INBOX_MAX_FILE_MB} MB` });
        continue;
      }
      noteAppWrite(abs);
      notifySyncChange('file', rel);
      emit('file-changed', { path: rel });
      const stat = fs.statSync(abs);
      saved.push({
        path: rel,
        name,
        rel: rel.slice(INBOX_DIR.length + 1),
        ext: (name.split('.').pop() || '').toLowerCase(),
        size: stat.size,
        mtime: stat.mtimeMs,
        category: categoryOf(name),
        status: 'pending',
        derivedPath: null,
      });
    }

    if (!saved.length && skipped.length) {
      return reply.code(413).send({ error: skipped[0].reason, skipped });
    }
    return { saved, skipped, total: listInboxItems().length };
  });

  /** 下载原件（Docker / 浏览器端「打开」= 下载；桌面端走系统默认程序，见 M2） */
  app.get('/api/inbox/download', async (req, reply) => {
    const { path: rel } = req.query as { path?: string };
    if (!rel || !isInboxPath(rel) || isInboxDerivedPath(rel)) {
      return reply.code(400).send({ error: '路径无效' });
    }
    let abs: string;
    try {
      abs = safeJoin(rel);
    } catch {
      return reply.code(400).send({ error: '路径无效' });
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return reply.code(404).send({ error: '文件不存在' });
    }
    const stat = fs.statSync(abs);
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`);
    reply.header('Content-Length', stat.size);
    return reply.send(fs.createReadStream(abs));
  });

  /** 移除：进回收站（可恢复），与知识库删除同一套语义 */
  app.delete('/api/inbox/items', async (req, reply) => {
    const { path: rel } = (req.body || {}) as { path?: string };
    if (!rel || !isInboxPath(rel) || isInboxDerivedPath(rel)) {
      return reply.code(400).send({ error: '路径无效' });
    }
    try {
      const item = moveToTrash(rel, 'local');
      emit('file-changed', { path: rel });
      return { removed: item.originalPath };
    } catch (error: any) {
      return reply.code(404).send({ error: error?.message || '移除失败' });
    }
  });

  /** 转换产物路径（转换流程用；不是浏览接口，返回的只是路径字符串） */
  app.get('/api/inbox/derived-path', async (req, reply) => {
    const { path: rel } = req.query as { path?: string };
    if (!rel || !isInboxPath(rel) || isInboxDerivedPath(rel)) {
      return reply.code(400).send({ error: '路径无效' });
    }
    if (!fs.existsSync(safeJoin(rel))) return reply.code(404).send({ error: '文件不存在' });
    return { path: uniqueDerivedPath(rel, (candidate) => fs.existsSync(safeJoin(candidate))) };
  });
}
