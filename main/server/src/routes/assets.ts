import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { db } from '../lib/db.js';
import {
  attachUnassignedAsset,
  assetDisplayName,
  collectAssetOrphans,
  deletePageAsset,
  isParentId,
  listParentAssets,
  savePageAsset,
  UNASSIGNED_PARENT,
  type PageAsset,
} from '../lib/pageAssets.js';
import { fetchRemoteImage, ImageFetchError } from '../lib/imageFetch.js';
import { appendWikiLog } from '../pipeline/indexFile.js';
import { readPage, writePage } from '../lib/vault.js';

/**
 * 页面图片资产接口。
 *
 * 模型：图片不是独立实体，而是某个 md 父项（Wiki 页面 / 原始资料 md）的私有资产，
 * 归属由父项正文里的 `/media/<parentId>/<file>` 引用决定。所以这里没有「全局图片列表」——
 * 所有读写都必须带父项，前端也只从父项的右键菜单进（见 AssetDrawer.vue）。
 * 例外是 `_unassigned`（历史散图收容所），只在 设置 → 存储空间 里出现。
 */

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/** 父项必须是一个存在的 md 页面；`_unassigned` 不接受写入（只能挂载出去或删除） */
function requireParent(parentId: unknown): { id: string; title: string } {
  const id = String(parentId || '');
  if (!isParentId(id)) throw new Error('父项无效');
  if (id === UNASSIGNED_PARENT) throw new Error('未归属图片池不能作为父项');
  const row = db.prepare(`SELECT id, title FROM pages WHERE id = ? AND deleted = 0`).get(id) as
    | { id: string; title: string }
    | undefined;
  if (!row) throw new Error('父项不存在或不是 md 页面（只有 md 文件有图片资产）');
  return row;
}

function publicAsset(asset: PageAsset) {
  return {
    parentId: asset.parentId,
    name: asset.name,
    url: asset.url,
    path: asset.relPath,
    ext: asset.ext,
    mime: asset.mime,
    size: asset.size,
    updatedAt: asset.updatedAt,
    referenced: asset.referenced,
    ...(asset.sourceUrl ? { sourceUrl: asset.sourceUrl } : {}),
  };
}

