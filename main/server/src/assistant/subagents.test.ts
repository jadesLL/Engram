import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 子代理落库：对话流要看得见「用了子代理、在干什么、结果如何」，全靠这几张表与几条更新规则。
 * 用临时 DATA_DIR 起真库（与 jobs.test.ts 同一套做法），钉住：
 *   - 一轮里同一子会话只对应一张卡；
 *   - 过程条目按 callId 合并，结果事件（只有 callId、没有工具名）不能把工具名抹成空；
 *   - 本轮结束时还在跑的子代理标成 background，而不是假装还在 running；
 *   - 快照把子代理一起带走（前端只认快照）。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-subagents-'));
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

function seedRun(): { sessionId: string; runId: string; callId: string } {
  const session = repo.createSession('子代理测试');
  const message = repo.insertMessage({ sessionId: session.id, role: 'user', content: '整理同步设计' });
  const run = repo.createRun({ sessionId: session.id, userMessageId: message.id, context: {} });
  const call = repo.insertToolCall({ runId: run.id, name: 'subagent', args: '{"description":"检索同步"}' });
  return { sessionId: session.id, runId: run.id, callId: call.id };
}

test('子代理卡：建卡 → 描述符补标签 → 过程按 callId 合并 → 收工定稿', () => {
  const { sessionId, runId, callId } = seedRun();

  const created = repo.insertSubagent({
    sessionId,
    runId,
    parentCallId: callId,
    parentSessionId: 'session-root',
    childSessionId: 'child-1',
    prompt: '把同步设计相关的页面检索出来',
  });
  assert.equal(created.status, 'running');
  assert.equal(created.parentCallId, callId);
  assert.equal(created.prompt, '把同步设计相关的页面检索出来');

  repo.updateSubagent(created.id, { label: '检索同步', mode: 'one-shot', provider: 'spawn' });

  // 工具调用 → 过程一步
  repo.recordSubagentActivity(created.id, {
    callId: 'c1',
    name: 'mcp__engram__search',
    summary: '同步',
    status: 'running',
    text: '',
    at: '2026-01-01T00:00:01.000Z',
  });
  // 结果事件只带 callId：工具名与摘要必须保留，不能抹成空
  repo.recordSubagentActivity(created.id, {
    callId: 'c1',
    name: '',
    summary: '',
    status: 'completed',
    text: '3 条结果',
    at: '2026-01-01T00:00:02.000Z',
  });

  let card = repo.getSubagent(created.id)!;
  assert.equal(card.label, '检索同步');
  assert.equal(card.mode, 'one-shot');
  assert.equal(card.activity.length, 1);
  assert.deepEqual(
    { name: card.activity[0].name, summary: card.activity[0].summary, status: card.activity[0].status, text: card.activity[0].text },
    { name: 'mcp__engram__search', summary: '同步', status: 'completed', text: '3 条结果' }
  );

  repo.updateSubagent(created.id, { status: 'completed', stopReason: 'completed', result: '同步页已整理' });
  card = repo.getSubagent(created.id)!;
  assert.equal(card.status, 'completed');
  assert.equal(card.stopReason, 'completed');
  assert.equal(card.result, '同步页已整理');

  // 按子会话反查：dsh 的通知只给 childSessionId
  assert.equal(repo.findSubagentByChildSession('child-1')?.id, created.id);
  assert.equal(repo.findSubagentByChildSession('child-unknown'), null);
});

test('过程条目：同一 callId 覆盖、不同 callId 追加，超出上限丢最旧的', () => {
  const { sessionId, runId } = seedRun();
  const card = repo.insertSubagent({ sessionId, runId, parentSessionId: 'session-root', childSessionId: 'child-2' });

  for (let i = 0; i < 45; i += 1) {
    repo.recordSubagentActivity(card.id, {
      callId: `c${i}`,
      name: 'mcp__engram__read_page',
      summary: `第 ${i} 页`,
      status: 'running',
      text: '',
      at: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
    });
  }
  const afterMany = repo.getSubagent(card.id)!;
  assert.ok(afterMany.activity.length <= 40, `过程条目要有上限，实际 ${afterMany.activity.length}`);
  assert.equal(afterMany.activity[afterMany.activity.length - 1].summary, '第 44 页');

  repo.recordSubagentActivity(card.id, {
    callId: 'c44',
    name: '',
    summary: '',
    status: 'failed',
    text: '页面不存在',
    at: '2026-01-01T00:01:00.000Z',
  });
  const merged = repo.getSubagent(card.id)!;
  assert.equal(merged.activity.length, afterMany.activity.length);
  assert.equal(merged.activity[merged.activity.length - 1].status, 'failed');
  assert.equal(merged.activity[merged.activity.length - 1].name, 'mcp__engram__read_page');
});

test('本轮结束时仍在跑的子代理标成 background（后台继续跑）', () => {
  const { sessionId, runId } = seedRun();
  const running = repo.insertSubagent({ sessionId, runId, parentSessionId: 'session-root', childSessionId: 'child-3' });
  const done = repo.insertSubagent({ sessionId, runId, parentSessionId: 'session-root', childSessionId: 'child-4' });
  repo.updateSubagent(done.id, { status: 'completed' });

  repo.markSubagentsBackground(runId);

  assert.equal(repo.getSubagent(running.id)!.status, 'background');
  assert.equal(repo.getSubagent(done.id)!.status, 'completed');
});

test('快照带子代理；删会话连卡一起删', () => {
  const { sessionId, runId } = seedRun();
  repo.insertSubagent({ sessionId, runId, parentSessionId: 'session-root', childSessionId: 'child-5' });

  const snap = repo.snapshot(sessionId)!;
  assert.equal(snap.subagents.length, 1);
  assert.equal(snap.subagents[0].childSessionId, 'child-5');

  repo.deleteSession(sessionId);
  assert.equal(repo.snapshot(sessionId), null);
  assert.equal(repo.findSubagentByChildSession('child-5'), null);
});

test('正在跑的轮次列表：只列 queued/running，前端据此接事件流', () => {
  const { sessionId, runId } = seedRun();
  const active = repo.listActiveRuns();
  assert.deepEqual(active.map((run) => run.id), [runId]);
  assert.equal(active[0].sessionId, sessionId);

  repo.updateRun(runId, { status: 'completed' });
  assert.deepEqual(repo.listActiveRuns(), []);
});
