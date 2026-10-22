import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  MASK,
  assembleInventory,
  maskDumpText,
  maskSecrets,
  packageRoot,
  parseDumpConfig,
  resolvePluginVersion,
  settingsFromSchema,
  shortPluginName,
  type InventoryRuntime,
} from './agentInventory.js';

/**
 * 夹具取自 dsh 0.2.1-rc.2 实测输出：
 *  - __fixtures__/dump-sdk-0.2.1.yml：--profile sdk --patch engram.cordis.yml --dump-config
 *  - __fixtures__/schema-sdk-0.2.1.json：对应 --dump-config-schema（裁剪到相关 entry）
 */

const dumpText = fs.readFileSync(new URL('./__fixtures__/dump-sdk-0.2.1.yml', import.meta.url), 'utf8');
const schema = JSON.parse(fs.readFileSync(new URL('./__fixtures__/schema-sdk-0.2.1.json', import.meta.url), 'utf8'));

const runtime: InventoryRuntime = {
  dshVersion: '0.2.1-rc.2',
  sdkClientVersion: '0.2.1-rc.2',
  profile: 'sdk',
  bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
  home: '/data/dsh',
  profileDir: '/data/dsh/profiles/sdk',
  patchFile: '/data/dsh/engram.cordis.yml',
  engramEntries: ['mcp-engram', 'llm-pi-ai', 'agent-default-model'],
};

const engramPatch = [
  '- insert:',
  '    - id: mcp-engram',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '- id: llm-pi-ai',
  '  config:',
  '    providers: {}',
  '- id: agent-default-model',
  '  config:',
  '    provider: engram-custom',
  '    model: probe',
].join('\n');

