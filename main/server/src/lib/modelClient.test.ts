import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 服务端直连模型的线协议与失败语义：
 * - 三种 route 的 URL/请求体/响应取值；
 * - 「输出被上限截断」与「上游没给内容」必须区分开（收集箱转换要据此缩小输入重试）；
 * - 自定义网关拒绝过大 max_tokens 时退到保守预算。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-model-client-'));
process.env.DATA_DIR = temp;

let modelRequest: typeof import('./modelClient.js').modelRequest;
let completeText: typeof import('./modelClient.js').completeText;
let ModelUnavailableError: typeof import('./modelClient.js').ModelUnavailableError;
let ModelOutputTruncatedError: typeof import('./modelClient.js').ModelOutputTruncatedError;
let ModelEmptyResponseError: typeof import('./modelClient.js').ModelEmptyResponseError;
let db: any;

before(async () => {
  db = (await import('./db.js')).db;
  (await import('./db.js')).migrate();
  ({
    modelRequest, completeText, ModelUnavailableError, ModelOutputTruncatedError, ModelEmptyResponseError,
  } = await import('./modelClient.js'));
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

const messages = [
  { role: 'system' as const, content: '系统提示' },
  { role: 'user' as const, content: '用户正文' },
];

/** 造一个返回固定 JSON（或错误）的 fetch，并记录请求体 */
function fakeFetch(replies: Array<{ status?: number; body: any }>) {
  const calls: any[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    const status = reply.status ?? 200;
    const raw = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => raw,
    };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test('官方路由：chat/completions + 默认模型，max_tokens 透传', () => {
  const request = modelRequest({ apiKey: 'k' } as any, messages, { maxTokens: 32768 });
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.headers.authorization, 'Bearer k');
  assert.equal((request.body as any).model, 'deepseek-v4-flash');
  assert.equal((request.body as any).max_tokens, 32768);
  assert.deepEqual((request.body as any).messages, messages);
});

test('自定义路由：三种线协议各自的 URL / 请求体 / 响应取值', () => {
  const openai = modelRequest(
    { apiKey: 'k', baseUrl: 'https://gw.example/v1', model: 'm1', api: 'openai-completions' } as any,
    messages,
    { maxTokens: 1024 },
  );
  assert.equal(openai.url, 'https://gw.example/v1/chat/completions');
  assert.equal((openai.body as any).max_tokens, 1024);
  assert.equal((openai.body as any).messages[0].role, 'system');
  assert.equal(openai.pick({ choices: [{ message: { content: 'ok' } }] }), 'ok');

  const anthropic = modelRequest(
    { apiKey: 'k', baseUrl: 'https://gw.example/v1', model: 'm2', api: 'anthropic-messages' } as any,
    messages,
  );
  assert.equal(anthropic.url, 'https://gw.example/v1/messages');
  assert.equal(anthropic.headers['x-api-key'], 'k');
  assert.equal((anthropic.body as any).system, '系统提示');
  assert.equal(anthropic.pick({ content: [{ type: 'text', text: 'ok' }] }), 'ok');

  const responses = modelRequest(
    { apiKey: 'k', baseUrl: 'https://gw.example', model: 'm3', api: 'openai-responses' } as any,
    messages,
  );
  assert.equal(responses.url, 'https://gw.example/responses');
  assert.equal((responses.body as any).instructions, '系统提示');
  assert.equal((responses.body as any).input, '用户正文');
  assert.equal(responses.pick({ output_text: 'ok' }), 'ok');
});

test('没配凭据：抛 ModelUnavailableError，给出设置路径', () => {
  assert.throws(() => modelRequest({ apiKey: '' } as any, messages), ModelUnavailableError);
  assert.throws(() => modelRequest({ apiKey: '' } as any, messages), /设置 → Agent 接入/);
});

test('正常返回：trim 后返回正文与模型名', async () => {
  const { fetchImpl } = fakeFetch([{ body: { choices: [{ message: { content: '  结果  ' }, finish_reason: 'stop' }], usage: { completion_tokens: 10 } } }]);
  const result = await completeText(messages, { fetchImpl, config: { apiKey: 'k' } as any, maxTokens: 1024 });
  assert.equal(result.text, '结果');
  assert.equal(result.model, 'deepseek-v4-flash');
});

test('推理吃满预算：content 为空 + finish_reason=length → 截断错误（带用量诊断）', async () => {
  const { fetchImpl } = fakeFetch([{
    body: {
      choices: [{ message: { content: '', reasoning_content: '很长的推理' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 15925, completion_tokens: 8193, completion_tokens_details: { reasoning_tokens: 8193 } },
    },
  }]);
  await assert.rejects(
    () => completeText(messages, { fetchImpl, config: { apiKey: 'k' } as any, maxTokens: 8192 }),
    (error: any) => {
      assert.equal(error instanceof ModelOutputTruncatedError, true);
      assert.match(error.message, /正文为空/);
      assert.match(error.message, /reasoning 8193|推理 8193/);
      assert.match(error.message, /finish_reason=length/);
      return true;
    },
  );
});

test('有内容但被截断：同样抛截断错误（不能把半截正文当成功）', async () => {
  const { fetchImpl } = fakeFetch([{
    body: { choices: [{ message: { content: '# 半截正文' }, finish_reason: 'length' }] },
  }]);
  await assert.rejects(
    () => completeText(messages, { fetchImpl, config: { apiKey: 'k' } as any }),
    (error: any) => error instanceof ModelOutputTruncatedError && /正文被截断/.test(error.message),
  );
});

test('空内容但不是截断：抛 ModelEmptyResponseError，不误报成截断', async () => {
  const { fetchImpl } = fakeFetch([{
    body: { choices: [{ message: { content: '   ' }, finish_reason: 'stop' }] },
  }]);
  await assert.rejects(
    () => completeText(messages, { fetchImpl, config: { apiKey: 'k' } as any }),
    (error: any) => error instanceof ModelEmptyResponseError
      && /模型没有返回内容/.test(error.message)
      && /finish_reason=stop/.test(error.message),
  );
});

test('anthropic / responses 的截断字段也能识别', async () => {
  const anthropic = fakeFetch([{
    body: { stop_reason: 'max_tokens', content: [], usage: { output_tokens: 8192 } },
  }]);
  await assert.rejects(
    () => completeText(messages, {
      fetchImpl: anthropic.fetchImpl,
      config: { apiKey: 'k', baseUrl: 'https://gw.example', model: 'm', api: 'anthropic-messages' } as any,
    }),
    (error: any) => error instanceof ModelOutputTruncatedError && /stop_reason=max_tokens/.test(error.message),
  );

  const responses = fakeFetch([{
    body: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] },
  }]);
  await assert.rejects(
    () => completeText(messages, {
      fetchImpl: responses.fetchImpl,
      config: { apiKey: 'k', baseUrl: 'https://gw.example', model: 'm', api: 'openai-responses' } as any,
    }),
    (error: any) => error instanceof ModelOutputTruncatedError && /status=incomplete/.test(error.message),
  );
});

test('网关拒绝过大 max_tokens：自动退到 8192 再试一次', async () => {
  const { fetchImpl, calls } = fakeFetch([
    { status: 400, body: { error: { message: 'max_tokens is too large' } } },
    { body: { choices: [{ message: { content: '退档成功' }, finish_reason: 'stop' }] } },
  ]);
  const result = await completeText(messages, {
    fetchImpl,
    config: { apiKey: 'k', baseUrl: 'https://gw.example', model: 'm', api: 'openai-completions' } as any,
    maxTokens: 32768,
  });
  assert.equal(result.text, '退档成功');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.max_tokens, 32768);
  assert.equal(calls[1].body.max_tokens, 8192);
});

test('普通 400 不因 token 关键词之外的原因重试', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 400, body: { error: { message: 'model not found' } } }]);
  await assert.rejects(
    () => completeText(messages, { fetchImpl, config: { apiKey: 'k' } as any, maxTokens: 32768 }),
    /模型请求失败（400）/,
  );
  assert.equal(calls.length, 1);
});
