import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 收集箱列表状态口径（/api/inbox/items 与 MCP list_inbox 共用）：
 * 产物在磁盘上就是「已转换」，失败任务不能盖住后来补写的产物（Agent 通道写产物没有 job 行）。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-inbox-items-'));
process.env.DATA_DIR = temp;

let BRAIN_DIR = '';
let db: any;
let listInboxItems: typeof import('./inboxItems.js').listInboxItems;
let writeInboxMarkdown: typeof import('../pipeline/inboxConvert.js').writeInboxMarkdown;

before(async () => {
  BRAIN_DIR = (await import('../config.js')).BRAIN_DIR;
  (await import('../config.js')).ensureDirs();
  db = (await import('./db.js')).db;
  (await import('./db.js')).migrate();
  ({ listInboxItems } = await import('./inboxItems.js'));
  ({ writeInboxMarkdown } = await import('../pipeline/inboxConvert.js'));
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function plant(name: string, content = '原件正文'): string {
  const rel = `收集箱/${name}`;
  fs.writeFileSync(path.join(BRAIN_DIR, ...rel.split('/')), content, 'utf8');
  return rel;
}

function insertJob(rel: string, status: string, error: string | null = null): number {
  const result = db.prepare(
    `INSERT INTO jobs(kind,payload,status,error,created_at,stage,progress,detail,updated_at)
     VALUES('inbox_convert',? ,?,?,?, '语义转换', 60, '', ?)`
  ).run(JSON.stringify({ path: rel }), status, error, new Date().toISOString(), new Date().toISOString());
  return Number(result.lastInsertRowid);
}

beforeEach(() => {
  fs.rmSync(path.join(BRAIN_DIR, '收集箱'), { recursive: true, force: true });
  fs.mkdirSync(path.join(BRAIN_DIR, '收集箱', '转换结果'), { recursive: true });
  db.prepare(`DELETE FROM jobs WHERE kind = 'inbox_convert'`).run();
});

test('失败任务之后 Agent 通道补写了产物：列表显示已转换，不再显示失败', () => {
  const rel = plant('业绩表.xlsx');
  const jobId = insertJob(rel, 'failed', '模型没有返回内容');
  writeInboxMarkdown(rel, '# 业绩表\n\n数据', undefined, { title: '业绩表' });

  const item = listInboxItems().items.find((entry) => entry.path === rel);
  assert.ok(item);
  assert.equal(item.status, 'converted');
  assert.equal(item.error, '', '产物已在，旧失败原因不该再当现状展示');
  assert.equal(item.jobId, jobId, '仍保留那次任务 id 供“查看过程”');
  assert.match(item.derivedPath || '', /^收集箱\/转换结果\//);
});

test('转换任务正在跑：即使旧产物在也显示转换中', () => {
  const rel = plant('合同.pdf');
  writeInboxMarkdown(rel, '# 合同\n\n条款');
  insertJob(rel, 'running');
  assert.equal(listInboxItems().items.find((entry) => entry.path === rel)?.status, 'converting');
});

test('失败且没有产物：显示失败与原因；待整理的不带错误', () => {
  const failedRel = plant('失败的.docx');
  insertJob(failedRel, 'failed', '模型没有返回内容');
  const pendingRel = plant('待整理的.txt');

  const items = listInboxItems();
  const failed = items.items.find((entry) => entry.path === failedRel);
  const pending = items.items.find((entry) => entry.path === pendingRel);
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.error, '模型没有返回内容');
  assert.equal(pending?.status, 'pending');
  assert.equal(pending?.error, '');
});

test('计数与筛选口径同步：converted / failed / converting 各归其位', () => {
  const done = plant('已完成.txt');
  writeInboxMarkdown(done, '# 已完成');
  const failedRel = plant('失败.txt');
  insertJob(failedRel, 'failed', 'x');
  plant('待整理.md');
  writeInboxMarkdown(plant('转换中.txt'), '# 转换中');
  insertJob('收集箱/转换中.txt', 'running');

  const { counts } = listInboxItems();
  assert.equal(counts.all, 4);
  assert.equal(counts.converted, 1);
  assert.equal(counts.converting, 1);
  assert.equal(counts.failed, 1);
  assert.equal(counts.pending, 1);
});
