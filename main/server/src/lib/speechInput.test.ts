import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPEECH_MAX_AUDIO_BYTES,
  SpeechUnavailableError,
  buildSpeechCatalog,
  cleanTranscript,
  isWavBuffer,
  speechStatus,
  transcribeWithModel,
  wavDurationSec,
} from './speechInput.js';
import type { SyncedAgentModelConfig } from './agentModelConfig.js';

/**
 * 语音输入的转写口径：
 *  - 引擎顺序：默认 Agent 模型（声明音频）→ 本机离线识别 → 已配置的音频模型 → 可操作提示；
 *  - 模型请求是 OpenAI 兼容 chat/completions + input_audio（base64 data URI + format=wav）+ stream；
 *  - SSE 文本要逐段累积，网关直接回 JSON 也要兜住；
 *  - 模型的包装（代码围栏 / 整段引号 /「转写：」前缀）与无人声哨兵值要清掉；
 *  - 没配 Key 是「去配置」而不是上游故障，错误文案要能直接给用户看。
 */

/** 默认模型只声明文本/图片 + 用户另配了一个音频模型（当前真实场景） */
const textDefault: SyncedAgentModelConfig = {
  version: 1,
  official: {
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', inputModalities: ['text', 'image'] },
    ],
  },
  providers: {
    dashscope: {
      displayName: '阿里云百炼（DashScope）',
      baseURL: 'https://dashscope.example.com/compatible-mode/v1',
      models: [{ id: 'qwen3.8-omni-flash', name: 'qwen3.8-omni-flash', input: ['text', 'audio'] }],
    },
  },
  default: { provider: 'deepseek-official', model: 'deepseek-flash' },
  keys: { DASHSCOPE_API_KEY: 'test-key' },
};

/** 默认模型本身声明音频 */
const audioDefault: SyncedAgentModelConfig = {
  ...textDefault,
  default: { provider: 'dashscope', model: 'qwen3.8-omni-flash' },
};

/** 只有文本模型、没有任何音频模型 */
const noAudio: SyncedAgentModelConfig = {
  ...textDefault,
  providers: {},
  keys: {},
};

/** 造一段 16k 单声道 PCM16 WAV（sec 秒静音），只用于体积/时长校验 */
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

function sseResponse(chunks: string[]): Response {
  const body =
    chunks
      .map((text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
      .join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('WAV 校验：能读时长，非 WAV 直接拒', () => {
  const wav = makeWav(2);
  assert.equal(isWavBuffer(wav), true);
  assert.equal(Math.round(wavDurationSec(wav)), 2);
  assert.equal(isWavBuffer(Buffer.from('not a wav file at all')), false);
  assert.equal(wavDurationSec(Buffer.from('RIFF')), 0);
  assert.ok(SPEECH_MAX_AUDIO_BYTES > 4 * 1024 * 1024);
});

test('音频能力只看声明：默认模型是 text/image 时不算音频模型', () => {
  const catalog = buildSpeechCatalog(textDefault, textDefault.keys);
  assert.equal(catalog.defaultModel?.model, 'deepseek-flash');
  assert.equal(catalog.defaultModel?.supportsAudio, false);
  assert.deepEqual(catalog.defaultModel?.inputs, ['text', 'image']);
  assert.deepEqual(catalog.audioCandidates.map((item) => item.id), ['model:dashscope:qwen3.8-omni-flash']);
  assert.equal(catalog.audioCandidates[0].apiKey, 'test-key');
  assert.equal(catalog.audioCandidates[0].baseUrl, 'https://dashscope.example.com/compatible-mode/v1');
});

test('默认模型声明音频时优先用它', () => {
  const catalog = buildSpeechCatalog(audioDefault, audioDefault.keys);
  assert.equal(catalog.defaultModel?.supportsAudio, true);
  assert.equal(catalog.defaultCandidate?.id, 'model:dashscope:qwen3.8-omni-flash');
});

test('引擎自动选择：默认模型不支持音频时先用本机离线识别', async () => {
  const status = await speechStatus({
    config: textDefault,
    keys: textDefault.keys,
    local: { available: true, detail: 'Windows 语音识别（zh-CN）' },
  });
  assert.equal(status.configured, true);
  assert.equal(status.defaultEngine, 'local');
  assert.match(status.defaultEngineReason, /DeepSeek-V4\.1-Flash/);
  assert.match(status.defaultEngineReason, /只声明了 text \/ image 输入/);
  // 用户配过的音频模型仍然列在菜单里可手动选
  assert.deepEqual(status.engines.map((engine) => engine.id), ['local', 'model:dashscope:qwen3.8-omni-flash']);
  assert.deepEqual(
    status.engines.find((engine) => engine.id === 'model:dashscope:qwen3.8-omni-flash')?.label,
    '阿里云百炼（DashScope） · qwen3.8-omni-flash'
  );
});

test('引擎自动选择：本机没有离线识别时用用户配置的音频模型', async () => {
  const status = await speechStatus({
    config: textDefault,
    keys: textDefault.keys,
    local: { available: false, detail: 'Docker 没有 SAPI' },
  });
  assert.equal(status.defaultEngine, 'model:dashscope:qwen3.8-omni-flash');
  assert.match(status.defaultEngineReason, /本机离线识别不可用/);
  assert.match(status.defaultEngineReason, /阿里云百炼/);
});

test('默认模型声明音频时，即使本机可离线识别也优先默认模型', async () => {
  const status = await speechStatus({
    config: audioDefault,
    keys: audioDefault.keys,
    local: { available: true, detail: 'Windows 语音识别（zh-CN）' },
  });
  assert.equal(status.defaultEngine, 'model:dashscope:qwen3.8-omni-flash');
  assert.match(status.defaultEngineReason, /声明支持音频输入/);
});

test('一个可用引擎都没有：configured=false 并给可操作提示', async () => {
  const status = await speechStatus({
    config: noAudio,
    keys: {},
    local: { available: false, detail: '没有识别器' },
  });
  assert.equal(status.configured, false);
  assert.equal(status.defaultEngine, '');
  assert.match(status.hint, /内置 Agent 控制台/);
  assert.deepEqual(status.engines, []);
});

test('转写请求：chat/completions + input_audio base64 + stream', async () => {
  const candidate = buildSpeechCatalog(textDefault, textDefault.keys).audioCandidates[0];
  const calls: Array<{ url: string; body: any; headers: any }> = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return sseResponse(['今天', '开会', '讨论了语音输入。']);
  }) as unknown as typeof fetch;

  const result = await transcribeWithModel(makeWav(1), candidate, { fetchImpl });
  assert.equal(result.text, '今天开会讨论了语音输入。');
  assert.equal(result.model, 'qwen3.8-omni-flash');
  assert.equal(result.engine, 'model:dashscope:qwen3.8-omni-flash');
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, 'https://dashscope.example.com/compatible-mode/v1/chat/completions');
  assert.equal(call.headers.authorization, 'Bearer test-key');
  assert.equal(call.body.model, 'qwen3.8-omni-flash');
  assert.equal(call.body.stream, true);
  const user = call.body.messages.find((m: any) => m.role === 'user');
  const audioPart = user.content.find((part: any) => part.type === 'input_audio');
  assert.ok(audioPart, '缺少 input_audio 内容块');
  assert.equal(audioPart.input_audio.format, 'wav');
  assert.match(audioPart.input_audio.data, /^data:audio\/wav;base64,/);
  const system = call.body.messages.find((m: any) => m.role === 'system');
  assert.match(system.content, /逐字转成文字/);
});

