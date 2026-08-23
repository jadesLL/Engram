import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-protocols-'));
process.env.DATA_DIR = temp;

let setSetting: (key: string, value: string) => void;
let db: any;
let migrateLegacyModelConfig: typeof import('./modelConfig.js').migrateLegacyModelConfig;
let saveModelConfig: typeof import('./modelConfig.js').saveModelConfig;
let listModelEntries: typeof import('./modelConfig.js').listModelEntries;
let activeModelId: typeof import('./modelConfig.js').activeModelId;
let revealModelKey: typeof import('./modelConfig.js').revealModelKey;
let maskApiKey: typeof import('./modelConfig.js').maskApiKey;
let convertMessagesForAnthropic: typeof import('./llmProtocols.js').convertMessagesForAnthropic;
let parseAnthropicResponse: typeof import('./llmProtocols.js').parseAnthropicResponse;
let anthropicUrl: typeof import('./llmProtocols.js').anthropicUrl;
let anthropicAdapter: typeof import('./llmProtocols.js').anthropicAdapter;

before(async () => {
  const dbModule = await import('./db.js');
  db = dbModule.db;
  setSetting = dbModule.setSetting;
  dbModule.migrate();
  ({
    migrateLegacyModelConfig,
    saveModelConfig,
    listModelEntries,
    activeModelId,
    revealModelKey,
    maskApiKey,
  } = await import('./modelConfig.js'));
  ({
    convertMessagesForAnthropic,
    parseAnthropicResponse,
    anthropicUrl,
    anthropicAdapter,
  } = await import('./llmProtocols.js'));
});

after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

// ---------- Anthropic 消息转换 ----------

test('system 消息上提为顶层 system 字段', () => {
  const { system, messages } = convertMessagesForAnthropic([
    { role: 'system', content: '你是知识库助手' },
    { role: 'user', content: '你好' },
  ]);
  assert.equal(system, '你是知识库助手');
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { role: 'user', content: '你好' });
});

test('assistant tool_calls 转为 tool_use block，tool 角色转为 tool_result', () => {
  const { messages } = convertMessagesForAnthropic([
    { role: 'user', content: '查一下页面' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'search', arguments: '{"q":"向量"}' } }],
    },
    { role: 'tool', content: '结果内容', tool_call_id: 'tu_1' },
  ]);
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[1], {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu_1', name: 'search', input: { q: '向量' } }],
  });
  assert.deepEqual(messages[2], {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '结果内容' }],
  });
});

test('image_url data URL 转为 base64 image block', () => {
  const dataUrl = 'data:image/png;base64,QUJD';
  const { messages } = convertMessagesForAnthropic([
    { role: 'user', content: [
      { type: 'image_url', image_url: { url: dataUrl } },
      { type: 'text', text: '读数字' },
    ] },
  ]);
  const content = messages[0].content as any[];
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].source.media_type, 'image/png');
  assert.equal(content[0].source.data, 'QUJD');
  assert.equal(content[1].type, 'text');
});

// ---------- Anthropic 响应转换 ----------

test('text/thinking/tool_use blocks 映射为 OpenAI 风格 message', () => {
  const payload = parseAnthropicResponse({
    id: 'msg_1',
    model: 'claude-test',
    stop_reason: 'tool_use',
    content: [
      { type: 'thinking', thinking: '先想一想' },
      { type: 'text', text: '需要调用工具' },
      { type: 'tool_use', id: 'tu_9', name: 'search', input: { q: 'x' } },
    ],
    usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5 },
  }) as any;
  const message = payload.choices[0].message;
  assert.equal(message.content, '需要调用工具');
  assert.equal(message.reasoning_content, '先想一想');
  assert.equal(message.tool_calls[0].function.name, 'search');
  assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), { q: 'x' });
  // 截断判定依赖的 finish_reason 映射：tool_use → tool_calls
  assert.equal(payload.choices[0].finish_reason, 'tool_calls');
  // 用量：OpenAI 别名 + Anthropic 原生字段保留（normalizeLlmUsage 识别 cache_read_input_tokens）
  assert.equal(payload.usage.prompt_tokens, 11);
  assert.equal(payload.usage.completion_tokens, 7);
  assert.equal(payload.usage.cache_read_input_tokens, 5);
});

test('stop_reason=max_tokens 映射 finish_reason=length（截断翻倍重试依赖）', () => {
  const payload = parseAnthropicResponse({
    content: [{ type: 'text', text: '被截断的文' }],
    stop_reason: 'max_tokens',
    usage: { input_tokens: 1, output_tokens: 2 },
  }) as any;
  assert.equal(payload.choices[0].finish_reason, 'length');
});

