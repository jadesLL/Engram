import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Agent 提问通道（MCP ask_user ↔ 对话最下侧弹窗）：钉住这几条规则——
 *   - 提问落在「最近开跑的那一轮」上：没有正在跑的对话就明说弹不出来，让 Agent 改用正文提问；
 *   - ask 挂起等答复：用户在弹窗里点选（answerAgentQuestion）后同一个 Promise 拿到答案；
 *   - 超时（expired）与本轮结束/被停（cancelled）都要唤醒等待者，绝不把工具调用挂死；
 *   - 参数校验：一次最多 5 个问题、每问最多 6 个选项、单选不能多选、选项必须在题面内；
 *   - 提问进快照（刷新页面仍在），答复后从快照里消失。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-questions-'));
process.env.DATA_DIR = temp;

let repo: typeof import('./repository.js');
let kernel: typeof import('./questions.js');
let db: any;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  repo = await import('./repository.js');
  kernel = await import('./questions.js');
});

beforeEach(() => {
  db.prepare(`DELETE FROM assistant_questions`).run();
  db.prepare(`DELETE FROM assistant_subagents`).run();
  db.prepare(`DELETE FROM assistant_tool_calls`).run();
  db.prepare(`DELETE FROM assistant_runs`).run();
  db.prepare(`DELETE FROM assistant_messages`).run();
  db.prepare(`DELETE FROM assistant_sessions`).run();
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

/** 一轮正在跑的对话（用户消息 + running 轮次） */
function seedRunning(): { sessionId: string; runId: string } {
  const session = repo.createSession('提问测试');
  const message = repo.insertMessage({ sessionId: session.id, role: 'user', content: '把这份材料提炼一下' });
  const run = repo.createRun({ sessionId: session.id, userMessageId: message.id, context: {} });
  return { sessionId: session.id, runId: run.id };
}

const ASK = {
  questions: [{
    id: 'name',
    header: '名称核验',
    question: '是否允许联网查企查查/天眼查？',
    options: [{ label: '允许联网查询', description: '查到全名后再问你一次' }, { label: '不允许' }],
  }],
};

test('没有正在跑的对话：直接说弹不出来，让 Agent 改用正文提问', async () => {
  const outcome = await kernel.askUserQuestions(ASK);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'no_active_run');
  assert.equal(outcome.questions.length, 0);
  assert.match(kernel.formatAskOutcome(outcome), /没有正在运行的 Engram 对话/);
  assert.match(kernel.formatAskOutcome(outcome), /写进你的回复正文/);
  // 没有落任何提问行（不留悬空记录）
  assert.equal(repo.listPendingQuestions('whatever').length, 0);
});

test('提问落地：进快照、挂在那一轮上，用户点选后同一个等待拿到答案', async () => {
  const { sessionId, runId } = seedRunning();
  const pending = kernel.askUserQuestions(ASK);

  // 提问已经落库并进快照（界面刷新也还在）
  const rows = repo.listPendingQuestions(sessionId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runId, runId);
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].header, '名称核验');
  assert.deepEqual(rows[0].options.map((option) => option.label), ['允许联网查询', '不允许']);
  assert.equal(rows[0].multiSelect, false);
  assert.equal(repo.snapshot(sessionId)?.questions.length, 1);

  // 用户在对话最下侧的弹窗里点「允许联网查询」→ 挂起的那次调用当场返回
  const answered = kernel.answerAgentQuestion(rows[0].id, { selected: ['允许联网查询'], custom: '用户点了允许' });
  assert.equal(answered.status, 'answered');
  assert.deepEqual(answered.selected, ['允许联网查询']);
  assert.equal(answered.custom, '用户点了允许');

  const outcome = await pending;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.reason, '');
  assert.deepEqual(outcome.questions[0].selected, ['允许联网查询']);
  const text = kernel.formatAskOutcome(outcome);
  assert.match(text, /用户在对话里点选了答复/);
  assert.match(text, /是否允许联网查企查查\/天眼查？ → 允许联网查询；补充：用户点了允许/);
  assert.match(text, /用户确认/);

  // 答复后从快照里消失，也不再进 pending
  assert.equal(repo.listPendingQuestions(sessionId).length, 0);
  assert.equal(repo.snapshot(sessionId)?.questions.length, 0);
});

