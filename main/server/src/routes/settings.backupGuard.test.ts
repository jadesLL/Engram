import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import bcrypt from 'bcryptjs';
import JSZip from 'jszip';

/**
 * 整库备份/恢复的「嵌套 vault」护栏：
 *  - 备份：vault 里又套了一层 brain/ 的整库副本不进 zip（否则备份越打越大、恢复继续嵌套）；
 *  - 恢复：备份里出现 brain/brain/… 这类嵌套路径时直接拒绝，不落 .restore-staging。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-backup-guard-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let BRAIN_DIR = '';

/** 手搓 multipart 请求体（避免为测试引入额外依赖），与 assets.test.ts 同一套写法 */
function form(
  fields: Record<string, string>,
  files: Array<{ filename: string; content: Buffer; type?: string }>
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----engrambackup${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
    ));
  }
  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n`
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

function auth() {
  return { authorization: `Bearer ${app.jwt.sign({ sub: 'owner' })}` };
}

function writeBrain(rel: string, body: string): void {
  const abs = path.join(BRAIN_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
}

async function zipOf(files: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(files)) zip.file(name, value);
  return zip.generateAsync({ type: 'nodebuffer' });
}

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  const config = await import('../config.js');
  config.ensureDirs();
  BRAIN_DIR = config.BRAIN_DIR;
  dbModule.setSetting('password_hash', bcrypt.hashSync('test-password', 4));

  const { settingsRoutes } = await import('./settings.js');
  app = Fastify();
  await app.register(jwt, { secret: 'backup-guard-test-secret' });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  await app.register(settingsRoutes);
  await app.ready();
});

after(async () => {
  try { await app.close(); } catch { /* 已关闭 */ }
  try { db?.close(); } catch { /* 已关闭 */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('整库备份跳过 vault 内嵌套的 brain/ 副本', async () => {
  writeBrain('Wiki/概念/正常.md', '# 正常\n');
  writeBrain('brain/Wiki/概念/副本一.md', '# 副本一\n');
  writeBrain('brain/brain/Wiki/概念/副本二.md', '# 副本二\n');

  const res = await app.inject({ method: 'GET', url: '/api/settings/backup', headers: auth() });
  assert.equal(res.statusCode, 200);
  const zip = await JSZip.loadAsync(res.rawPayload);
  const names = Object.keys(zip.files);
  assert.ok(names.includes('brain/Wiki/概念/正常.md'), '正常页面应进备份');
  assert.equal(names.some((name) => name.startsWith('brain/brain/')), false, '第二层嵌套不该进备份');
  assert.equal(names.includes('brain/Wiki/概念/副本一.md'), false, '第一层嵌套副本也不该进备份');
  assert.ok(names.includes('wiki.db'));
});

test('恢复备份时发现嵌套 brain/brain/ 路径直接拒绝，不落暂存目录', async () => {
  const zip = await zipOf({
    'wiki.db': Buffer.from('not-a-real-db'),
    'brain/Wiki/概念/正常.md': '# 正常\n',
    'brain/brain/Wiki/概念/副本.md': '# 副本\n',
  });
  const body = form({ password: 'test-password' }, [{ filename: 'backup.zip', content: zip }]);
  const res = await app.inject({
    method: 'POST',
    url: '/api/settings/restore',
    headers: { ...auth(), ...body.headers },
    payload: body.payload,
  });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /嵌套/);
  assert.equal(fs.existsSync(path.join(temp, '.restore-staging')), false, '拒绝后不留下暂存目录');
});

test('正常备份（无嵌套路径）仍可恢复：只有 wiki.db 会被单列要求', async () => {
  const zip = await zipOf({
    'wiki.db': Buffer.from('not-a-real-db'),
    'brain/Wiki/概念/正常.md': '# 正常\n',
  });
  const body = form({ password: 'test-password' }, [{ filename: 'backup.zip', content: zip }]);
  const res = await app.inject({
    method: 'POST',
    url: '/api/settings/restore',
    headers: { ...auth(), ...body.headers },
    payload: body.payload,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
  assert.ok(fs.existsSync(path.join(temp, '.restore-staging', 'brain', 'Wiki', '概念', '正常.md')));
});
