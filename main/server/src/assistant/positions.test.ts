import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 位置引用令牌：用户引用的正文块 → 一次性 pos_xxx → Agent 插入。
 * 钉住这几条规则：
 *   - 锚点必须能在当前页面里按块命中，找不到/出现次数对不上就拒绝；
 *   - 插入只落在锚点块之后，前后文没变才写；
 *   - 同一令牌第二次调用不重复插入（幂等），页面被改动后写入要失败。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-position-'));
process.env.DATA_DIR = temp;

const PAGE_PATH = 'Wiki/项目/项目规划.md';
const PAGE_BODY = [
  '# 项目规划',
  '',
  '## 二、里程碑',
  '',
  '第一版在周五前发出。',
  '',
  '下周一收集反馈，确认是否进入第二阶段。',
  '',
  '## 三、风险与预案',
  '',
  '检索延迟可能上升。',
].join('\n');

let db: any;
let writePage: (rel: string, content: string, extra?: any) => any;
let readPage: (rel: string) => { content: string } | null;
let preparePositionRef: typeof import('./positions.js').preparePositionRef;
let insertAtPosition: typeof import('./positions.js').insertAtPosition;
let validatePositionRef: typeof import('./positions.js').validatePositionRef;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  ({ writePage, readPage } = await import('../lib/vault.js'));
  ({ preparePositionRef, insertAtPosition, validatePositionRef } = await import('./positions.js'));
});

