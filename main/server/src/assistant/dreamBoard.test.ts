import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 提炼看板的数据组装（只读）：轮次倒序、明细提取与去重、before/after 快照对位、空态兜底。
 *
 * 轮次、工具卡、消息都走真实表（repo）——看板读的就是它们，替身只会把「SQL 里漏了一列」
 * 这类问题藏起来。唯一合成的是时间戳：用例要钉住先后顺序，系统时钟不受控。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-dream-board-'));
process.env.DATA_DIR = temp;

let kernel: typeof import('./dreamBoard.js');
let configKernel: typeof import('./dreamConfig.js');
let repo: typeof import('./repository.js');
let db: any;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  repo = await import('./repository.js');
  configKernel = await import('./dreamConfig.js');
  kernel = await import('./dreamBoard.js');
});

beforeEach(() => {
  db.prepare('DELETE FROM assistant_tool_calls').run();
  db.prepare('DELETE FROM assistant_runs').run();
  db.prepare('DELETE FROM assistant_messages').run();
  db.prepare('DELETE FROM assistant_sessions').run();
  db.prepare('DELETE FROM settings WHERE key IN (?, ?, ?)')
    .run(configKernel.DREAM_SETTINGS_KEY, configKernel.DREAM_STATE_KEY, configKernel.DREAM_HISTORY_KEY);
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function dreamSession(): { id: string } {
  return repo.createSession('梦境思考', 'dream_thinking');
}

/** 造一轮：user 消息 + 轮次 + 助手正文 + 工具卡；时间戳直接写库，钉住先后顺序 */
function addRound(
  sessionId: string,
  options: {
    createdAt: string;
    completedAt?: string;
    status?: string;
    text?: string;
    calls?: Array<{ name: string; args: Record<string, unknown>; ok?: boolean }>;
  },
): { runId: string } {
  const user = repo.insertMessage({ sessionId, role: 'user', content: '【梦境思考】自动整理与纠错' });
  const run = repo.createRun({ sessionId, userMessageId: user.id, context: {} });
  db.prepare('UPDATE assistant_runs SET created_at = ? WHERE id = ?').run(options.createdAt, run.id);
  if (options.text) {
    const assistant = repo.insertMessage({ sessionId, runId: run.id, role: 'assistant', content: options.text });
    repo.updateRun(run.id, { status: (options.status as any) ?? 'completed', assistantMessageId: assistant.id });
  } else {
    repo.updateRun(run.id, { status: (options.status as any) ?? 'completed' });
  }
  if (options.completedAt) {
    db.prepare('UPDATE assistant_runs SET completed_at = ? WHERE id = ?').run(options.completedAt, run.id);
  }
  for (const call of options.calls ?? []) {
    const row = repo.insertToolCall({ runId: run.id, name: call.name, args: JSON.stringify(call.args) });
    repo.finishToolCallById(row.id, { ok: call.ok !== false, text: 'ok' });
  }
  return { runId: run.id };
}

function snapshot(runId: string, overrides: Partial<import('./dreamConfig.js').DreamRunSnapshot> = {}) {
  return {
    runId,
    startedAt: '2026-09-27T03:00:00.000Z',
    finishedAt: '2026-09-27T03:12:00.000Z',
    trigger: 'schedule' as const,
    status: 'completed' as const,
    before: { pendingFiles: 4, issues: 6 },
    after: { pendingFiles: 1, issues: 2, deadLinks: 1, duplicates: 1, outdatedPages: 0 },
    ...overrides,
  };
}

test('dreamBoard：没有会话时是空看板（界面据此显示空态）', () => {
  const board = kernel.dreamBoard('');
  assert.deepEqual(board.rounds, []);
  assert.equal(board.limit, kernel.DREAM_BOARD_ROUNDS);
});

test('dreamBoard：会话存在但一轮没跑过也是空看板', () => {
  const session = dreamSession();
  assert.deepEqual(kernel.dreamBoard(session.id).rounds, []);
});

test('dreamBoard：轮次最新在前，起点/收口计数来自记账快照', () => {
  const session = dreamSession();
  const first = addRound(session.id, { createdAt: '2026-09-26T03:00:00.000Z', completedAt: '2026-09-26T03:20:00.000Z', text: '昨天跑完' });
  const second = addRound(session.id, { createdAt: '2026-09-27T03:00:00.000Z', completedAt: '2026-09-27T03:10:00.000Z', text: '今天跑完' });
  configKernel.recordDreamRun(snapshot(first.runId, { startedAt: '2026-09-26T03:00:00.000Z' }));
  configKernel.recordDreamRun(snapshot(second.runId, {
    startedAt: '2026-09-27T03:00:00.000Z',
    finishedAt: '2026-09-27T03:10:00.000Z',
    before: { pendingFiles: 3, issues: 4 },
  }));

  const board = kernel.dreamBoard(session.id);
  assert.equal(board.rounds.length, 2);
  assert.equal(board.rounds[0].runId, second.runId, '最新一轮排最前');
  assert.equal(board.rounds[0].summary, '今天跑完', '小结给原文（Markdown 由界面渲染）');
  assert.equal(board.rounds[0].durationMs, 10 * 60_000);
  assert.deepEqual(board.rounds[0].before, { pendingFiles: 3, issues: 4 });
  assert.deepEqual(board.rounds[0].after, { pendingFiles: 1, issues: 2, deadLinks: 1, duplicates: 1, outdatedPages: 0 });
  assert.equal(board.rounds[1].runId, first.runId);
});

test('dreamBoard：老轮次没有记账快照时 before/after 留空，其余照常展示', () => {
  const session = dreamSession();
  const legacy = addRound(session.id, {
    createdAt: '2026-09-20T03:00:00.000Z',
    completedAt: '2026-09-20T03:05:00.000Z',
    text: '上个版本跑的轮次',
  });
  const board = kernel.dreamBoard(session.id);
  assert.equal(board.rounds[0].runId, legacy.runId);
  assert.equal(board.rounds[0].before, null);
  assert.equal(board.rounds[0].after, null);
  assert.equal(board.rounds[0].summary, '上个版本跑的轮次');
});

test('dreamBoard：明细提取——写页去重、读资料、改名/删除算纠错', () => {
  const session = dreamSession();
  const round = addRound(session.id, {
    createdAt: '2026-09-27T03:00:00.000Z',
    completedAt: '2026-09-27T03:30:00.000Z',
    text: '本轮小结',
    calls: [
      { name: 'mcp__engram__list_raw_files', args: { pending: true } },
      { name: 'mcp__engram__read_raw_file', args: { path: '原始资料/文档/甲.md' } },
      { name: 'mcp__engram__read_raw_file', args: { path: '原始资料/文档/甲.md' } },
      { name: 'mcp__engram__read_raw_file', args: { path: '原始资料/文档/乙.pdf' } },
      { name: 'mcp__engram__write_page', args: { path: 'Wiki/概念/甲概念.md', title: '甲概念' } },
      { name: 'mcp__engram__write_page', args: { path: 'Wiki/概念/甲概念.md', title: '甲概念' } },
      { name: 'mcp__engram__write_page', args: { path: 'Wiki/实体/乙公司.md', title: '乙公司' } },
      { name: 'mcp__engram__create_raw_material', args: { path: '原始资料/文档/2026.09.27_调研.md' } },
      { name: 'mcp__engram__rename_page', args: { titleOrId: '乙公司', newTitle: '乙公司有限公司' } },
      { name: 'mcp__engram__delete_page', args: { titleOrId: '重复页', reason: '疑似重复' }, ok: false },
    ],
  });
  configKernel.recordDreamRun(snapshot(round.runId));

  const item = kernel.dreamBoard(session.id).rounds[0];
  assert.deepEqual(item.pages.map((page) => page.label), ['甲概念', '乙公司'], '同一页面写多次只算一条');
  assert.deepEqual(item.sources.map((source) => source.label), ['原始资料/文档/甲.md', '原始资料/文档/乙.pdf']);
  assert.deepEqual(item.changes.map((change) => change.kind), ['create', 'rename', 'delete']);
  assert.equal(item.changes[1].note, '改用 乙公司有限公司');
  assert.equal(item.changes[2].ok, false, '失败的调用要标出来');
  assert.deepEqual(item.counts, { pages: 2, sources: 2, changes: 3, calls: 10 });
  assert.equal(item.trigger, 'schedule');
});

test('dreamBoard：正在跑的那一轮用 state 里的起点计数', () => {
  const session = dreamSession();
  const running = addRound(session.id, {
    createdAt: '2026-09-27T03:00:00.000Z',
    status: 'running',
    calls: [{ name: 'write_page', args: { path: 'Wiki/概念/在写.md', title: '在写' } }],
  });
  configKernel.writeDreamState({
    currentRunId: running.runId,
    beforePendingFiles: 5,
    beforeIssues: 3,
  });

  const board = kernel.dreamBoard(session.id);
  assert.equal(board.rounds[0].status, 'running');
  assert.deepEqual(board.rounds[0].before, { pendingFiles: 5, issues: 3 });
  assert.equal(board.rounds[0].after, null);
  assert.deepEqual(board.rounds[0].pages.map((page) => page.label), ['在写']);
});

test('dreamBoard：limit 只取最近 N 轮（更早的轮次不进看板）', () => {
  const session = dreamSession();
  for (let index = 0; index < 4; index++) {
    addRound(session.id, {
      createdAt: `2026-09-2${index}T03:00:00.000Z`,
      completedAt: `2026-09-2${index}T03:05:00.000Z`,
      text: `第 ${index} 轮`,
    });
  }
  const board = kernel.dreamBoard(session.id, { limit: 2 });
  assert.equal(board.limit, 2);
  assert.deepEqual(board.rounds.map((round) => round.summary), ['第 3 轮', '第 2 轮']);
});

test('dreamBoard：认不出的记账快照不会让看板崩（坏数据当没有）', () => {
  const session = dreamSession();
  addRound(session.id, { createdAt: '2026-09-27T03:00:00.000Z', completedAt: '2026-09-27T03:01:00.000Z', text: '好的' });
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('{"不是数组": true}', configKernel.DREAM_HISTORY_KEY);
  const board = kernel.dreamBoard(session.id);
  assert.equal(board.rounds.length, 1);
  assert.equal(board.rounds[0].before, null);
});
