import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 任务看板的服务端状态：一个专用会话 + 最近一次成功答案。
 * 这里钉住的规则——
 *   - 会话 id 记在服务端设置里，会话被删掉能重建；
 *   - empty / running / ready / failed 四种状态的判定，失败时仍把上一次的答案带出来；
 *   - 过期判定按完成时刻算；
 *   - 已经有一轮在跑就不再起新轮（不重复烧 token），没配 Agent 时原样抛给路由回 503。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-task-board-'));
process.env.DATA_DIR = temp;

let repo: typeof import('./repository.js');
let board: typeof import('./taskBoard.js');
let db: any;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  repo = await import('./repository.js');
  board = await import('./taskBoard.js');
});

beforeEach(() => {
  db.prepare(`DELETE FROM assistant_subagents`).run();
  db.prepare(`DELETE FROM assistant_tool_calls`).run();
  db.prepare(`DELETE FROM assistant_runs`).run();
  db.prepare(`DELETE FROM assistant_messages`).run();
  db.prepare(`DELETE FROM assistant_sessions`).run();
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(board.BOARD_SESSION_SETTING);
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

/** 造一轮跑完的问答（成功带答案，失败只有错误） */
function seedRun(input: { status: 'completed' | 'failed'; answer?: string; at?: Date; error?: string }) {
  const session = board.ensureBoardSession();
  const userMessage = repo.insertMessage({ sessionId: session.id, role: 'user', content: '下周的工作任务有哪些' });
  const run = repo.createRun({ sessionId: session.id, userMessageId: userMessage.id, context: {} });
  let assistantMessageId: string | undefined;
  if (input.answer) {
    assistantMessageId = repo.insertMessage({ sessionId: session.id, runId: run.id, role: 'assistant', content: input.answer }).id;
  }
  repo.updateRun(run.id, {
    status: input.status,
    ...(assistantMessageId ? { assistantMessageId } : {}),
    ...(input.error ? { error: input.error } : {}),
  });
  if (input.at) {
    // completed_at 由 updateRun 写成「现在」，要造旧答案就在这里改成想要的时刻
    db.prepare(`UPDATE assistant_runs SET completed_at = ?, updated_at = ? WHERE id = ?`)
      .run(input.at.toISOString(), input.at.toISOString(), run.id);
  }
  return { session, run };
}

test('没生成过：empty、没有会话 id，也不凭空建会话', () => {
  const state = board.boardState();
  assert.equal(state.status, 'empty');
  assert.equal(state.sessionId, '');
  assert.equal(state.answer, '');
  assert.equal(board.boardSession(), null);
});

test('ensureBoardSession：建一次就记进设置，后续复用同一个会话（标题钉住不被自动命名覆盖）', () => {
  const first = board.ensureBoardSession();
  assert.equal(first.title, '任务看板');
  assert.equal(first.titleSource, 'user');
  assert.equal(board.ensureBoardSession().id, first.id, '第二次不再新建');

  // 会话被删掉：拿不到就重建，而不是一直指向一个死 id
  repo.deleteSession(first.id);
  const rebuilt = board.ensureBoardSession();
  assert.notEqual(rebuilt.id, first.id);
});

test('有答案：ready，带答案原文与完成时刻；六小时内不算过期', () => {
  const { run } = seedRun({ status: 'completed', answer: '# 看板\n\n- [ ] 一条事', at: new Date() });
  const state = board.boardState();
  assert.equal(state.status, 'ready');
  assert.equal(state.answer, '# 看板\n\n- [ ] 一条事');
  assert.equal(state.stale, false);
  assert.equal(state.runId, run.id);
  assert.equal(state.runStatus, 'completed');
  assert.equal(state.error, '');
});

test('旧答案算过期：超过六小时要重新生成', () => {
  seedRun({ status: 'completed', answer: '旧清单', at: new Date(Date.now() - board.BOARD_FRESH_MS - 60_000) });
  assert.equal(board.boardState().stale, true);

  seedRun({ status: 'completed', answer: '边界内', at: new Date(Date.now() - board.BOARD_FRESH_MS + 60_000) });
  assert.equal(board.boardState().stale, false, '卡在窗口内的仍是新鲜的');
});

test('最近一轮失败：status=failed 并把上一次的答案与失败原因一起带出来', () => {
  seedRun({ status: 'completed', answer: '上一次的清单' });
  seedRun({ status: 'failed', error: '模型不可用' });
  const state = board.boardState();
  assert.equal(state.status, 'failed');
  assert.equal(state.answer, '上一次的清单', '失败不清空旧答案，界面还能显示上一版');
  assert.equal(state.error, '模型不可用');
});

test('正在跑：status=running，runId 指向在跑的那一轮', () => {
  const session = board.ensureBoardSession();
  const userMessage = repo.insertMessage({ sessionId: session.id, role: 'user', content: '下周的工作任务有哪些' });
  const run = repo.createRun({ sessionId: session.id, userMessageId: userMessage.id, context: {} });
  const state = board.boardState();
  assert.equal(state.status, 'running');
  assert.equal(state.runId, run.id);
  assert.equal(state.runStatus, 'running');
});

test('窗口：按答案生成时刻算自然周（前端按天视图铺每一天），没有答案时按现在算', () => {
  const saturday = new Date(2026, 8, 26, 15, 30);
  const blank = board.boardState(saturday);
  assert.equal(blank.windowStart, '2026-09-28');
  assert.equal(blank.windowEnd, '2026-10-04');

  // 答案生成于周六：窗口就是那一刻的「下周」
  seedRun({ status: 'completed', answer: '看板', at: new Date(2026, 8, 26, 9, 0) });
  const ready = board.boardState(saturday);
  assert.equal(ready.windowStart, '2026-09-28');
  assert.equal(ready.windowEnd, '2026-10-04');

  // 生成于周一：窗口顺延到下一个自然周（前端别把旧答案套在新一周上）
  seedRun({ status: 'completed', answer: '看板', at: new Date(2026, 8, 28, 9, 0) });
  const next = board.boardState(saturday);
  assert.equal(next.windowStart, '2026-10-05');
  assert.equal(next.windowEnd, '2026-10-11');
});

test('没配 Agent：refreshBoard 原样把配置错误抛出来（路由回 400 给前端提示去配 Key）', () => {
  assert.throws(() => board.refreshBoard(), /还没配模型凭据/);
});

test('已经有一轮在跑：refreshBoard 复用它，不重复起轮', () => {
  const session = board.ensureBoardSession();
  const userMessage = repo.insertMessage({ sessionId: session.id, role: 'user', content: '下周的工作任务有哪些' });
  const run = repo.createRun({ sessionId: session.id, userMessageId: userMessage.id, context: {} });
  const again = board.refreshBoard();
  assert.equal(again.reused, true);
  assert.equal(again.run.id, run.id);
  assert.equal(repo.listRuns(session.id).length, 1, '没有多出第二轮');
});
