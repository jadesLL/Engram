import fs from 'node:fs';
import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { safeJoin, notifySyncChange } from '../lib/vault.js';
import { moveToTrash } from '../lib/trash.js';
import { emit } from '../lib/events.js';
import { noteAppWrite } from '../lib/appWrites.js';
import { enqueue } from '../jobQueue.js';
import { listInboxItems, inboxCategoryOf, type InboxItem } from '../lib/inboxItems.js';
import {
  adoptInboxItem,
  capabilityHint,
  convertCapability,
  readDerivedMarkdown,
} from '../pipeline/inboxConvert.js';
import {
  INBOX_DIR,
  INBOX_DERIVED_DIR,
  isInboxPath,
  isInboxDerivedPath,
  uniqueDerivedPath,
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
 * 收集箱不设固定单文件大小上限，必须边收边写。
 */

/** 单次请求最多文件数 */
const INBOX_MAX_FILES = 200;

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

export async function inboxRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** 收集箱列表：目录实时扫描（同步落地、外部拷入都会立刻反映），不额外维护状态表 */
  app.get('/api/inbox/items', async () => {
    const { items, counts } = listInboxItems();
    return {
      dir: INBOX_DIR,
      derivedDir: INBOX_DERIVED_DIR,
      counts,
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
      // Fastify 的全局 multipart 默认仍有限制；这里显式覆盖为 Infinity。
      limits: { fileSize: Infinity, files: INBOX_MAX_FILES },
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
        skipped.push({ name, reason: '上传数据不完整' });
        continue;
      }
      noteAppWrite(abs);
      notifySyncChange('file', rel);
      emit('file-changed', { path: rel });
      const stat = fs.statSync(abs);
      const capability = convertCapability(rel);
      saved.push({
        path: rel,
        name,
        rel: rel.slice(INBOX_DIR.length + 1),
        ext: (name.split('.').pop() || '').toLowerCase(),
        size: stat.size,
        mtime: stat.mtimeMs,
        category: inboxCategoryOf(name),
        status: 'pending',
        derivedPath: null,
        capability,
        hint: capabilityHint(rel, capability),
        error: '',
        jobId: null,
      } satisfies InboxItem);
    }

    if (!saved.length && skipped.length) {
      return reply.code(413).send({ error: skipped[0].reason, skipped });
    }
    return { saved, skipped, total: listInboxItems().counts.all };
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

  /**
   * 语义转换：入队 inbox_convert。按内容重写成 Markdown，产物留在收集箱。
   * 同一份文件重复点不会排两次（jobQueue 按 kind+payload 去重）。
   */
  app.post('/api/inbox/convert', async (req, reply) => {
    const body = (req.body || {}) as { paths?: string[]; all?: boolean };
    const requested = body.all
      ? listInboxItems().items.map((item) => item.path)
      : Array.isArray(body.paths)
        ? body.paths
        : [];
    if (!requested.length) return reply.code(400).send({ error: '没有要转换的文件' });

    const queued: { path: string; jobId: number }[] = [];
    const skipped: { path: string; reason: string }[] = [];
    for (const rel of requested) {
      if (!isInboxPath(rel) || isInboxDerivedPath(rel) || !fs.existsSync(safeJoin(rel))) {
        skipped.push({ path: String(rel), reason: '路径无效' });
        continue;
      }
      const capability = convertCapability(rel);
      if (capability === 'agent-only' || capability === 'unsupported') {
        skipped.push({ path: rel, reason: capabilityHint(rel, capability) });
        continue;
      }
      const jobId = enqueue('inbox_convert', { path: rel });
      if (typeof jobId === 'number') queued.push({ path: rel, jobId });
      else queued.push({ path: rel, jobId: 0 }); // 已有同样的任务在排队/运行：0 = 复用
      emit('file-changed', { path: rel });
    }
    return { queued, skipped };
  });

  /** 读取转换产物（产物是 Engram 生成的草稿，不是「收集箱原件」，因此在应用内可读可审） */
  app.get('/api/inbox/derived', async (req, reply) => {
    const { path: rel } = req.query as { path?: string };
    if (!rel || !isInboxPath(rel) || isInboxDerivedPath(rel)) {
      return reply.code(400).send({ error: '路径无效' });
    }
    try {
      const { derivedPath, markdown } = readDerivedMarkdown(rel);
      return { path: rel, derivedPath, markdown, chars: markdown.length };
    } catch (error: any) {
      return reply.code(404).send({ error: error.message || '还没有转换产物' });
    }
  });

  /**
   * 入库：把转换产物复制进 原始资料/收集箱/ 并登记为知识库页面。
   * 这是收集箱内容变成「可检索、可引用」的唯一入口，只由用户显式触发。
   */
  app.post('/api/inbox/adopt', async (req, reply) => {
    const { path: rel } = (req.body || {}) as { path?: string };
    if (!rel || !isInboxPath(rel) || isInboxDerivedPath(rel)) {
      return reply.code(400).send({ error: '路径无效' });
    }
    try {
      const result = adoptInboxItem(rel);
      return { ...result, source: rel };
    } catch (error: any) {
      return reply.code(400).send({ error: error.message || '入库失败' });
    }
  });
}
