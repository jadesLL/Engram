import { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../lib/db.js';
import {
  listTree, readPage, writePage, createPage, movePage, mkdir, safeJoin,
} from '../lib/vault.js';
import { moveToTrash } from '../lib/trash.js';
import { FIXED_DIRS, normalizeDir, isPageDir, typeToDir, ARCHIVE_DIR } from '../config.js';
import { requireAuth } from './auth.js';
import { enqueue, enqueuePagePipeline } from '../jobs.js';
import { appendWikiLog } from '../pipeline/indexFile.js';
import { mergePages, MergeError } from '../lib/mergePages.js';
import { renamePageSafely, RenameError } from '../lib/renamePage.js';
import { pageEvidenceResponse, queuePageRecompose } from '../pipeline/pageSynthesis.js';
import { isSynthesizable } from '../lib/pageTypes.js';
import { allPageContributions } from '../pipeline/sourceLedger.js';

export { stamp } from '../lib/mergePages.js';

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
    const { type, tag } = req.query as { type?: string; tag?: string };
    let rows = db
      .prepare(`SELECT id, path, title, type, tags, summary, created_at, updated_at, word_count FROM pages WHERE deleted = 0 ORDER BY updated_at DESC`)
      .all() as any[];
    if (type) rows = rows.filter((r) => r.type === type);
    if (tag) rows = rows.filter((r) => (JSON.parse(r.tags) as string[]).includes(tag));
    return { pages: rows.map((r) => ({ ...r, tags: JSON.parse(r.tags) })) };
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

  app.post('/api/pages/:id/recompose', async (req, reply) => {
    const { id } = req.params as { id: string };
    const force = (req.query as { force?: string } | undefined)?.force === 'true';
    const page = db.prepare(`SELECT id,title,type FROM pages WHERE id=? AND deleted=0`).get(id) as { title: string; type: string } | undefined;
    if (!page) return reply.code(404).send({ error: '页面不存在' });
    if (!isSynthesizable(page.type)) return reply.code(409).send({ error: '该页面类型不支持整页综合' });
    const synthesisId = queuePageRecompose(id, { force });
    if (!synthesisId) return reply.code(409).send({ error: '页面没有可综合的有效来源事实，或尚未配置模型' });
    try { appendWikiLog('整页综合', `[[${page.title}]]（${id}）`); } catch { /* 日志失败不阻塞 */ }
    return { ok: true, synthesisId };
  });

  /** 按页面重新提炼：反查依赖来源，强制重跑完整提炼管线（连带刷新共享来源的其他页面） */
  app.post('/api/pages/:id/reextract', async (req, reply) => {
    const { id } = req.params as { id: string };
    const page = db.prepare(`SELECT id,title,type FROM pages WHERE id=? AND deleted=0`).get(id) as { id: string; title: string; type: string } | undefined;
    if (!page) return reply.code(404).send({ error: '页面不存在' });
    if (!isSynthesizable(page.type)) return reply.code(409).send({ error: '该页面类型不支持重新提炼' });
    const sources = [...new Set(allPageContributions(id).map((item) => item.source_path))];
    if (!sources.length) return reply.code(409).send({ error: '该页面没有可重新提炼的来源' });
    enqueue('page_reextract', { pageId: id });
    try { appendWikiLog('重新提炼', `[[${page.title}]]（${sources.length} 份来源）`); } catch { /* 日志失败不阻塞 */ }
    return { ok: true, sources: sources.length };
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
    const unchanged = current &&
      comparablePageContent(String(content ?? '')) === comparablePageContent(current.content) &&
      (title === undefined || title === page.title) &&
      (type === undefined || type === page.type) &&
      JSON.stringify(nextTags) === JSON.stringify(currentTags);
    if (unchanged) return { meta: current.meta, unchanged: true };
    const meta = writePage(page.path, content ?? '', { title, type, tags });
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

  /** 合并两页：keep 吸收 other 的内容（追加为其时间线事件），other 归档，写合并日志 */
  app.post('/api/pages/merge', async (req, reply) => {
    const { keepId, otherId } = req.body as { keepId?: string; otherId?: string };
    try {
      await mergePages(keepId || '', otherId || '');
    } catch (e) {
      const status = e instanceof MergeError ? e.status : 500;
      return reply.code(status).send({ error: e instanceof Error ? e.message : String(e) });
    }
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

  /** 页面关联：图谱邻居 + 语义相似（供编辑器底部展示） */
  // 短 TTL 内存缓存：向量 KNN 是全表扫描，数据库在 Windows bind mount 上随机
  // 读极慢（实测每页 ~0.85s），编辑器每次打开页面都会请求本接口。60s 内重复
  // 点击同一页面直接返回缓存；关联数据对实时性不敏感，可接受 60s 陈旧窗口。
  const relatedCache = new Map<string, { at: number; data: unknown }>();
  const RELATED_CACHE_TTL_MS = 60_000;
  const RELATED_CACHE_MAX = 200;
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

    // 语义相似（第一 chunk 向量最近邻）
    let similar: any[] = [];
    try {
      const rep = db
        .prepare(`SELECT id FROM chunks WHERE ref_type = 'page' AND ref_id = ? AND idx = 0`)
        .get(id) as any;
      const vecRow = rep
        ? (db.prepare(`SELECT embedding FROM vec_chunks WHERE rowid = ?`).get(rep.id) as any)
        : null;
      if (vecRow?.embedding) {
        similar = db
          .prepare(
            `SELECT c.ref_id AS id, p.title, p.path, p.type, v.distance
             FROM vec_chunks v JOIN chunks c ON c.id = v.rowid
             JOIN pages p ON p.id = c.ref_id
             WHERE v.embedding MATCH ?
               AND k = 6 AND c.ref_type = 'page' AND c.ref_id != ? AND p.deleted = 0
             ORDER BY v.distance`
          )
          .all(vecRow.embedding, id) as any[];
      }
    } catch {
      /* 无向量时忽略 */
    }

    const entities = db
      .prepare(
        `SELECT e2.name, e2.type, e.rel FROM edges e JOIN entities e2 ON e2.id = e.entity_id
         WHERE e.src_page = ? AND e.entity_id IS NOT NULL`
      )
      .all(id) as any[];

    const data = { neighbors, similar, entities };
    relatedCache.set(id, { at: Date.now(), data });
    if (relatedCache.size > RELATED_CACHE_MAX) {
      let oldestKey: string | undefined;
      let oldestAt = Infinity;
      for (const [key, value] of relatedCache) {
        if (value.at < oldestAt) {
          oldestAt = value.at;
          oldestKey = key;
        }
      }
      if (oldestKey) relatedCache.delete(oldestKey);
    }
    return data;
  });
}
