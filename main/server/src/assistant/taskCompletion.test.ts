import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-task-completion-'));
process.env.DATA_DIR = temp;
let db: typeof import('../lib/db.js').db;
let vault: typeof import('../lib/vault.js');
let completion: typeof import('./taskCompletion.js');
let model: typeof import('./taskBoardModel.js');

before(async () => {
  const module = await import('../lib/db.js');
  db = module.db;
  module.migrate();
  vault = await import('../lib/vault.js');
  completion = await import('./taskCompletion.js');
  model = await import('./taskBoardModel.js');
});
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const at = new Date('2026-10-06T17:30:00Z');
function board(text: string, source: string, date = '2026-09-30') {
  const answer = '```json\n' + JSON.stringify({ version: 2, groups: [{ title: '客户与项目', cards: [{ text, source, date, owner: '张三' }] }] }) + '\n```';
  const key = model.taskCardKey(model.boardCards(model.parseTaskBoard(answer))[0]);
  return { answer, key };
}

test('写回真实 Markdown，保留原文与 frontmatter，按点击时区记日期，重复点击不重复写', () => {
  const source = '原始资料/文档/验收.md';
  vault.writePage(source, '# 原始纪要\n\n截止日待验收。\n', { title: '验收原文', tags: ['测试'] });
  const previous = vault.readPage(source)!;
  const { answer, key } = board('安排客户验收', source);
  const result = completion.completeTask(answer, key, 'Asia/Hong_Kong', at);
  assert.equal(result.date, '2026-10-07');
  const saved = vault.readPage(source)!;
  assert.ok(saved.content.startsWith(previous.content));
  assert.match(saved.content, /- \[x\] 安排客户验收.*已手动完成：2026-10-07/);
  assert.equal(saved.meta.id, previous.meta.id);
  assert.deepEqual(saved.meta.tags, previous.meta.tags);
  assert.deepEqual(completion.completedTaskKeys(answer), [key]);
  assert.equal(completion.completeTask(answer, key, 'Asia/Hong_Kong', new Date('2026-10-08')).date, result.date);
  assert.equal(vault.readPage(source)!.content, saved.content);
  const next = board('安排客户验收', source, '2026-10-15');
  assert.ok(!completion.completedTaskKeys(next.answer).includes(next.key), '不同日期的下一次任务不能被隐藏');
});

test('正文兜底的看板同样可完成；记录可从磁盘重读', () => {
  vault.writePage('Wiki/实体/跟进.md', '# 跟进\n\n原文。');
  const answer = '## 客户与项目\n- [ ] 处理积压 —— 张三/9/30 前（依据：《跟进》）';
  const key = model.taskCardKey(model.boardCards(model.parseTaskBoard(answer))[0]);
  assert.equal(completion.completeTask(answer, key, 'Asia/Hong_Kong', at).path, 'Wiki/实体/跟进.md');
  assert.ok(completion.completedTaskKeys(answer).includes(key));
});

test('无 Markdown 依据时使用记录页；Markdown 字符不会破坏完成记录', () => {
  const { answer, key } = board('核对 [合同] <条款>', '原始资料/合同.pdf');
  const result = completion.completeTask(answer, key, 'America/Los_Angeles', at);
  assert.equal(result.date, '2026-10-06');
  assert.equal(result.path, 'Wiki/任务看板手动完成记录.md');
  assert.ok(completion.completedTaskKeys(answer).includes(key));
  assert.ok(vault.readPage(result.path)!.content.includes('核对 \\[合同\\] \\<条款\\>'));
});

test('过期看板、非逾期、非法时区、缺失原文均不伪报完成', () => {
  const { answer, key } = board('不能保存', '原始资料/文档/不存在.md');
  assert.throws(() => completion.completeTask(answer, key, 'Asia/Hong_Kong', at), /依据文档不存在/);
  assert.throws(() => completion.completeTask(answer, '伪造身份', 'Asia/Hong_Kong', at), /看板已更新/);
  assert.throws(() => completion.completeTask(answer, key, 'invalid', at), /时区无效/);
  const future = board('还未逾期', '', '2026-10-07');
  assert.throws(() => completion.completeTask(future.answer, future.key, 'Asia/Hong_Kong', at), /只有已逾期/);
  assert.ok(!completion.completedTaskKeys(future.answer).includes(future.key));
});
