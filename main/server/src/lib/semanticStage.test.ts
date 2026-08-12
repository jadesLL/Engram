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
let failNext = false;
let db: any;
let runSemanticStage: any;
let capturedRequests: any[] = [];

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    capturedRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (failNext) {
      failNext = false;
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
  ({ runSemanticStage } = await import('./semanticStage.js'));
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

  failNext = true;
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
  failNext = true;
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

test('oversized semantic history resets at a batch boundary', async () => {
  capturedRequests = [];
  const schema = z.object({ answer: z.string() });
  const system = '返回结构化结论。';
  const history = [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: 'x'.repeat(30_000) },
    { role: 'assistant' as const, content: 'y'.repeat(20_000) },
  ];

  await runSemanticStage({
    scope: 'history-reset-test',
    stage: 'decide',
    tag: 'semantic-history-reset-test',
    schema,
    system,
    history,
    input: { value: 1 },
    retries: 0,
  });

  assert.equal(capturedRequests[0].messages.length, 2);
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((message) => message.role), ['system', 'user', 'assistant']);
});
