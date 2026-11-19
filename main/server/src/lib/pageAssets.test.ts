import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-assets-'));
process.env.DATA_DIR = temp;

let db: any;
let migrate: () => void;
let ensureDirs: () => void;
let ASSETS_DIR: string;
let createPage: (dir: string, title: string) => any;
let readPage: (relPath: string) => any;
let writePage: (relPath: string, content: string, extra?: any) => any;
let adoptPageAssetRefs: (relPath: string) => any[];
let syncPageFile: (relPath: string) => any;

let parseMediaUrl: (url: string) => any;
let parseAssetRefs: (md: string) => any[];
let mediaUrl: (parentId: string, name: string) => string;
let savePageAsset: (parentId: string, name: string, buffer: Buffer, options?: any) => any;
let listParentAssets: (parentId: string) => any[];
let deletePageAsset: (parentId: string, name: string) => void;
let collectAssetOrphans: () => any;
let migrateLegacyAssets: () => any;
let sweepLooseAssetsOnly: () => number;
let assetCountsByParent: () => Map<string, number>;
let invalidateAssetCountCache: () => void;
let UNASSIGNED_PARENT: string;
let adoptForeignAssetRefs: (pageId: string, markdown: string) => any;
let countRemoteImages: (content: string) => number;

/** 1×1 PNG：内容稳定，用来验证内容寻址命名与去重 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const PNG2 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

before(async () => {
  ({ db, migrate } = await import('./db.js'));
  ({ ensureDirs, ASSETS_DIR } = await import('../config.js'));
  ({ createPage, readPage, writePage, adoptPageAssetRefs, syncPageFile } = await import('./vault.js'));
  ({
    parseMediaUrl,
    parseAssetRefs,
    mediaUrl,
    savePageAsset,
    listParentAssets,
    deletePageAsset,
    collectAssetOrphans,
    migrateLegacyAssets,
    sweepLooseAssetsOnly,
    assetCountsByParent,
    invalidateAssetCountCache,
    UNASSIGNED_PARENT,
    adoptForeignAssetRefs,
  } = await import('./pageAssets.js'));
  ({ countRemoteImages } = await import('./remoteImages.js'));
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
  invalidateAssetCountCache();
});

after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

/* ---------------- 引用解析 ---------------- */

test('parseMediaUrl：只认本库媒体路径，挡住穿越与非法父项', () => {
  assert.deepEqual(parseMediaUrl('/media/abc-1/x.png'), { parentId: 'abc-1', name: 'x.png' });
  // URL 编码的文件名要还原
  assert.deepEqual(parseMediaUrl('/media/abc-1/%E7%8E%B0%E5%9C%BA.png'), {
    parentId: 'abc-1',
    name: '现场.png',
  });
  // 带查询串/锚点时只取路径部分
  assert.equal(parseMediaUrl('/media/abc-1/x.png?v=2')?.name, 'x.png');
  // 外部图片、非本库路径、穿越、缺文件名一律 null
  assert.equal(parseMediaUrl('https://example.com/x.png'), null);
  assert.equal(parseMediaUrl('/api/files/content?path=assets%2Fx.png'), null);
  assert.equal(parseMediaUrl('/media/abc/../x.png'), null);
  assert.equal(parseMediaUrl('/media/abc/'), null);
  assert.equal(parseMediaUrl('/media/x.png'), null);
});

test('parseAssetRefs：markdown 与 <img> 两种写法都收，外部图片忽略，同名去重', () => {
  const md = [
    '正文',
    '![现场]( /media/p1/a.png )',
    '![带出处](/media/p1/b.png "原图 https://example.com/b.png")',
    '<img src="/media/p2/c.jpg">',
    '![外链](https://example.com/d.png)',
    '![重复](/media/p1/a.png)',
  ].join('\n\n');
  const refs = parseAssetRefs(md);
  assert.deepEqual(
    refs.map((r) => `${r.parentId}/${r.name}`),
    ['p1/a.png', 'p1/b.png', 'p2/c.jpg']
  );
  assert.equal(refs[1].title, '原图 https://example.com/b.png');
});

test('countRemoteImages：只数 http(s) 图片，本地引用不算', () => {
  assert.equal(countRemoteImages('![a](/media/p/x.png)'), 0);
  assert.equal(countRemoteImages('![a](https://example.com/x.png)'), 1);
  assert.equal(countRemoteImages('<img src="http://example.com/y.jpg">'), 1);
  // 普通外链（不是图片）不该被算作待本地化
  assert.equal(countRemoteImages('[文档](https://example.com/a.pdf)'), 0);
});

/* ---------------- 存取与归属 ---------------- */

