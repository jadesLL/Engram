import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 专用 ASR 配置：四种接口形态的地址解析、保存 / 读取 / 清空、Key 绝不回显。
 *
 * 用临时 DATA_DIR 跑真实的 settings 表（与 videoConfig.test.ts 同一套做法），
 * 不碰用户数据；每个用例自己先清空配置，避免顺序依赖。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-speech-asr-'));
process.env.DATA_DIR = temp;

let mod: typeof import('./speechAsr.js');
let db: any;
let setSetting: (key: string, value: string) => void;

before(async () => {
  const dbModule = await import('./db.js');
  db = dbModule.db;
  setSetting = dbModule.setSetting;
  dbModule.migrate();
  mod = await import('./speechAsr.js');
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('接口地址：Base URL 与完整接口地址都认，不重复拼路径', () => {
  const { asrEndpoint } = mod;
  assert.equal(
    asrEndpoint('openai-transcriptions', 'https://api.openai.com/v1'),
    'https://api.openai.com/v1/audio/transcriptions'
  );
  assert.equal(
    asrEndpoint('openai-transcriptions', 'https://api.openai.com/v1/audio/transcriptions'),
    'https://api.openai.com/v1/audio/transcriptions'
  );
  assert.equal(
    asrEndpoint('openai-chat-audio', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
  );
  assert.equal(
    asrEndpoint('openai-chat-audio', 'https://gw.example/chat/completions'),
    'https://gw.example/chat/completions'
  );
  for (const protocol of ['dashscope-audio', 'dashscope-qwen3'] as const) {
    assert.equal(
      asrEndpoint(protocol, 'https://dashscope.aliyuncs.com'),
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
    );
    assert.equal(
      asrEndpoint(protocol, 'https://ws.cn-beijing.maas.aliyuncs.com/api/v1'),
      'https://ws.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
    );
    assert.equal(
      asrEndpoint(protocol, 'https://ws.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'),
      'https://ws.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
    );
  }
});

test('保存 / 读取 / 部分更新：省略 Key 保留原值，clearKey 才清空', () => {
  mod.clearSpeechAsrConfig();
  assert.equal(mod.getSpeechAsrConfig(), null);

  const first = mod.saveSpeechAsrConfig({
    protocol: 'dashscope-audio',
    baseUrl: 'https://dashscope.aliyuncs.com/',
    model: 'qwen-audio-3.1-asr-flash',
    name: '百炼 ASR',
    apiKey: 'sk-secret-asr',
  });
  assert.equal(first.ok, true);
  assert.equal(first.config?.baseUrl, 'https://dashscope.aliyuncs.com', '保存时去掉末尾斜杠');
  assert.equal(first.config?.apiKey, 'sk-secret-asr');

  // 修改显示名但不传 apiKey：沿用原 Key（面板不回显，不能把 Key 顶掉）
  const second = mod.saveSpeechAsrConfig({
    protocol: 'dashscope-audio',
    baseUrl: 'https://dashscope.aliyuncs.com',
    model: 'qwen-audio-3.1-asr-flash',
    name: '新的名字',
  });
  assert.equal(second.ok, true);
  assert.equal(second.config?.name, '新的名字');
  assert.equal(second.config?.apiKey, 'sk-secret-asr');

  const cleared = mod.saveSpeechAsrConfig({
    protocol: 'dashscope-audio',
    baseUrl: 'https://dashscope.aliyuncs.com',
    model: 'qwen-audio-3.1-asr-flash',
    name: '新的名字',
    clearKey: true,
  });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.config?.apiKey, '');

  const same = mod.saveSpeechAsrConfig({
    protocol: 'dashscope-audio',
    baseUrl: 'https://dashscope.aliyuncs.com',
    model: 'qwen-audio-3.1-asr-flash',
    name: '新的名字',
  });
  assert.equal(same.changed, false, '内容没变不算改动（不重复入同步队列）');

  assert.equal(mod.clearSpeechAsrConfig(), true);
  assert.equal(mod.getSpeechAsrConfig(), null);
  assert.equal(mod.clearSpeechAsrConfig(), false);
});

test('保存校验：地址 / 模型 / 接口类型不对时给可读错误且不写入', () => {
  mod.clearSpeechAsrConfig();
  assert.match(mod.saveSpeechAsrConfig({ protocol: 'nope', baseUrl: 'https://x.example', model: 'm' }).error || '', /接口类型/);
  assert.match(mod.saveSpeechAsrConfig({ protocol: 'dashscope-audio', baseUrl: '', model: 'm' }).error || '', /接口地址/);
  assert.match(mod.saveSpeechAsrConfig({ protocol: 'dashscope-audio', baseUrl: 'ftp://x.example', model: 'm' }).error || '', /http/);
  assert.match(mod.saveSpeechAsrConfig({ protocol: 'dashscope-audio', baseUrl: 'https://x.example', model: '' }).error || '', /模型名/);
  assert.match(
    mod.saveSpeechAsrConfig({ protocol: 'dashscope-audio', baseUrl: 'https://x.example', model: 'm', name: 'x'.repeat(61) }).error || '',
    /显示名称/
  );
  assert.equal(mod.getSpeechAsrConfig(), null, '校验失败不能留下半份配置');
});

test('脱敏结构：只有 hasKey，任何字段都不带 Key 原文', () => {
  mod.clearSpeechAsrConfig();
  mod.saveSpeechAsrConfig({
    protocol: 'openai-transcriptions',
    baseUrl: 'https://api.openai.com/v1',
    model: 'whisper-1',
    apiKey: 'sk-never-leak-me',
  });
  const config = mod.getSpeechAsrConfig();
  const pub = mod.speechAsrPublic(config);
  assert.equal(pub.configured, true);
  assert.equal(pub.hasKey, true);
  assert.equal(pub.protocol, 'openai-transcriptions');
  assert.equal(pub.endpoint, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal((pub as any).apiKey, undefined);
  assert.equal(JSON.stringify(pub).includes('sk-never-leak-me'), false);
});

test('坏 JSON / 缺字段的存量配置按「未配置」处理，不抛', () => {
  setSetting('speech_asr_config', '{bad json');
  assert.equal(mod.getSpeechAsrConfig(), null);
  setSetting('speech_asr_config', JSON.stringify({ protocol: 'dashscope-audio', baseUrl: 'https://x.example' }));
  assert.equal(mod.getSpeechAsrConfig(), null);
  setSetting('speech_asr_config', JSON.stringify({ protocol: 'unknown', baseUrl: 'https://x.example', model: 'm' }));
  assert.equal(mod.getSpeechAsrConfig(), null);
});
