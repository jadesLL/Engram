import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 梦境思考的确定性待办信号：待提炼份数、死链、疑似重复、规则落后。
 *
 * 这些数字同时服务三处——定时器据此决定跑不跑、作业手册据此给 Agent 起点、
 * 设置页据此显示「待提炼 N 份 · 待核查 M 处」——所以口径必须钉死。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-dream-audit-'));
process.env.DATA_DIR = temp;

let kernel: typeof import('./dreamAudit.js');
let db: any;
let vault: typeof import('../lib/vault.js');
let extractor: typeof import('../pipeline/extractor.js');
let guide: typeof import('../content/agentGuide.js');

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  vault = await import('../lib/vault.js');
  extractor = await import('../pipeline/extractor.js');
  guide = await import('../content/agentGuide.js');
  kernel = await import('./dreamAudit.js');
});

beforeEach(() => {
  db.prepare('DELETE FROM edges').run();
  db.prepare('DELETE FROM pages_fts').run();
  db.prepare('DELETE FROM chunks').run();
  db.prepare('DELETE FROM page_contributions').run();
  db.prepare('DELETE FROM source_versions').run();
  db.prepare('DELETE FROM pages').run();
  fs.rmSync(vault.safeJoin('原始资料'), { recursive: true, force: true });
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

/** 造一份原始资料文件（md 是页面；其他后缀走 fs 直写模拟待提取文件） */
function rawFile(rel: string, content = '示例内容'): void {
  const abs = vault.safeJoin(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

/** 建一个 Wiki 页并把它正文里的双链接成边（wirePageEdges 是索引管线里的既有步骤） */
function wikiPage(rel: string, title: string, body: string): string {
  vault.writePage(rel, body, { title });
  extractor.wirePageEdges(pageId(rel), body);
  return rel;
}

function pageId(rel: string): string {
  const row = db.prepare('SELECT id FROM pages WHERE path = ?').get(rel) as { id: string } | undefined;
  assert.ok(row, `页面应已建好：${rel}`);
  return row!.id;
}

/** 把某页标成规则已是最新（否则新建页 guide_version=0 永远算落后） */
function markGuideCurrent(rel: string, version = guide.GUIDE_VERSION): void {
  db.prepare('UPDATE pages SET guide_version = ? WHERE path = ?').run(version, rel);
}

test('待提炼份数：只算未提炼的原始资料，图片资产不计，不可读的单独统计', () => {
  rawFile('原始资料/文档/会议纪要.md');
  rawFile('原始资料/对话/某次对话.md');
  rawFile('原始资料/文档/扫描件.pdf', '%PDF-1.4 假装是扫描件');
  // 图片是 md 父项的私有资产，不算原始资料
  rawFile('原始资料/文档/配图.png', 'not really a png');

  const audit = kernel.dreamAudit();
  assert.equal(audit.pendingFiles, 3, '3 份原始资料待提炼（不含图片）');
  assert.equal(audit.pendingUnreadable, 1, 'pdf 没有提取文本 → 不可读');
  assert.deepEqual(
    [...audit.pendingSamples].sort(),
    ['原始资料/对话/某次对话.md', '原始资料/文档/会议纪要.md', '原始资料/文档/扫描件.pdf'],
  );
  assert.equal(kernel.dreamIssueTotal(audit), 0);
  assert.equal(kernel.dreamAuditIdle(audit), false);
});

test('已提炼的来源不再计入待提炼（账本口径）', () => {
  rawFile('原始资料/文档/已提炼.md');
  db.prepare(
    `INSERT INTO source_versions(id,path,content_hash,status,created_at,activated_at)
     VALUES('sv-1','原始资料/文档/已提炼.md','hash-1','active','2026-09-27 10:00:00','2026-09-27 10:00:00')`
  ).run();

  const audit = kernel.dreamAudit();
  assert.equal(audit.pendingFiles, 0, '账本标了 active 就不该再列进待提炼');
  assert.equal(kernel.dreamAuditIdle(audit), true, '没有待办时定时跑直接跳过');
});

test('死链：双链指向的标题没有页面才计数，已解析的不算', () => {
  wikiPage('Wiki/概念/专题.md', '专题', '# 专题\n\n内容。');
  markGuideCurrent('Wiki/概念/专题.md');
  wikiPage('Wiki/实体/示例公司.md', '示例公司', '# 示例公司\n\n关联 [[专题]] 与 [[还没建的客户页]]，另有 [[另一个缺页]]。');
  markGuideCurrent('Wiki/实体/示例公司.md');

  const audit = kernel.dreamAudit();
  assert.equal(audit.deadLinks, 2, '[[专题]] 已解析，两条缺页才算死链');
  const titles = audit.deadLinkSamples.map((item) => item.title).sort();
  assert.deepEqual(titles, ['另一个缺页', '还没建的客户页']);
  assert.deepEqual(audit.deadLinkSamples.find((item) => item.title === '还没建的客户页')?.from, ['示例公司']);
});

test('疑似重复：标题归一化后撞名的页面组才算，同一页面的不同写法不算', () => {
  wikiPage('Wiki/实体/示例公司.md', '示例公司', '# 示例公司');
  wikiPage('Wiki/实体/示例公司（北京）.md', '示例公司（北京）', '# 示例公司（北京）');
  wikiPage('Wiki/实体/示例 公司.md', '示例 公司', '# 示例 公司');
  for (const rel of ['Wiki/实体/示例公司.md', 'Wiki/实体/示例公司（北京）.md', 'Wiki/实体/示例 公司.md']) {
    markGuideCurrent(rel);
  }

  const audit = kernel.dreamAudit();
  assert.equal(audit.duplicates, 1, '「示例公司」与「示例 公司」归一化后撞名；带（北京）的是另一个对象');
  const group = audit.duplicateSamples[0];
  assert.deepEqual([...group.paths].sort(), ['Wiki/实体/示例 公司.md', 'Wiki/实体/示例公司.md']);
  assert.deepEqual([...group.titles].sort(), ['示例 公司', '示例公司']);
});

test('规则落后：只算低于当前指南的概念/实体页，达标的不算', () => {
  wikiPage('Wiki/概念/新概念.md', '新概念', '# 新概念');
  markGuideCurrent('Wiki/概念/新概念.md');
  wikiPage('Wiki/概念/旧概念.md', '旧概念', '# 旧概念');
  // 原始资料不在「规则落后」清单里（它只由用户维护，归档页不再维护）
  rawFile('原始资料/文档/资料.md');

  const audit = kernel.dreamAudit();
  assert.equal(audit.outdatedPages, 1);
  assert.equal(audit.outdatedSamples[0].path, 'Wiki/概念/旧概念.md');
  assert.equal(audit.outdatedSamples[0].guideVersion, 0);
  assert.ok(audit.outdatedSamples[0].guideVersion < guide.GUIDE_VERSION);
});

test('概览口径：一行摘要与待办总数', () => {
  rawFile('原始资料/文档/甲.md');
  rawFile('原始资料/文档/乙.md');
  wikiPage('Wiki/实体/甲公司.md', '甲公司', '# 甲公司\n\n[[缺页]]');
  wikiPage('Wiki/实体/甲 公司.md', '甲 公司', '# 甲 公司');

  const audit = kernel.dreamAudit();
  assert.equal(kernel.dreamAuditIdle(audit), false);
  assert.equal(kernel.dreamIssueTotal(audit), audit.deadLinks + audit.duplicates + audit.outdatedPages);
  assert.equal(
    kernel.dreamAuditSummary(audit),
    `待提炼 2 份 · 待核查 ${kernel.dreamIssueTotal(audit)} 处（死链 ${audit.deadLinks} · 疑似重复 ${audit.duplicates} · 规则落后 ${audit.outdatedPages}）`,
  );
});

test('normalizeTitle：去空白与标点、忽略大小写', () => {
  assert.equal(kernel.normalizeTitle('示例 公司'), '示例公司');
  assert.equal(kernel.normalizeTitle(' Acme  Inc. '), 'acmeinc');
  assert.equal(kernel.normalizeTitle('示例公司（北京）'), '示例公司北京');
  assert.notEqual(kernel.normalizeTitle('示例公司'), kernel.normalizeTitle('示例公司北京'));
});
