import { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { db } from '../lib/db.js';
import { safeJoin } from '../lib/vault.js';
import { moveToTrash } from '../lib/trash.js';
import { requireAuth } from './auth.js';
import { officeToText } from '../pipeline/office.js';
import { upsertFileRecord } from '../pipeline/indexer.js';
import { enqueue } from '../jobs.js';
import { normalizeDir, isUploadDir } from '../config.js';
import { syncPageFile } from '../lib/vault.js';
import { appendWikiLog } from '../pipeline/indexFile.js';

/** 可提取文本入索引的 Office 格式 */
const OFFICE_EXTS = new Set(['docx', 'xlsx', 'pptx']);
const TEXT_EXTS = new Set(['txt']);
const INGEST_EXTS = new Set(['docx', 'md', 'markdown', 'txt', 'xlsx', 'pptx']);

export async function fileRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** 原始资料文件列表（供侧栏展示）；md 文件附带 page id（可直接进编辑器）。
   *  默认只列 原始资料 顶层；?dir=原始资料/对话 时递归该子树（对话分区用，与原始资料同构）。 */
  app.get('/api/files/list', async (req) => {
    const { dir } = req.query as { dir?: string };
    const sub = dir ? normalizeDir(dir) : '';
    const out: any[] = [];
    const pushEntry = (name: string, rel: string) => {
      const abs = safeJoin(rel);
      let stat: fs.Stats;
      try { stat = fs.statSync(abs); } catch { return; }
      const ext = path.extname(name).slice(1).toLowerCase();
      let pageId: string | undefined;
      if (['md', 'markdown'].includes(ext)) {
        const page = db.prepare(`SELECT id FROM pages WHERE path = ? AND deleted = 0`).get(rel) as any;
        pageId = page?.id;
      }
      const ing = db.prepare(`SELECT at, status, error FROM ingest_log WHERE path = ?`).get(rel) as any;
      out.push({
        name, path: rel, ext, size: stat.size,
        updated_at: stat.mtime.toISOString(),
        pageId,
        ingestSupported: INGEST_EXTS.has(ext),
        ingestedAt: ing?.status === 'completed' ? ing.at : null,
        ingestStatus: ing?.status || null,
        ingestError: ing?.error || null,
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
      if (pageId) enqueue('embed', { pageId });
    } else if (TEXT_EXTS.has(ext)) {
      const fileId = upsertFileRecord(rel, '', 0);
      enqueue('index_file', { fileId });
    }
    enqueue('ingest', { path: rel });
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
      } else if (TEXT_EXTS.has(ext)) {
        const text = buffer.toString('utf8').replace(/\r\n/g, '\n');
        const fileId = upsertFileRecord(rel, text, buffer.length);
        enqueue('index_file', { fileId });
        indexed = true;
      } else if (['md', 'markdown'].includes(ext)) {
        // 上传的 md 直接登记为可编辑页面并入库索引
        const meta = syncPageFile(rel);
        pageId = meta?.id;
        if (pageId) {
          enqueue('embed', { pageId });
          indexed = true;
        }
      }
      // 原始资料入料即消化（AI 提炼概念/实体页到 Wiki）
      if (INGEST_EXTS.has(ext)) {
        enqueue('ingest', { path: rel });
      }
      saved.push({
        path: rel,
        name: path.basename(rel),
        indexed,
        pageId,
        ingestSupported: INGEST_EXTS.has(ext),
        ingestNote: INGEST_EXTS.has(ext) ? undefined : '文件已保存，当前格式暂不支持 AI 整理',
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
    if (['md', 'markdown'].includes(ext)) {
      const parsed = matter(fs.readFileSync(abs, 'utf8'));
      return { kind: 'markdown', text: parsed.content.trim() };
    }
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
      return { kind: 'image', url: `/api/files/raw?path=${encodeURIComponent(p)}` };
    }
    if (['txt', 'json', 'log', 'yaml', 'yml', 'csv'].includes(ext)) {
      return { kind: 'text', text: fs.readFileSync(abs, 'utf8').slice(0, 200_000) };
    }
    return { kind: 'unsupported', ext };
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

  /** Tauri 桌面端：下载到临时目录后用系统程序打开（由客户端完成打开动作，这里只提供字节流） */
  app.get('/api/files/open', async (req, reply) => {
    const { path: p } = req.query as { path?: string };
    if (!p) return reply.code(400).send({ error: '缺少 path' });
    const abs = safeJoin(p);
    if (!fs.existsSync(abs)) return reply.code(404).send({ error: '文件不存在' });
    reply.header('X-File-Name', encodeURIComponent(path.basename(abs)));
    reply.header('Content-Type', 'application/octet-stream');
    return reply.send(fs.createReadStream(abs));
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
