import test, { after, afterEach, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-assistant-run-'));
process.env.DATA_DIR = temp;

const originalFetch = globalThis.fetch;
let db: any;
let migrate: () => void;
let setSetting: (key: string, value: string) => void;
let ensureDirs: typeof import('../config.js').ensureDirs;
let readPage: typeof import('../lib/vault.js').readPage;
let createSession: typeof import('./repository.js').createSession;
let createRun: typeof import('./repository.js').createRun;
let createToolCall: typeof import('./repository.js').createToolCall;
let appendMessage: typeof import('./repository.js').appendMessage;
let getRun: typeof import('./repository.js').getRun;
let getSession: typeof import('./repository.js').getSession;
let getSnapshotByRun: typeof import('./repository.js').getSnapshotByRun;
let listMessages: typeof import('./repository.js').listMessages;
let updateRun: typeof import('./repository.js').updateRun;
let updateSession: typeof import('./repository.js').updateSession;
let startAssistantRun: typeof import('./orchestrator.js').startAssistantRun;
let decideAssistantRun: typeof import('./orchestrator.js').decideAssistantRun;
let cancelAssistantRun: typeof import('./orchestrator.js').cancelAssistantRun;
let assistantModelMessagesForRun: typeof import('./orchestrator.js').assistantModelMessagesForRun;
let compactAssistantSessionForRun: typeof import('./orchestrator.js').compactAssistantSessionForRun;

before(async () => {
  ({ db, migrate, setSetting } = await import('../lib/db.js'));
  ({ ensureDirs } = await import('../config.js'));
  ({ readPage } = await import('../lib/vault.js'));
  ({
    appendMessage,
    createSession,
    createRun,
    createToolCall,
    getRun,
    getSession,
    getSnapshotByRun,
    listMessages,
    updateRun,
    updateSession,
  } = await import('./repository.js'));
  ({
    assistantModelMessagesForRun,
    cancelAssistantRun,
    compactAssistantSessionForRun,
    decideAssistantRun,
    startAssistantRun,
  } = await import('./orchestrator.js'));
  migrate();
});

beforeEach(() => {
  db.exec(`
    DELETE FROM assistant_artifacts;
    DELETE FROM assistant_tool_calls;
    DELETE FROM assistant_runs;
    DELETE FROM assistant_messages;
    DELETE FROM assistant_sessions;
    DELETE FROM edges;
    DELETE FROM chunks;
    DELETE FROM vec_chunks;
    DELETE FROM pages_fts;
    DELETE FROM files_fts;
    DELETE FROM pages;
    DELETE FROM files;
    DELETE FROM jobs;
    DELETE FROM semantic_cache;
    DELETE FROM semantic_events;
    DELETE FROM llm_usage;
    DELETE FROM settings WHERE key IN ('chat_models', 'active_chat_model');
  `);
  fs.rmSync(path.join(temp, 'brain'), { recursive: true, force: true });
  ensureDirs();
  const model = {
    id: 'chat-test',
    name: 'Test Chat',
    provider: 'openai-compatible',
    baseUrl: 'https://llm.example/v1',
    model: 'test-model',
    apiKey: 'secret',
  };
  setSetting('chat_models', JSON.stringify([model]));
  setSetting('active_chat_model', model.id);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function mockCompletions(responses: any[]) {
  let index = 0;
  globalThis.fetch = async () => {
    const body = responses[Math.min(index++, responses.length - 1)];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

async function waitForStatus(runId: string, status: string, timeout = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const run = getRun(runId);
    if (run?.status === status) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`run ${runId} did not reach ${status}: ${getRun(runId)?.status}`);
}

function createToolResponse(title: string) {
  return {
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        content: null,
        tool_calls: [{
          id: 'call-create',
          type: 'function',
          function: {
            name: 'create_page',
            arguments: JSON.stringify({
              title,
              type: 'concept',
              content: `# ${title}\n\ncreated by agent`,
            }),
          },
        }],
      },
    }],
  };
}

const finalResponse = {
  choices: [{
    finish_reason: 'stop',
    message: { content: '任务处理完成。' },
  }],
};

const agentRouteResponse = {
  choices: [{
    finish_reason: 'stop',
    message: {
      content: JSON.stringify({
        mode: 'agent',
        retrievalQuery: '创建页面',
        reason: '用户要求改变软件状态',
      }),
    },
  }],
};

const chatRouteResponse = {
  choices: [{
    finish_reason: 'stop',
    message: {
      content: JSON.stringify({
        mode: 'chat',
        retrievalQuery: '',
        reason: '通用闲聊，与知识库和软件功能无关',
      }),
    },
  }],
};

test('chat mode answers general questions without retrieval or tools', async () => {
  const requests: any[] = [];
  globalThis.fetch = async (_input: any, init?: any) => {
    requests.push(JSON.parse(String(init?.body || '{}')));
    if (requests.length === 1) {
      return new Response(JSON.stringify(chatRouteResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: '当然，坚持写笔记' } }] })}`,
      '',
      `data: ${JSON.stringify({ choices: [{ delta: { content: '的诀窍是降低门槛。' } }] })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const session = createSession();
  const run = startAssistantRun(session.id, '聊聊：怎么坚持写笔记？');
  await waitForStatus(run.id, 'completed');

  assert.equal(requests.length, 2);
  assert.match(requests[0].messages[0].content, /路由模型/);
  const chatSystem = requests[1].messages.find((message: any) => message.role === 'system');
  assert.match(chatSystem.content, /AI 助手/);
  assert.doesNotMatch(chatSystem.content, /只依据提供的知识库证据/);
  const snapshot = getSnapshotByRun(run.id)!;
  assert.equal(snapshot.toolCalls.length, 0);
  const visible = snapshot.messages
    .filter((message: any) => !message.metadata.hidden && message.role === 'assistant');
  assert.match(visible.at(-1)?.content || '', /坚持写笔记/);
  assert.equal(visible.at(-1)?.metadata.sources, undefined);
});

