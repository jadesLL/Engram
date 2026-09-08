import { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../lib/db.js';
import {
  listTree, readPage, writePage, createPage, movePage, mkdir, safeJoin, reconcileMissingPages,
} from '../lib/vault.js';
import { moveToTrash } from '../lib/trash.js';
import { FIXED_DIRS, normalizeDir, isPageDir, typeToDir, ARCHIVE_DIR } from '../config.js';
import { requireAuth } from './auth.js';
import { enqueuePagePipeline } from '../jobs.js';
import { appendWikiLog } from '../pipeline/indexFile.js';
import { renamePageSafely, RenameError } from '../lib/renamePage.js';
import { pageEvidenceResponse } from '../pipeline/pageEvidence.js';
import { GUIDE_VERSION } from '../content/agentGuide.js';

function comparablePageContent(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/<!--\s*(?:ingest:|contribution:|synthesis:)[^>]*-->/g, '')
    .replace(/\[(?:managed)?\]\(#ingest-preserved-[A-Za-z0-9_-]+\)/g, '')
    .trim();
}

export async function pageRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/pages/tree', async () => ({ tree: listTree() }));

  app.get('/api/pages/list', async (req) => {
    const { type, tag, outdated } = req.query as { type?: string; tag?: string; outdated?: string };
    // 带外删除（Agent 裸移文件、外部程序）会让行停在 deleted=0：列表前对账一次，
    // 否则侧栏留下点开报「文件不存在」的幽灵页（等价于启动扫描，只是立刻生效）
    reconcileMissingPages();
    let rows = db
      .prepare(`SELECT id, path, title, type, tags, summary, created_at, updated_at, word_count, guide_version FROM pages WHERE deleted = 0 ORDER BY updated_at DESC`)
      .all() as any[];
    if (type) rows = rows.filter((r) => r.type === type);
    if (tag) rows = rows.filter((r) => (JSON.parse(r.tags) as string[]).includes(tag));
    // 规则落后 = 提炼规则版本低于当前指南（存量旧行为 0）。重提炼对象只含 Agent 维护的
    // 概念/实体 页：原始资料只读不改，归档页不再维护，均不入清单
    if (outdated === 'true' || outdated === '1') {
      rows = rows.filter((r) =>
        (r.path.startsWith('Wiki/概念/') || r.path.startsWith('Wiki/实体/'))
        && Number(r.guide_version ?? 0) < GUIDE_VERSION
      );
    }
    return { guideVersion: GUIDE_VERSION, pages: rows.map((r) => ({ ...r, tags: JSON.parse(r.tags) })) };
  });

  app.get('/api/pages/tags', async () => {
    const rows = db.prepare(`SELECT tags FROM pages WHERE deleted = 0`).all() as any[];
    const count = new Map<string, number>();
    for (const r of rows) {
      for (const t of JSON.parse(r.tags) as string[]) count.set(t, (count.get(t) || 0) + 1);
    }
    return { tags: [...count.entries()].map(([name, n]) => ({ name, count: n })).sort((a, b) => b.count - a.count) };
  });

  app.get('/api/pages/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const page = db.prepare(`SELECT path FROM pages WHERE id = ? AND deleted = 0`).get(id) as any;
    if (!page) return reply.code(404).send({ error: '页面不存在' });
    const rd = readPage(page.path);
    if (!rd) return reply.code(404).send({ error: '文件不存在' });
    return rd;
  });

  app.get('/api/pages/:id/evidence', async (req, reply) => {
    const { id } = req.params as { id: string };
    const evidence = pageEvidenceResponse(id);
    if (!evidence) return reply.code(404).send({ error: '页面不存在或不是可综合的概念/实体页' });
    return evidence;
  });

  /** wikilink 跳转：按标题解析 */
  app.get('/api/pages/by-title/:title', async (req, reply) => {
    const { title } = req.params as { title: string };
    const page = db
      .prepare(`SELECT id FROM pages WHERE deleted = 0 AND lower(title) = lower(?)`)
      .get(decodeURIComponent(title)) as any;
    if (!page) return reply.code(404).send({ error: 'not found' });
    return { id: page.id };
  });

  /** wikilink 自动补全 */
  app.get('/api/pages/suggest', async (req) => {
    const { q } = req.query as { q?: string };
    const rows = db
      .prepare(`SELECT id, title, path FROM pages WHERE deleted = 0 AND title LIKE ? ORDER BY updated_at DESC LIMIT 10`)
      .all(`%${q || ''}%`);
    return { suggestions: rows };
  });

  app.post('/api/pages', async (req) => {
    const { dir, title, type } = req.body as { dir?: string; title?: string; type?: string };
    // 类型即目录：显式 dir 优先（需为合法页面目录），否则按类型映射；默认概念
    const pageType = type || 'concept';
    const targetDir = dir && isPageDir(normalizeDir(dir)) ? normalizeDir(dir) : typeToDir(pageType);
    const meta = createPage(targetDir, title || '未命名页面');
    appendWikiLog('新建页面', `[[${meta.title}]]（${meta.path}）`);
    if (pageType !== meta.type) {
      writePage(meta.path, readPage(meta.path)?.content ?? '', { type: pageType });
      const updated = db.prepare(`SELECT * FROM pages WHERE id = ?`).get(meta.id) as any;
      enqueuePagePipeline(meta.id);
      return { meta: { ...updated, tags: JSON.parse(updated.tags) } };
    }
    enqueuePagePipeline(meta.id);
    return { meta };
  });

  app.put('/api/pages/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { content, title, type, tags } = req.body as any;
    const page = db.prepare(`SELECT path,title,type,tags FROM pages WHERE id = ? AND deleted = 0`).get(id) as any;
    if (!page) return reply.code(404).send({ error: '页面不存在' });
    const current = readPage(page.path);
    const currentTags = current?.meta.tags || JSON.parse(page.tags || '[]');
    const nextTags = Array.isArray(tags) ? tags : currentTags;
    // content 未传时保留现有正文：本路由支持 title/type/tags 单独更新（如侧栏拖拽改类型只发 type），
    // 缺省成 '' 会把整页正文清空。
    const nextContent = content === undefined ? (current?.content ?? '') : String(content);
    const unchanged = current &&
      comparablePageContent(nextContent) === comparablePageContent(current.content) &&
      (title === undefined || title === page.title) &&
      (type === undefined || type === page.type) &&
      JSON.stringify(nextTags) === JSON.stringify(currentTags);
    if (unchanged) return { meta: current.meta, unchanged: true };
    const meta = writePage(page.path, nextContent, { title, type, tags });
    // 类型变化 → 物理移动到映射目录（归档区与 Wiki 树外的页面不自动移动）
    if (type && type !== page.type && page.path.startsWith('Wiki/') && !page.path.startsWith('Wiki/归档/')) {
      const targetDir = typeToDir(type);
      const filename = path.posix.basename(page.path);
      const newRel = path.posix.join(targetDir, filename);
      if (newRel !== page.path && !fs.existsSync(safeJoin(newRel))) {
        movePage(page.path, newRel);
      }
    }
    enqueuePagePipeline(meta.id);
    try { appendWikiLog('编辑页面', `[[${page.title}]]（${page.path}）`); } catch { /* 日志失败不阻塞 */ }
    const fresh = db.prepare(`SELECT * FROM pages WHERE id = ?`).get(meta.id) as any;
    return { meta: { ...fresh, tags: JSON.parse(fresh.tags) } };
  });

  /** 归档：移入 Wiki/归档/ */
  app.post('/api/pages/:id/archive', async (req, reply) => {
    const { id } = req.params as { id: string };
    const page = db.prepare(`SELECT path, title FROM pages WHERE id = ? AND deleted = 0`).get(id) as any;
    if (!page) return reply.code(404).send({ error: '页面不存在' });
    if (page.path.startsWith(ARCHIVE_DIR + '/')) return { ok: true }; // 已在归档区
    let newRel = path.posix.join(ARCHIVE_DIR, path.posix.basename(page.path));
    let i = 1;
    while (fs.existsSync(safeJoin(newRel))) {
      const base = path.posix.basename(page.path, '.md');
      newRel = path.posix.join(ARCHIVE_DIR, `${base}-${i++}.md`);
    }
    movePage(page.path, newRel);
    appendWikiLog('归档', `[[${page.title}]] → ${ARCHIVE_DIR}/`);
    return { ok: true };
  });

  /** 安全重命名：移动文件 + 改标题 + 重定向所有引用双链（用于实体歧义澄清） */
  app.post('/api/pages/:id/rename', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { newTitle } = req.body as { newTitle?: string };
    try {
      renamePageSafely(id, newTitle || '');
    } catch (e) {
      const status = e instanceof RenameError ? e.status : 500;
      return reply.code(status).send({ error: e instanceof Error ? e.message : String(e) });
    }
    return { ok: true };
  });

  /** 取消归档：按其类型移回对应目录 */
  app.post('/api/pages/:id/unarchive', async (req, reply) => {
    const { id } = req.params as { id: string };
    const page = db.prepare(`SELECT path, title, type FROM pages WHERE id = ? AND deleted = 0`).get(id) as any;
    if (!page) return reply.code(404).send({ error: '页面不存在' });
    if (!page.path.startsWith(ARCHIVE_DIR + '/')) return { ok: true }; // 不在归档区
    const targetDir = typeToDir(page.type);
    let newRel = path.posix.join(targetDir, path.posix.basename(page.path));
    let i = 1;
    while (fs.existsSync(safeJoin(newRel))) {
      const base = path.posix.basename(page.path, '.md');
      newRel = path.posix.join(targetDir, `${base}-${i++}.md`);
    }
    movePage(page.path, newRel);
    appendWikiLog('取消归档', `[[${page.title}]] → ${targetDir}/`);
    return { ok: true };
  });

  app.post('/api/pages/:id/move', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { dir, newTitle } = req.body as { dir?: string; newTitle?: string };
    const page = db.prepare(`SELECT path, title FROM pages WHERE id = ? AND deleted = 0`).get(id) as any;
    if (!page) return reply.code(404).send({ error: '页面不存在' });
    // 固定目录约束：只允许在 Wiki 树内移动
    const targetDir = dir !== undefined ? (normalizeDir(dir) || 'Wiki') : path.posix.dirname(page.path);
    if (!isPageDir(targetDir)) {
      return reply.code(400).send({ error: '页面只能移动到 Wiki 目录内' });
    }
    const filename = (newTitle || page.title).replace(/[\\/:*?"<>|]/g, '-') + '.md';
    const newRel = path.posix.join(targetDir, filename);
    if (newRel === page.path) return { ok: true };
    const meta = movePage(page.path, newRel);
    if (!meta) return reply.code(500).send({ error: '移动失败' });
    if (newTitle && newTitle !== page.title) {
      const rd = readPage(newRel);
      if (rd) writePage(newRel, rd.content, { title: newTitle });
    }
    try { appendWikiLog('移动', `[[${page.title}]] → ${newRel}`); } catch { /* 日志失败不阻塞 */ }
    return { ok: true, meta };
  });

  app.delete('/api/pages/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const page = db.prepare(`SELECT path, title FROM pages WHERE id = ? AND deleted = 0`).get(id) as any;
    if (!page) return reply.code(404).send({ error: '页面不存在' });
    moveToTrash(page.path);
    appendWikiLog('删除', `[[${page.title}]]（${page.path}，已入回收站）`);
    return { ok: true };
  });

  /** 目录结构固定：只允许"创建"预定义目录（幂等种子），禁止任意建目录 */
  app.post('/api/mkdir', async (req, reply) => {
    const { path: p } = req.body as { path: string };
    if (!(FIXED_DIRS as readonly string[]).includes(normalizeDir(p || ''))) {
      return reply.code(403).send({ error: '目录结构是固定的，不能新建文件夹' });
    }
    mkdir(p);
    return { ok: true };
  });

  /** 页面关联：图谱邻居（供编辑器底部展示）；语义相似随向量索引移除 */
  const relatedCache = new Map<string, { at: number; data: unknown }>();
  const RELATED_CACHE_TTL_MS = 60_000;
  app.get('/api/pages/:id/related', async (req) => {
    const { id } = req.params as { id: string };
    const cached = relatedCache.get(id);
    if (cached && Date.now() - cached.at < RELATED_CACHE_TTL_MS) return cached.data;
    // 图谱邻居（出边 + 入边）
    const neighbors = db
      .prepare(
        `SELECT DISTINCT p.id, p.title, p.path, p.type,
                CASE WHEN e.src_page = ? THEN 'out' ELSE 'in' END AS direction, e.rel
         FROM edges e JOIN pages p ON p.id = (CASE WHEN e.src_page = ? THEN e.dst_page ELSE e.src_page END)
         WHERE (e.src_page = ? OR e.dst_page = ?) AND p.deleted = 0 AND e.dst_page IS NOT NULL`
      )
      .all(id, id, id, id) as any[];

    const entities = db
      .prepare(
        `SELECT e2.name, e2.type, e.rel FROM edges e JOIN entities e2 ON e2.id = e.entity_id
         WHERE e.src_page = ? AND e.entity_id IS NOT NULL`
      )
      .all(id) as any[];

    const data = { neighbors, similar: [] as any[], entities };
    relatedCache.set(id, { at: Date.now(), data });
    return data;
  });
}
