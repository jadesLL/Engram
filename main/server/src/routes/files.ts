import { FastifyInstance, FastifyReply } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import JSZip from 'jszip';
import { db } from '../lib/db.js';
import { safeJoin, notifySyncChange } from '../lib/vault.js';
import { moveToTrash } from '../lib/trash.js';
import { requireAuth } from './auth.js';
import { officeToText } from '../pipeline/office.js';
import { ensureFileRecord, upsertFileRecord } from '../pipeline/indexer.js';
import { isDistilledPath } from '../pipeline/sourceLedger.js';
import { enqueue, enqueuePagePipeline } from '../jobs.js';
import { normalizeDir, isUploadDir } from '../config.js';
import { syncPageFile } from '../lib/vault.js';
import { appendWikiLog } from '../pipeline/indexFile.js';
import {
  acceptPartialExtraction,
  EXTRACTABLE_EXTENSIONS,
  extractionDetails,
  IMAGE_EXTENSIONS,
  scheduleFileExtraction,
  supportsFileExtraction,
} from '../pipeline/fileExtraction.js';
import { assetCountsByParent, isAssetFile, parseAssetRefs, assetRelPath, safeAssetJoin, MEDIA_PREFIX } from '../lib/pageAssets.js';

/** 可提取文本入索引的 Office 格式 */
const OFFICE_EXTS = new Set(['docx', 'xlsx', 'pptx']);
const TEXT_EXTS = new Set(['txt']);

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

