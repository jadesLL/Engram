import test, { after, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-chat-window-'));
process.env.DATA_DIR = temp;

let db: any;
let migrate: typeof import('../lib/db.js').migrate;
let createSession: typeof import('./repository.js').createSession;
let appendMessage: typeof import('./repository.js').appendMessage;
let updateMessage: typeof import('./repository.js').updateMessage;
let getSession: typeof import('./repository.js').getSession;
let assistantChatWindowMessages: typeof import('./orchestrator.js').assistantChatWindowMessages;

before(async () => {
  ({ db, migrate } = await import('../lib/db.js'));
  ({ createSession, appendMessage, updateMessage, getSession } = await import('./repository.js'));
  ({ assistantChatWindowMessages } = await import('./orchestrator.js'));
  migrate();
});

beforeEach(() => {
  db.exec(`
    DELETE FROM assistant_artifacts;
    DELETE FROM assistant_tool_calls;
    DELETE FROM assistant_runs;
    DELETE FROM assistant_messages;
    DELETE FROM assistant_sessions;
  `);
});

after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function fill(content: string, chars: number): string {
  let s = content;
  while (s.length < chars) s += `${content}-${s.length}`;
  return s.slice(0, chars);
}

async function appendPair(sessionId: string, index: number, chars: number) {
  appendMessage({ sessionId, role: 'user', content: fill(`第${index}轮用户消息`, chars) });
  appendMessage({ sessionId, role: 'assistant', content: fill(`第${index}轮助手回复`, chars) });
}

function windowChars(window: Array<{ content: string }>): number {
  return window.reduce((sum, m) => sum + m.content.length, 0);
}

test('世代内窗口逐轮只追加：新窗口的前缀与上一轮窗口逐字节一致', () => {
  const session = createSession('前缀稳定');
  const previous: Array<{ role: string; content: string }> = [];
  for (let i = 1; i <= 6; i++) {
    appendPair(session.id, i, 600);
    const current = assistantChatWindowMessages(session.id);
    if (previous.length) {
      assert.ok(current.length > previous.length, `第${i}轮窗口应只增不减`);
      assert.deepEqual(
        current.slice(0, previous.length),
        previous,
        `第${i}轮窗口前缀应与上一轮完全一致（世代内头部冻结）`
      );
    }
    previous.length = 0;
    previous.push(...current);
  }
});

test('预算超限时锚点跳进：一次断裂后重新稳定，而不是每轮滑动', () => {
  const session = createSession('预算跳进');
  let previousFirst = '';
  let jumps = 0;
  for (let i = 1; i <= 20; i++) {
    appendPair(session.id, i, 2000);
    const current = assistantChatWindowMessages(session.id);
    assert.ok(
      windowChars(current) <= 32_000 + 4000,
      `第${i}轮窗口超出预算上限（含单条余量）`
    );
    const first = current[0]?.content || '';
    if (previousFirst && first !== previousFirst) jumps++;
    previousFirst = first;
  }
  assert.ok(jumps >= 1, '应发生过至少一次锚点跳进');
  assert.ok(jumps <= 5, `跳进应低频（实际 ${jumps} 次），不得退化成逐轮滑动`);
});

test('跳进后锚点与窗口头部一致', () => {
  const session = createSession('锚点一致');
  for (let i = 1; i <= 12; i++) appendPair(session.id, i, 2000);
  const current = assistantChatWindowMessages(session.id);
  const anchor = getSession(session.id)?.chatAnchorId;
  assert.ok(anchor, '应已写入世代锚点');
  const anchorRow = db.prepare(`SELECT content FROM assistant_messages WHERE id = ?`).get(anchor) as { content: string };
  assert.equal(anchorRow.content, current[0]?.content, '锚点消息应与窗口头部为同一条消息');
});

test('压缩（compacted 标记）后锚点重置到首个可见消息', () => {
  const session = createSession('压缩重置');
  for (let i = 1; i <= 5; i++) appendPair(session.id, i, 600);
  const before = assistantChatWindowMessages(session.id);
  assert.equal(before.length, 10);
  const list = db.prepare(`SELECT id FROM assistant_messages ORDER BY rowid`).all() as { id: string }[];
  for (const row of list.slice(0, 6)) {
    updateMessage(row.id, { metadata: { compacted: true } });
  }
  const afterWindow = assistantChatWindowMessages(session.id);
  assert.equal(afterWindow.length, 4, '窗口应从首个未压缩消息开始');
  assert.match(afterWindow[0].content, /第4轮用户消息/);
});

test('窗口返回的是请求形态：每条内容截断到 4000 字符', () => {
  const session = createSession('截断形态');
  appendMessage({ sessionId: session.id, role: 'user', content: fill('超长消息', 6000) });
  appendMessage({ sessionId: session.id, role: 'assistant', content: '短回复' });
  const window = assistantChatWindowMessages(session.id);
  assert.equal(window[0].content.length, 4000);
  assert.equal(window[1].content, '短回复');
});