test('agent pauses for approval, executes exact tool call and completes', async () => {
  mockCompletions([agentRouteResponse, createToolResponse('Agent Approved'), finalResponse]);
  const session = createSession();
  const run = startAssistantRun(session.id, '创建一个名为 Agent Approved 的概念页面');
  await waitForStatus(run.id, 'waiting_approval');
  const pending = getSnapshotByRun(run.id)!.toolCalls;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].risk, 'reversible');
  assert.equal(pending[0].status, 'proposed');

  await decideAssistantRun(run.id, [{
    toolCallId: pending[0].id,
    approved: true,
  }]);
  await waitForStatus(run.id, 'completed');
  const page = db.prepare(`SELECT path FROM pages WHERE title = ? AND deleted = 0`).get('Agent Approved') as any;
  assert.ok(page);
  assert.match(readPage(page.path)?.content || '', /created by agent/);
  const snapshot = getSnapshotByRun(run.id)!;
  assert.equal(snapshot.toolCalls[0].status, 'completed');
  assert.match(snapshot.messages.find((message) => message.role === 'assistant' && !message.metadata.hidden)?.content || '', /完成/);
});

test('agent respects rejection and does not mutate the vault', async () => {
  mockCompletions([agentRouteResponse, createToolResponse('Agent Rejected'), finalResponse]);
  const session = createSession();
  const run = startAssistantRun(session.id, '创建一个名为 Agent Rejected 的概念页面');
  await waitForStatus(run.id, 'waiting_approval');
  const pending = getSnapshotByRun(run.id)!.toolCalls;
  await decideAssistantRun(run.id, [{
    toolCallId: pending[0].id,
    approved: false,
  }]);
  await waitForStatus(run.id, 'completed');
  const page = db.prepare(`SELECT id FROM pages WHERE title = ? AND deleted = 0`).get('Agent Rejected');
  assert.equal(page, undefined);
  assert.equal(getSnapshotByRun(run.id)!.toolCalls[0].status, 'rejected');
});

test('waiting approval can be cancelled and running states recover as interrupted', async () => {
  mockCompletions([agentRouteResponse, createToolResponse('Agent Cancelled')]);
  const session = createSession();
  const run = startAssistantRun(session.id, '创建一个名为 Agent Cancelled 的概念页面');
  await waitForStatus(run.id, 'waiting_approval');
  cancelAssistantRun(run.id);
  assert.equal(getRun(run.id)?.status, 'cancelled');

  const second = createRun(session.id, '创建另一个页面', {});
  updateRun(second.id, { status: 'running' });
  migrate();
  assert.equal(getRun(second.id)?.status, 'interrupted');
});

