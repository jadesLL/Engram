import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 往收集箱新建文本原件（MCP add_inbox_file 的服务端实现）：
 * 只写收集箱、绝不覆盖、不建页面、不进检索。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-inbox-add-'));
process.env.DATA_DIR = temp;

let BRAIN_DIR = '';
let db: any;
let addInboxFile: typeof import('./inboxAdd.js').addInboxFile;
let InboxAddError: typeof import('./inboxAdd.js').InboxAddError;
let INBOX_ADD_MAX_CHARS: number;

before(async () => {
  const config = await import('../config.js');
  BRAIN_DIR = config.BRAIN_DIR;
  config.ensureDirs();
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  ({ addInboxFile, InboxAddError, INBOX_ADD_MAX_CHARS } = await import('./inboxAdd.js'));
});

after(async () => {
  try { db?.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

beforeEach(() => {
  const inbox = path.join(BRAIN_DIR, '收集箱');
  fs.rmSync(inbox, { recursive: true, force: true });
  fs.mkdirSync(path.join(inbox, '转换结果'), { recursive: true });
});

/** 收集箱相对路径 → 磁盘绝对路径 */
function inboxAbs(rel: string): string {
  return path.join(BRAIN_DIR, ...rel.split('/'));
}

/** 收集箱根目录下是否残留临时文件（落盘失败/成功后都不该留） */
function tempFiles(): string[] {
  return fs.readdirSync(path.join(BRAIN_DIR, '收集箱')).filter((name) => name.startsWith('.inbox-add-'));
}

test('成功写入：正文原样落进收集箱，不建页面、不进检索', async () => {
  const events: string[] = [];
  const { subscribe } = await import('../lib/events.js');
  const unsubscribe = subscribe({ raw: {} as any, send: (event: string) => events.push(event) });
  const content = '# 网页摘要\n\n- 结论一：交付周期 30 天\n- 结论二：预算 80 万\n';
  let result: { path: string; chars: number } | undefined;
  try {
    result = addInboxFile({ path: '收集箱/网页摘要.md', content });
  } finally {
    unsubscribe();
  }

  assert.ok(result);
  assert.deepEqual(result, { path: '收集箱/网页摘要.md', chars: content.length });
  assert.equal(fs.readFileSync(inboxAbs(result.path), 'utf8'), content);
  assert.equal(fs.existsSync(path.join(BRAIN_DIR, '收集箱', '网页摘要.md')), true);
  assert.deepEqual(tempFiles(), [], '落盘后不应残留临时文件');
  assert.equal(events.includes('file-changed'), true, '收集箱界面要收到刷新事件');
  const { isAppWrite } = await import('../lib/appWrites.js');
  assert.equal(isAppWrite(inboxAbs(result.path)), true, '自身写入应登记，避免监听回声');

  // 收集箱不属于知识库：不建 pages/files 行，检索也看不到正文
  assert.equal(db.prepare(`SELECT id FROM pages WHERE path LIKE '收集箱/%'`).get(), undefined);
  assert.equal(db.prepare(`SELECT id FROM files WHERE path LIKE '收集箱/%'`).get(), undefined);
  const { hybridSearch } = await import('../retrieval/hybrid.js');
  const hits = await hybridSearch('交付周期', 10);
  assert.equal(hits.some((hit: any) => String(hit.path).startsWith('收集箱/')), false);
});

test('无扩展名自动补 .md；收集箱子目录自动创建', () => {
  const plain = addInboxFile({ path: '收集箱/网页摘要', content: '无扩展名的正文' });
  assert.equal(plain.path, '收集箱/网页摘要.md');
  assert.equal(fs.readFileSync(inboxAbs(plain.path), 'utf8'), '无扩展名的正文');

  const nested = addInboxFile({ path: '收集箱/会议/2026-10-21 纪要.txt', content: '会议正文' });
  assert.equal(nested.path, '收集箱/会议/2026-10-21 纪要.txt');
  assert.equal(fs.readFileSync(inboxAbs(nested.path), 'utf8'), '会议正文');
});

test('拒绝非收集箱路径与绝对路径', () => {
  const cases = [
    '原始资料/文档/摘要.md',
    'Wiki/概念/越界.md',
    '收集箱',
    '收集箱/',
    '/tmp/摘要.md',
    'C:/temp/摘要.md',
  ];
  for (const target of cases) {
    assert.throws(
      () => addInboxFile({ path: target, content: '正文' }),
      (error: any) => error instanceof InboxAddError && /收集箱/.test(error.message),
      `应拒绝：${target}`
    );
  }
});

test('拒绝写入 收集箱/转换结果/（那是 write_inbox_markdown 的产物通道）', () => {
  assert.throws(
    () => addInboxFile({ path: '收集箱/转换结果/网页摘要.md', content: '正文' }),
    (error: any) => error instanceof InboxAddError && /write_inbox_markdown/.test(error.message)
  );
  assert.throws(
    () => addInboxFile({ path: '收集箱/转换结果', content: '正文' }),
    (error: any) => error instanceof InboxAddError && /转换结果/.test(error.message)
  );
});

test('已存在同名文件：拒绝覆盖并保留原内容', () => {
  fs.writeFileSync(inboxAbs('收集箱/合同.txt'), '原始合同内容', 'utf8');
  assert.throws(
    () => addInboxFile({ path: '收集箱/合同.txt', content: '新内容' }),
    (error: any) => error instanceof InboxAddError && /拒绝覆盖/.test(error.message) && /换一个文件名/.test(error.message)
  );
  assert.equal(fs.readFileSync(inboxAbs('收集箱/合同.txt'), 'utf8'), '原始合同内容');
  assert.deepEqual(tempFiles(), []);
});

test('空内容（含仅空白）与缺失 content 都被拒绝', () => {
  for (const content of ['', '   \n\t  ', '\r\n']) {
    assert.throws(
      () => addInboxFile({ path: '收集箱/空.md', content }),
      (error: any) => error instanceof InboxAddError && /content 不能为空/.test(error.message)
    );
  }
  assert.equal(fs.existsSync(inboxAbs('收集箱/空.md')), false);
});

test('不支持的文件类型被拒绝：只收文本类扩展名', () => {
  for (const target of ['收集箱/表格.xlsx', '收集箱/扫描件.pdf', '收集箱/现场.png', '收集箱/归档.zip']) {
    assert.throws(
      () => addInboxFile({ path: target, content: '正文' }),
      (error: any) => error instanceof InboxAddError && /不支持的文件类型/.test(error.message),
      `应拒绝：${target}`
    );
  }
  assert.equal(fs.readdirSync(path.join(BRAIN_DIR, '收集箱')).length, 1, '只应有 转换结果 子目录');
});

test('大小超限：超过上限的正文被拒绝，且不落盘', () => {
  const oversized = 'a'.repeat(INBOX_ADD_MAX_CHARS + 1);
  assert.throws(
    () => addInboxFile({ path: '收集箱/超长.txt', content: oversized }),
    (error: any) => error instanceof InboxAddError && /上限/.test(error.message)
  );
  assert.equal(fs.existsSync(inboxAbs('收集箱/超长.txt')), false);

  // 恰好等于上限可以写入（边界不误伤）
  const exact = 'b'.repeat(INBOX_ADD_MAX_CHARS);
  const result = addInboxFile({ path: '收集箱/边界.txt', content: exact });
  assert.equal(result.chars, INBOX_ADD_MAX_CHARS);
  assert.equal(fs.statSync(inboxAbs('收集箱/边界.txt')).size, INBOX_ADD_MAX_CHARS);
});

test('越界路径被拒绝：.. 与目录结构异常', () => {
  const cases = ['收集箱/../越界.md', '收集箱/子/../../越界.md', '../收集箱/越界.md', '收集箱/./越界.md'];
  for (const target of cases) {
    assert.throws(
      () => addInboxFile({ path: target, content: '正文' }),
      (error: any) => error instanceof InboxAddError,
      `应拒绝：${target}`
    );
  }
  for (const target of cases) {
    assert.equal(fs.existsSync(path.join(BRAIN_DIR, '越界.md')), false);
  }
});

test('目标是目录时拒绝；隐藏文件与非法字符路径也拒绝', () => {
  fs.mkdirSync(inboxAbs('收集箱/资料.md'));
  assert.throws(
    () => addInboxFile({ path: '收集箱/资料.md', content: '正文' }),
    (error: any) => error instanceof InboxAddError && /是目录/.test(error.message)
  );
  // 无扩展名路径命中已有目录时也要拒绝，不能悄悄生成「目录名.md」
  fs.mkdirSync(inboxAbs('收集箱/归档目录'));
  assert.throws(
    () => addInboxFile({ path: '收集箱/归档目录', content: '正文' }),
    (error: any) => error instanceof InboxAddError && /是目录/.test(error.message)
  );
  assert.equal(fs.existsSync(inboxAbs('收集箱/归档目录.md')), false);
  assert.throws(
    () => addInboxFile({ path: '收集箱/.隐藏.md', content: '正文' }),
    (error: any) => error instanceof InboxAddError && /隐藏文件/.test(error.message)
  );
  assert.throws(
    () => addInboxFile({ path: '收集箱/报告?.md', content: '正文' }),
    (error: any) => error instanceof InboxAddError && /无效的路径段/.test(error.message)
  );
});
