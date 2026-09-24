import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';

/**
 * 收集箱：接受任意格式，且在「入库」之前必须与知识库彻底隔离——
 * 不入库、不进文件树、不写 FTS、检索不到、通用文件接口（内置浏览）一律拒绝。
 * 这些断言就是那句需求「不能被提炼和引用」的可执行版本。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-inbox-routes-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let token = '';
let BRAIN_DIR = '';
let INBOX_DIR_REL = '';

/** 手搓 multipart（与 assets.test.ts 同一套写法，避免为测试引额外依赖） */
function form(
  fields: Record<string, string>,
  files: Array<{ filename: string; content: Buffer; type?: string }>
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----engraminbox${Math.random().toString(16).slice(2)}`;
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
  const config = await import('../config.js');
  BRAIN_DIR = config.BRAIN_DIR;
  ({ INBOX_DIR: INBOX_DIR_REL } = await import('../lib/brainPaths.js'));
  config.ensureDirs();
  dbModule.migrate();

  const [{ inboxRoutes }, { fileRoutes }] = await Promise.all([
    import('./inbox.js'),
    import('./files.js'),
  ]);
  app = Fastify();
  await app.register(jwt, { secret: 'inbox-route-test-secret' });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  await app.register(inboxRoutes);
  await app.register(fileRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${token}` });

async function upload(files: Array<{ filename: string; content: Buffer; type?: string }>, dir?: string) {
  const req = form(dir ? { dir } : {}, files);
  return app.inject({
    method: 'POST',
    url: '/api/inbox/upload',
    headers: { ...auth(), ...req.headers },
    payload: req.payload,
  });
}

test('任意格式都能收：可执行文件、图片、音视频一律落进收集箱', async () => {
  const res = await upload([
    { filename: '安装包.exe', content: Buffer.from('MZ binary') },
    { filename: '现场照片.png', content: Buffer.from('fake png') },
    { filename: '评审录音.m4a', content: Buffer.from('fake audio') },
  ]);
  assert.equal(res.statusCode, 200);
  const saved = res.json().saved as any[];
  assert.equal(saved.length, 3);
  for (const name of ['安装包.exe', '现场照片.png', '评审录音.m4a']) {
    assert.equal(fs.existsSync(path.join(BRAIN_DIR, INBOX_DIR_REL, name)), true, `${name} 应落盘`);
  }
});

test('同名不覆盖：第二份自动加序号', async () => {
  await upload([{ filename: '合同.pdf', content: Buffer.from('v1') }]);
  await upload([{ filename: '合同.pdf', content: Buffer.from('v2') }]);
  const first = fs.readFileSync(path.join(BRAIN_DIR, INBOX_DIR_REL, '合同.pdf'), 'utf8');
  const second = fs.readFileSync(path.join(BRAIN_DIR, INBOX_DIR_REL, '合同 (2).pdf'), 'utf8');
  assert.equal(first, 'v1');
  assert.equal(second, 'v2');
});

test('网址抓取拒绝本地与非网页地址', async () => {
  for (const url of ['http://127.0.0.1/', 'file:///tmp/secret', 'http://[::1]/']) {
    const res = await app.inject({
      method: 'POST', url: '/api/inbox/fetch-url', headers: auth(), payload: { url },
    });
    assert.equal(res.statusCode, 400, url);
  }
});

test('列表按状态分组：有转换产物即视为已转换，产物本身不作为条目', async () => {
  const derivedDir = path.join(BRAIN_DIR, INBOX_DIR_REL, '转换结果');
  fs.mkdirSync(derivedDir, { recursive: true });
  fs.writeFileSync(path.join(derivedDir, '合同.md'), '# 合同要点\n');

  const res = await app.inject({ method: 'GET', url: '/api/inbox/items', headers: auth() });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  const contract = body.items.find((item: any) => item.name === '合同.pdf');
  assert.equal(contract.status, 'converted');
  assert.equal(contract.derivedPath, `${INBOX_DIR_REL}/转换结果/合同.md`);
  const names = body.items.map((item: any) => item.name);
  assert.equal(names.includes('合同.md'), false, '转换产物不应作为收集箱条目');
  assert.equal(body.counts.converted >= 1, true);
});