test('网关忽略 stream 直接回 JSON 也能取到文本', async () => {
  const candidate = buildSpeechCatalog(textDefault, textDefault.keys).audioCandidates[0];
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '直接返回的转写' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  const result = await transcribeWithModel(makeWav(1), candidate, { fetchImpl });
  assert.equal(result.text, '直接返回的转写');
});

test('清理模型包装与无人声哨兵', () => {
  assert.equal(cleanTranscript('"今天天气不错。"'), '今天天气不错。');
  assert.equal(cleanTranscript('“今天天气不错。”'), '今天天气不错。');
  assert.equal(cleanTranscript('转写结果：今天天气不错。'), '今天天气不错。');
  assert.equal(cleanTranscript('```text\n今天天气不错。\n```'), '今天天气不错。');
  assert.equal(cleanTranscript('NO_SPEECH'), '');
  assert.equal(cleanTranscript('no_speech'), '');
  assert.equal(cleanTranscript('（没有检测到人声）'), '');
  assert.equal(cleanTranscript('  \n '), '');
  // 正文里的引号不该被误删
  assert.equal(cleanTranscript('他说“可以”，然后就走了。'), '他说“可以”，然后就走了。');
});

test('无人声哨兵 -> 可读错误（不把哨兵插进正文）', async () => {
  const candidate = buildSpeechCatalog(textDefault, textDefault.keys).audioCandidates[0];
  const fetchImpl = (async () => sseResponse(['NO_SPEECH'])) as unknown as typeof fetch;
  await assert.rejects(() => transcribeWithModel(makeWav(1), candidate, { fetchImpl }), /没有识别到语音/);
});

test('模型没配 Key：抛 SpeechUnavailableError，不发请求', async () => {
  const candidate = { ...buildSpeechCatalog(textDefault, textDefault.keys).audioCandidates[0], apiKey: '' };
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return sseResponse(['不该被调用']);
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => transcribeWithModel(makeWav(1), candidate, { fetchImpl }),
    (error: any) => {
      assert.ok(error instanceof SpeechUnavailableError);
      assert.match(error.message, /API Key/);
      return true;
    }
  );
  assert.equal(called, false, '没配 Key 时不应发请求');
});

test('上游 401：提示去检查 Key，而不是抛原始英文报文', async () => {
  const candidate = buildSpeechCatalog(textDefault, textDefault.keys).audioCandidates[0];
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: { message: 'Invalid API-key provided.' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  await assert.rejects(() => transcribeWithModel(makeWav(1), candidate, { fetchImpl }), /API Key 无效或没有权限/);
});

test('模型不支持音频：给出勾音频 / 换本机识别的提示', async () => {
  const candidate = buildSpeechCatalog(textDefault, textDefault.keys).audioCandidates[0];
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: { message: 'input_audio is not supported by this model' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  await assert.rejects(
    () => transcribeWithModel(makeWav(1), candidate, { fetchImpl }),
    /勾上音频输入.*本机离线识别|本机离线识别/
  );
});
