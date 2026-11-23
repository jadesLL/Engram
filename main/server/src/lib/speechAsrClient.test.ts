import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeWithAsr } from './speechAsrClient.js';
import type { SpeechAsrConfig } from './speechAsr.js';

/**
 * 专用 ASR 的四种接口适配：请求体形态、文本字段解析、错误文案与 Key 不外泄。
 * 全部用注入的 fetch，不联网。
 */

function makeWav(sec: number): Buffer {
  const sampleRate = 16000;
  const samples = Math.round(sec * sampleRate);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function config(overrides: Partial<SpeechAsrConfig>): SpeechAsrConfig {
  return {
    version: 1,
    protocol: 'openai-transcriptions',
    baseUrl: 'https://api.example.com/v1',
    model: 'whisper-1',
    name: '',
    apiKey: 'sk-test-key',
    ...overrides,
  };
}

test('OpenAI 兼容转写：multipart 上传 WAV + model，读 text', async () => {
  const captured: Array<{ url: string; init: any }> = [];
  const fetchImpl = (async (url: string, init: any) => {
    captured.push({ url, init });
    return jsonResponse({ text: '今天开会讨论了语音输入。' });
  }) as unknown as typeof fetch;

  const result = await transcribeWithAsr(makeWav(1), config({ protocol: 'openai-transcriptions' }), { fetchImpl });
  assert.equal(result.text, '今天开会讨论了语音输入。');
  assert.equal(result.engine, 'asr');
  assert.equal(result.engineLabel, '专用语音识别 · whisper-1');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://api.example.com/v1/audio/transcriptions');
  assert.equal(captured[0].init.headers.authorization, 'Bearer sk-test-key');
  const form = captured[0].init.body as FormData;
  assert.equal(form.get('model'), 'whisper-1');
  assert.ok(form.get('file'), '缺少 multipart file 字段');
});

test('OpenAI 兼容转写：兼容少数网关的 results 结构', async () => {
  const fetchImpl = (async () => jsonResponse({ results: [{ text: '逐段' }, { text: '结果' }] })) as unknown as typeof fetch;
  const result = await transcribeWithAsr(makeWav(1), config({}), { fetchImpl });
  assert.equal(result.text, '逐段结果');
});

test('OpenAI 兼容转写：自建服务不填 Key 时不发 Authorization', async () => {
  const headersList: any[] = [];
  const fetchImpl = (async (_url: string, init: any) => {
    headersList.push(init.headers);
    return jsonResponse({ text: '本地 whisper' });
  }) as unknown as typeof fetch;
  const result = await transcribeWithAsr(makeWav(1), config({ apiKey: '' }), { fetchImpl });
  assert.equal(result.text, '本地 whisper');
  assert.equal(headersList[0].authorization, undefined);
});

test('百炼 Qwen-Audio-ASR：input_audio + parameters.format，读 output.text', async () => {
  const captured: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (url: string, init: any) => {
    captured.push({ url, body: JSON.parse(init.body) });
    return jsonResponse({ output: { text: '你好，世界。', sentence: { text: '你好，世界。' } } });
  }) as unknown as typeof fetch;

  const result = await transcribeWithAsr(
    makeWav(1),
    config({
      protocol: 'dashscope-audio',
      baseUrl: 'https://dashscope.aliyuncs.com',
      model: 'qwen-audio-3.1-asr-flash',
    }),
    { fetchImpl }
  );
  assert.equal(result.text, '你好，世界。');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(captured[0].body.model, 'qwen-audio-3.1-asr-flash');
  const part = captured[0].body.input.messages[0].content[0];
  assert.equal(part.type, 'input_audio');
  assert.match(part.input_audio.data, /^data:audio\/wav;base64,/);
  assert.equal(captured[0].body.parameters.format, 'wav');
  assert.equal(captured[0].body.parameters.sample_rate, '16000');
});

