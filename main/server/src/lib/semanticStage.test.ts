import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-semantic-stage-'));
process.env.DATA_DIR = temp;

let server: http.Server;
let failNext = 0;
let db: any;
let runSemanticStage: any;
let createSemanticCacheSession: any;
let capturedRequests: any[] = [];

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    capturedRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (failNext > 0) {
      failNext--;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'forced semantic failure' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content: JSON.stringify({ answer: '模型结论' }) },
      }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_cache_hit_tokens: 80,
        prompt_cache_miss_tokens: 20,
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const dbModule = await import('./db.js');
  db = dbModule.db;
  dbModule.migrate();
  dbModule.setSetting('chat_models', JSON.stringify([{
    id: 'mock',
    name: 'mock',
    provider: 'custom',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: 'mock',
    apiKey: 'mock',
  }]));
  dbModule.setSetting('active_chat_model', 'mock');
  ({ runSemanticStage, createSemanticCacheSession } = await import('./semanticStage.js'));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('semantic stages audit both successful and failed model decisions', async () => {
  const schema = z.object({ answer: z.string() });
  const result = await runSemanticStage({
    scope: 'test',
    refId: 'run-success',
    stage: 'decide',
    tag: 'semantic-stage-test',
    schema,
    system: '返回结构化结论。',
    input: { value: 1 },
    retries: 0,
  });
  assert.deepEqual(result, { answer: '模型结论' });

  failNext = 6; // 初始 1 次 + 自动重试 5 次全失败，确保 reject 路径被测到且不泄漏到后续测试
  await assert.rejects(
    runSemanticStage({
      scope: 'test',
      refId: 'run-failure',
      stage: 'decide',
      tag: 'semantic-stage-test',
      schema,
      system: '返回结构化结论。',
      input: { value: 2 },
      retries: 0,
    }),
    /forced semantic failure|LLM 请求失败/,
  );

  const rows = db.prepare(
    `SELECT ref_id,status,output,error,duration_ms
     FROM semantic_events WHERE scope='test' ORDER BY id`
  ).all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ref_id, 'run-success');
  assert.equal(rows[0].status, 'succeeded');
  assert.match(rows[0].output, /模型结论/);
  assert.equal(rows[1].ref_id, 'run-failure');
  assert.equal(rows[1].status, 'failed');
  assert.match(rows[1].error, /forced semantic failure|LLM 请求失败/);
  assert.ok(rows.every((row: any) => row.duration_ms >= 0));

  const usage = db.prepare(
    `SELECT tag,prompt_tokens,cache_read_tokens,cache_miss_tokens
     FROM llm_usage ORDER BY id`
  ).get();
  assert.deepEqual(usage, {
    tag: 'semantic-stage-test',
    prompt_tokens: 100,
    cache_read_tokens: 80,
    cache_miss_tokens: 20,
  });
});

test('cache context stays before changing stage input', async () => {
  capturedRequests = [];
  const schema = z.object({ answer: z.string() });
  const sharedContext = {
    roster: '- 共享实体（person）',
    related: '- 共享证据',
  };
  for (const value of [1, 2]) {
    await runSemanticStage({
      scope: 'cache-prefix-test',
      refId: `run-${value}`,
      stage: 'decide',
      tag: 'semantic-cache-prefix-test',
      schema,
      system: '返回结构化结论。',
      cacheContext: sharedContext,
      input: { value },
      retries: 0,
    });
  }

  assert.equal(capturedRequests.length, 2);
  const firstMessages = capturedRequests[0].messages;
  const secondMessages = capturedRequests[1].messages;
  assert.equal(firstMessages.length, 2);
  assert.equal(secondMessages.length, 2);
  assert.equal(firstMessages[0].content, secondMessages[0].content);
  const firstInput = JSON.parse(firstMessages[1].content);
  const secondInput = JSON.parse(secondMessages[1].content);
  assert.deepEqual(firstInput, { sharedContext, input: { value: 1 } });
  assert.deepEqual(secondInput, { sharedContext, input: { value: 2 } });
  const expectedPrefix = `${JSON.stringify({ sharedContext }).slice(0, -1)},"input":`;
  assert.ok(firstMessages[1].content.startsWith(expectedPrefix));
  assert.ok(secondMessages[1].content.startsWith(expectedPrefix));
});

test('validated semantic turns append to provider history and failed turns do not', async () => {
  capturedRequests = [];
  const schema = z.object({ answer: z.string() });
  const history = [{ role: 'system' as const, content: '返回结构化结论。' }];

  await runSemanticStage({
    scope: 'append-only-test',
    refId: 'append-only-run',
    stage: 'decide',
    tag: 'semantic-append-only-test',
    schema,
    system: history[0].content,
    history,
    input: { value: 1 },
    retries: 0,
  });
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((message) => message.role), ['system', 'user', 'assistant']);

  await runSemanticStage({
    scope: 'append-only-test',
    refId: 'append-only-run',
    stage: 'decide',
    tag: 'semantic-append-only-test',
    schema,
    system: history[0].content,
    history,
    input: { value: 2 },
    retries: 0,
  });
  assert.equal(history.length, 5);
  assert.deepEqual(
    capturedRequests[1].messages.slice(0, capturedRequests[0].messages.length),
    capturedRequests[0].messages,
  );
  const usageRows = db.prepare(
    `SELECT ref_id,history_messages,prefix_hash
     FROM llm_usage WHERE tag='semantic-append-only-test' ORDER BY id`
  ).all();
  assert.equal(usageRows.length, 2);
  assert.deepEqual(usageRows.map((row: any) => row.history_messages), [1, 3]);
  assert.ok(usageRows.every((row: any) => row.ref_id === 'append-only-run'));
  assert.ok(usageRows.every((row: any) => /^[a-f0-9]{64}$/.test(row.prefix_hash)));

  const beforeFailure = structuredClone(history);
  failNext = 6; // 初始 1 次 + 自动重试 5 次全失败，确保 reject 路径被测到且不泄漏到后续测试
  await assert.rejects(
    runSemanticStage({
      scope: 'append-only-test',
      refId: 'append-only-run',
      stage: 'decide',
      tag: 'semantic-append-only-test',
      schema,
      system: history[0].content,
      history,
      input: { value: 3 },
      retries: 0,
    }),
    /forced semantic failure|LLM 请求失败/,
  );
  assert.deepEqual(history, beforeFailure);
});

