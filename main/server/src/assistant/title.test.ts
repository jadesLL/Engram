import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTitlePrompt,
  generateSessionTitle,
  heuristicTitle,
  normalizeTitle,
  titleRequest,
} from './title.js';

/**
 * 自动命名是「用户看得见但不该出错」的功能：规则标题要稳，模型调用失败必须静默
 * 保留临时标题。这里钉住提示词构造、三种线协议的请求形状与失败路径。
 */

test('规则标题：压成一行、去列表符号与寒暄、按句读截断', () => {
  assert.equal(heuristicTitle('帮我整理同步相关的页面'), '帮我整理同步相关的页面');
  assert.equal(heuristicTitle('  你好，帮我看看索引状态  '), '帮我看看索引状态');
  assert.equal(heuristicTitle('- 列出还没提炼的原始资料'), '列出还没提炼的原始资料');
  assert.equal(heuristicTitle('这个知识库现在有哪些实体页？另外顺便看看死链'), '这个知识库现在有哪些实体页');
  assert.equal(heuristicTitle(''), '新对话');
  assert.equal(heuristicTitle('   '), '新对话');
});

test('规则标题：超长截断到上限并带省略号', () => {
  const title = heuristicTitle('一'.repeat(60));
  assert.equal(title.length, 25);
  assert.ok(title.endsWith('…'));
});

test('模型标题归一化：只取第一行、去引号与前缀、去句末标点', () => {
  assert.equal(normalizeTitle('标题：知识库同步设计\n\n说明'), '知识库同步设计');
  assert.equal(normalizeTitle('“同步冲突处理”'), '同步冲突处理');
  assert.equal(normalizeTitle('**索引重建**。'), '索引重建');
  assert.equal(normalizeTitle('   '), '');
});

test('提示词：带长度约束与对话正文，长文按预算截断', () => {
  const prompt = buildTitlePrompt([
    { role: 'user', content: '同步为什么老是冲突' },
    { role: 'assistant', content: '因为两端都改了同一页' },
  ]);
  assert.match(prompt, /不超过 24 个字/);
  assert.match(prompt, /用户：同步为什么老是冲突/);
  assert.match(prompt, /助手：因为两端都改了同一页/);

  const long = buildTitlePrompt([{ role: 'user', content: 'x'.repeat(5000) }]);
  assert.ok(long.length < 1500);
});

test('没配凭据时不发请求', () => {
  assert.equal(titleRequest({}, 'p'), null);
});

test('官方路由：默认走 api.deepseek.com 的 chat/completions', () => {
  const previous = process.env.DEEPSEEK_BASE_URL;
  delete process.env.DEEPSEEK_BASE_URL;
  try {
    const request = titleRequest({ apiKey: 'sk-1' }, 'p');
    assert.ok(request);
    assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer sk-1');
    assert.equal(request.body.model, 'deepseek-v4-flash');
    // 预算不能压到几十：推理型模型会把 64 全花在 reasoning 上，content 为空（2026-09 实测）
    assert.ok(Number(request.body.max_tokens) >= 256, `max_tokens 应为推理留量，实际 ${request.body.max_tokens}`);
    assert.deepEqual(request.pick({ choices: [{ message: { content: '同步设计' } }] }), '同步设计');
  } finally {
    if (previous !== undefined) process.env.DEEPSEEK_BASE_URL = previous;
  }
});

test('自定义地址：openai-completions / openai-responses / anthropic-messages 各自的端点与取文本', () => {
  const chat = titleRequest({ apiKey: 'k', baseUrl: 'https://gw.example.com/v1/', model: 'gpt-x', api: 'openai-completions' }, 'p');
  assert.ok(chat);
  assert.equal(chat.url, 'https://gw.example.com/v1/chat/completions');
  assert.equal(chat.body.model, 'gpt-x');

  const responses = titleRequest({ apiKey: 'k', baseUrl: 'https://gw.example.com/v1', model: 'gpt-x', api: 'openai-responses' }, 'p');
  assert.ok(responses);
  assert.equal(responses.url, 'https://gw.example.com/v1/responses');
  assert.equal(responses.pick({ output: [{ content: [{ text: '甲' }, { text: '乙' }] }] }), '甲乙');
  assert.equal(responses.pick({ output_text: '丙' }), '丙');

  const anthropic = titleRequest({ apiKey: 'k', baseUrl: 'https://api.anthropic.com', model: 'claude-x', api: 'anthropic-messages' }, 'p');
  assert.ok(anthropic);
  assert.equal(anthropic.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(anthropic.headers['x-api-key'], 'k');
  assert.equal(anthropic.pick({ content: [{ text: '同步冲突' }] }), '同步冲突');

  // baseUrl 已经带 /v1 时不重复拼
  const anthropicV1 = titleRequest({ apiKey: 'k', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-x', api: 'anthropic-messages' }, 'p');
  assert.equal(anthropicV1?.url, 'https://api.anthropic.com/v1/messages');
});

test('模型命名：拿到标题就归一化返回，失败一律返回 null', async () => {
  const history = [{ role: 'user' as const, content: '同步为什么冲突' }];
  const okFetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: '标题：同步冲突排查\n' } }],
  }), { status: 200 })) as unknown as typeof fetch;
  assert.equal(await generateSessionTitle(history, { config: { apiKey: 'k' }, fetchImpl: okFetch }), '同步冲突排查');

  const failFetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
  assert.equal(await generateSessionTitle(history, { config: { apiKey: 'k' }, fetchImpl: failFetch }), null);

  const throwFetch = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  assert.equal(await generateSessionTitle(history, { config: { apiKey: 'k' }, fetchImpl: throwFetch }), null);

  // 没配凭据：连请求都不发
  assert.equal(await generateSessionTitle(history, { config: {}, fetchImpl: okFetch }), null);
  // 空对话不命名
  assert.equal(await generateSessionTitle([{ role: 'user', content: '  ' }], { config: { apiKey: 'k' }, fetchImpl: okFetch }), null);
});