test('百炼 Qwen3-ASR：content.audio + 读 output.choices', async () => {
  const bodies: any[] = [];
  const fetchImpl = (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return jsonResponse({
      output: { choices: [{ message: { role: 'assistant', content: [{ text: '千问转写' }] } }] },
    });
  }) as unknown as typeof fetch;

  const result = await transcribeWithAsr(
    makeWav(1),
    config({ protocol: 'dashscope-qwen3', baseUrl: 'https://dashscope.aliyuncs.com', model: 'qwen3-asr-flash' }),
    { fetchImpl }
  );
  assert.equal(result.text, '千问转写');
  const part = bodies[0].input.messages[0].content[0];
  assert.equal(part.audio.startsWith('data:audio/wav;base64,'), true);
  assert.equal(part.type, undefined, 'Qwen3 原生接口用 audio 字段，不是 input_audio');
});

test('OpenAI 兼容对话：stream=false + input_audio，读 choices[0].message.content', async () => {
  const bodies: any[] = [];
  const fetchImpl = (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return jsonResponse({ choices: [{ message: { content: '聊天接口转写' } }] });
  }) as unknown as typeof fetch;

  const result = await transcribeWithAsr(
    makeWav(1),
    config({
      protocol: 'openai-chat-audio',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3-asr-flash',
    }),
    { fetchImpl }
  );
  assert.equal(result.text, '聊天接口转写');
  assert.equal(bodies[0].stream, false);
  assert.equal(bodies[0].model, 'qwen3-asr-flash');
  const user = bodies[0].messages.find((item: any) => item.role === 'user');
  assert.equal(user.content[0].type, 'input_audio');
  assert.equal(user.content[0].input_audio.format, 'wav');
});

test('完整接口地址不重复拼路径', async () => {
  const urls: string[] = [];
  const fetchImpl = (async (next: string) => {
    urls.push(next);
    return jsonResponse({ text: 'ok' });
  }) as unknown as typeof fetch;
  await transcribeWithAsr(
    makeWav(1),
    config({ baseUrl: 'https://gw.example/custom/audio/transcriptions' }),
    { fetchImpl }
  );
  assert.equal(urls[0], 'https://gw.example/custom/audio/transcriptions');
});

test('401：提示去设置页检查 Key，上游报文里的 Key 片段也会被抹掉', async () => {
  const fetchImpl = (async () =>
    jsonResponse({ error: { message: 'Incorrect API key provided: sk-never-leak. Check your key.' } }, 401)) as unknown as typeof fetch;
  await assert.rejects(
    () => transcribeWithAsr(makeWav(1), config({ apiKey: 'sk-never-leak' }), { fetchImpl }),
    (error: any) => {
      assert.match(error.message, /API Key 无效或没有权限/);
      assert.match(error.message, /设置 → 外设接入 → 语音输入/);
      assert.equal(error.message.includes('sk-never-leak'), false);
      return true;
    }
  );
});

test('空文本 / 无人声哨兵：返回可读错误，不把哨兵插入正文', async () => {
  const empty = (async () => jsonResponse({ text: '   ' })) as unknown as typeof fetch;
  await assert.rejects(() => transcribeWithAsr(makeWav(1), config({}), { fetchImpl: empty }), /没有识别到语音/);

  const sentinel = (async () => jsonResponse({ text: 'NO_SPEECH' })) as unknown as typeof fetch;
  await assert.rejects(() => transcribeWithAsr(makeWav(1), config({}), { fetchImpl: sentinel }), /没有识别到语音/);
});

test('连不上服务：给出网络提示，不抛原始英文', async () => {
  const fetchImpl = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => transcribeWithAsr(makeWav(1), config({}), { fetchImpl }),
    /连不上专用语音识别服务/
  );
});

test('去掉模型常见的包装（引号 / 代码围栏 /「转写：」前缀）', async () => {
  const fetchImpl = (async () => jsonResponse({ text: '“转写结果：今天天气不错。”' })) as unknown as typeof fetch;
  const result = await transcribeWithAsr(makeWav(1), config({}), { fetchImpl });
  assert.equal(result.text, '今天天气不错。');
});