test('savePageAsset：内容寻址命名、同图去重、扩展名白名单', () => {
  const page = createPage('Wiki/概念', '图片归属测试');
  const first = savePageAsset(page.id, '现场照片.png', PNG);
  assert.match(first.name, /^[0-9a-f]{8}-现场照片\.png$/);
  // url 里的文件名是 URL 编码过的，别按裸文件名比对
  assert.equal(first.url, mediaUrl(page.id, first.name));

  // 同一张图再存一次：同名同路径，不产生第二份
  const again = savePageAsset(page.id, '现场照片.png', PNG);
  assert.equal(again.name, first.name);
  assert.equal(fs.readdirSync(path.join(ASSETS_DIR, page.id)).length, 1);

  // 同名不同图：哈希前缀不同，互不顶替
  const other = savePageAsset(page.id, '现场照片.png', PNG2);
  assert.notEqual(other.name, first.name);
  assert.equal(fs.readdirSync(path.join(ASSETS_DIR, page.id)).length, 2);

  assert.throws(() => savePageAsset(page.id, '笔记.md', Buffer.from('x')), /不支持的图片格式/);
  assert.throws(() => savePageAsset('..', 'x.png', PNG), /父项无效/);
});

test('listParentAssets：按正文引用判定 referenced，删掉引用就变孤儿', () => {
  const page = createPage('Wiki/概念', '引用判定');
  const a = savePageAsset(page.id, 'a.png', PNG);
  const b = savePageAsset(page.id, 'b.png', PNG2);
  writePage(page.path, `正文\n\n![a](${a.url})\n`);

  let assets = listParentAssets(page.id);
  assert.equal(assets.length, 2);
  assert.equal(assets.find((x) => x.name === a.name)?.referenced, true);
  assert.equal(assets.find((x) => x.name === b.name)?.referenced, false);

  // 正文里去掉引用 → 变成孤儿
  writePage(page.path, '正文里已经没有图了\n');
  assets = listParentAssets(page.id);
  assert.equal(assets.every((x) => !x.referenced), true);
});

test('listParentAssets：外链本地化写进 title 的原出处能读回来', () => {
  const page = createPage('Wiki/概念', '出处记录');
  const asset = savePageAsset(page.id, 'from-web.png', PNG, { sourceUrl: 'https://example.com/x.png' });
  writePage(page.path, `![图](${asset.url} "原图 https://example.com/x.png")\n`);
  const [listed] = listParentAssets(page.id);
  assert.equal(listed.sourceUrl, 'https://example.com/x.png');
});

test('deletePageAsset：删空后目录一并清掉，计数缓存同步失效', () => {
  const page = createPage('Wiki/概念', '删除图片');
  const asset = savePageAsset(page.id, 'gone.png', PNG);
  assert.equal(assetCountsByParent().get(page.id), 1);
  deletePageAsset(page.id, asset.name);
  invalidateAssetCountCache();
  assert.equal(fs.existsSync(path.join(ASSETS_DIR, page.id)), false);
  assert.equal(assetCountsByParent().get(page.id), undefined);
  assert.throws(() => deletePageAsset(page.id, asset.name), /图片不存在/);
});

test('collectAssetOrphans：未归属池与未被引用分开列', () => {
  const page = createPage('Wiki/概念', '孤儿收集');
  const used = savePageAsset(page.id, 'used.png', PNG);
  const unused = savePageAsset(page.id, 'unused.png', PNG2);
  writePage(page.path, `![u](${used.url})\n`);
  fs.mkdirSync(path.join(ASSETS_DIR, UNASSIGNED_PARENT), { recursive: true });
  fs.writeFileSync(path.join(ASSETS_DIR, UNASSIGNED_PARENT, 'loose.png'), PNG);

  const orphans = collectAssetOrphans();
  assert.deepEqual(orphans.unassigned.map((x: any) => x.name), ['loose.png']);
  assert.deepEqual(orphans.unreferenced.map((x: any) => x.name), [unused.name]);
  assert.equal(
    orphans.totalBytes,
    [...orphans.unassigned, ...orphans.unreferenced].reduce((sum: number, x: any) => sum + x.size, 0)
  );
  assert.equal(orphans.totalBytes, PNG.length + PNG2.length);
});

/* ---------------- 跨父项引用收编 ---------------- */

