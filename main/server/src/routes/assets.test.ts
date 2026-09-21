import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-assets-routes-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let token = '';
let ASSETS_DIR = '';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** 手搓 multipart 请求体（避免为测试引入额外依赖） */
function form(
  fields: Record<string, string>,
  files: Array<{ filename: string; content: Buffer; type?: string }>
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----engramtest${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
    ));
  }
  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.filename}"\r\n`
      + `Content-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`
    ));
    chunks.push(file.content);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  ({ ASSETS_DIR } = await import('../config.js'));

  const [{ pageRoutes }, { fileRoutes }, { assetRoutes }, { mediaRoutes }] = await Promise.all([
    import('./pages.js'),
    import('./files.js'),
    import('./assets.js'),
    import('./media.js'),
  ]);
  app = Fastify();
  await app.register(jwt, { secret: 'assets-route-test-secret' });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  await app.register(pageRoutes);
  await app.register(fileRoutes);
  await app.register(assetRoutes);
  await app.register(mediaRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${token}` });

async function newPage(title: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/pages',
    headers: auth(),
    payload: { title, type: 'concept' },
  });
  assert.equal(res.statusCode, 200);
  return res.json().meta.id;
}

test('图片不能作为独立资料上传（/api/files/upload 拒绝）', async () => {
  const req = form({ dir: '原始资料' }, [{ filename: '现场照片.png', content: PNG, type: 'image/png' }]);
  const res = await app.inject({
    method: 'POST',
    url: '/api/files/upload',
    headers: { ...auth(), ...req.headers },
    payload: req.payload,
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /图片不能单独上传/);
  assert.equal(fs.existsSync(path.join(temp, 'brain', '原始资料', '现场照片.png')), false);
});

test('原始资料列表不列图片（历史散图也不进侧栏）', async () => {
  const rawDir = path.join(temp, 'brain', '原始资料');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, '纪要.txt'), '正文');
  fs.writeFileSync(path.join(rawDir, '遗留散图.png'), PNG);

  const res = await app.inject({ method: 'GET', url: '/api/files/list', headers: auth() });
  assert.equal(res.statusCode, 200);
  const names = res.json().files.map((f: any) => f.name);
  assert.ok(names.includes('纪要.txt'));
  assert.equal(names.includes('遗留散图.png'), false);
});

test('上传到父项 + /media 直链 + 抽屉列表 + 删除', async () => {
  const pageId = await newPage('图片接口测试');

  // 没有父项 → 拒绝（裸图正是要消灭的形态）
  const orphanReq = form({}, [{ filename: 'a.png', content: PNG, type: 'image/png' }]);
  const orphanRes = await app.inject({
    method: 'POST',
    url: '/api/assets/upload',
    headers: { ...auth(), ...orphanReq.headers },
    payload: orphanReq.payload,
  });
  assert.equal(orphanRes.statusCode, 400);

  // 带父项 → 落成该页面的资产
  const req = form({ parent: pageId, insert: 'append' }, [
    { filename: '产线.png', content: PNG, type: 'image/png' },
  ]);
  const up = await app.inject({
    method: 'POST',
    url: '/api/assets/upload',
    headers: { ...auth(), ...req.headers },
    payload: req.payload,
  });
  assert.equal(up.statusCode, 200);
  const saved = up.json().saved[0];
  assert.equal(saved.parentId, pageId);
  assert.equal(up.json().appended, true);
  assert.match(saved.name, /^[0-9a-f]{8}-产线\.png$/);
  // url 里的文件名是 URL 编码过的
  assert.equal(saved.url, `/media/${pageId}/${encodeURIComponent(saved.name)}`);

  // 引用已追加到正文，所以是「被引用」而不是孤儿
  const listed = await app.inject({ method: 'GET', url: `/api/assets/${pageId}`, headers: auth() });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().assets.length, 1);
  assert.equal(listed.json().assets[0].referenced, true);

  // 页面列表带 assetCount，供侧栏右键菜单显示张数
  const pages = await app.inject({ method: 'GET', url: '/api/pages/list', headers: auth() });
  const row = pages.json().pages.find((p: any) => p.id === pageId);
  assert.equal(row.assetCount, 1);

  // /media 直链：正确 MIME + 长缓存 + ETag 命中 304
  const media = await app.inject({ method: 'GET', url: saved.url, headers: auth() });
  assert.equal(media.statusCode, 200);
  assert.equal(media.headers['content-type'], 'image/png');
  assert.equal(media.headers['cache-control'], 'private, max-age=31536000, immutable');
  assert.equal(media.headers['x-content-type-options'], 'nosniff');
  const cached = await app.inject({
    method: 'GET',
    url: saved.url,
    headers: { ...auth(), 'if-none-match': String(media.headers.etag) },
  });
  assert.equal(cached.statusCode, 304);

  // 未认证拿不到图片
  const anonymous = await app.inject({ method: 'GET', url: saved.url });
  assert.equal(anonymous.statusCode, 401);

  // 路径穿越与非图片扩展名一律 404
  assert.equal((await app.inject({ method: 'GET', url: '/media/..%2F..%2Fwiki.db', headers: auth() })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/media/${pageId}/notes.md`, headers: auth() })).statusCode, 404);

  // 删除
  const removed = await app.inject({
    method: 'DELETE',
    url: '/api/assets',
    headers: auth(),
    payload: { parentId: pageId, name: saved.name },
  });
  assert.equal(removed.statusCode, 200);
  assert.equal(fs.existsSync(path.join(ASSETS_DIR, pageId)), false);
});