beforeEach(() => {
  writePage(PAGE_PATH, PAGE_BODY, { title: '项目规划' });
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

const REF = {
  pagePath: PAGE_PATH,
  pageTitle: '项目规划',
  anchorText: '下周一收集反馈，确认是否进入第二阶段。',
  occurrence: 1,
  headingPath: ['项目规划', '二、里程碑'],
  before: '第一版在周五前发出。',
  after: '三、风险与预案',
};

/** 原始资料：内置 Agent 凭用户引用的位置令牌可以局部插入，但仍不能整页改写 */
const RAW_PATH = '原始资料/文档/未命名.md';
const RAW_BODY = [
  '# 会议纪要',
  '',
  '## 讨论',
  '',
  '先确认了交付范围。',
  '',
  '## 待办',
  '',
  '整理接口清单。',
].join('\n');
const RAW_REF = {
  pagePath: RAW_PATH,
  pageTitle: '会议纪要',
  anchorText: '先确认了交付范围。',
  occurrence: 1,
  headingPath: ['会议纪要', '讨论'],
  before: '## 讨论',
  after: '## 待办',
};

/** AIWorks 等系统目录：位置引用仍应拒绝（不是 Wiki / 原始资料） */
const SYSTEM_PATH = 'AIWorks/日志/测试.md';
const SYSTEM_BODY = ['# 测试', '', '这段正文不允许被引用。'].join('\n');

test('原始资料：位置引用可通过，内置 Agent 令牌插到锚点块之后', () => {
  writePage(RAW_PATH, RAW_BODY, { title: '会议纪要' });
  const validated = validatePositionRef(RAW_REF);
  assert.equal(validated.page.path, RAW_PATH);

  const prepared = preparePositionRef(RAW_REF, { sessionId: 'raw-s1', runId: 'raw-r1' });
  assert.match(prepared.token || '', /^pos_[a-f0-9]{10}$/);
  const inserted = insertAtPosition(prepared.token!, '范围之外的部分下周再确认。');
  assert.equal(inserted.alreadyUsed, false);
  const saved = readPage(RAW_PATH)!.content;
  assert.match(
    saved,
    /先确认了交付范围。\n\n范围之外的部分下周再确认。\n\n## 待办/,
  );
  // 同一令牌第二次调用只回第一次的结果，不重复插入
  const again = insertAtPosition(prepared.token!, '不应重复写入');
  assert.equal(again.alreadyUsed, true);
  assert.equal((readPage(RAW_PATH)!.content.match(/范围之外的部分下周再确认/g) || []).length, 1);
  assert.doesNotMatch(readPage(RAW_PATH)!.content, /不应重复写入/);
});

test('AIWorks 系统目录仍拒绝位置引用（403，只读区）', () => {
  writePage(SYSTEM_PATH, SYSTEM_BODY, { title: '测试' });
  assert.throws(
    () => validatePositionRef({
      pagePath: SYSTEM_PATH,
      pageTitle: '测试',
      anchorText: '这段正文不允许被引用。',
      occurrence: 1,
    }),
    (error: any) => error.status === 403 && /只读区/.test(error.message),
  );
  const prepared = preparePositionRef(
    {
      pagePath: SYSTEM_PATH,
      pageTitle: '测试',
      anchorText: '这段正文不允许被引用。',
      occurrence: 1,
    },
    { sessionId: 'sys-s1', runId: 'sys-r1' },
  );
  assert.equal(prepared.token, undefined);
  assert.match(prepared.error || '', /只读区/);
});

test('校验：锚点按块命中，返回标题路径与前后块', () => {
  const validated = validatePositionRef(REF);
  assert.equal(validated.page.path, PAGE_PATH);
  assert.equal(validated.anchorText, REF.anchorText);
  assert.equal(validated.occurrence, 1);
  assert.equal(validated.blocks[validated.blockIndex].text.trim(), REF.anchorText);
});

test('校验：页面里没有这段原文就拒绝（页面可能已改动）', () => {
  assert.throws(
    () => validatePositionRef({ ...REF, anchorText: '这段原文不存在。' }),
    /已不存在/,
  );
});

test('校验：重复块按 occurrence 取第 N 处，超出就拒绝', () => {
  writePage(PAGE_PATH, `${PAGE_BODY}\n\n${REF.anchorText}\n`, { title: '项目规划' });
  const second = validatePositionRef({ ...REF, occurrence: 2 });
  assert.equal(second.occurrence, 2);
  assert.throws(
    () => validatePositionRef({ ...REF, occurrence: 3 }),
    /只出现了 2 次/,
  );
});

test('插入：内容落在锚点块之后，同令牌重复调用不重复写', () => {
  const prepared = preparePositionRef(REF, { sessionId: 's1', runId: 'r1' });
  assert.match(prepared.token || '', /^pos_[a-f0-9]{10}$/);

  const first = insertAtPosition(prepared.token!, '验收安排：下周三前完成回归。');
  assert.equal(first.alreadyUsed, false);
  assert.equal(first.chars, '验收安排：下周三前完成回归。'.length);
  const saved = readPage(PAGE_PATH)!.content;
  assert.match(
    saved,
    /下周一收集反馈，确认是否进入第二阶段。\n\n验收安排：下周三前完成回归。\n\n## 三、风险与预案/,
  );

  const again = insertAtPosition(prepared.token!, '第二份不该写入。');
  assert.equal(again.alreadyUsed, true);
  assert.equal((readPage(PAGE_PATH)!.content.match(/验收安排/g) || []).length, 1);
  assert.doesNotMatch(readPage(PAGE_PATH)!.content, /第二份不该写入/);
});

test('插入：页面在前文处被改动后拒绝写入（不按偏移硬写）', () => {
  const prepared = preparePositionRef(REF, { sessionId: 's1', runId: 'r2' });
  const changed = PAGE_BODY.replace('第一版在周五前发出。', '第一版已经改了。');
  writePage(PAGE_PATH, changed, { title: '项目规划' });
  assert.throws(
    () => insertAtPosition(prepared.token!, '不该写入。'),
    /前文已变化/,
  );
  assert.doesNotMatch(readPage(PAGE_PATH)!.content, /不该写入/);
});

test('插入：锚点被删掉后拒绝，令牌保持未使用', () => {
  const prepared = preparePositionRef(REF, { sessionId: 's1', runId: 'r3' });
  writePage(PAGE_PATH, PAGE_BODY.replace(REF.anchorText, '换了一段。'), { title: '项目规划' });
  assert.throws(
    () => insertAtPosition(prepared.token!, '不该写入。'),
    /已不存在/,
  );
});

test('起跑预检：位置失效返回 error 而不是抛异常（Agent 会被告知别写）', () => {
  const prepared = preparePositionRef(
    { ...REF, anchorText: '不存在的段落。' },
    { sessionId: 's1', runId: 'r4' },
  );
  assert.equal(prepared.token, undefined);
  assert.match(prepared.error || '', /已不存在/);
});

test('令牌格式与空正文校验', () => {
  assert.throws(() => insertAtPosition('not-a-token', '正文'), /格式不对/);
  const prepared = preparePositionRef(REF, { sessionId: 's1', runId: 'r5' });
  assert.throws(() => insertAtPosition(prepared.token!, '   '), /不能为空/);
});