test('adoptForeignAssetRefs：复制到本页目录并改写引用，保留 #w= 宽度与 title', () => {
  const owner = createPage('Wiki/概念', '图片来源页');
  const asset = savePageAsset(owner.id, 'image.png', PNG);
  const target = createPage('Wiki/概念', '收编目标页');
  const md = [
    `![image.png](${asset.url}#w=628)`,
    `![带出处](${asset.url} "原图 https://example.com/x.png")`,
    `<img src="${asset.url}">`,
  ].join('\n\n');

  const result = adoptForeignAssetRefs(target.id, md);
  const ownUrl = mediaUrl(target.id, asset.name);
  assert.equal(result.adopted, 3);
  assert.deepEqual(result.files.map((f: any) => f.name), [asset.name]);
  assert.ok(result.content.includes(`![image.png](${ownUrl}#w=628)`));
  assert.ok(result.content.includes(`![带出处](${ownUrl} "原图 https://example.com/x.png")`));
  assert.ok(result.content.includes(`<img src="${ownUrl}">`));
  // 只复制、不搬移：两边都在（旧父项可能只是进了回收站，恢复后还要能用）
  assert.equal(fs.existsSync(path.join(ASSETS_DIR, target.id, asset.name)), true);
  assert.equal(fs.existsSync(path.join(ASSETS_DIR, owner.id, asset.name)), true);
  // 收编后的正文写回本页：抽屉能看到，且标记为「正文引用」
  writePage(target.path, result.content);
  const own = listParentAssets(target.id);
  assert.equal(own.length, 1);
  assert.equal(own[0].referenced, true);
  // 幂等：收编过的正文再跑一遍不再改
  const again = adoptForeignAssetRefs(target.id, result.content);
  assert.equal(again.adopted, 0);
  assert.equal(again.content, result.content);
});

test('adoptForeignAssetRefs：源文件不在（同步未到）时保持原引用，不报错', () => {
  const target = createPage('Wiki/概念', '缺图目标页');
  const md = '![缺失](/media/ghost-parent/none.png)';
  const result = adoptForeignAssetRefs(target.id, md);
  assert.equal(result.adopted, 0);
  assert.equal(result.content, md);
  assert.equal(fs.existsSync(path.join(ASSETS_DIR, target.id)), false);
});

test('writePage：正文从别的页面复制过来，图片自动收编到本页', () => {
  const owner = createPage('Wiki/概念', '旧页面');
  const asset = savePageAsset(owner.id, 'copy.png', PNG);
  const target = createPage('Wiki/概念', '新页面');
  writePage(target.path, `正文\n\n![图](${asset.url}#w=320)\n`);

  const content = readPage(target.path)!.content;
  const ownUrl = mediaUrl(target.id, asset.name);
  assert.ok(content.includes(`${ownUrl}#w=320`));
  assert.equal(content.includes(`/media/${owner.id}/`), false);
  assert.equal(listParentAssets(target.id).length, 1);
  // 原页面的图不受影响
  assert.equal(listParentAssets(owner.id).length, 1);
  assert.equal(assetCountsByParent().get(target.id), 1);
});

test('writePage：frontmatter id 撞上已有页面时，收编用换出的新 id', () => {
  const owner = createPage('Wiki/概念', '被复制页');
  const asset = savePageAsset(owner.id, 'clash.png', PNG);
  const rel = 'Wiki/概念/复制出来的页面.md';
  // 模拟「把原页面文件复制成新文件」：frontmatter 里还带着原页面 id
  fs.writeFileSync(
    path.join(temp, 'brain', ...rel.split('/')),
    `---\nid: ${owner.id}\n标题: 复制出来的页面\n类型: concept\n---\n\n![图](${asset.url})\n`,
    'utf8'
  );
  const meta = writePage(rel, `![图](${asset.url})\n`);
  assert.notEqual(meta.id, owner.id);
  const content = readPage(rel)!.content;
  assert.ok(content.includes(`/media/${meta.id}/`));
  assert.equal(listParentAssets(meta.id).length, 1);
  assert.equal(listParentAssets(owner.id).length, 1);
});

test('adoptPageAssetRefs：带外转写（不经 writePage）的存量页面也能自愈', () => {
  const owner = createPage('Wiki/概念', '存量来源页');
  const asset = savePageAsset(owner.id, 'legacy.png', PNG);
  const target = createPage('Wiki/概念', '存量目标页');
  // 直接落盘 + 登记，模拟启动扫描看到的「正文里引用别的父项」的存量状态
  fs.writeFileSync(
    path.join(temp, 'brain', ...target.path.split('/')),
    `---\nid: ${target.id}\n标题: 存量目标页\n类型: concept\n---\n\n![图](${asset.url})\n`,
    'utf8'
  );
  syncPageFile(target.path);
  const adopted = adoptPageAssetRefs(target.path);
  assert.equal(adopted.length, 1);
  assert.ok(readPage(target.path)!.content.includes(`/media/${target.id}/`));
  assert.equal(listParentAssets(target.id)[0].referenced, true);
});