test('parseDumpConfig：条数、来源层、禁用形态、config 解析', () => {
  const entries = parseDumpConfig(dumpText);
  assert.equal(entries.length, 101);
  assert.equal(entries[0].entryId, 'tool-plugin-manager');
  assert.equal(entries[0].layer, 'dsh-base');

  const hmr = entries.find((entry) => entry.entryId === 'hmr');
  assert.equal(hmr?.disabledRaw, 'true');
  assert.deepEqual(hmr?.config, { root: [] });

  const bash = entries.find((entry) => entry.entryId === 'tool-bash');
  assert.match(bash?.disabledRaw ?? '', /process\.platform === 'win32'/);

  const model = entries.find((entry) => entry.entryId === 'agent-default-model');
  assert.deepEqual(model?.config, { provider: 'deepseek-official', model: 'deepseek-flash' });

  const mcp = entries.find((entry) => entry.entryId === 'mcp-engram');
  assert.equal(mcp?.layer, 'engram');
  assert.equal(mcp?.config?.serverName, 'engram');
  assert.equal(mcp?.config?.url, 'http://127.0.0.1:18080/mcp');
  assert.equal(mcp?.config?.toolCallTimeoutMs, 1800000);

  // !!js block 标量折成单行表达式
  const approval = entries.find((entry) => entry.entryId === 'approval');
  const policy = (approval?.config?.policy ?? {}) as { __js: string };
  assert.match(policy.__js, /^\(process\.env\.DSH_PERMISSION_MODE/);
  assert.match(policy.__js, /'ask'$/);
});

test('settingsFromSchema：条目配置 schema 归一化（含 required / 默认值）', () => {
  const modelFields = settingsFromSchema(schema, 'agent-default-model');
  const provider = modelFields.find((field) => field.path === 'provider');
  const modelField = modelFields.find((field) => field.path === 'model');
  assert.ok(provider);
  assert.equal(provider?.type, 'string');
  assert.equal(provider?.required, true);
  assert.equal(modelField?.required, true);
  assert.equal(modelField?.volatile, true);

  const fsFields = settingsFromSchema(schema, 'tool-fs');
  const read = fsFields.find((field) => field.path === 'read');
  assert.equal(read?.defaultValue, true);
  assert.equal(read?.type, 'boolean');

  // 未在 schema 名单里的条目返回空数组（缺省不是错误）
  assert.deepEqual(settingsFromSchema(schema, 'no-such-entry'), []);
});

test('assembleInventory：插件/设置/来源/版本/脱敏一次性对齐', () => {
  const inventory = assembleInventory({
    dumpText,
    schema,
    generatedAt: '2026-10-22T00:00:00.000Z',
    runtime,
    engramPatchText: engramPatch,
    profilePatchText: '',
    resolveVersion: () => '9.9.9',
  });

  assert.equal(inventory.plugins.length, 101);
  const mcp = inventory.plugins.find((plugin) => plugin.entryId === 'mcp-engram');
  assert.equal(mcp?.layer, 'engram');
  assert.equal(mcp?.version, '9.9.9');
  assert.equal(mcp?.shortName, 'mcp-client');
  assert.equal(mcp?.status, 'active');
  // headers 里的 Authorization 已脱敏
  const headers = (mcp?.config?.headers ?? {}) as Record<string, unknown>;
  assert.equal(headers.Authorization, MASK);

  const bash = inventory.plugins.find((plugin) => plugin.entryId === 'tool-bash');
  assert.equal(bash?.status, 'conditional');
  assert.match(bash?.disabled ?? '', /process\.platform/);

  const provider = inventory.settings.find(
    (setting) => setting.entryId === 'agent-default-model' && setting.path === 'provider',
  );
  assert.equal(provider?.current, 'deepseek-official');
  assert.equal(provider?.source, 'engram'); // 命中 Engram patch 条目 → 归 Engram 管
  assert.equal(provider?.required, true);

  const read = inventory.settings.find((setting) => setting.entryId === 'tool-fs' && setting.path === 'read');
  assert.equal(read?.current, true);
  assert.equal(read?.source, 'default'); // 没被 patch 覆盖 → schema 默认值
});

test('assembleInventory：dump 为空时给空清单而不是抛错', () => {
  const inventory = assembleInventory({
    dumpText: '',
    schema,
    generatedAt: '2026-10-22T00:00:00.000Z',
    runtime,
    engramPatchText: '',
    profilePatchText: '',
    errors: ['dump-config 失败：boom'],
  });
  assert.deepEqual(inventory.plugins, []);
  assert.deepEqual(inventory.settings, []);
  assert.deepEqual(inventory.errors, ['dump-config 失败：boom']);
});

test('maskSecrets / maskDumpText：敏感键脱敏但保留凭据引用名', () => {
  const masked = maskSecrets({
    apiKey: 'sk-123',
    apiKeyEnv: 'ENGRAM_AGENT_API_KEY',
    headers: { Authorization: 'Bearer abc', Accept: 'application/json' },
    nested: { password: 'p', token: 't' },
  }) as Record<string, any>;
  assert.equal(masked.apiKey, MASK);
  assert.equal(masked.apiKeyEnv, 'ENGRAM_AGENT_API_KEY');
  assert.equal(masked.headers.Authorization, MASK);
  assert.equal(masked.headers.Accept, 'application/json');
  assert.equal(masked.nested.password, MASK);
  assert.equal(masked.nested.token, MASK);

  const text = maskDumpText(['    headers:', '      Authorization: Bearer probe', '    url: http://x/mcp'].join('\n'));
  assert.equal(text.includes('Bearer probe'), false);
  assert.equal(text.includes('Authorization: ' + MASK), true);
  assert.equal(text.includes('url: http://x/mcp'), true);
});

test('packageRoot / shortPluginName：作用域与子路径归一', () => {
  assert.equal(packageRoot('@deepseek-ai/dsh-tool-fs'), '@deepseek-ai/dsh-tool-fs');
  assert.equal(packageRoot('@deepseek-ai/dsh-plugin-manager/tools'), '@deepseek-ai/dsh-plugin-manager');
  assert.equal(packageRoot('fastify'), 'fastify');
  assert.equal(shortPluginName('@deepseek-ai/dsh-tool-fs'), 'tool-fs');
  assert.equal(shortPluginName('@deepseek-ai/cordis-plugin-timer'), 'cordis-plugin-timer');
  assert.equal(shortPluginName('@deepseek-ai/dsh-plugin-manager/tools'), 'plugin-manager');
});

test('resolvePluginVersion：按 dsh 的包上下文解析（pnpm 嵌套布局也能命中）', () => {
  const dsh = resolvePluginVersion('@deepseek-ai/dsh');
  if (!dsh) return; // 本地没装依赖时跳过；Docker verify 里一定有
  assert.match(dsh, /^\d+\.\d+\.\d+/);
  const mcp = resolvePluginVersion('@deepseek-ai/dsh-mcp-client');
  assert.equal(typeof mcp === 'string' && /^\d+\.\d+\.\d+/.test(mcp), true);
  // 同一个包重复解析走缓存，结果稳定
  assert.equal(resolvePluginVersion('@deepseek-ai/dsh'), dsh);
});
