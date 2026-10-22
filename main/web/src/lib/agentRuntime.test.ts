import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 测试由 node 内置类型擦除直接跑（web 包无额外测试框架），相对导入要带真实扩展名
import {
  LAYER_ORDER,
  agentRuntimeSummary,
  bundlesText,
  filterPlugins,
  formatInventoryTime,
  formatSettingValue,
  groupPluginsByLayer,
  groupSettingsByEntry,
  inventoryBadge,
  layerExpandedByDefault,
  layerLabel,
  layerNote,
  layerRank,
  normalizeInventory,
  normalizeQuery,
  pluginConfigCount,
  pluginConfigSummary,
  pluginMatchesQuery,
  pluginShortName,
  pluginStatusHint,
  pluginStatusLabel,
  pluginStatusTone,
  pluginVersionLabel,
  runtimeFingerprint,
  settingSourceLabel,
  settingSourceTone,
  shortPackageName,
  sortPlugins,
  type InventoryPlugin,
  type InventorySetting,
} from './agentRuntime.ts';

/**
 * 「内置 Agent 运行时」面板的展示口径：层 / 状态的叫法与色调、搜索过滤、分组排序、来源映射、
 * 指纹条、归一化兜底。数据本身来自服务端（GET /api/assistant/inventory），这里只锁「前端怎么说」。
 */

function plugin(patch: Partial<InventoryPlugin> = {}): InventoryPlugin {
  return {
    entryId: 'tool-fs',
    name: '@deepseek-ai/dsh-tool-fs',
    shortName: 'tool-fs',
    version: '0.2.1-rc.2',
    layer: 'dsh-base',
    status: 'active',
    disabled: null,
    configKeys: ['read', 'write'],
    config: { read: true, write: true },
    ...patch,
  };
}

function setting(patch: Partial<InventorySetting> = {}): InventorySetting {
  return {
    entryId: 'agent-default-model',
    plugin: '@deepseek-ai/dsh-agent-default-model',
    path: 'model',
    type: 'string',
    required: true,
    default: null,
    current: 'deepseek-flash',
    source: 'bundle',
    secret: false,
    volatile: true,
    description: '',
    ...patch,
  };
}

test('层分组：Engram 注入置顶，随包两层垫底且默认折叠', () => {
  assert.deepEqual(LAYER_ORDER, ['engram', 'user', 'unknown', 'dsh-base', 'dsh-sdk-app']);
  assert.equal(layerLabel('engram'), 'Engram 注入');
  assert.equal(layerLabel('user'), '用户配置');
  assert.equal(layerLabel('unknown'), '未归属');
  assert.equal(layerLabel('dsh-base'), '随包 dsh-base');
  assert.equal(layerLabel('dsh-sdk-app'), '随包 dsh-sdk-app');
  assert.equal(layerLabel('weird-layer'), 'weird-layer', '没见过的层名原样展示，不吞掉排障线索');
  assert.equal(layerLabel(''), '未归属');
  assert.match(layerNote('engram'), /engram\.cordis\.yml/);
  assert.equal(layerNote('weird-layer'), '层归属未知的条目');
  // 排序权重：Engram 最前、随包在已知层里最末、未知层名排在所有已知层之后
  assert.ok(layerRank('engram') < layerRank('user'));
  assert.ok(layerRank('user') < layerRank('dsh-base'));
  assert.ok(layerRank('dsh-base') < layerRank('dsh-sdk-app'));
  assert.equal(layerRank('weird-layer'), LAYER_ORDER.length);
  // 默认展开：Engram / 用户 / 未知；随包两层折叠（条目最多、日常不看）
  assert.equal(layerExpandedByDefault('engram'), true);
  assert.equal(layerExpandedByDefault('user'), true);
  assert.equal(layerExpandedByDefault('unknown'), true);
  assert.equal(layerExpandedByDefault('dsh-base'), false);
  assert.equal(layerExpandedByDefault('dsh-sdk-app'), false);
});

