import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_MODEL_CONFIG_KEY,
  agentModelConfigDigest,
  applyAgentModelConfigToCredentials,
  applyAgentModelConfigToPatch,
  hasAgentModelConfig,
  mergeAgentModelConfig,
  normalizeAgentModelConfig,
  parseAgentModelConfig,
  readAgentModelConfig,
  stableStringify,
  writeAgentModelConfig,
  type SyncedAgentModelConfig,
} from './agentModelConfig.js';

/**
 * 内置 Agent 模型配置的读取 / 合并 / 写回。
 *
 * 锁住四件事：
 *  1) 只读解析能认出 dsh 设置页写入的 llm-pi-ai / llm-deepseek / agent-default-model +
 *     .credentials.yaml 的 refs（flow 与块状两种写法），并且只取被引用到的 Key；
 *  2) 合并是并集：本机独有保留、同 id 同 ref 远端胜、official/default 远端有值才覆盖；
 *  3) 写回是文本级保守编辑：其它顶层条目、注释、records 段逐字保留，写前留 .engram-bak；
 *  4) digest 稳定（对象 key 顺序不影响），坏输入不抛。
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-agent-model-config-'));

function patchPath(target = home): string {
  return path.join(target, 'profiles', 'web', 'cordis.patch.yml');
}

function credentialsPath(target = home): string {
  return path.join(target, '.credentials.yaml');
}

const PATCH = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries.',
  '',
  '- id: ui-settings-general',
  '  config:',
  '    welcomeNoticeVersion: 3',
  '',
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      local-only:',
  '        displayName: 本机独有提供商',
  '        apiKeyEnv: LOCAL_ONLY_API_KEY',
  '        api: openai-completions',
  '        baseURL: https://local.example/v1',
  '        models:',
  '        - id: local-model',
  '          name: 本机模型',
  '      dashscope:',
  '        displayName: 阿里云百炼（DashScope）',
  '        apiKeyEnv: DASHSCOPE_API_KEY',
  '        api: openai-completions',
  '        baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1',
  '        models:',
  '        - id: qwen3.8-omni-flash',
  '          name: qwen3.8-omni-flash',
  '          input:',
  '          - text',
  '          - image',
  '',
  '- id: llm-deepseek',
  '  config:',
  '    apiKeyEnv: DEEPSEEK_API_KEY',
  '    baseURL: https://api.deepseek.com',
  '    maxTokens: 8192',
  '    models:',
  '    - id: deepseek-chat',
  '      name: DeepSeek Chat',
  '      contextWindow: 128000',
  '      inputModalities:',
  '      - text',
  '      - image',
  '',
  '- id: agent-default-model',
  '  config:',
  '    provider: deepseek-official',
  '    model: deepseek-chat',
].join('\n') + '\n';

const CREDENTIALS = [
  'version: 1',
  'records:',
  '  some/record:',
  '    kind: oauth',
  'refs:',
  '  {',
  "    DASHSCOPE_API_KEY: 'sk-dashscope-local',",
  "    DEEPSEEK_API_KEY: 'sk-deepseek-local',",
  "    UNRELATED_API_KEY: 'sk-unrelated',",
  '  }',
].join('\n') + '\n';

function seedHome(target = home, patch = PATCH, credentials = CREDENTIALS): void {
  fs.mkdirSync(path.dirname(patchPath(target)), { recursive: true });
  fs.writeFileSync(patchPath(target), patch, 'utf8');
  fs.writeFileSync(credentialsPath(target), credentials, 'utf8');
}

function remoteConfig(): SyncedAgentModelConfig {
  const config = normalizeAgentModelConfig({
    version: 1,
    official: {
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      baseURL: '',
      maxTokens: 16384,
      models: [{ id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', contextWindow: 64000, inputModalities: ['text'] }],
    },
    providers: {
      dashscope: {
        displayName: '远端 DashScope',
        api: 'openai-completions',
        baseURL: 'https://dashscope.example/v1',
        apiKeyEnv: 'DASHSCOPE_API_KEY',
        models: [
          { id: 'qwen3.8-omni-flash', name: 'qwen3.8-omni-flash', contextWindow: 1000000, input: ['text', 'video'] },
          { id: 'qwen-max', name: 'qwen-max' },
        ],
      },
      commandcode: {
        displayName: 'CommandCode',
        api: 'openai-completions',
        baseURL: 'https://cc.example/v1',
        apiKeyEnv: 'COMMANDCODE_API_KEY',
        models: [{ id: 'deepseek/chat', name: 'Chat', input: ['text'] }],
      },
    },
    default: { provider: 'dashscope', model: 'qwen3.8-omni-flash', reasoningEffort: 'high' },
    keys: { DASHSCOPE_API_KEY: 'sk-dashscope-remote', COMMANDCODE_API_KEY: 'sk-commandcode' },
  });
  assert.ok(config);
  return config as SyncedAgentModelConfig;
}

test('readAgentModelConfig：解析三类条目 + 只取被引用到的 Key（含块状 input / inputModalities）', () => {
  seedHome();
  const config = readAgentModelConfig(home);
  assert.equal(hasAgentModelConfig(config), true);
  assert.deepEqual(Object.keys(config.providers).sort(), ['dashscope', 'local-only']);
  const dashscope = config.providers.dashscope;
  assert.equal(dashscope.displayName, '阿里云百炼（DashScope）');
  assert.equal(dashscope.api, 'openai-completions');
  assert.equal(dashscope.baseURL, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(dashscope.apiKeyEnv, 'DASHSCOPE_API_KEY');
  assert.equal(dashscope.models[0].id, 'qwen3.8-omni-flash');
  assert.deepEqual(dashscope.models[0].input, ['text', 'image']);

  assert.equal(config.official.apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.equal(config.official.baseURL, 'https://api.deepseek.com');
  assert.equal(config.official.maxTokens, 8192);
  assert.equal(config.official.models?.[0].id, 'deepseek-chat');
  assert.equal(config.official.models?.[0].contextWindow, 128000);
  assert.deepEqual(config.official.models?.[0].inputModalities, ['text', 'image']);

  assert.deepEqual(config.default, { provider: 'deepseek-official', model: 'deepseek-chat' });
  // 只同步被引用到的 Key，其它凭据（不相关 ref）不进同步数据
  assert.deepEqual(Object.keys(config.keys).sort(), ['DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY']);
  assert.equal(config.keys.DASHSCOPE_API_KEY, 'sk-dashscope-local');
  assert.equal(config.keys.UNRELATED_API_KEY, undefined);
});

test('readAgentModelConfig：块状 refs 也能读；读不到文件时返回空配置且不抛', () => {
  const blockHome = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-agent-model-block-'));
  try {
    fs.mkdirSync(path.dirname(patchPath(blockHome)), { recursive: true });
    fs.writeFileSync(patchPath(blockHome), [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      dashscope:',
      '        apiKeyEnv: DASHSCOPE_API_KEY',
      '        models:',
      '        - id: qwen3.8-omni-flash',
    ].join('\n') + '\n');
    fs.writeFileSync(credentialsPath(blockHome), [
      'version: 2',
      'refs:',
      "  DASHSCOPE_API_KEY: 'sk-block-key'",
    ].join('\n') + '\n');
    const config = readAgentModelConfig(blockHome);
    assert.equal(config.keys.DASHSCOPE_API_KEY, 'sk-block-key');
  } finally {
    fs.rmSync(blockHome, { recursive: true, force: true });
  }
  const missing = readAgentModelConfig(path.join(home, 'does-not-exist'));
  assert.deepEqual(missing.providers, {});
  assert.deepEqual(missing.official, {});
  assert.deepEqual(missing.keys, {});
  assert.equal(hasAgentModelConfig(missing), false);
});

test('readAgentModelConfig：凭据文件缺 ref 时回退同名环境变量（与 resolveVideoModel 同口径）', () => {
  const envHome = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-agent-model-env-'));
  try {
    fs.mkdirSync(path.dirname(patchPath(envHome)), { recursive: true });
    fs.writeFileSync(patchPath(envHome), [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      envprovider:',
      '        baseURL: https://env.example/v1',
      '        models:',
      '        - id: env-model',
    ].join('\n') + '\n');
    process.env.ENVPROVIDER_API_KEY = 'sk-from-env';
    const config = readAgentModelConfig(envHome);
    assert.equal(config.keys.ENVPROVIDER_API_KEY, 'sk-from-env');
  } finally {
    delete process.env.ENVPROVIDER_API_KEY;
    fs.rmSync(envHome, { recursive: true, force: true });
  }
});

test('mergeAgentModelConfig：并集合并——本机独有保留、同 id / 同 ref 远端胜、official/default 远端胜', () => {
  seedHome();
  const local = readAgentModelConfig(home);
  const remote = remoteConfig();
  const merged = mergeAgentModelConfig(local, remote);

  // 本机独有提供商保留；远端同 id 覆盖字段与模型
  assert.equal(merged.providers['local-only'].displayName, '本机独有提供商');
  assert.equal(merged.providers.dashscope.displayName, '远端 DashScope');
  assert.equal(merged.providers.dashscope.baseURL, 'https://dashscope.example/v1');
  assert.deepEqual(merged.providers.dashscope.models.map((model) => model.id), ['qwen3.8-omni-flash', 'qwen-max']);
  // 远端独有提供商加入
  assert.equal(merged.providers.commandcode.displayName, 'CommandCode');
  // official 远端有值才覆盖；baseURL 的空串表示官方地址，同样要覆盖
  assert.equal(merged.official.apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.equal(merged.official.baseURL, '');
  assert.equal(merged.official.maxTokens, 16384);
  assert.deepEqual(merged.official.models?.map((model) => model.id), ['deepseek-reasoner']);
  // default 远端胜
  assert.deepEqual(merged.default, {
    provider: 'dashscope',
    model: 'qwen3.8-omni-flash',
    reasoningEffort: 'high',
  });
  // keys 并集：同 ref 远端胜，本机独有 Key 保留
  assert.equal(merged.keys.DASHSCOPE_API_KEY, 'sk-dashscope-remote');
  assert.equal(merged.keys.DEEPSEEK_API_KEY, 'sk-deepseek-local');
  assert.equal(merged.keys.COMMANDCODE_API_KEY, 'sk-commandcode');
});

test('mergeAgentModelConfig：远端没有的字段不覆盖本机（official 为空、default 为空时保留本机）', () => {
  seedHome();
  const local = readAgentModelConfig(home);
  const emptyRemote = normalizeAgentModelConfig({ version: 1, providers: {}, official: {}, default: {}, keys: {} });
  assert.ok(emptyRemote);
  const merged = mergeAgentModelConfig(local, emptyRemote as SyncedAgentModelConfig);
  assert.equal(merged.official.maxTokens, 8192);
  assert.deepEqual(merged.default, { provider: 'deepseek-official', model: 'deepseek-chat' });
  assert.equal(merged.providers['local-only'].displayName, '本机独有提供商');
});

test('digest / stableStringify：对象 key 顺序不影响指纹，内容变化会变指纹', () => {
  const local = readAgentModelConfig(home);
  const copy = JSON.parse(JSON.stringify(local)) as SyncedAgentModelConfig;
  assert.equal(agentModelConfigDigest(local), agentModelConfigDigest(copy));
  // 手工换一下 providers 的 key 顺序：稳定序列化后应完全一致
  const reordered: SyncedAgentModelConfig = {
    ...local,
    providers: Object.fromEntries(Object.entries(local.providers).reverse()),
  };
  assert.equal(stableStringify(local), stableStringify(reordered));
  assert.equal(agentModelConfigDigest(local), agentModelConfigDigest(reordered));
  const changed = mergeAgentModelConfig(local, remoteConfig());
  assert.notEqual(agentModelConfigDigest(local), agentModelConfigDigest(changed));
});

test('applyAgentModelConfigToPatch：只动三类条目，其它条目 / 注释保留；写回的配置能再次解析', () => {
  seedHome();
  const local = readAgentModelConfig(home);
  const merged = mergeAgentModelConfig(local, remoteConfig());
  const next = applyAgentModelConfigToPatch(PATCH, merged);
  // 其它顶层条目与注释逐字保留
  assert.ok(next.includes('# Your patch layer for this dsh profile'));
  assert.ok(next.includes('- id: ui-settings-general'));
  assert.ok(next.includes('welcomeNoticeVersion: 3'));
  // 本机独有提供商不被删除
  assert.ok(next.includes('local-only:'));
  assert.ok(next.includes('本机独有提供商'));
  // 远端内容写入
  assert.ok(next.includes('commandcode:'));
  assert.ok(next.includes('https://dashscope.example/v1'));
  assert.ok(next.includes('provider: dashscope'));
  assert.ok(next.includes('reasoningEffort: high'));
  // 写回文本能再次被解析成同样的合并结果
  fs.writeFileSync(patchPath(), next, 'utf8');
  const reparsed = readAgentModelConfig(home);
  assert.deepEqual(Object.keys(reparsed.providers).sort(), ['commandcode', 'dashscope', 'local-only']);
  assert.equal(reparsed.providers.dashscope.baseURL, 'https://dashscope.example/v1');
  assert.equal(reparsed.default.provider, 'dashscope');
  assert.equal(reparsed.official.maxTokens, 16384);
  // baseURL: '' 表示官方地址：写回时清掉本机自定义地址
  assert.equal(reparsed.official.baseURL, undefined);
});

test('applyAgentModelConfigToPatch：补写缺失条目（llm-pi-ai 与 llm-deepseek 都不存在时新建）', () => {
  const patch = ['# 只有注释与别的条目', '- id: ui-settings-general', '  config:', '    welcomeNoticeVersion: 3', ''].join('\n');
  const config = normalizeAgentModelConfig({
    providers: {
      dashscope: {
        displayName: '远端 DashScope',
        apiKeyEnv: 'DASHSCOPE_API_KEY',
        baseURL: 'https://dashscope.example/v1',
        models: [{ id: 'qwen3.8-omni-flash', input: ['text', 'video'] }],
      },
    },
    official: { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-chat' }] },
    default: { provider: 'dashscope', model: 'qwen3.8-omni-flash' },
    keys: {},
  }) as SyncedAgentModelConfig;
  const next = applyAgentModelConfigToPatch(patch, config);
  assert.ok(next.includes('- id: llm-pi-ai'));
  assert.ok(next.includes('- id: llm-deepseek'));
  assert.ok(next.includes('- id: agent-default-model'));
  assert.ok(next.includes('# 只有注释与别的条目'), '新建条目时保留原文件注释');
  assert.ok(!next.includes('cloud'), '不应引入无关内容');

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-agent-model-new-'));
  try {
    fs.mkdirSync(path.dirname(patchPath(tempHome)), { recursive: true });
    fs.writeFileSync(patchPath(tempHome), next, 'utf8');
    const config2 = readAgentModelConfig(tempHome);
    assert.equal(config2.providers.dashscope.displayName, '远端 DashScope');
    assert.deepEqual(config2.providers.dashscope.models[0].input, ['text', 'video']);
    assert.equal(config2.official.apiKeyEnv, 'DEEPSEEK_API_KEY');
    assert.equal(config2.default.model, 'qwen3.8-omni-flash');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('applyAgentModelConfigToCredentials：只重写 refs 段，保留 version / records，值单引号转义', () => {
  const next = applyAgentModelConfigToCredentials(CREDENTIALS, {
    DASHSCOPE_API_KEY: 'sk-new-remote',
    NEW_API_KEY: "sk-with-'quote",
  });
  assert.ok(next.includes('version: 1'), 'version 段保留');
  assert.ok(next.includes('records:'), 'records 段保留');
  assert.ok(next.includes('some/record:'));
  assert.ok(next.includes("DASHSCOPE_API_KEY: 'sk-new-remote'"));
  assert.ok(next.includes("NEW_API_KEY: 'sk-with-''quote'"), "单引号按 YAML 规则转义成 ''");
  // 其它本机凭据不应因为重写 refs 而丢失
  assert.ok(next.includes("UNRELATED_API_KEY: 'sk-unrelated'"));
  assert.ok(!next.includes('{'), 'flow map 被换成块状 map');
});

test('applyAgentModelConfigToCredentials：没有 refs 段时追加；空文件补 version: 1', () => {
  const withVersion = applyAgentModelConfigToCredentials('version: 1\n', { DASHSCOPE_API_KEY: 'sk-x' });
  assert.equal(withVersion, "version: 1\nrefs:\n  DASHSCOPE_API_KEY: 'sk-x'\n");
  // 新建凭据文件与 dsh 实际写出的格式一致（version: 1）
  const empty = applyAgentModelConfigToCredentials('', { DASHSCOPE_API_KEY: 'sk-x' });
  assert.ok(empty.startsWith('version: 1\nrefs:'));
});

test('applyAgentModelConfigToCredentials：refs 内容没变时原样返回，不重排格式（幂等）', () => {
  const flow = [
    'version: 1',
    'refs:',
    '  {',
    "    DASHSCOPE_API_KEY: 'sk-flow',",
    "    DEEPSEEK_API_KEY: 'sk-deep',",
    '  }',
  ].join('\n') + '\n';
  // 合并结果与现有 refs 完全一致：不该被改写成块状 map（否则每次 apply 都会动凭据文件）
  assert.equal(applyAgentModelConfigToCredentials(flow, {
    DASHSCOPE_API_KEY: 'sk-flow',
    DEEPSEEK_API_KEY: 'sk-deep',
  }), flow);
});

test('writeAgentModelConfig：写文件并覆盖式留 .engram-bak；内容没变不写', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-agent-model-write-'));
  try {
    seedHome(target, PATCH, CREDENTIALS);
    const local = readAgentModelConfig(target);
    const first = mergeAgentModelConfig(local, remoteConfig());
    const result = writeAgentModelConfig(target, first);
    assert.equal(result.patchChanged, true);
    assert.equal(result.credentialsChanged, true);
    const firstPatch = fs.readFileSync(patchPath(target), 'utf8');
    const firstCredentials = fs.readFileSync(credentialsPath(target), 'utf8');
    assert.ok(fs.existsSync(patchPath(target) + '.engram-bak'), '写 patch 前留备份');
    assert.ok(fs.existsSync(credentialsPath(target) + '.engram-bak'), '写凭据前留备份');
    assert.ok(firstPatch.includes('commandcode:'));
    assert.ok(firstCredentials.includes("COMMANDCODE_API_KEY: 'sk-commandcode'"));
    // dsh 的 credentials-local 启动时要求凭据文件仅属主可读（POSIX 600），否则控制台拒绝启动；
    // Linux（Docker 中枢）会真实命中这条，Windows 没有对应语义，跳过。
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(credentialsPath(target)).mode & 0o777, 0o600, '凭据文件必须收紧到 600');
    }

    // 同样内容再写一次：不应产生变化（digest 抑制的上游口径；这里验证写函数本身幂等）
    const second = writeAgentModelConfig(target, first);
    assert.deepEqual(second, { patchChanged: false, credentialsChanged: false });
    assert.equal(fs.readFileSync(patchPath(target), 'utf8'), firstPatch);
    // 没写就不动备份：备份仍是「第一次写之前」的原文件（不累积历史版本）
    assert.equal(fs.readFileSync(patchPath(target) + '.engram-bak', 'utf8'), PATCH);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('坏输入：非对象 / 坏 JSON / 空值都按「没有配置」处理，不抛', () => {
  assert.equal(parseAgentModelConfig('not-json'), null);
  assert.equal(parseAgentModelConfig('[]'), null);
  assert.equal(parseAgentModelConfig('"text"'), null);
  assert.equal(parseAgentModelConfig(''), null);
  assert.equal(normalizeAgentModelConfig(null), null);
  assert.equal(applyAgentModelConfigToPatch('', normalizeAgentModelConfig({}) as SyncedAgentModelConfig), '');
  assert.equal(applyAgentModelConfigToCredentials('refs:\n  A: b\n', {}), 'refs:\n  A: b\n');
  assert.equal(AGENT_MODEL_CONFIG_KEY, 'agent_model_config');
});
