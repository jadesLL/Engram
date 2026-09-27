import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 任务看板的服务端状态：每次提炼一个新会话 + 跨会话取「最近一次成功答案」+ 可配的自动提炼间隔。
 * 这里钉住的规则——
 *   - 每次提炼都新开会话（不共用上下文），旧会话一律保留；
 *   - 答案与在跑的轮次按系统标记**跨会话**取（新会话一开，上一版看板不能消失）；
 *   - empty / running / ready / failed 四种状态的判定，失败时仍把上一次的答案带出来；
 *   - 过期按「答案生成时刻 + 配置的间隔天数」算，关闭自动时永不判过期；
 *   - 已经有一轮在跑就不再起新轮（不重复烧 token），没配 Agent 时原样抛给路由回 400，
 *     且刚建的空会话与指针一起回滚（一次「起不来」不能让看板丢上一版）。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-task-board-'));
process.env.DATA_DIR = temp;

let repo: typeof import('./repository.js');
let board: typeof import('./taskBoard.js');
let core: typeof import('./boardCore.js');
let db: any;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  repo = await import('./repository.js');
  board = await import('./taskBoard.js');
  core = await import('./boardCore.js');
});

beforeEach(() => {
  db.prepare(`DELETE FROM assistant_subagents`).run();
  db.prepare(`DELETE FROM assistant_tool_calls`).run();
  db.prepare(`DELETE FROM assistant_runs`).run();
  db.prepare(`DELETE FROM assistant_messages`).run();
  db.prepare(`DELETE FROM assistant_sessions`).run();
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(board.BOARD_SESSION_SETTING);
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(core.BOARD_AUTO_SETTING);
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

/** 造一轮跑完的问答（成功带答案，失败只有错误）；每次都在新会话里，贴近真实提炼节奏 */
function seedRun(input: { status: 'completed' | 'failed'; answer?: string; at?: Date; error?: string }) {
  const session = board.newBoardSession();
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
  // 回读一次：completed_at / assistant_message_id 都是落库后才有，调用方断言要用最新那份
  return { session, run: repo.getRun(run.id)! };
}

/** 造一轮还在跑的（用来验证「正在提炼」与「复用不重复起轮」） */
function seedRunning() {
  const session = board.newBoardSession();
  const userMessage = repo.insertMessage({ sessionId: session.id, role: 'user', content: '下周的工作任务有哪些' });
  const run = repo.createRun({ sessionId: session.id, userMessageId: userMessage.id, context: {} });
  return { session, run };
}

/** 看板会话列表（按系统标记），用来断言「每次新开、旧的都留着」 */
function boardSessions() {
  return repo.listSessions().filter((session) => session.systemKey === core.BOARD_SYSTEM_KEY);
}

test('没生成过：empty、没有会话 id，也不凭空建会话', () => {
  const state = board.boardState();
  assert.equal(state.status, 'empty');
  assert.equal(state.sessionId, '');
  assert.equal(state.answer, '');
  assert.equal(state.autoDays, core.BOARD_AUTO_DEFAULT_DAYS, '没配过就用默认间隔（每 2 天）');
  assert.equal(state.dueAt, '');
  assert.equal(board.boardSession(), null);
});

test('每次提炼新开会话：指针跟着走、旧会话全留着、标题带日期时间', () => {
  const first = board.newBoardSession(new Date(2026, 8, 30, 9, 5));
  assert.equal(first.systemKey, core.BOARD_SYSTEM_KEY);
  assert.equal(first.titleSource, 'user');
  assert.match(first.title, /^任务看板 2026-09-30 09:05/);

  const second = board.newBoardSession(new Date(2026, 9, 2, 14, 30));
  assert.notEqual(second.id, first.id, '第二次必须新开一个会话');
  assert.equal(board.boardSession()?.id, second.id, '设置里的指针指向最新那个会话');
  assert.equal(boardSessions().length, 2, '旧会话不删（聊天抽屉里还能翻过程）');
  assert.equal(second.title, '任务看板 2026-10-02 14:30');
});

test('跨会话取答案：新会话还没出答案时，界面上仍是上一版看板', () => {
  seedRun({ status: 'completed', answer: '上一版清单', at: new Date(Date.now() - 60_000) });
  board.newBoardSession(); // 新一轮已开，但还没有答案
  const state = board.boardState();
  assert.equal(state.status, 'ready');
  assert.equal(state.answer, '上一版清单');
});

test('有答案：ready，带答案原文与完成时刻；默认间隔（2 天）内不算过期', () => {
  const { run } = seedRun({ status: 'completed', answer: '# 看板\n\n- [ ] 一条事', at: new Date() });
  const state = board.boardState();
  assert.equal(state.status, 'ready');
  assert.equal(state.answer, '# 看板\n\n- [ ] 一条事');
  assert.equal(state.stale, false);
  assert.equal(state.runId, run.id);
  assert.equal(state.runStatus, 'completed');
  assert.equal(state.error, '');
  assert.equal(state.dueAt, new Date(Date.parse(run.completedAt!) + core.BOARD_AUTO_DEFAULT_DAYS * core.DAY_MS).toISOString());
});

test('过期按配置的间隔天数算：默认 2 天、改成 1 天即收紧、关闭自动则永不判过期', () => {
  const twoDays = 2 * core.DAY_MS;
  seedRun({ status: 'completed', answer: '旧清单', at: new Date(Date.now() - twoDays - 60_000) });
  assert.equal(board.boardState().stale, true, '超过 2 天算过期');

  const hourAgo = new Date(Date.now() - core.DAY_MS - 60_000);
  db.prepare(`UPDATE assistant_runs SET completed_at = ?, updated_at = ?`).run(hourAgo.toISOString(), hourAgo.toISOString());
  assert.equal(board.boardState().stale, false, '一天前在 2 天的窗口内');

  core.writeBoardAutoDays(1);
  assert.equal(board.boardState().stale, true, '改成每天后，一天前就过期了');

  core.writeBoardAutoDays(0);
  const closed = board.boardState();
  assert.equal(closed.stale, false, '关闭自动后不判过期（只剩手动刷新）');
  assert.equal(closed.dueAt, '');
});

test('档位归一化：只认登记的档位，野值落回默认并把结果写回库', () => {
  assert.equal(core.readBoardAutoDays(), core.BOARD_AUTO_DEFAULT_DAYS, '没设置时给默认值');
  assert.deepEqual(core.BOARD_AUTO_OPTIONS, [0, 1, 2, 3, 7]);
  for (const days of core.BOARD_AUTO_OPTIONS) {
    assert.equal(core.writeBoardAutoDays(days), days);
    assert.equal(core.readBoardAutoDays(), days);
  }
  assert.equal(core.writeBoardAutoDays(5), core.BOARD_AUTO_DEFAULT_DAYS, '没登记的档位落回默认');
  assert.equal(core.writeBoardAutoDays('abc'), core.BOARD_AUTO_DEFAULT_DAYS);
  assert.equal(core.writeBoardAutoDays(null), core.BOARD_AUTO_DEFAULT_DAYS, 'null 不等于「关闭自动」');
  assert.equal(core.writeBoardAutoDays(''), core.BOARD_AUTO_DEFAULT_DAYS);
  assert.equal(core.writeBoardAutoDays(true), core.BOARD_AUTO_DEFAULT_DAYS, 'true 不等于「每天」');
  assert.equal(core.readBoardAutoDays(), core.BOARD_AUTO_DEFAULT_DAYS, '归一化结果已经落库');
  db.prepare(`UPDATE settings SET value = '99' WHERE key = ?`).run(core.BOARD_AUTO_SETTING);
  assert.equal(core.readBoardAutoDays(), core.BOARD_AUTO_DEFAULT_DAYS, '库里被手改成野值也按默认读');
});

test('最近一轮失败：status=failed 并把上一次的答案与失败原因一起带出来', () => {
  seedRun({ status: 'completed', answer: '上一次的清单' });
  seedRun({ status: 'failed', error: '模型不可用' });
  const state = board.boardState();
  assert.equal(state.status, 'failed');
  assert.equal(state.answer, '上一次的清单', '失败不清空旧答案，界面还能显示上一版');
  assert.equal(state.error, '模型不可用');
});

test('正在跑：status=running，runId 指向在跑的那一轮（哪怕它在新会话里）', () => {
  const { run } = seedRunning();
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

test('配置态：带档位、可选档位、上次更新时刻与到期时刻（设置面板与看板页读同一份）', () => {
  const before = board.boardConfig();
  assert.equal(before.autoDays, core.BOARD_AUTO_DEFAULT_DAYS);
  assert.deepEqual(before.options, [0, 1, 2, 3, 7]);
  assert.equal(before.generatedAt, '');
  assert.equal(before.dueAt, '');
  assert.equal(before.running, false);

  const { run } = seedRun({ status: 'completed', answer: '清单', at: new Date() });
  const after = board.boardConfig();
  assert.equal(after.generatedAt, run.completedAt);
  assert.ok(after.dueAt, '有答案且自动开着：给出到期时刻');
  assert.equal(after.stale, false);

  const running = seedRunning();
  assert.equal(board.boardConfig().running, true);
  assert.equal(board.boardConfig().runId, running.run.id);
});

test('没配 Agent：refreshBoard 原样把配置错误抛出来，且不留下空会话、不丢上一版', () => {
  const { session } = seedRun({ status: 'completed', answer: '上一版清单' });
  const beforeCount = boardSessions().length;

  assert.throws(() => board.refreshBoard(), /还没配模型凭据/);
  assert.equal(boardSessions().length, beforeCount, '起轮失败后刚建的空会话被回滚删除');
  assert.equal(board.boardSession()?.id, session.id, '指针回到上一版所在的会话');
  assert.equal(board.boardState().answer, '上一版清单', '上一版看板没丢');
});

test('已经有一轮在跑：refreshBoard 跨会话复用它，不重复起轮也不新开会话', () => {
  seedRun({ status: 'completed', answer: '上一版' });
  const { session, run } = seedRunning();
  const beforeCount = boardSessions().length;

  const again = board.refreshBoard();
  assert.equal(again.reused, true);
  assert.equal(again.run.id, run.id);
  assert.equal(again.sessionId, session.id);
  assert.equal(boardSessions().length, beforeCount, '复用时不会再开一个会话');
  assert.equal(repo.listRuns(session.id).length, 1, '没有多出第二轮');
});