test('收集箱里的 .md（原件与产物）不会被建成知识库页面', async () => {
  fs.writeFileSync(path.join(BRAIN_DIR, INBOX_DIR_REL, '随手记.md'), '# 随手记\n不该出现在知识库\n');
  const { scanVault, listTree } = await import('../lib/vault.js');
  await scanVault();

  const page = db
    .prepare(`SELECT id FROM pages WHERE path LIKE ?`)
    .get(`${INBOX_DIR_REL}/%`);
  assert.equal(page, undefined, '收集箱内容不应有 pages 行');

  const flat = JSON.stringify(listTree());
  assert.equal(flat.includes(INBOX_DIR_REL), false, '收集箱不应出现在目录树里');
});

test('检索不到收集箱内容（即使有人给它建了 files 行）', async () => {
  const { hybridSearch } = await import('../retrieval/hybrid.js');
  const { ftsSegment } = await import('../lib/fts.js');

  // 正常路径下根本不会有这行（ensureFileRecord 直接拒收），这里手动造一条模拟漏网之鱼
  const id = 'inbox-leak-test';
  const rel = `${INBOX_DIR_REL}/泄漏样本.pdf`;
  db.prepare(
    `INSERT INTO files(id, path, name, ext, size, text, updated_at, deleted)
     VALUES(?, ?, '泄漏样本.pdf', 'pdf', 10, '独一无二的关键词斑马线', ?, 0)`
  ).run(id, rel, new Date().toISOString());
  db.prepare(`INSERT INTO files_fts(name, content, file_id) VALUES(?, ?, ?)`)
    .run(ftsSegment('泄漏样本.pdf'), ftsSegment('独一无二的关键词斑马线'), id);

  const hits = await hybridSearch('斑马线', 10);
  assert.equal(hits.some((hit: any) => hit.path === rel), false, '收集箱内容不得被检索命中');
  assert.equal(hits.some((hit: any) => hit.refId === id), false);
});

test('不接受文字提取：收集箱条目不进 files 表', async () => {
  const { scheduleFileExtraction } = await import('../pipeline/fileExtraction.js');
  const rel = `${INBOX_DIR_REL}/扫描件.pdf`;
  fs.writeFileSync(path.join(BRAIN_DIR, rel), '%PDF-1.4 fake');
  const scheduled = scheduleFileExtraction(rel, { mode: 'auto' });
  assert.equal(scheduled.fileId, '');
  assert.equal(scheduled.jobId, undefined);
  const row = db.prepare(`SELECT id FROM files WHERE path = ?`).get(rel);
  assert.equal(row, undefined);
});

test('不支持内置浏览：通用文件接口拒绝收集箱路径', async () => {
  const target = `${INBOX_DIR_REL}/现场照片.png`;
  for (const url of [
    `/api/files/preview?path=${encodeURIComponent(target)}`,
    `/api/files/content?path=${encodeURIComponent(target)}`,
    `/api/files/raw?path=${encodeURIComponent(target)}`,
    `/api/files/download?path=${encodeURIComponent(target)}`,
    `/api/files/list?dir=${encodeURIComponent(INBOX_DIR_REL)}`,
  ]) {
    const res = await app.inject({ method: 'GET', url, headers: auth() });
    assert.equal(res.statusCode, 403, `${url} 应被拒绝`);
    assert.match(res.json().error, /收集箱/);
  }
});

test('下载原件：附件流返回，内容一致', async () => {
  const target = `${INBOX_DIR_REL}/安装包.exe`;
  const res = await app.inject({
    method: 'GET',
    url: `/api/inbox/download?path=${encodeURIComponent(target)}`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-disposition']), /attachment/);
  assert.equal(res.rawPayload.toString('utf8'), 'MZ binary');
});

test('越界路径被拒：只能操作收集箱内的文件', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/inbox/download?path=${encodeURIComponent('原始资料/别人的资料.pdf')}`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 400);
});

test('移除收集箱条目：进回收站而不是直接删掉', async () => {
  await upload([{ filename: '待移除.zip', content: Buffer.from('zip') }]);
  const target = `${INBOX_DIR_REL}/待移除.zip`;
  const res = await app.inject({
    method: 'DELETE',
    url: '/api/inbox/items',
    headers: auth(),
    payload: { path: target },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(fs.existsSync(path.join(BRAIN_DIR, target)), false);
  const trash = fs.readdirSync(path.join(BRAIN_DIR, '.trash'));
  assert.equal(trash.some((name) => name.endsWith('待移除.zip')), true, '应能在回收站里找到');
});
