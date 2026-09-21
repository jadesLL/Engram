import { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { ASSETS_DIR } from '../config.js';
import { requireAuth } from './auth.js';
import { assetMime, isAssetFile, isParentId } from '../lib/pageAssets.js';

/**
 * 页面图片资产的直链出口：`/media/<parentId>/<file>` → `brain/assets/<parentId>/<file>`。
 *
 * 为什么单开一条根级路由，而不是复用 `/api/files/content`：
 *  - 正文里存的是根相对路径，图片在编辑器 IR 预览、阅读视图、文件预览三处都能被浏览器
 *    直接解析，不需要任何 DOM 改写；页面在 Wiki 子目录之间移动也不会失效。
 *  - `/assets/` 已被前端构建产物占用（`web/dist/assets/*.js`，见 lib/staticAssets.ts 的
 *    缓存策略），所以另起 `/media/` 前缀，避免与 SPA 资源撞路径。
 * 鉴权沿用 Cookie：同源 `<img>` 请求会带上 token，与其它 API 一致。
 */
export async function mediaRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/media/*', async (req, reply) => {
    const wildcard = String((req.params as Record<string, string>)['*'] || '');
    const segments = wildcard.split('/').filter(Boolean);
    // 只允许「一个父项目录 + 一个文件名」两层，杜绝子目录与穿越
    if (segments.length !== 2) return reply.code(404).send({ error: '图片不存在' });
    const [parentId, name] = segments;
    if (!isParentId(parentId) || !isAssetFile(name)) {
      return reply.code(404).send({ error: '图片不存在' });
    }
    const abs = path.resolve(ASSETS_DIR, parentId, name);
    if (!abs.startsWith(ASSETS_DIR + path.sep)) {
      return reply.code(404).send({ error: '图片不存在' });
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return reply.code(404).send({ error: '图片不存在' });
    }
    if (!stat.isFile()) return reply.code(404).send({ error: '图片不存在' });

    // 文件名是内容寻址的（<sha1-8>-<原名>），所以可以安全地长缓存
    const etag = `"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    reply.header('Content-Type', assetMime(name) || 'application/octet-stream');
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    reply.header('ETag', etag);
    reply.header('X-Content-Type-Options', 'nosniff');
    if (name.toLowerCase().endsWith('.svg')) {
      // SVG 可携带脚本：按静态资源沙箱化，避免同源执行
      reply.header('Content-Security-Policy', 'sandbox');
    }
    const inm = req.headers['if-none-match'];
    const inmValue = Array.isArray(inm) ? inm.join(',') : inm;
    if (inmValue?.split(',').some((candidate) => candidate.trim() === etag)) {
      return reply.code(304).send();
    }
    reply.header('Content-Length', stat.size);
    if (req.method === 'HEAD') return reply.send();
    return reply.send(fs.createReadStream(abs));
  });
}