test('超时：等到上限没答复就作废（expired），并说明用户没答', { timeout: 20_000 }, async () => {
  const { sessionId } = seedRunning();
  const outcome = await kernel.askUserQuestions({ ...ASK, timeoutMs: 5_000 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'timeout');
  assert.equal(outcome.questions[0].status, 'expired');
  assert.equal(repo.listPendingQuestions(sessionId).length, 0, '过期后不再进 pending');
  const text = kernel.formatAskOutcome(outcome);
  assert.match(text, /用户未在 5 秒内答复/);
  assert.match(text, /不要再等/);
});

test('问题不会挂死：本轮结束（cancelled）时等待者立刻拿到作废结果', async () => {
  const { runId } = seedRunning();
  const pending = kernel.askUserQuestions(ASK);
  assert.equal(kernel.closeQuestionsForRun(runId, 'cancelled'), 1);
  const outcome = await pending;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'cancelled');
  assert.equal(outcome.questions[0].status, 'cancelled');
  assert.match(kernel.formatAskOutcome(outcome), /提问已作废/);
});

test('答复校验：选项必须在题面内、单选不能多选、空答复拒收、已结束的拒收', async () => {
  const { sessionId } = seedRunning();
  const pending = kernel.askUserQuestions(ASK);
  const id = repo.listPendingQuestions(sessionId)[0].id;

  assert.throws(() => kernel.answerAgentQuestion(id, { selected: ['没这个选项'] }), /选项不在提问范围内/);
  assert.throws(() => kernel.answerAgentQuestion(id, { selected: ['允许联网查询', '不允许'] }), /只能选一个/);
  assert.throws(() => kernel.answerAgentQuestion(id, { selected: [], custom: '   ' }), /请选择一个选项/);

  // 自己填一句也算答复（没有选项的提问只认这条路）
  const answered = kernel.answerAgentQuestion(id, { selected: [], custom: '先别查，材料里可能有' });
  assert.deepEqual(answered.selected, []);
  assert.equal(answered.custom, '先别查，材料里可能有');
  await pending;
  assert.throws(() => kernel.answerAgentQuestion(id, { selected: ['不允许'] }), /已经结束/);
});

test('多选提问：可以选多个，答复顺序按用户点选', async () => {
  const { sessionId } = seedRunning();
  const pending = kernel.askUserQuestions({
    questions: [{
      question: '这次要重提炼哪些页面？',
      multiSelect: true,
      options: [{ label: '客户页' }, { label: '供应商页' }, { label: '项目页' }],
    }],
  });
  const row = repo.listPendingQuestions(sessionId)[0];
  assert.equal(row.multiSelect, true);
  kernel.answerAgentQuestion(row.id, { selected: ['供应商页', '客户页'] });
  const outcome = await pending;
  assert.deepEqual(outcome.questions[0].selected, ['供应商页', '客户页']);
});

test('入参校验：问题文本必填、数量与选项数量有上限、id 去重', () => {
  assert.throws(() => kernel.normalizeQuestions([]), /至少要有一个问题/);
  assert.throws(() => kernel.normalizeQuestions([{ question: '  ' }]), /缺少 question 文本/);
  assert.throws(
    () => kernel.normalizeQuestions(Array.from({ length: 6 }, (_, i) => ({ question: `第 ${i} 个` }))),
    /一次最多问 5 个问题/
  );
  assert.throws(
    () => kernel.normalizeQuestions([{ question: '选哪个？', options: Array.from({ length: 7 }, (_, i) => ({ label: `选项${i}` })) }]),
    /选项最多 6 个/
  );
  const normalized = kernel.normalizeQuestions([
    { id: 'q1', question: '第一个' },
    { id: 'q1', question: '第二个' },
    { question: '第三个' },
  ]);
  assert.deepEqual(normalized.map((item) => item.id), ['q1', 'q1-2', 'q3']);
});

test('一次问多个问题：都答完才算 ok，文案逐条给出用户口径', async () => {
  const { sessionId } = seedRunning();
  const pending = kernel.askUserQuestions({
    questions: [
      { question: '允许联网查询吗？', options: [{ label: '允许' }, { label: '不允许' }] },
      { question: '用哪个口径写标题？', options: [{ label: '工商全名' }, { label: '材料写法' }] },
    ],
  });
  const rows = repo.listPendingQuestions(sessionId);
  assert.equal(rows.length, 2);
  kernel.answerAgentQuestion(rows[0].id, { selected: ['允许'] });
  kernel.answerAgentQuestion(rows[1].id, { selected: ['工商全名'] });
  const outcome = await pending;
  assert.equal(outcome.ok, true);
  const text = kernel.formatAskOutcome(outcome);
  assert.match(text, /允许联网查询吗？ → 允许/);
  assert.match(text, /用哪个口径写标题？ → 工商全名/);
});
