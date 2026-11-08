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
let normalizeStoredVideoConfig: typeof import('./videoConfig.js').normalizeStoredVideoConfig;
let videoModelConfig: typeof import('./videoConfig.js').videoModelConfig;
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

function settingValue(key: string): string {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any)?.value ?? '';
}

/** 模拟「另一台设备同步过来的模型配置」（偏好 + meta） */
function writeSyncedModelConfig(nodeId: string): void {
  setSetting('agent_model_config', JSON.stringify({
    version: 1,
    official: {},
    providers: {
      dashscope: {
        displayName: '远端 DashScope',
        api: 'openai-completions',
        baseURL: 'https://dashscope.example/v1',
        apiKeyEnv: 'DASHSCOPE_API_KEY',
        models: [{ id: 'qwen3.8-omni-flash' }],
      },
    },
    default: { provider: '', model: '' },
    keys: { DASHSCOPE_API_KEY: 'sk-synced-dashscope' },
  }));
  setSetting('sync_preference:agent_model_config', JSON.stringify({ updatedAt: Date.now(), nodeId }));
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
    normalizeStoredVideoConfig,
    videoModelConfig,
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
  assert.equal(status.keySource, 'local', '本机控制台已配置 Key 时来源是 local');
  assert.equal(videoConfigReady(), true);
  assert.equal(videoConfigHint(), '');
});

test('normalizeStoredVideoConfig：旧 JSON 里的 baseUrl / apiKey / model 被清掉，只留 enabled', () => {
  setSetting('video_config', JSON.stringify({ enabled: true, baseUrl: 'https://old.example/v1', apiKey: 'sk-old', model: 'old' }));
  assert.equal(normalizeStoredVideoConfig(), true);
  assert.equal(settingValue('video_config'), '{"enabled":true}');
  assert.equal(normalizeStoredVideoConfig(), false, '已归一化后不再改写（避免每次读取都 stamp）');
  assert.equal(settingValue('video_config').includes('sk-old'), false);
});

test('keySource：本机缺 Key 但同步配置里有同款 Key → synced，并给出 keyFromNode', () => {
  writeSyncedModelConfig('peer-device');
  // 本机 provider 还在但凭据删掉：用同步下来的同名 Key 兜底
  fs.rmSync(path.join(dshHome, '.credentials.yaml'), { force: true });
  const status = videoConfigStatus();
  assert.equal(status.hasKey, true);
  assert.equal(status.keySource, 'synced');
  assert.equal(status.keyFromNode, 'peer-device');
  assert.equal(status.configured, true);
  assert.equal(JSON.stringify(status).includes('sk-synced-dashscope'), false, '状态摘要绝不能带出 Key');
  // 视频模型解析同样用上了同步的 Key（管线不需要等 dsh 重读配置）
  assert.equal(videoModelConfig().provider.apiKey, 'sk-synced-dashscope');
  assert.equal(videoModelConfig().keySource, 'synced');
});

test('keySource：本机完全没有提供商时用同步的 provider + Key；都没有时 none', () => {
  writeSyncedModelConfig('peer-device');
  fs.rmSync(path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), { force: true });
  fs.rmSync(path.join(dshHome, '.credentials.yaml'), { force: true });
  const status = videoConfigStatus();
  assert.equal(status.provider, 'dashscope');
  assert.equal(status.providerName, '远端 DashScope');
  assert.equal(status.model, 'qwen3.8-omni-flash');
  assert.equal(status.baseUrl, 'https://dashscope.example/v1');
  assert.equal(status.keySource, 'synced');
  assert.equal(status.configured, true);

  // 同步配置也清掉：回到未配置
  setSetting('agent_model_config', '');
  setSetting('sync_preference:agent_model_config', '');
  const empty = videoConfigStatus();
  assert.equal(empty.hasKey, false);
  assert.equal(empty.keySource, 'none');
  assert.equal(empty.configured, false);
  assert.deepEqual(empty.missing, ['视频模型提供商']);
});