export async function assetRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** 某个父项的图片资产（右击 →「查看引用图片」打开抽屉时调） */
  app.get('/api/assets/:parentId', async (req, reply) => {
    const { parentId } = req.params as { parentId: string };
    if (!isParentId(parentId)) return reply.code(400).send({ error: '父项无效' });
    let parent: { id: string; title: string } | null = null;
    if (parentId === UNASSIGNED_PARENT) {
      parent = { id: UNASSIGNED_PARENT, title: '未归属图片' };
    } else {
      const row = db.prepare(`SELECT id, title FROM pages WHERE id = ? AND deleted = 0`).get(parentId) as
        | { id: string; title: string }
        | undefined;
      if (!row) return reply.code(404).send({ error: '父项不存在' });
      parent = row;
    }
    const assets = listParentAssets(parentId);
    return {
      parent: { id: parent.id, title: parent.title },
      assets: assets.map(publicAsset),
    };
  });

  /**
   * 上传图片到某个父项（编辑器粘贴/拖入走这里）。
   * 不接受「没有父项的裸图」——那正是本次要消灭的形态；前端拖到分区空白处会被拦下。
   */
  app.post('/api/assets/upload', async (req, reply) => {
    const fields: Record<string, string> = {};
    const incoming: { filename: string; buffer: Buffer }[] = [];
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        fields[part.fieldname] = String(part.value ?? '');
      } else if (part.type === 'file' && part.filename) {
        const buffer = await part.toBuffer();
        if (buffer.length > MAX_UPLOAD_BYTES) {
          return reply.code(413).send({ error: `图片超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 上限` });
        }
        incoming.push({ filename: part.filename, buffer });
      }
    }
    if (!incoming.length) return reply.code(400).send({ error: '没有图片' });

    let parent: { id: string; title: string };
    try {
      // 父项从表单字段取；Vditor 的 setHeaders 每次上传前重设，因此也接受请求头
      const header = req.headers['x-engram-parent'];
      parent = requireParent(fields.parent || (Array.isArray(header) ? header[0] : header));
    } catch (error: any) {
      return reply.code(400).send({ error: error?.message || '父项无效' });
    }

    const saved: Array<ReturnType<typeof publicAsset>> = [];
    const errors: string[] = [];
    for (const file of incoming) {
      try {
        saved.push(publicAsset(savePageAsset(parent.id, file.filename, file.buffer)));
      } catch (error: any) {
        errors.push(`${file.filename}：${error?.message || '保存失败'}`);
      }
    }
    if (!saved.length) return reply.code(400).send({ error: errors.join('；') || '图片保存失败' });

    // insert=append：把引用追加到父项正文末尾（侧栏把图片拖到某个条目上时用）。
    // 服务端读改写走 writePage，索引/图谱/同步通知都由它统一收口。
    let appended = false;
    if (fields.insert === 'append') {
      try {
        const page = db.prepare(`SELECT path FROM pages WHERE id = ? AND deleted = 0`).get(parent.id) as
          | { path: string }
          | undefined;
        const current = page ? readPage(page.path) : null;
        if (current) {
          // 图注用去掉哈希前缀的原名，正文里不该出现内容哈希
          const block = saved.map((asset) => `![${assetDisplayName(asset.name)}](${asset.url})`).join('\n\n');
          const next = `${current.content.trimEnd()}\n\n${block}\n`;
          writePage(page!.path, next, {});
          appended = true;
        }
      } catch { /* 追加失败不影响图片已入库，用户可在编辑器里手动插入 */ }
    }

    try { appendWikiLog('插入图片', `${saved.length} 张 → [[${parent.title}]]`); } catch { /* 日志失败不阻塞 */ }
    return { saved, errors, appended };
  });

  /**
   * 外链图片本地化：抓取远程图片存成父项资产，原 URL 由前端写进图片 title 作为出处。
   * 抓取失败不报错中断，返回 ok:false 让调用方保留外链（离线/防盗链/私网都要能降级）。
   */
  app.post('/api/assets/import-url', async (req, reply) => {
    const { parent, url } = (req.body || {}) as { parent?: string; url?: string };
    let target: { id: string; title: string };
    try {
      target = requireParent(parent);
    } catch (error: any) {
      return reply.code(400).send({ error: error?.message || '父项无效' });
    }
    const source = String(url || '').trim();
    if (!/^https?:\/\//i.test(source)) return reply.code(400).send({ error: '只支持 http/https 图片地址' });
    try {
      const image = await fetchRemoteImage(source);
      const asset = savePageAsset(target.id, image.name, image.buffer, { sourceUrl: source });
      try { appendWikiLog('本地化外链图片', `${source} → [[${target.title}]]`); } catch { /* 忽略 */ }
      return { ok: true, asset: publicAsset(asset), sourceUrl: source };
    } catch (error: any) {
      const message = error instanceof ImageFetchError ? error.message : (error?.message || '下载失败');
      return { ok: false, error: message };
    }
  });

  /** 删除一张图片资产 */
  app.delete('/api/assets', async (req, reply) => {
    const { parentId, name } = (req.body || {}) as { parentId?: string; name?: string };
    try {
      deletePageAsset(String(parentId || ''), String(name || ''));
    } catch (error: any) {
      return reply.code(400).send({ error: error?.message || '删除失败' });
    }
    try { appendWikiLog('删除图片', `${parentId}/${name}`); } catch { /* 忽略 */ }
    return { ok: true };
  });

  /** 未归属 / 未引用图片（设置 → 存储空间 的清理入口） */
  app.get('/api/assets/orphans/list', async () => {
    const orphans = collectAssetOrphans();
    return {
      unassigned: orphans.unassigned.map(publicAsset),
      unreferenced: orphans.unreferenced.map(publicAsset),
      totalBytes: orphans.totalBytes,
    };
  });

  /** 把未归属图片挂到某个父项下：移动文件 + 把引用追加到父项正文末尾 */
  app.post('/api/assets/attach', async (req, reply) => {
    const { name, parent } = (req.body || {}) as { name?: string; parent?: string };
    let target: { id: string; title: string };
    try {
      target = requireParent(parent);
    } catch (error: any) {
      return reply.code(400).send({ error: error?.message || '父项无效' });
    }
    try {
      const asset = attachUnassignedAsset(String(name || ''), target.id);
      // 挂载后把引用补进正文，否则它立刻又变成「未被引用」的孤儿
      let appended = false;
      try {
        const page = db.prepare(`SELECT path FROM pages WHERE id = ? AND deleted = 0`).get(target.id) as
          | { path: string }
          | undefined;
        const current = page ? readPage(page.path) : null;
        if (current) {
          const next = `${current.content.trimEnd()}\n\n![${assetDisplayName(asset.name)}](${asset.url})\n`;
          writePage(page!.path, next, {});
          appended = true;
        }
      } catch { /* 追加失败不影响挂载本身 */ }
      try { appendWikiLog('挂载图片', `${name} → [[${target.title}]]`); } catch { /* 忽略 */ }
      return { ok: true, asset: publicAsset(asset), parentTitle: target.title, appended };
    } catch (error: any) {
      return reply.code(400).send({ error: error?.message || '挂载失败' });
    }
  });
}
