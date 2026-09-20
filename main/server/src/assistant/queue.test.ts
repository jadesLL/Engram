import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 排队轮次（运行中又发一条消息）：钉住这几条规则——
 *   - 排队的轮次不占会话单飞位（runningRunForSession 看不到它，activeRunForSession 看得到）；
 *   - 排队消息带 metadata.queued，转正时摘掉，界面据此标/撤「排队中」；
 *   - 停止时撤回排队消息：消息与轮次一起删掉，原文按先来后到交回前端填输入框；
 *   - 前端的「接事件流」列表（listActiveRuns）只认正在跑的轮次。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-queue-'));
process.env.DATA_DIR = temp;

let repo: typeof import('./repository.js');
let db: any;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  repo = await import('./repository.js');
});

beforeEach(() => {
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
  const session = repo.createSession('排队测试');
  const message = repo.insertMessage({ sessionId: session.id, role: 'user', content: '先讲讲同步设计' });
  const run = repo.createRun({ sessionId: session.id, userMessageId: message.id, context: { route: '/wiki' } });
  return { sessionId: session.id, runId: run.id };
}

test('排队：消息与轮次一起落库，但不占单飞位', () => {
  const { sessionId, runId } = seedRunning();

  const { run, message } = repo.queueRun({
    sessionId,
    message: '再补一句：只看冲突处理',
    context: { route: '/wiki' },
  });

  assert.equal(run.status, 'queued');
  assert.equal(message.role, 'user');
  assert.equal(message.metadata.queued, true);
  assert.equal(message.runId, run.id);

  // 正在跑的那轮照旧占着单飞位；排队的这轮不算
  assert.equal(repo.runningRunForSession(sessionId)?.id, runId);
  assert.equal(repo.activeRunForSession(sessionId)?.id, run.id);
  // 前端接事件流只认正在跑的轮次（排队轮次还没有事件可接）
  assert.deepEqual(repo.listActiveRuns().map((item) => item.id), [runId]);
});

test('转正：状态改 running，消息上的排队标记摘掉', () => {
  const { sessionId } = seedRunning();
  const { run, message } = repo.queueRun({ sessionId, message: '第二条', context: {} });

  assert.equal(repo.nextQueuedRun(sessionId)?.id, run.id);

  const promoted = repo.promoteQueuedRun(run.id);
  assert.equal(promoted?.status, 'running');
  assert.equal(repo.getMessage(message.id)?.metadata.queued, false);
  assert.equal(repo.nextQueuedRun(sessionId), null);
  assert.equal(repo.runningRunForSession(sessionId)?.id, run.id);
});

test('排队先来后到：队首是最早那条，撤回也按同一顺序交回原文', () => {
  const { sessionId, runId } = seedRunning();
  const first = repo.queueRun({ sessionId, message: '第一条排队', context: {} });
  const second = repo.queueRun({ sessionId, message: '第二条排队', context: {} });

  assert.deepEqual(repo.listQueuedRuns(sessionId).map((item) => item.id), [first.run.id, second.run.id]);
  assert.equal(repo.nextQueuedRun(sessionId)?.id, first.run.id);

  // 停止 = 全停：排队消息与它们的轮次一起撤下，原文交回前端
  assert.deepEqual(repo.discardQueuedRuns(sessionId), ['第一条排队', '第二条排队']);
  assert.deepEqual(repo.listQueuedRuns(sessionId), []);
  assert.equal(repo.getMessage(first.message.id), null);
  assert.equal(repo.getRun(first.run.id), null);
  // 正在跑的那轮不受影响
  assert.equal(repo.runningRunForSession(sessionId)?.id, runId);
});

test('撤回不影响已经转正的那轮：转正后就不在排队名单里了', () => {
  const { sessionId } = seedRunning();
  const queued = repo.queueRun({ sessionId, message: '转正这条', context: {} });
  repo.promoteQueuedRun(queued.run.id);

  assert.deepEqual(repo.discardQueuedRuns(sessionId), []);
  assert.equal(repo.getMessage(queued.message.id)?.content, '转正这条');
});

test('上下文随轮次存下来：转正时按原样还原', () => {
  const { sessionId } = seedRunning();
  const { run } = repo.queueRun({ sessionId, message: '带上下文', context: { route: '/files', currentFile: { path: 'a.md' } } });

  assert.deepEqual(repo.runContext(run.id), { route: '/files', currentFile: { path: 'a.md' } });
});
