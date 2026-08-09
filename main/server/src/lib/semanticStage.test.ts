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

before(async () => {
  server = http.createServer(async (_req, res) => {
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
});