test('插件状态：中文标签、色调与「为什么不是启用」的说明', () => {
  assert.equal(pluginStatusLabel('active'), '启用');
  assert.equal(pluginStatusLabel('disabled'), '已禁用');
  assert.equal(pluginStatusLabel('conditional'), '按条件');
  assert.equal(pluginStatusLabel('absent'), '未激活');
  assert.equal(pluginStatusLabel('mystery'), 'mystery');
  assert.equal(pluginStatusTone('active'), 'ok');
  assert.equal(pluginStatusTone('disabled'), 'warn');
  assert.equal(pluginStatusTone('conditional'), 'accent');
  assert.equal(pluginStatusTone('absent'), 'muted');
  assert.equal(pluginStatusTone('mystery'), 'muted');

  assert.equal(pluginStatusHint(plugin({ status: 'active' })), '已加载并生效');
  assert.equal(pluginStatusHint(plugin({ status: 'disabled' })), '配置里把它关掉了（disabled）');
  assert.match(pluginStatusHint(plugin({ status: 'conditional', disabled: '!!js process.env.CI' })), /process\.env\.CI/);
  assert.equal(pluginStatusHint(plugin({ status: 'conditional', disabled: null })), '按条件加载（表达式为空）');
  assert.match(pluginStatusHint(plugin({ status: 'absent' })), /absent/);
});

test('设置项来源：层序映射成中文，Engram / 环境变量单独提色', () => {
  assert.equal(settingSourceLabel('bundle'), '随包默认');
  assert.equal(settingSourceLabel('profile-patch'), 'profile 补丁');
  assert.equal(settingSourceLabel('engram'), 'Engram 配置');
  assert.equal(settingSourceLabel('env'), '环境变量');
  assert.equal(settingSourceLabel('default'), '默认值');
  assert.equal(settingSourceLabel(''), '未知来源');
  assert.equal(settingSourceLabel('mystery'), 'mystery');
  assert.equal(settingSourceTone('engram'), 'accent');
  assert.equal(settingSourceTone('env'), 'warn');
  assert.equal(settingSourceTone('bundle'), 'muted');
});