test('未归属图片：列出 + 挂载到父项并把引用补进正文', async () => {
  const pageId = await newPage('挂载目标页');
  const pool = path.join(ASSETS_DIR, '_unassigned');
  fs.mkdirSync(pool, { recursive: true });
  fs.writeFileSync(path.join(pool, 'a1b2c3d4-散图.png'), PNG);

  const orphans = await app.inject({ method: 'GET', url: '/api/assets/orphans/list', headers: auth() });
  assert.equal(orphans.statusCode, 200);
  assert.deepEqual(orphans.json().unassigned.map((a: any) => a.name), ['a1b2c3d4-散图.png']);

  const attached = await app.inject({
    method: 'POST',
    url: '/api/assets/attach',
    headers: auth(),
    payload: { name: 'a1b2c3d4-散图.png', parent: pageId },
  });
  assert.equal(attached.statusCode, 200);
  assert.equal(attached.json().parentTitle, '挂载目标页');
  assert.equal(attached.json().appended, true);

  const listed = await app.inject({ method: 'GET', url: `/api/assets/${pageId}`, headers: auth() });
  assert.equal(listed.json().assets[0].referenced, true);
  assert.equal(fs.existsSync(path.join(pool, 'a1b2c3d4-散图.png')), false);
});

test('导出：md 引用的图片一并打包，正文里的 /media 重写为 assets/', async () => {
  const pageId = await newPage('导出带图');
  const req = form({ parent: pageId, insert: 'append' }, [
    { filename: '配图.png', content: PNG, type: 'image/png' },
  ]);
  const up = await app.inject({
    method: 'POST',
    url: '/api/assets/upload',
    headers: { ...auth(), ...req.headers },
    payload: req.payload,
  });
  assert.equal(up.statusCode, 200);
  const asset = up.json().saved[0];

  const pageRow = db.prepare(`SELECT path FROM pages WHERE id = ?`).get(pageId) as { path: string };
  const zip = await app.inject({
    method: 'POST',
    url: '/api/files/export',
    headers: auth(),
    payload: { paths: [pageRow.path], name: '测试导出' },
  });
  assert.equal(zip.statusCode, 200);
  const body = zip.rawPayload;
  assert.ok(body.length > 0);
  // zip 里同时含页面与图片（用文件名片段粗验，避免为测试引入解压依赖）
  assert.ok(body.includes(Buffer.from(pageRow.path)));
  assert.ok(body.includes(Buffer.from(`assets/${pageId}/${asset.name}`)));
});