test('anthropicUrl 兼容带/不带 /v1 的 baseUrl', () => {
  assert.equal(anthropicUrl('https://api.siliconflow.cn/api/anthropic', '/chat/completions'),
    'https://api.siliconflow.cn/api/anthropic/v1/messages');
  assert.equal(anthropicUrl('https://api.deepseek.com/anthropic/', '/chat/completions'),
    'https://api.deepseek.com/anthropic/v1/messages');
  assert.equal(anthropicUrl('https://relay.example/v1', '/chat/completions'),
    'https://relay.example/v1/messages');
});

test('buildBody 丢弃 OpenAI 专属参数（thinking/response_format/stream_options）', () => {
  const body = anthropicAdapter.buildBody({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    temperature: 0.3,
    max_tokens: 512,
    thinking: { type: 'disabled' },
    stream_options: { include_usage: true },
    response_format: { type: 'json_object' },
  });
  assert.equal(body.model, 'm');
  assert.equal(body.max_tokens, 512);
  assert.equal(body.stream, true);
  assert.equal('thinking' in body, false);
  assert.equal('stream_options' in body, false);
  assert.equal('response_format' in body, false);
});

test('流式解析器：text_delta 出文本、message_delta 出用量、message_stop 收尾', () => {
  const parser = anthropicAdapter.createStreamParser();
  assert.deepEqual(parser.feed(JSON.stringify({
    type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' },
  })), { text: '你好' });
  assert.deepEqual(parser.feed(JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 9 } } })), {});
  const tail = parser.feed(JSON.stringify({
    type: 'message_delta', usage: { output_tokens: 4 },
  })) as { usage?: Record<string, number> };
  assert.equal(tail.usage?.prompt_tokens, 9);
  assert.equal(tail.usage?.completion_tokens, 4);
  assert.equal(parser.feed(JSON.stringify({ type: 'message_stop' })).done, true);
});

// ---------- modelConfig：迁移与保存 ----------

test('migrateLegacyModelConfig 迁移旧 settings JSON 并删除旧 key', () => {
  // migrate() 启动时已执行过一次迁移（空库无旧数据为空操作）；此处重新注入旧数据验证
  db.exec('DELETE FROM model_entries;');
  setSetting('chat_models', JSON.stringify([
    { id: 'old-chat', name: '旧对话', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1/', model: 'deepseek-v4-flash', apiKey: 'sk-old' },
  ]));
  setSetting('active_chat_model', 'old-chat');
  const migrated = migrateLegacyModelConfig();
  assert.equal(migrated, 1);
  const chat = listModelEntries('chat');
  assert.equal(chat.length, 1);
  assert.equal(chat[0].id, 'old-chat');
  // trailing slash 归一化 + 默认 openai 协议
  assert.equal(chat[0].baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(chat[0].protocol, undefined);
  assert.equal(revealModelKey('old-chat'), 'sk-old');
  assert.equal(activeModelId('chat'), 'old-chat');
  // 旧 key 已删除
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('chat_models');
  assert.equal(row, undefined);
});

test('saveModelConfig 空 Key 沿用库中原值（前端不持有明文 key 场景）', () => {
  saveModelConfig({
    chat: [{ id: 'keep-key', name: 'n', provider: 'custom', baseUrl: 'https://x.example/v1', model: 'm', apiKey: 'sk-real' }],
    activeChat: 'keep-key',
  });
  saveModelConfig({
    chat: [{ id: 'keep-key', name: 'n2', provider: 'custom', baseUrl: 'https://x.example/v1', model: 'm', apiKey: '' }],
  });
  const chat = listModelEntries('chat');
  assert.equal(chat[0].apiKey, 'sk-real');
  assert.equal(chat[0].name, 'n2');
  // activeId 保留（第二次保存未传时不动）
  assert.equal(activeModelId('chat'), 'keep-key');
});

test('saveModelConfig 掩码 Key 回传不覆盖明文（列表脱敏下发后原样保存场景）', () => {
  saveModelConfig({
    chat: [{ id: 'mask-key', name: 'n', provider: 'custom', baseUrl: 'https://y.example/v1', model: 'm', apiKey: 'sk-plain-value' }],
    activeChat: 'mask-key',
  });
  // 前端拿到掩码 sk-p*******alue 后未重输即保存：服务端必须沿用明文原值
  saveModelConfig({
    chat: [{ id: 'mask-key', name: 'n', provider: 'custom', baseUrl: 'https://y.example/v1', model: 'm', apiKey: 'sk-p*******alue' }],
    activeChat: 'mask-key',
  });
  assert.equal(listModelEntries('chat')[0].apiKey, 'sk-plain-value');
});

test('maskApiKey 掩码规则', () => {
  assert.equal(maskApiKey('sk-1234567890abcdef'), 'sk-1********cdef');
  assert.equal(maskApiKey('abcd'), '****');
  assert.equal(maskApiKey(''), '');
});