test('搜索：短名 / 包名 / entryId 都能命中，大小写与首尾空白不影响', () => {
  const plugins = [
    plugin(),
    plugin({ entryId: 'mcp-engram', name: '@deepseek-ai/dsh-mcp-engram', shortName: 'mcp-engram', layer: 'engram' }),
    plugin({ entryId: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', shortName: 'llm-pi-ai', layer: 'engram' }),
  ];
  assert.deepEqual(filterPlugins(plugins, '').map((item) => item.entryId), ['tool-fs', 'mcp-engram', 'llm-pi-ai']);
  assert.deepEqual(filterPlugins(plugins, 'FS').map((item) => item.entryId), ['tool-fs']);
  assert.deepEqual(filterPlugins(plugins, 'dsh-mcp').map((item) => item.entryId), ['mcp-engram']);
  assert.deepEqual(filterPlugins(plugins, ' llm ').map((item) => item.entryId), ['llm-pi-ai']);
  assert.deepEqual(filterPlugins(plugins, '没有这个'), []);
  assert.equal(normalizeQuery('  TooL-Fs  '), 'tool-fs');
  assert.equal(pluginMatchesQuery(plugins[0], ''), true);
  assert.equal(pluginMatchesQuery(plugins[0], 'tool'), true);
  assert.equal(pluginMatchesQuery(plugins[0], 'agent'), false);
  // 返回新数组：调用方后续排序不会改到入参
  const copy = filterPlugins(plugins, '');
  copy.pop();
  assert.equal(plugins.length, 3);
});

test('按层分组：Engram 置顶、随包折叠、层内按短名字母序', () => {
  const groups = groupPluginsByLayer([
    plugin({ entryId: 'tool-web', shortName: 'tool-web', layer: 'dsh-sdk-app' }),
    plugin({ entryId: 'tool-fs', shortName: 'tool-fs', layer: 'dsh-base' }),
    plugin({ entryId: 'agent-default-model', shortName: 'agent-default-model', layer: 'dsh-base' }),
    plugin({ entryId: 'mcp-engram', shortName: 'mcp-engram', layer: 'engram' }),
    plugin({ entryId: 'stray', shortName: 'stray', layer: 'weird-layer' }),
    plugin({ entryId: 'mine', shortName: 'mine', layer: 'user' }),
  ]);
  assert.deepEqual(groups.map((group) => group.layer), ['engram', 'user', 'dsh-base', 'dsh-sdk-app', 'weird-layer']);
  assert.equal(groups[0].label, 'Engram 注入');
  assert.equal(groups[0].expandedByDefault, true);
  assert.equal(groups[1].expandedByDefault, true);
  assert.equal(groups[2].expandedByDefault, false);
  assert.deepEqual(groups[2].plugins.map((item) => item.shortName), ['agent-default-model', 'tool-fs']);
  assert.equal(groups[3].expandedByDefault, false);
  assert.equal(groups[4].label, 'weird-layer', '没归到已知层的条目单独成组，不丢');
  assert.deepEqual(groupPluginsByLayer([]), []);
  assert.deepEqual(
    sortPlugins([plugin({ shortName: 'b' }), plugin({ shortName: 'a' })]).map((item) => item.shortName),
    ['a', 'b'],
  );
});

test('版本与包名：版本解析不到时给人话，短名可从包名兜底推导', () => {
  assert.equal(pluginVersionLabel('0.2.1-rc.2'), '0.2.1-rc.2');
  assert.equal(pluginVersionLabel(null), '版本未知');
  assert.equal(pluginVersionLabel('   '), '版本未知');
  assert.equal(pluginShortName('@deepseek-ai/dsh-tool-fs'), 'tool-fs');
  assert.equal(pluginShortName('dsh-mcp'), 'mcp');
  assert.equal(pluginShortName(''), '');
  assert.equal(shortPackageName('@deepseek-ai/dsh-base'), 'dsh-base');
  assert.equal(shortPackageName('plain-bundle'), 'plain-bundle');
  assert.equal(bundlesText(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app']), 'dsh-base · dsh-sdk-app');
  assert.equal(bundlesText([]), '未知');
  assert.equal(bundlesText(null), '未知');
});

test('生成时间：本地时区的分钟精度；坏输入原样返回', () => {
  // 不带时区的字符串按本地时间解析，断言与跑测试的机器时区无关
  assert.equal(formatInventoryTime('2026-10-22T03:41:05'), '2026-10-22 03:41');
  assert.equal(formatInventoryTime(''), '');
  assert.equal(formatInventoryTime(null), '');
  assert.equal(formatInventoryTime('not-a-date'), 'not-a-date');
});

test('设置项取值：空值 / 空串 / 布尔 / 对象都有明确写法', () => {
  assert.equal(formatSettingValue(null), '—');
  assert.equal(formatSettingValue(undefined), '—');
  assert.equal(formatSettingValue(''), '（空字符串）');
  assert.equal(formatSettingValue('deepseek-flash'), 'deepseek-flash');
  assert.equal(formatSettingValue(false), 'false');
  assert.equal(formatSettingValue(0), '0');
  assert.equal(formatSettingValue({ a: 1 }), '{"a":1}');
});

test('插件配置摘要：有配置给缩进 JSON，只有声明键时退化成键值对', () => {
  assert.equal(pluginConfigSummary(plugin({ config: { read: true } })), '{\n  "read": true\n}');
  assert.equal(
    pluginConfigSummary(plugin({ config: {}, configKeys: ['read', 'write'] })),
    'read: （未设置）\nwrite: （未设置）',
  );
  assert.equal(pluginConfigSummary(plugin({ config: {}, configKeys: [] })), '');
  assert.equal(pluginConfigCount(plugin({ config: { read: true, write: false } })), 2);
  assert.equal(pluginConfigCount(plugin({ config: {}, configKeys: ['read'] })), 1);
  assert.equal(pluginConfigCount(plugin({ config: {}, configKeys: [] })), 0);
});

test('设置项按 entryId 分组：组内保持服务端顺序，组间按标题排序', () => {
  const groups = groupSettingsByEntry([
    setting({ entryId: 'llm-pi-ai', plugin: '@deepseek-ai/dsh-llm-pi-ai', path: 'providers' }),
    setting({ entryId: 'agent-default-model', path: 'provider' }),
    setting({ entryId: 'agent-default-model', path: 'model' }),
    setting({ entryId: '', plugin: '@deepseek-ai/dsh-orphan', path: 'x' }),
  ]);
  assert.deepEqual(groups.map((group) => group.label), [
    '@deepseek-ai/dsh-agent-default-model',
    '@deepseek-ai/dsh-llm-pi-ai',
    '@deepseek-ai/dsh-orphan',
  ]);
  assert.equal(groups[0].key, 'agent-default-model');
  assert.deepEqual(groups[0].rows.map((row) => row.path), ['provider', 'model']);
  assert.equal(groups[2].key, '@deepseek-ai/dsh-orphan', '没有 entryId 时退回包名当分组键');
  assert.deepEqual(groupSettingsByEntry([]), []);
});

test('内置 Agent 摘要行：版本与 profile 取不到就写「未知」', () => {
  assert.equal(agentRuntimeSummary({ agentVersion: '0.2.1-rc.2', profile: 'sdk' }), 'dsh 0.2.1-rc.2 · profile sdk');
  assert.equal(agentRuntimeSummary({}), 'dsh 未知 · profile 未知');
  assert.equal(agentRuntimeSummary(null), 'dsh 未知 · profile 未知');
  assert.equal(agentRuntimeSummary({ agentVersion: '  ', profile: 'sdk-minimal' }), 'dsh 未知 · profile sdk-minimal');
});

test('指纹条：8 项齐全，缺字段显示未知，bundles 去掉 scope', () => {
  const items = runtimeFingerprint({
    dshVersion: '0.2.1-rc.2',
    sdkClientVersion: '0.2.1-rc.2',
    profile: 'sdk',
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
    home: 'C:/data/dsh',
    profileDir: 'C:/data/dsh/profiles/sdk',
    patchFile: 'C:/data/dsh/engram.cordis.yml',
  }, '2026-10-22T03:41:00');
  assert.deepEqual(items.map((item) => item.label), [
    'dsh 版本',
    'SDK 客户端',
    'profile',
    'bundles',
    'DSH_HOME',
    'profile 目录',
    'Engram patch',
    '生成时间',
  ]);
  assert.equal(items[3].value, 'dsh-base · dsh-sdk-app');
  assert.equal(items[3].mono, false, 'bundles 有分隔符，用正文而不是等宽');
  assert.equal(items[0].mono, true);
  assert.equal(items[7].value, '2026-10-22 03:41');
  const empty = runtimeFingerprint(null, null);
  assert.equal(empty.length, 8);
  assert.equal(empty[0].value, '未知');
  assert.equal(empty[3].value, '未知');
  assert.equal(empty[7].value, '未知');
});

test('分组徽标：错误优先于过期，平时显示插件总数', () => {
  assert.deepEqual(inventoryBadge(null), { text: '', tone: 'muted' });
  assert.deepEqual(
    inventoryBadge({ stale: false, errors: [], plugins: [plugin(), plugin()] }),
    { text: '2 个插件', tone: 'muted' },
  );
  assert.deepEqual(inventoryBadge({ stale: true, errors: [], plugins: [] }), { text: '可能过期', tone: 'warn' });
  assert.deepEqual(
    inventoryBadge({ stale: true, errors: ['dump 超时'], plugins: [] }),
    { text: '有错误', tone: 'warn' },
    '有错误时必须报错误，过期只是次要提示',
  );
});

test('inventory 归一化：按设计文档第 5 节的契约字段落到面板数据', () => {
  const inventory = normalizeInventory({
    generatedAt: '2026-10-22T03:41:00.000Z',
    stale: false,
    runtime: {
      dshVersion: '0.2.1-rc.2',
      sdkClientVersion: '0.2.1-rc.2',
      profile: 'sdk',
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
      home: '/data/dsh',
      profileDir: '/data/dsh/profiles/sdk',
      patchFile: '/data/dsh/engram.cordis.yml',
      engramEntries: ['mcp-engram', 'llm-pi-ai', 'agent-default-model'],
    },
    plugins: [{
      entryId: 'tool-fs',
      name: '@deepseek-ai/dsh-tool-fs',
      shortName: 'tool-fs',
      version: '0.2.1-rc.2',
      layer: 'dsh-base',
      status: 'active',
      disabled: null,
      configKeys: ['read', 'write'],
      config: { read: true, write: true },
    }],
    settings: [{
      entryId: 'agent-default-model',
      plugin: '@deepseek-ai/dsh-agent-default-model',
      path: 'model',
      type: 'string',
      required: true,
      default: null,
      current: 'deepseek-flash',
      source: 'bundle',
      secret: false,
      volatile: true,
      description: '',
    }],
    errors: [],
  });
  assert.equal(inventory.runtime.dshVersion, '0.2.1-rc.2');
  assert.deepEqual(inventory.runtime.engramEntries, ['mcp-engram', 'llm-pi-ai', 'agent-default-model']);
  assert.equal(inventory.plugins.length, 1);
  assert.equal(inventory.plugins[0].shortName, 'tool-fs');
  assert.equal(inventory.settings[0].current, 'deepseek-flash');
  assert.equal(inventory.settings[0].secret, false);
  assert.equal(inventory.stale, false);
  assert.deepEqual(inventory.errors, []);
});

test('inventory 归一化：字段缺失 / 类型漂移时降级，不抛异常', () => {
  const inventory = normalizeInventory({
    plugins: [
      { entryId: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { read: true } },
      { name: '@deepseek-ai/dsh-tool-web', version: '', status: 'weird' },
    ],
    settings: [{ plugin: '@deepseek-ai/dsh-orphan', path: 'x', current: '' }],
  });
  assert.equal(inventory.plugins[0].shortName, 'tool-fs', '缺 shortName 时从包名推导');
  assert.equal(inventory.plugins[0].layer, 'unknown', '缺 layer 归到未归属');
  assert.equal(inventory.plugins[0].status, 'absent', '缺 status 按未激活处理');
  assert.deepEqual(inventory.plugins[0].configKeys, ['read'], '缺 configKeys 时用 config 的键');
  assert.equal(inventory.plugins[1].version, null, '空版本归一成 null，界面显示「版本未知」');
  assert.equal(inventory.plugins[1].status, 'weird', '未知状态原样保留（展示层各自兜底）');
  assert.equal(inventory.plugins[1].shortName, 'tool-web');
  assert.equal(inventory.settings[0].entryId, '', '缺 entryId 的分组退回 plugin');
  assert.equal(inventory.settings[0].source, '');
  assert.deepEqual(inventory.errors, []);

  const empty = normalizeInventory(null);
  assert.deepEqual(empty.plugins, []);
  assert.deepEqual(empty.settings, []);
  assert.deepEqual(empty.errors, []);
  assert.deepEqual(empty.runtime.bundles, []);
  assert.equal(empty.stale, false);
});

/* ------------------------------------------------------------------ *
 * 页面结构守卫：导航顺序 = 页面顺序（docs/AGENT-RUNTIME-INVENTORY.md 第 7 节）
 * ------------------------------------------------------------------ */

const here = path.dirname(fileURLToPath(import.meta.url));
const settingsDir = path.resolve(here, '..', 'components', 'settings');

/** 取模板体（<template>…</template>），去注释 */
function templateBodyOf(name: string): string {
  const source = fs.readFileSync(path.join(settingsDir, `${name}.vue`), 'utf8');
  const match = source.match(/<template>([\s\S]*?)\n<\/template>/);
  assert.ok(match, `${name}.vue 没有模板`);
  return (match?.[1] || '').replace(/<!--[\s\S]*?-->/g, '');
}

test('页面结构：内置 Agent 运行时紧跟在内置 Agent 之后、自动化插槽之前', () => {
  const panel = templateBodyOf('AgentPanel');
  const builtinAt = panel.indexOf('anchor="agent-builtin"');
  const runtimeAt = panel.indexOf('<AgentRuntimePanel');
  const slotAt = panel.indexOf('<slot name="after-builtin"');
  const targetAt = panel.indexOf('anchor="agent-target"');
  assert.ok(builtinAt >= 0, 'AgentPanel 里找不到 agent-builtin 分组');
  assert.ok(runtimeAt > builtinAt, 'AgentRuntimePanel 没有渲染在「内置 Agent」分组之后');
  assert.ok(slotAt > runtimeAt, 'AgentRuntimePanel 必须在 #after-builtin 插槽之前（导航顺序 = 页面顺序）');
  assert.ok(targetAt > slotAt, '「外部接入」分组应排在自动化插槽之后');
  // 锚点由面板自己的 SettingsGroup 渲染（settingsDomains 里登记的分组 id 是 agent-runtime）
  assert.match(templateBodyOf('AgentRuntimePanel'), /anchor="agent-runtime"/);
  // 设计文档第 7 节要求的三块内容：插件清单 / 设置 / 高级
  const runtimeSource = fs.readFileSync(path.join(settingsDir, 'AgentRuntimePanel.vue'), 'utf8');
  for (const label of ['插件清单', '设置', '高级']) {
    assert.match(runtimeSource, new RegExp(label), `AgentRuntimePanel 少了「${label}」这块内容`);
  }
});
