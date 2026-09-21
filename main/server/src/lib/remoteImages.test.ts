import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-remote-images-'));
process.env.DATA_DIR = temp;

let db: any;
let migrate: () => void;
let ensureDirs: () => void;
let createPage: (dir: string, title: string) => any;
let readPage: (relPath: string) => any;
let writePage: (relPath: string, content: string, extra?: any) => any;
let syncPageFile: (relPath: string) => any;
let mediaUrl: (parentId: string, name: string) => string;

let hasRemoteImages: (content: string) => boolean;
let listRemoteImageUrls: (content: string) => string[];
let countRemoteImages: (content: string) => number;
let localizeRemoteImages: (pageId: string) => Promise<any>;
let resetRemoteImageQueueForTest: (budget?: number) => void;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const originalFetch = globalThis.fetch;
let fetchCalls: string[] = [];

/** 用公网字面量 IP：SSRF 防护对字面量 IP 不做 DNS 解析，测试因此不依赖网络/DNS */
const PUBLIC_HOST = 'https://93.184.216.34';

/** 让外链抓取走本地桩：命中 okUrls 返回 PNG，其余按 status 失败 */
function stubFetch(okUrls: string[], status = 403) {
  fetchCalls = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    fetchCalls.push(url);
    if (okUrls.some((u) => url.startsWith(u))) {
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return new Response('nope', { status, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
}

/** 等一个条件成立（队列是异步消费的） */
async function waitUntil(check: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return false;
}

before(async () => {
  ({ db, migrate } = await import('./db.js'));
  ({ ensureDirs } = await import('../config.js'));
  ({ createPage, readPage, writePage, syncPageFile } = await import('./vault.js'));
  ({ mediaUrl } = await import('./pageAssets.js'));
  ({
    hasRemoteImages,
    listRemoteImageUrls,
    countRemoteImages,
    localizeRemoteImages,
    resetRemoteImageQueueForTest,
  } = await import('./remoteImages.js'));
  migrate();
});

beforeEach(() => {
  db.exec(`
    DELETE FROM vec_chunks;
    DELETE FROM chunks;
    DELETE FROM edges;
    DELETE FROM pages_fts;
    DELETE FROM files_fts;
    DELETE FROM pages;
    DELETE FROM files;
  `);
  fs.rmSync(path.join(temp, 'brain'), { recursive: true, force: true });
  ensureDirs();
  resetRemoteImageQueueForTest(0); // 预算 0 = 关掉自动入队，测试只跑显式调用
  globalThis.fetch = originalFetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

/* ---------------- 纯函数 ---------------- */

test('hasRemoteImages / listRemoteImageUrls：只认 http(s) 图片，本地引用与普通外链不算', () => {
  assert.equal(hasRemoteImages('![a](https://example.com/x.png)'), true);
  assert.equal(hasRemoteImages('<img src="http://example.com/y.jpg">'), true);
  assert.equal(hasRemoteImages('![a](/media/p/x.png)'), false);
  // 已本地化过的图片：title 里带原图 URL，不能再被当成待本地化
  assert.equal(hasRemoteImages('![a](/media/p/x.png "原图 https://example.com/x.png")'), false);
  assert.equal(hasRemoteImages('[文档](https://example.com/a.pdf)'), false);

  assert.deepEqual(
    listRemoteImageUrls('![a](https://e.com/1.png)\n\n![b](https://e.com/2.png)\n\n![a2](https://e.com/1.png)'),
    ['https://e.com/1.png', 'https://e.com/2.png']
  );
  assert.equal(countRemoteImages('![](https://e.com/1.png)'), 1);
});

/* ---------------- 本地化成功 ---------------- */

test('本地化成功：图片落成本地资产、正文改写成 /media 引用、原 URL 记进 title', async () => {
  const page = createPage('Wiki/概念', '外链本地化');
  const remote = `${PUBLIC_HOST}/pic/现场.png`;
  writePage(page.path, `正文\n\n![图片](${remote})\n`);
  stubFetch([`${PUBLIC_HOST}/`]);

  const result = await localizeRemoteImages(page.id);
  assert.equal(result.localized, 1);
  assert.deepEqual(result.failed, []);

  const content = readPage(page.path)!.content;
  const [assetName] = fs.readdirSync(path.join(temp, 'brain', 'assets', page.id));
  assert.match(assetName, /^[0-9a-f]{8}-现场\.png$/);
  // 正文里的 URL 是编码过的，别按裸文件名拼期望值
  assert.equal(content.includes(`![图片](${mediaUrl(page.id, assetName)} "原图 ${remote}")`), true);
  assert.equal(content.includes(remote), true); // 原 URL 作为出处保留在 title 里

  // 资产目录里确实有文件
  const dir = path.join(temp, 'brain', 'assets', page.id);
  assert.equal(fs.readdirSync(dir).length, 1);
});

test('本地化：同一 URL 在一页里出现多次只抓一次', async () => {
  const page = createPage('Wiki/概念', '重复外链');
  const remote = `${PUBLIC_HOST}/same.png`;
  writePage(page.path, `![一](${remote})\n\n![二](${remote})\n`);
  stubFetch([`${PUBLIC_HOST}/`]);

  const result = await localizeRemoteImages(page.id);
  assert.equal(result.localized, 2);
  assert.equal(fetchCalls.length, 1);
  const content = readPage(page.path)!.content;
  assert.equal(content.includes(remote), true); // 只在 title 里留作出处
  assert.equal((content.match(/\/media\//g) || []).length, 2);
});

/* ---------------- 失败降级 ---------------- */

test('抓取失败：正文原样保留外链，并回报失败原因（不静默）', async () => {
  const page = createPage('Wiki/概念', '抓不到');
  const remote = `${PUBLIC_HOST}/x.png`;
  writePage(page.path, `正文\n\n![图](${remote})\n`);
  stubFetch([]); // 一律 403

  const result = await localizeRemoteImages(page.id);
  assert.equal(result.localized, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /HTTP 403/);
  assert.equal(readPage(page.path)!.content.includes(remote), true);
  assert.equal(fs.existsSync(path.join(temp, 'brain', 'assets', page.id)), false);
});

test('SSRF 防护：私网/环回地址在抓取前就被拦下，不发出请求', async () => {
  const page = createPage('Wiki/概念', '内网图');
  writePage(page.path, `![内网](http://127.0.0.1:8080/secret.png)\n`);
  stubFetch(['http://127.0.0.1']); // 即便桩允许，也不该走到 fetch

  const result = await localizeRemoteImages(page.id);
  assert.equal(result.localized, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /私网|环回/);
  assert.equal(fetchCalls.length, 0);
});

test('防盗链两类都覆盖：空 Referer 被 403 拒时，用同源 Referer 重试一次', async () => {
  const page = createPage('Wiki/概念', '防盗链');
  const remote = `${PUBLIC_HOST}/hotlink.png`;
  writePage(page.path, `![图](${remote})\n`);

  fetchCalls = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const referer = init?.headers?.Referer || '-';
    fetchCalls.push(`${String(input)}|${referer}`);
    // 模拟「必须有同源 Referer 才给图」的图床
    return referer === '-'
      ? new Response('denied', { status: 403, headers: { 'content-type': 'text/plain' } })
      : new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;

  const result = await localizeRemoteImages(page.id);
  assert.equal(result.localized, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(fetchCalls.length, 2);
  assert.match(fetchCalls[0], /\|-$/);
  assert.match(fetchCalls[1], /\|https:\/\/93\.184\.216\.34\/$/);
});

/* ---------------- 触发点 ---------------- */

test('触发点：syncPageFile 是导入/同步路径的收口，导入的正文也会被自动本地化', async () => {
  resetRemoteImageQueueForTest(10);
  stubFetch([`${PUBLIC_HOST}/`]);
  const page = createPage('Wiki/概念', '导入触发');
  // 模拟「导入 .md / 同步拉回 / Agent 直接落文件」：绕过 writePage，只改文件再 syncPageFile
  const abs = path.join(temp, 'brain', page.path);
  fs.appendFileSync(abs, `\n![外链](${PUBLIC_HOST}/imported.png)\n`, 'utf8');
  syncPageFile(page.path);

  // 入队是异步的（动态 import + 队列消费），等它跑完
  const done = await waitUntil(() => readPage(page.path)!.content.includes('/media/'));
  assert.equal(done, true, '导入的正文没有被自动本地化');
  assert.equal(fs.readdirSync(path.join(temp, 'brain', 'assets', page.id)).length, 1);
});