function contentRange(value: string | undefined, size: number): { start: number; end: number } | null {
  const match = value?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : NaN;
  let end = match[2] ? Number(match[2]) : NaN;
  if (!Number.isFinite(start) && Number.isFinite(end)) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else {
    if (!Number.isFinite(start)) return null;
    if (!Number.isFinite(end)) end = size - 1;
  }
  if (start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * 把一个 brain 相对路径塞进 zip；md 正文引用的图片资产一并放进包根的 `assets/`，
 * 并把正文里的 `/media/` 改写成**从该 md 出发**的相对路径（`assets/…`，md 在子目录时按层数退回）。
 * 返回随包带走的图片张数——0 表示这份文件没有本地图片，调用方可以照原样下载。
 */
function addFileToZip(zip: JSZip, rel: string, entryPath: string): number {
  const abs = safeJoin(rel);
  let body: Buffer | string = fs.readFileSync(abs);
  let assetsAdded = 0;
  if (/\.md$/i.test(rel)) {
    const text = body.toString('utf8');
    if (text.includes(MEDIA_PREFIX)) {
      for (const ref of parseAssetRefs(text)) {
        const assetAbs = safeAssetJoin(`${ref.parentId}/${ref.name}`);
        if (!fs.existsSync(assetAbs)) continue;
        const assetRel = assetRelPath(ref.parentId, ref.name);
        if (zip.file(assetRel)) continue;
        zip.file(assetRel, fs.readFileSync(assetAbs));
        assetsAdded++;
      }
      // 图片统一放包根 assets/：md 若在子目录里，链接要退回相应层数才指得中
      const depth = entryPath.split('/').length - 1;
      body = text.split(MEDIA_PREFIX).join(`${'../'.repeat(depth)}assets/`);
    }
  }
  zip.file(entryPath, body);
  return assetsAdded;
}

/** 打包结果落盘：zip 名用调用方给的标签 + 日期 */
async function sendZip(reply: FastifyReply, zip: JSZip, label: string): Promise<void> {
  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  reply.header('Content-Type', 'application/zip');
  reply.header(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(`${label}-${new Date().toISOString().slice(0, 10)}.zip`)}`
  );
  reply.header('Content-Length', buf.length);
  reply.send(buf);
}

export async function fileRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** 原始资料文件列表（供侧栏展示）；md 文件附带 page id（可直接进编辑器）。
   *  默认只列 原始资料 顶层；?dir=原始资料/对话 时递归该子树（对话分区用，与原始资料同构）。
   *  图片不在这里出现：图片是 md 父项的私有资产（见 lib/pageAssets.ts），只能从父项右键菜单进，
   *  侧栏目录里不占行、不计数、不成组。 */
  app.get('/api/files/list', async (req) => {
    const { dir } = req.query as { dir?: string };
    const sub = dir ? normalizeDir(dir) : '';
    const out: any[] = [];
    const assetCounts = assetCountsByParent();
    const pushEntry = (name: string, rel: string) => {
      // 历史遗留的散图（迁移没搬走的）同样不进侧栏
      if (isAssetFile(name)) return;
      const abs = safeJoin(rel);
      let stat: fs.Stats;
      try { stat = fs.statSync(abs); } catch { return; }
      const ext = path.extname(name).slice(1).toLowerCase();
      let pageId: string | undefined;
      if (['md', 'markdown'].includes(ext)) {
        const page = db.prepare(`SELECT id FROM pages WHERE path = ? AND deleted = 0`).get(rel) as any;
        pageId = page?.id;
      }
      const extraction = db.prepare(
        `SELECT fe.* FROM file_extractions fe
         JOIN files f ON f.id=fe.file_id
         WHERE f.path=? AND f.deleted=0`
      ).get(rel) as any;
      out.push({
        name, path: rel, ext, size: stat.size,
        updated_at: stat.mtime.toISOString(),
        pageId,
        // 该 md 父项引用的图片张数（侧栏右键「查看引用图片」的徽标）
        assetCount: pageId ? assetCounts.get(String(pageId)) || 0 : 0,
        extractionStatus: extraction?.status || null,
        extractionMethod: extraction?.method || null,
        extractionPageCount: extraction?.page_count || 0,
        extractionOcrPages: extraction?.ocr_pages || 0,
        extractionSkippedPages: extraction?.skipped_pages || 0,
        extractionError: extraction?.error || null,
        distilled: isDistilledPath(rel),
      });
    };
    if (sub) {
      // 递归子树（对话分区：对话/项目/xxx.md）
      const walk = (abs: string, rel: string) => {
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;
          const childAbs = path.join(abs, e.name);
          const childRel = `${rel}/${e.name}`;
          if (e.isDirectory()) walk(childAbs, childRel);
          else pushEntry(e.name, childRel);
        }
      };
      walk(safeJoin(sub), sub);
    } else {
      // 原始资料顶层（保持原样：不递归）
      const top = safeJoin('原始资料');
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(top, { withFileTypes: true }); } catch { /* empty */ }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.isDirectory()) continue;
        pushEntry(e.name, `原始资料/${e.name}`);
      }
    }
    out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return { files: out };
  });

  /** 在原始资料中新建空文件（md/txt），md 自动登记为页面可编辑 */
  app.post('/api/files/create', async (req, reply) => {
    const { name } = req.body as { name?: string };
    if (!name?.trim()) return reply.code(400).send({ error: '文件名为空' });
    const safeName = path.basename(name.trim()).replace(/[\\/:*?"<>|]/g, '-');
    const ext = path.posix.extname(safeName).slice(1).toLowerCase();
    if (!['md', 'markdown', 'txt'].includes(ext)) {
      return reply.code(400).send({ error: '仅支持新建 .md / .txt 文件' });
    }
    let rel = `原始资料/${safeName}`;
    if (fs.existsSync(safeJoin(rel))) {
      return reply.code(409).send({ error: `已存在同名文件：${safeName}` });
    }
    const abs = safeJoin(rel);
    fs.writeFileSync(abs, ext === 'txt' ? '' : `# ${path.basename(rel, path.extname(rel))}\n\n`);
    let pageId: string | undefined;
    if (['md', 'markdown'].includes(ext)) {
      const meta = syncPageFile(rel);
      pageId = meta?.id;
      if (pageId) enqueuePagePipeline(pageId);
      notifySyncChange('page', rel);
    } else if (TEXT_EXTS.has(ext)) {
      const fileId = upsertFileRecord(rel, '', 0);
      enqueue('index_file', { fileId });
      notifySyncChange('file', rel);
    }
    try { appendWikiLog('新建文件', `「${safeName}」（${rel}）`); } catch { /* 日志失败不阻塞 */ }
    return { ok: true, path: rel, pageId };
  });

  /** 上传文件到指定目录；Office/TXT 自动提取文本入索引，可整理格式立即进入 ingest。 */
  app.post('/api/files/upload', async (req, reply) => {
    // 先收集全部 part（dir 字段可能排在文件之后）
    const fields: Record<string, string> = {};
    const incoming: { filename: string; buffer: Buffer }[] = [];
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        fields[part.fieldname] = String(part.value ?? '');
      } else if (part.type === 'file' && part.filename) {
        incoming.push({ filename: part.filename, buffer: await part.toBuffer() });
      }
    }
    const dir = normalizeDir(fields.dir || '') || '原始资料';
    if (!isUploadDir(dir)) {
      return reply.code(403).send({ error: '文件只能上传到「原始资料」目录' });
    }
    // 图片不能作为独立资料上传：图片是某个 md 父项的私有资产，只能插进某个内容里
    // （编辑器内粘贴/拖入，或拖到侧栏某个条目上）。裸图会让侧栏目录、提炼清单、
    // 图谱全部多出一类没有归属的实体——正是本模型要消灭的形态。
    const images = incoming.filter((file) => isAssetFile(path.basename(file.filename)));
    if (images.length) {
      return reply.code(400).send({
        error: images.length === incoming.length
          ? '图片不能单独上传：请把它拖到某个页面或 Markdown 资料上（或直接粘贴进正文），图片会作为该内容的资产保存'
          : `以下图片不能单独上传，请拖到具体内容里：${images.map((f) => path.basename(f.filename)).join('、')}`,
      });
    }
    const saved: any[] = [];
    const duplicates: string[] = [];
    for (const file of incoming) {
      const buffer = file.buffer;
      const safeName = path.basename(file.filename).replace(/[\\/:*?"<>|]/g, '-');
      const rel = path.posix.join(dir, safeName);
      // 同名文件已存在：跳过，不自动改名，记录后统一提示
      if (fs.existsSync(safeJoin(rel))) {
        duplicates.push(safeName);
        continue;
      }
      const abs = safeJoin(rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buffer);

      const ext = path.posix.extname(safeName).slice(1).toLowerCase();
      let indexed = false;
      let pageId: string | undefined;
      if (OFFICE_EXTS.has(ext)) {
        try {
          const text = await officeToText(ext, buffer);
          const fileId = upsertFileRecord(rel, text ?? '', buffer.length);
          enqueue('index_file', { fileId });
          indexed = true;
        } catch (e: any) {
          app.log.warn(`Office 提取失败 ${rel}: ${e.message}`);
        }
        notifySyncChange('file', rel);
      } else if (TEXT_EXTS.has(ext)) {
        const text = buffer.toString('utf8').replace(/\r\n/g, '\n');
        const fileId = upsertFileRecord(rel, text, buffer.length);
        enqueue('index_file', { fileId });
        indexed = true;
        notifySyncChange('file', rel);
      } else if (['md', 'markdown'].includes(ext)) {
        // 上传的 md 直接登记为可编辑页面并入库索引
        const meta = syncPageFile(rel);
        pageId = meta?.id;
        if (pageId) {
          enqueuePagePipeline(pageId);
          indexed = true;
        }
        notifySyncChange('page', rel);
      } else if (dir === '原始资料' && EXTRACTABLE_EXTENSIONS.has(ext)) {
        const fileId = ensureFileRecord(rel, buffer.length);
        const scheduled = scheduleFileExtraction(rel, { mode: 'auto' });
        notifySyncChange('file', rel);
        saved.push({
          path: rel,
          name: path.basename(rel),
          indexed: false,
          fileId,
          extractionJobId: scheduled.jobId || null,
        });
        continue;
      } else {
        // 其余格式（图片等）仅落盘，不入索引，但同样需要多端同步
        notifySyncChange('file', rel);
      }
      try { appendWikiLog('上传文件', `「${safeName}」（${rel}）`); } catch { /* 日志失败不阻塞 */ }
      saved.push({
        path: rel,
        name: path.basename(rel),
        indexed,
        pageId,
      });
    }
    if (saved.length === 0 && duplicates.length > 0) {
      return reply.code(409).send({ error: `已存在同名文件，未重复导入：${duplicates.join('、')}` });
    }
    if (saved.length === 0) return reply.code(400).send({ error: '没有文件' });
    return { saved, duplicates: duplicates.length ? duplicates : undefined };
  });

  /** 文件预览：Office 格式返回二进制地址，由前端开源组件渲染（docx-preview / x-data-spreadsheet / pptx-preview） */
  app.get('/api/files/preview', async (req, reply) => {
    const { path: p } = req.query as { path?: string };
    if (!p) return reply.code(400).send({ error: '缺少 path' });
    const ext = path.posix.extname(p).slice(1).toLowerCase();
    const abs = safeJoin(p);
    if (!fs.existsSync(abs)) return reply.code(404).send({ error: '文件不存在' });
    if (['docx', 'xlsx', 'pptx'].includes(ext)) {
      return { kind: 'office', ext, url: `/api/files/raw?path=${encodeURIComponent(p)}` };
    }
    if (ext === 'pdf') {
      return {
        kind: 'pdf',
        ext,
        url: `/api/files/content?path=${encodeURIComponent(p)}`,
        extraction: extractionDetails(p),
      };
    }
    if (['md', 'markdown'].includes(ext)) {
      const parsed = matter(fs.readFileSync(abs, 'utf8'));
      return { kind: 'markdown', text: parsed.content.trim() };
    }
    if (IMAGE_EXTENSIONS.has(ext)) {
      return {
        kind: 'image',
        url: `/api/files/content?path=${encodeURIComponent(p)}`,
        extraction: extractionDetails(p),
      };
    }
    if (['txt', 'json', 'log', 'yaml', 'yml', 'csv'].includes(ext)) {
      return { kind: 'text', text: fs.readFileSync(abs, 'utf8').slice(0, 200_000) };
    }
    return { kind: 'unsupported', ext };
  });

  /** 浏览器内嵌查看：正确 MIME + 单区间 Range，供 PDF.js 和图片查看器使用。 */
  app.get('/api/files/content', async (req, reply) => {
    const { path: p } = req.query as { path?: string };
    if (!p) return reply.code(400).send({ error: '缺少 path' });
    const abs = safeJoin(p);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return reply.code(404).send({ error: '文件不存在' });
    }
    const stat = fs.statSync(abs);
    const ext = path.extname(abs).slice(1).toLowerCase();
    const mime = CONTENT_TYPES[ext];
    if (!mime) return reply.code(415).send({ error: '该格式不支持内嵌查看' });
    const requestedRange = typeof req.headers.range === 'string' ? req.headers.range : undefined;
    const range = contentRange(requestedRange, stat.size);
    const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    reply.header('Content-Type', mime);
    reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'private, no-cache');
    reply.header('ETag', etag);
    reply.header('X-Content-Type-Options', 'nosniff');
    if (ext === 'svg') reply.header('Content-Security-Policy', 'sandbox');
    if (requestedRange && !range) {
      reply.code(416);
      reply.header('Content-Range', `bytes */${stat.size}`);
      return reply.send();
    }
    if (!range) {
      reply.header('Content-Length', stat.size);
      return reply.send(fs.createReadStream(abs));
    }
    reply.code(206);
    reply.header('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
    reply.header('Content-Length', range.end - range.start + 1);
    return reply.send(fs.createReadStream(abs, range));
  });

  app.get('/api/files/extraction', async (req, reply) => {
    const { path: p } = req.query as { path?: string };
    if (!p) return reply.code(400).send({ error: '缺少 path' });
    const details = extractionDetails(p);
    if (!details) return reply.code(404).send({ error: '尚无文字提取记录' });
    return { extraction: details };
  });

  app.post('/api/files/extract', async (req, reply) => {
    const {
      path: p,
      mode = 'auto',
      pages = [],
    } = (req.body || {}) as {
      path?: string;
      mode?: 'auto' | 'continue' | 'pages' | 'accept_partial';
      pages?: number[];
    };
    if (!p || !p.startsWith('原始资料/')) {
      return reply.code(400).send({ error: '只能提取原始资料中的文件' });
    }
    if (!supportsFileExtraction(p)) {
      return reply.code(400).send({ error: '该格式不支持文字提取' });
    }
    try {
      if (mode === 'accept_partial') {
        return { ok: true, extraction: acceptPartialExtraction(p) };
      }
      if (!['auto', 'continue', 'pages'].includes(mode)) {
        return reply.code(400).send({ error: '提取模式无效' });
      }
      if (mode === 'pages' && (!Array.isArray(pages) || !pages.length)) {
        return reply.code(400).send({ error: '请选择需要重试的页面' });
      }
      const scheduled = scheduleFileExtraction(p, {
        mode,
        pages: pages.map(Number).filter(Number.isInteger).slice(0, 100),
      });
      return reply.code(202).send({ ok: true, jobId: scheduled.jobId || null });
    } catch (error: any) {
      return reply.code(400).send({ error: error?.message || '无法加入提取队列' });
    }
  });

  /** 原始文件下载（浏览器端"系统打开"=下载） */
  app.get('/api/files/raw', async (req, reply) => {
    const { path: p } = req.query as { path?: string };
    if (!p) return reply.code(400).send({ error: '缺少 path' });
    const abs = safeJoin(p);
    if (!fs.existsSync(abs)) return reply.code(404).send({ error: '文件不存在' });
    const name = path.basename(abs);
    reply.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
    );
    reply.header('Content-Type', 'application/octet-stream');
    return reply.send(fs.createReadStream(abs));
  });

  /**
   * 单文件下载：正文里带本地图片的 md 打包成 zip（md 放包根 + `assets/`，正文链接同步改相对路径），
   * 没有图片的文件照原样流式下载。前端各处「下载」入口统一走这里，图片不会再被落下。
   */
  app.get('/api/files/download', async (req, reply) => {
    const { path: p } = req.query as { path?: string };
    if (!p) return reply.code(400).send({ error: '缺少 path' });
    let abs: string;
    try {
      abs = safeJoin(p);
    } catch {
      return reply.code(400).send({ error: '路径无效' });
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return reply.code(404).send({ error: '文件不存在' });
    }
    const name = path.basename(abs);
    const rel = p.replace(/^[/\\]+/, '').replace(/\\/g, '/');
    // 非 md 不读进内存（大文件仍走流式）；md 没有本地图片时同样退回单文件下载
    const zip = new JSZip();
    const assetsAdded = /\.md$/i.test(rel) ? addFileToZip(zip, rel, name) : 0;
    if (!assetsAdded) {
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      reply.header('Content-Type', 'application/octet-stream');
      return reply.send(fs.createReadStream(abs));
    }
    await sendZip(reply, zip, name.replace(/\.[^.]*$/, '') || name);
    return;
  });

  /** 批量导出原始资料为 zip：接收 path 列表，打包后流式下载。
   *  - 路径都经 safeJoin 校验，越界或不存在则跳过并计入 skipped。
   *  - 同名文件（不同子目录）在 zip 内保留相对路径，不会冲突。
   *  - md 正文引用的图片资产一并打包（放回 `assets/<parentId>/`），并把正文里的
   *    `/media/` 重写成相对路径——导出的包离开 Engram 也能直接看到图。 */
  app.post('/api/files/export', async (req, reply) => {
    const { paths, name } = (req.body || {}) as { paths?: string[]; name?: string };
    if (!Array.isArray(paths) || !paths.length) {
      return reply.code(400).send({ error: '未选择要导出的文件' });
    }
    const zip = new JSZip();
    let added = 0;
    let assetsAdded = 0;
    const skipped: string[] = [];
    for (const p of paths) {
      if (typeof p !== 'string' || !p.trim()) continue;
      let abs: string;
      try {
        abs = safeJoin(p);
      } catch {
        skipped.push(p);
        continue;
      }
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        skipped.push(p);
        continue;
      }
      // zip 内路径用相对 brain 的正斜杠形式，保留子目录结构
      const rel = p.replace(/^[/\\]+/, '').replace(/\\/g, '/');
      assetsAdded += addFileToZip(zip, rel, rel);
      added++;
    }
    if (added === 0) {
      return reply.code(404).send({ error: '没有可导出的文件', skipped });
    }
    // zip 名前缀可由调用方指定（如"Wiki导出"/"AI整理日志"），默认"导出"
    const label = name && name.trim() ? name.trim().replace(/[\\/:*?"<>|]/g, '-') : '导出';
    try {
      appendWikiLog(
        '导出',
        `共 ${added} 个文件${assetsAdded ? `、${assetsAdded} 张图片` : ''}${skipped.length ? `，跳过 ${skipped.length} 个` : ''}`
      );
    } catch { /* 日志失败不阻塞 */ }
    await sendZip(reply, zip, label);
    return;
  });

  app.delete('/api/files', async (req, reply) => {
    const { path: p } = req.body as { path: string };
    try {
      const item = moveToTrash(p);
      appendWikiLog('删除', `「${item.name}」（${item.originalPath}，已入回收站）`);
    } catch (error: any) {
      return reply.code(error?.message === '文件不存在' ? 404 : 400).send({
        error: error?.message || '删除失败',
      });
    }
    return { ok: true };
  });
}
