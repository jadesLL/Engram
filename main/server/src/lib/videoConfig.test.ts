import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 视频理解配置：只剩「总开关」（enabled），模型/Key 来自 dsh 的模型配置。
 *
 * 锁住：
 *  1) 默认开启（「内置 Agent 与视频理解都默认上」，用户只需去控制台填 Key）；
 *  2) 旧客户端的 baseUrl/apiKey/model/quality 等字段被忽略，不再写进 Engram 设置、也不回显；
 *  3) 状态摘要能读到 dsh 里的 DashScope + qwen3.8-omni-flash，只给 hasKey 不回显 Key；
 *  4) 缺提供商 / 缺 Key 时缺项与提示准确。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-video-config-'));
process.env.DATA_DIR = temp;

let getVideoConfig: typeof import('./videoConfig.js').getVideoConfig;
let setVideoConfig: typeof import('./videoConfig.js').setVideoConfig;
let videoConfigReady: typeof import('./videoConfig.js').videoConfigReady;
let videoConfigHint: typeof import('./videoConfig.js').videoConfigHint;
let videoConfigStatus: typeof import('./videoConfig.js').videoConfigStatus;
let videoConfigForClient: typeof import('./videoConfig.js').videoConfigForClient;
let parseVideoConfigInput: typeof import('./videoConfig.js').parseVideoConfigInput;
let applyVideoConfigInput: typeof import('./videoConfig.js').applyVideoConfigInput;
let setSetting: typeof import('./db.js').setSetting;
let db: any;

const dshHome = path.join(temp, 'dsh');

function writeVideoProvider(withKey: boolean): void {
  const patch = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
  fs.mkdirSync(path.dirname(patch), { recursive: true });
  fs.writeFileSync(patch, [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      dashscope:',
    '        displayName: 阿里云百炼（DashScope）',
    '        apiKeyEnv: DASHSCOPE_API_KEY',
    '        api: openai-completions',
    '        baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1',
    '        models:',
    '        - id: qwen3.8-omni-flash',
  ].join('\n'), 'utf8');
  const credentials = path.join(dshHome, '.credentials.yaml');
  if (withKey) fs.writeFileSync(credentials, ['refs:', '  {', "    DASHSCOPE_API_KEY: 'sk-dashscope-real',", '  }'].join('\n'), 'utf8');
  else fs.rmSync(credentials, { force: true });
}

before(async () => {
  const dbModule = await import('./db.js');
  db = dbModule.db;
  setSetting = dbModule.setSetting;
  dbModule.migrate();
  ({
    getVideoConfig,
    setVideoConfig,
    videoConfigReady,
    videoConfigHint,
    videoConfigStatus,
    videoConfigForClient,
    parseVideoConfigInput,
    applyVideoConfigInput,
  } = await import('./videoConfig.js'));
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('默认：开启（内置 Agent 与视频理解默认上），但 dsh 里没有提供商时未就绪并提示去配置', () => {
  const config = getVideoConfig();
  assert.deepEqual(config, { enabled: true }, '默认应该是开启');
  assert.equal(videoConfigReady(config), false);
  assert.match(videoConfigHint(config), /视频理解模型还没有初始化/);
  assert.match(videoConfigHint(config), /内置 Agent 控制台/);
});

test('关闭后提示「未启用」，不再提模型配置', () => {
  setVideoConfig({ enabled: false });
  assert.equal(videoConfigReady(), false);
  assert.match(videoConfigHint(), /视频理解未启用/);
});

test('旧客户端字段（baseUrl/apiKey/model/quality/maxTokens/douyinBrowser）一律忽略，只存 enabled', () => {
  const patch = parseVideoConfigInput({
    enabled: true,
    baseUrl: 'https://gw.example/v1',
    apiKey: 'sk-old-secret',
    model: 'omni-2',
    quality: 32,
    maxTokens: 8192,
    douyinBrowser: true,
  });
  assert.deepEqual(patch, { enabled: true });
  const applied = applyVideoConfigInput(patch);
  assert.equal(applied.next.enabled, true);
  assert.deepEqual(getVideoConfig(), { enabled: true });
  // 旧字段没被写进设置，也就不可能被回显
  assert.equal(videoConfigForClient().includes('sk-old-secret'), false);
});

test('parse：接受 JSON 字符串；enabled 缺省时保持不变', () => {
  assert.deepEqual(parseVideoConfigInput('{"enabled":false,"apiKey":"sk-x"}'), { enabled: false });
  assert.deepEqual(parseVideoConfigInput('not-json'), {});
  assert.deepEqual(parseVideoConfigInput({ apiKey: 'sk-x' }), {});
});

test('videoConfigForClient：只回 enabled，旧 JSON 里的 Key 不会漏出去', () => {
  setSetting('video_config', JSON.stringify({ enabled: true, apiKey: 'sk-legacy-secret', model: 'omni-old' }));
  const json = videoConfigForClient();
  assert.equal(json, '{"enabled":true}');
  assert.equal(json.includes('sk-legacy-secret'), false);
  assert.equal(json.includes('omni-old'), false);
});

test('dsh 里有提供商但没 Key：缺 API Key，提示去控制台填', () => {
  writeVideoProvider(false);
  const status = videoConfigStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.configured, false);
  assert.deepEqual(status.missing, ['API Key']);
  assert.equal(status.hasKey, false);
  assert.equal(status.model, 'qwen3.8-omni-flash');
  assert.match(videoConfigHint(), /API Key/);
  assert.match(videoConfigHint(), /DashScope API Key/);
});

test('dsh 里提供商 + Key 齐全：configured=true，状态带模型/提供商但不回显 Key', () => {
  writeVideoProvider(true);
  const status = videoConfigStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.configured, true);
  assert.deepEqual(status.missing, []);
  assert.equal(status.provider, 'dashscope');
  assert.equal(status.providerName, '阿里云百炼（DashScope）');
  assert.equal(status.model, 'qwen3.8-omni-flash');
  assert.equal(status.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(status.hasKey, true);
  assert.equal(JSON.stringify(status).includes('sk-dashscope-real'), false, '状态摘要绝不能带出 Key');
  assert.equal(videoConfigReady(), true);
  assert.equal(videoConfigHint(), '');
});