test('高风险缺二次确认：decide 在置 executing 之前拒绝，run 停留 waiting_approval 可重新提交', async () => {
  const session = createSession();
  const run = createRun(session.id, '高危动作测试', {});
  updateRun(run.id, { status: 'waiting_approval' });
  const call = createToolCall({
    runId: run.id,
    name: 'create_page',
    arguments: { title: '高危目标', type: 'concept', content: '# 高危目标' },
    risk: 'high',
    status: 'proposed',
  });

  // 回归点：修复前这里先置 executing 再抛错，run 卡在 executing——
  // cancel/retry 都不接受该状态，会话被 activeRunForSession 永久锁死
  await assert.rejects(
    () => decideAssistantRun(run.id, [{ toolCallId: call.id, approved: true }]),
    /二次确认/,
  );
  assert.equal(getRun(run.id)?.status, 'waiting_approval');
  assert.equal(getSnapshotByRun(run.id)!.toolCalls[0].status, 'proposed');
});

test('未知工具：decide 预校验拒绝，run 同样停留 waiting_approval', async () => {
  const session = createSession();
  const run = createRun(session.id, '未知工具测试', {});
  updateRun(run.id, { status: 'waiting_approval' });
  const call = createToolCall({
    runId: run.id,
    name: 'no_such_tool',
    arguments: {},
    risk: 'reversible',
    status: 'proposed',
  });
  await assert.rejects(
    () => decideAssistantRun(run.id, [{ toolCallId: call.id, approved: true }]),
    /未知工具/,
  );
  assert.equal(getRun(run.id)?.status, 'waiting_approval');
});

test('agent keeps committed history before volatile interface context', () => {
  const session = createSession();
  updateSession(session.id, { summary: '长期目标：维护客户项目知识。' });
  const previous = createRun(session.id, '上一轮问题', {});
  appendMessage({
    sessionId: session.id,
    runId: previous.id,
    role: 'assistant',
    content: '上一轮回答',
  });
  updateRun(previous.id, { status: 'completed' });
  const current = createRun(session.id, '当前问题', {
    route: '/page/current',
    currentPage: {
      id: 'page-current',
      title: '当前页面',
      path: 'Wiki/概念/当前页面.md',
    },
  });

  const messages = assistantModelMessagesForRun(current.id);
  const previousIndex = messages.findIndex((message) => message.content === '上一轮回答');
  const contextIndex = messages.findIndex((message) =>
    typeof message.content === 'string' &&
    message.content.includes('UNTRUSTED_INTERFACE_CONTEXT')
  );
  const currentIndex = messages.findIndex((message) => message.content === '当前问题');

  assert.match(String(messages[1].content), /长期目标/);
  assert.ok(previousIndex > 1);
  assert.ok(contextIndex > previousIndex);
  assert.ok(currentIndex > contextIndex);
});

test('long sessions compact model context without deleting raw messages', async () => {
  mockCompletions([{
    choices: [{
      finish_reason: 'stop',
      message: {
        content: JSON.stringify({
          summary: '保留长期目标、关键决定和来源。',
        }),
      },
    }],
  }]);
  const session = createSession();
  for (let index = 0; index < 24; index++) {
    const run = createRun(session.id, `历史问题 ${index} ${'问'.repeat(1800)}`, {});
    appendMessage({
      sessionId: session.id,
      runId: run.id,
      role: 'assistant',
      content: `历史回答 ${index} ${'答'.repeat(1800)}`,
    });
    updateRun(run.id, { status: 'completed' });
  }
  const current = createRun(session.id, '当前问题', {});
  const before = listMessages(session.id, 500).length;

  await compactAssistantSessionForRun(current.id);

  const after = listMessages(session.id, 500);
  assert.equal(after.length, before);
  assert.match(getSession(session.id)?.summary || '', /长期目标/);
  assert.ok(after.some((message) => message.metadata.compacted));
  assert.equal(
    after.find((message) => message.id === current.userMessageId)?.metadata.compacted,
    undefined,
  );
});