test('cache context primes append-only history once and is not repeated on every turn', async () => {
  capturedRequests = [];
  const schema = z.object({ answer: z.string() });
  const system = '返回结构化结论。';
  const sharedContext = {
    roster: '- 共享实体（person）',
    related: '- 共享证据',
  };
  const history = [{ role: 'system' as const, content: system }];

  for (const value of [1, 2]) {
    await runSemanticStage({
      scope: 'history-cache-context-test',
      refId: 'history-cache-context-run',
      stage: 'decide',
      tag: 'semantic-history-cache-context-test',
      schema,
      system,
      cacheContext: sharedContext,
      history,
      input: { value },
      retries: 0,
    });
  }

  assert.deepEqual(
    JSON.parse(capturedRequests[0].messages[1].content),
    { sharedContext, input: { value: 1 } },
  );
  assert.deepEqual(
    JSON.parse(capturedRequests[1].messages.at(-1).content),
    { input: { value: 2 } },
  );
  assert.deepEqual(
    capturedRequests[1].messages.slice(0, 2),
    capturedRequests[0].messages,
  );
});

test('semantic cache sessions stay caller-owned and task-isolated', async () => {
  capturedRequests = [];
  const schema = z.object({ answer: z.string() });
  const system = '只处理最后一个任务。';
  for (const [run, context] of [['one', '旧名录'], ['two', '新名录']]) {
    const history = createSemanticCacheSession(`shared-context-refresh-test:${run}`, system);
    await runSemanticStage({
      scope: 'shared-context-refresh-test',
      refId: run,
      stage: 'decide',
      tag: 'shared-context-refresh-test',
      schema,
      system,
      cacheContext: { roster: context },
      cacheContextMode: 'always',
      history,
      input: { run },
      retries: 0,
    });
  }

  assert.deepEqual(
    JSON.parse(capturedRequests[0].messages[1].content),
    { sharedContext: { roster: '旧名录' }, input: { run: 'one' } },
  );
  assert.deepEqual(
    JSON.parse(capturedRequests[1].messages.at(-1).content),
    { sharedContext: { roster: '新名录' }, input: { run: 'two' } },
  );
  assert.equal(capturedRequests[0].messages.length, 2);
  assert.equal(capturedRequests[1].messages.length, 2);
});

test('exact semantic results bypass the provider and record saved prompt tokens', async () => {
  capturedRequests = [];
  db.exec(`DELETE FROM semantic_cache; DELETE FROM llm_usage; DELETE FROM semantic_events;`);
  const schema = z.object({ answer: z.string() });
  const options = {
    scope: 'result-cache-test',
    refId: 'same-input',
    stage: 'decide',
    tag: 'semantic-result-cache-test',
    schema,
    system: '返回结构化结论。',
    input: { value: 42 },
    promptVersion: '1',
    resultCache: true,
    retries: 0,
  };

  assert.deepEqual(await runSemanticStage(options), { answer: '模型结论' });
  assert.deepEqual(await runSemanticStage(options), { answer: '模型结论' });

  assert.equal(capturedRequests.length, 1);
  const usage = db.prepare(
    `SELECT result_cache_hit,prompt_tokens,cache_read_tokens,cache_miss_tokens
     FROM llm_usage ORDER BY id`
  ).all();
  assert.equal(usage.length, 2);
  // 结果缓存命中没有真实 provider 往返：prompt_tokens 保留原请求量用于成本统计，
  // 但不再伪造 cache_read_tokens（否则会被 provider_cache_hit_calls 重复计入综合命中率）。
  assert.deepEqual(usage[1], {
    result_cache_hit: 1,
    prompt_tokens: 100,
    cache_read_tokens: 0,
    cache_miss_tokens: 0,
  });
  assert.equal(
    db.prepare(`SELECT status FROM semantic_events ORDER BY id DESC LIMIT 1`).get().status,
    'cached',
  );
});

test('oversized semantic history resets at a batch boundary', async () => {
  capturedRequests = [];
  const schema = z.object({ answer: z.string() });
  const system = '返回结构化结论。';
  const sharedContext = { roster: '- 共享实体（person）' };
  const history = [
    { role: 'system' as const, content: system },
    {
      role: 'user' as const,
      content: JSON.stringify({ sharedContext, input: 'x'.repeat(30_000) }),
    },
    { role: 'assistant' as const, content: 'y'.repeat(20_000) },
  ];

  await runSemanticStage({
    scope: 'history-reset-test',
    stage: 'decide',
    tag: 'semantic-history-reset-test',
    schema,
    system,
    cacheContext: sharedContext,
    history,
    input: { value: 1 },
    // 默认上限已提高到 200k（b3e3c6d），这里用小上限触发同样的批量边界重置
    maxHistoryChars: 40_000,
    retries: 0,
  });

  assert.equal(capturedRequests[0].messages.length, 2);
  assert.deepEqual(
    JSON.parse(capturedRequests[0].messages[1].content),
    { sharedContext, input: { value: 1 } },
  );
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((message) => message.role), ['system', 'user', 'assistant']);
});