test('collectAssetOrphans：被别的页面正文引用的图不算可删孤儿', () => {
  const owner = createPage('Wiki/概念', '资产归属页');
  const asset = savePageAsset(owner.id, 'shared.png', PNG);
  const target = createPage('Wiki/概念', '跨页引用页');
  // 绕过收编直接落盘，造出「跨父项引用」的存量状态
  fs.writeFileSync(
    path.join(temp, 'brain', ...target.path.split('/')),
    `---\nid: ${target.id}\n标题: 跨页引用页\n类型: concept\n---\n\n![图](${asset.url})\n`,
    'utf8'
  );
  syncPageFile(target.path);
  const orphans = collectAssetOrphans();
  assert.equal(orphans.unreferenced.some((x: any) => x.name === asset.name), false);
});

/* ---------------- 存量迁移 ---------------- */

test('迁移：历史 /api/files/raw 内嵌写法改成 /media 并搬进父项目录', () => {
  const page = createPage('Wiki/概念', '历史正文');
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  fs.writeFileSync(path.join(ASSETS_DIR, '旧图.png'), PNG);
  writePage(page.path, `正文\n\n![旧图](/api/files/raw?path=assets%2F%E6%97%A7%E5%9B%BE.png)\n`);

  const result = migrateLegacyAssets();
  assert.equal(result.filesMoved, 1);
  assert.equal(result.refsRewritten, 1);

  const content = readPage(page.path)!.content;
  const assets = listParentAssets(page.id);
  assert.equal(assets.length, 1);
  assert.match(assets[0].name, /^[0-9a-f]{8}-旧图\.png$/);
  // 正文里的引用已换成 /media/<pageId>/<内容寻址文件名>（URL 编码形式）
  assert.equal(content.includes(`![旧图](${assets[0].url})`), true);
  assert.equal(fs.existsSync(path.join(ASSETS_DIR, '旧图.png')), false);
  assert.equal(assets[0].referenced, true);
});

test('迁移：裸 assets/ 相对路径也改写', () => {
  const page = createPage('Wiki/概念', '裸路径');
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  fs.writeFileSync(path.join(ASSETS_DIR, 'raw.png'), PNG);
  writePage(page.path, `正文\n\n![图](assets/raw.png)\n`);
  migrateLegacyAssets();
  const content = readPage(page.path)!.content;
  assert.match(content, new RegExp(`!\\[图\\]\\(/media/${page.id}/`));
  assert.equal(listParentAssets(page.id)[0].referenced, true);
});

test('迁移：没人引用的散图收进未归属池，不删除', () => {
  const page = createPage('Wiki/概念', '无引用');
  fs.mkdirSync(path.join(ASSETS_DIR), { recursive: true });
  fs.writeFileSync(path.join(ASSETS_DIR, '没人要.png'), PNG);
  fs.mkdirSync(path.join(temp, 'brain', '原始资料'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'brain', '原始资料', '散图.png'), PNG2);

  const result = migrateLegacyAssets();
  assert.equal(result.unassigned, 2);
  assert.equal(fs.existsSync(path.join(ASSETS_DIR, '没人要.png')), false);
  assert.equal(fs.existsSync(path.join(temp, 'brain', '原始资料', '散图.png')), false);
  const pool = listParentAssets(UNASSIGNED_PARENT).map((x) => x.name).sort();
  assert.equal(pool.length, 2);
  assert.equal(page.id.length > 0, true);
});

test('迁移：已经在新目录下的引用只改写不搬家（可重复执行）', () => {
  const page = createPage('Wiki/概念', '已归位');
  const asset = savePageAsset(page.id, 'ok.png', PNG);
  writePage(page.path, `![图](/api/files/content?path=assets%2F${page.id}%2F${asset.name})\n`);
  const result = migrateLegacyAssets();
  assert.equal(result.filesMoved, 0);
  assert.equal(result.refsRewritten, 1);
  assert.equal(readPage(page.path)!.content.includes(asset.url), true);
});

test('散图收容：每次启动都扫，用户绕过应用拷进原始资料的图不会变成看不见的死文件', () => {
  const rawDir = path.join(temp, 'brain', '原始资料');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, '直接拷进来的.png'), PNG);
  fs.mkdirSync(path.join(rawDir, '对话'), { recursive: true });
  fs.writeFileSync(path.join(rawDir, '对话', '对话里的图.png'), PNG2);

  const parked = sweepLooseAssetsOnly();
  assert.equal(parked, 2);
  assert.equal(fs.existsSync(path.join(rawDir, '直接拷进来的.png')), false);
  assert.equal(fs.existsSync(path.join(rawDir, '对话', '对话里的图.png')), false);
  assert.equal(listParentAssets(UNASSIGNED_PARENT).length, 2);

  // 幂等：再扫一次没有新东西
  assert.equal(sweepLooseAssetsOnly(), 0);
});

/* ---------------- URL 生成 ---------------- */

test('mediaUrl：文件名编码后拼在父项 id 下', () => {
  assert.equal(mediaUrl('p1', '现场 照片.png'), '/media/p1/%E7%8E%B0%E5%9C%BA%20%E7%85%A7%E7%89%87.png');
});
