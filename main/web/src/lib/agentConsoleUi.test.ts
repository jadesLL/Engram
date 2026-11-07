import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_API_PROTOCOLS,
  consoleStateLabel,
  formatStartedAt,
  groupInventory,
  inventoryStatusLabel,
  normalizeAdvanced,
  normalizeConsoleState,
  normalizeInputModalities,
  normalizeModels,
  normalizePlugins,
  normalizePresets,
  pluginConfigPayload,
  pluginFormDefaults,
  revisionConflict,
  splitModelOptions,
} from './agentConsoleUi.ts';

/* ── 归一化：空响应 ───────────────────────────────────── */

test('normalizeModels：空响应/脏响应给安全默认值，且默认只读', () => {
  const empty = normalizeModels(null);
  assert.equal(empty.writable, false);
  assert.deepEqual(empty.default, {
    provider: '',
    model: '',
    reasoningEffort: null,
    revision: 0,
    providerOptions: [],
    modelOptions: [],
  });
  assert.equal(empty.official, null);
  assert.deepEqual(empty.customProviders, []);
  assert.deepEqual(empty.declaredProviders, []);
  assert.deepEqual(empty.apiProtocols, DEFAULT_API_PROTOCOLS);

  // 字符串 'true' 不算 writable：只有服务端明确 writable === true 才允许写
  assert.equal(normalizeModels({ writable: 'true' }).writable, false);
  assert.equal(normalizeModels({ writable: true }).writable, true);
});

test('normalizeModels：脏数据丢弃空 id/空选项，revision 归一到非负整数', () => {
  const models = normalizeModels({
    writable: true,
    default: {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      revision: -3,
      providerOptions: [
        { value: 'deepseek-official', label: 'DeepSeek' },
        { value: 'deepseek-official', label: '重复项' },
        { value: '', label: '空值' },
        { label: '缺 value' },
        'not-an-object',
      ],
      modelOptions: [{ value: 'deepseek-flash', label: '' }, { value: 42 }],
    },
    official: {
      providerId: 'deepseek-official',
      title: '',
      apiKey: { configured: 'yes', ref: 7 },
      baseURL: { value: ' https://api.deepseek.com ', placeholder: null },
      models: [{ id: 'deepseek-flash', name: '' }, { id: '' }, null],
      maxTokens: '8192',
      revision: 2.9,
    },
    customProviders: [
      { id: 'my-gw', displayName: '', baseURL: 'https://x/v1', models: [{ id: 'm1', name: '' }, { id: '' }] },
      { id: '' },
      'bad',
    ],
    apiProtocols: ['openai-completions', '', 3],
  });

  assert.equal(models.default.revision, 0);
  // 重复/空选项去重；当前 provider 缺选项时会补一条用于展示
  assert.deepEqual(models.default.providerOptions, [
    { value: 'deepseek-official', label: 'DeepSeek' },
  ]);
  // 当前 model 已在选项里（不重复补）；'42' 数字转字符串、label 缺省回退 value
  assert.deepEqual(models.default.modelOptions, [
    { value: 'deepseek-flash', label: 'deepseek-flash' },
    { value: '42', label: '42' },
  ]);
  assert.ok(models.official);
  assert.equal(models.official?.apiKey.configured, false);
  assert.equal(models.official?.apiKey.writable, true);
  assert.equal(models.official?.apiKey.ref, '7');
  assert.equal(models.official?.baseURL.value, 'https://api.deepseek.com');
  assert.deepEqual(models.official?.models, [{ id: 'deepseek-flash', name: 'deepseek-flash' }]);
  assert.equal(models.official?.maxTokens, 8192);
  assert.equal(models.official?.revision, 2);
  assert.equal(models.customProviders.length, 1);
  assert.equal(models.customProviders[0].displayName, 'my-gw');
  assert.deepEqual(models.customProviders[0].models, [{ id: 'm1', name: 'm1' }]);
  assert.deepEqual(models.apiProtocols, ['openai-completions', '3']);
});

test('normalizeModels：模型输入类型只留 text/image、去重，缺省不塞默认值', () => {
  const models = normalizeModels({
    official: {
      providerId: 'deepseek-official',
      models: [
        { id: 'deepseek-flash', name: 'Flash', inputModalities: ['text', 'image', 'text', 'audio', ''] },
        { id: 'text-only', name: 'Text', inputModalities: ['text'] },
        { id: 'legacy', name: 'Legacy' },
        { id: 'broken', name: 'Broken', inputModalities: 'image' },
      ],
    },
    customProviders: [
      {
        id: 'my-gw',
        models: [
          { id: 'm1', name: 'M1', input: ['image', 'text', 'IMAGE', 'audio'] },
          { id: 'm2', name: 'M2', input: ['text'] },
          { id: 'm3', name: 'M3' },
          { id: 'm4', name: 'M4', input: [] },
        ],
      },
    ],
  });
  const officialModels = models.official?.models ?? [];
  // 只留 text / image 并按出现顺序去重；大写 IMAGE、audio、空串、非数组都丢弃
  assert.deepEqual(officialModels.map((model) => model.inputModalities), [
    ['text', 'image'],
    ['text'],
    undefined,
    undefined,
  ]);
  // 缺省不塞默认值：字段整个不存在，由界面按文本+图片回填
  assert.equal('inputModalities' in officialModels[2], false);
  assert.equal('inputModalities' in officialModels[3], false);

  const customModels = models.customProviders[0]?.models ?? [];
  assert.deepEqual(customModels.map((model) => model.input), [
    ['image', 'text'],
    ['text'],
    undefined,
    undefined,
  ]);
  assert.equal('input' in customModels[2], false);
  // 空数组等于未声明：不落成 input: []
  assert.equal('input' in customModels[3], false);

  // 归一化函数本身也守住同一口径
  assert.deepEqual(normalizeInputModalities(['image', 'image', 'audio', 'text', null]), ['image', 'text']);
  assert.deepEqual(normalizeInputModalities('image'), []);
  assert.deepEqual(normalizeInputModalities(undefined), []);
});

test('normalizePlugins：空响应 + 脏卡片/清单的容错', () => {
  const empty = normalizePlugins(undefined);
  assert.deepEqual(empty, { writable: false, cards: [], experimental: [], inventory: [] });

  const plugins = normalizePlugins({
    writable: true,
    cards: [
      {
        key: 'subagent',
        title: '',
        description: '递归与并行',
        icon: 'subagent',
        fields: [
          { key: 'maxDepth', label: '', type: 'number', value: '3', min: '0', step: -1 },
          { key: 'allowModel', type: 'boolean', value: 1 },
          { key: 'mystery', type: 'weird' },
          { type: 'text' },
        ],
        revisions: { 'agent-subagent': 4, '': 9, bad: '7' },
      },
      { key: '' },
      null,
    ],
    experimental: [
      { key: 'agent-team', id: 'agent-team', title: '智能体团队', tag: '', kind: 'bundle', enabled: true },
      { key: 'x', id: '', title: '缺 id' },
    ],
    inventory: [
      { entryId: 'persona', title: '', module: 'persona', enabled: true, status: 'active', scope: 'session' },
      { entryId: 'tool-web', module: 'tool-web', enabled: false, status: 'disabled', scope: 'mystery' },
      { entryId: '' },
    ],
  });

  assert.equal(plugins.cards.length, 1);
  const card = plugins.cards[0];
  assert.equal(card.title, 'subagent');
  assert.equal(card.fields.length, 3);
  assert.equal(card.fields[0].label, 'maxDepth');
  assert.equal(card.fields[0].min, 0);
  assert.equal(card.fields[0].step, undefined);
  assert.equal(card.fields[1].type, 'boolean');
  // 未知 type 降级为 text；缺 key 的字段丢弃
  assert.equal(card.fields[2].type, 'text');
  assert.deepEqual(card.revisions, { 'agent-subagent': 4, bad: 7 });

  assert.equal(plugins.experimental.length, 1);
  assert.equal(plugins.experimental[0].tag, '实验性');
  assert.equal(plugins.experimental[0].kind, 'bundle');
  assert.equal(plugins.inventory.length, 2);
  assert.equal(plugins.inventory[0].title, 'persona');
  assert.equal(plugins.inventory[1].scope, 'global');
});

test('normalizePresets / normalizeAdvanced：空响应与脏数据', () => {
  assert.deepEqual(normalizePresets(null), { writable: false, selected: '', revision: 0, presets: [] });
  const presets = normalizePresets({
    writable: true,
    selected: 'standard',
    revision: '3',
    presets: [{ id: 'standard', title: '', description: '标准' }, { id: 'broken-one', broken: '缺少插件' }, { id: '' }, 5],
  });
  assert.equal(presets.revision, 3);
  assert.equal(presets.presets.length, 2);
  assert.equal(presets.presets[0].title, 'standard');
  assert.equal(presets.presets[1].broken, '缺少插件');

  assert.deepEqual(normalizeAdvanced(null), {
    writable: false,
    sessionLog: { enabled: false, revision: 0 },
    console: { dshVersion: null, home: '' },
  });
  const advanced = normalizeAdvanced({
    writable: true,
    sessionLog: { enabled: 'true', revision: 2 },
    console: { dshVersion: '0.2.1-rc.2', home: 'C:/dsh' },
  });
  assert.equal(advanced.sessionLog.enabled, false);
  assert.equal(advanced.sessionLog.revision, 2);
  assert.equal(advanced.console.dshVersion, '0.2.1-rc.2');
  assert.equal(advanced.console.home, 'C:/dsh');
});

test('normalizeConsoleState：新 BFF 状态字段缺失时降级', () => {
  assert.deepEqual(normalizeConsoleState(null), {
    running: false,
    startedAt: null,
    dshVersion: null,
    error: '',
    origin: '',
    upstreamReady: false,
  });
  const state = normalizeConsoleState({
    running: true,
    startedAt: 1730000000000,
    dshVersion: ' 0.2.1-rc.2 ',
    error: null,
    origin: 'http://127.0.0.1:18180',
    upstreamReady: true,
  });
  assert.equal(state.running, true);
  assert.equal(state.startedAt, 1730000000000);
  assert.equal(state.dshVersion, '0.2.1-rc.2');
  assert.equal(state.origin, 'http://127.0.0.1:18180');
  assert.equal(state.upstreamReady, true);
  // 旧控制台模块的状态文案仍可复用
  assert.deepEqual(consoleStateLabel({ running: true, error: '' }), { text: '运行中', tone: 'ok' });
  assert.equal(formatStartedAt(0), '');
});

/* ── 模型选项拆分 ─────────────────────────────────────── */

test('splitModelOptions：选项带 provider 字段时直接按 provider 过滤', () => {
  const options = [
    { value: 'deepseek-flash', label: 'DeepSeek Flash', provider: 'deepseek-official' },
    { value: 'deepseek-pro', label: 'DeepSeek Pro', provider: 'deepseek-official' },
    // 不同 provider 可以有同名模型：不能按 value 全局去重
    { value: 'gpt-5', label: 'GPT-5 (OpenAI)', provider: 'openai' },
    { value: 'deepseek-flash', label: 'DeepSeek Flash @ 中转', provider: 'my-gw' },
    { value: 'gpt-5', label: 'GPT-5 (中转)', provider: 'my-gw' },
  ];
  assert.deepEqual(splitModelOptions(options, 'deepseek-official'), [
    { value: 'deepseek-flash', label: 'DeepSeek Flash' },
    { value: 'deepseek-pro', label: 'DeepSeek Pro' },
  ]);
  assert.deepEqual(splitModelOptions(options, 'my-gw'), [
    { value: 'deepseek-flash', label: 'DeepSeek Flash @ 中转' },
    { value: 'gpt-5', label: 'GPT-5 (中转)' },
  ]);
  // 当前 provider 没有任何模型 → 空列表（下拉显示「没有可选模型」），不能混入其他 provider 的模型
  assert.deepEqual(splitModelOptions(options, 'unknown'), []);
});

test('splitModelOptions：旧形状带 provider 前缀时按当前 provider 过滤并去掉前缀', () => {
  const options = [
    { value: 'deepseek-official/deepseek-flash', label: 'DeepSeek Flash' },
    { value: 'deepseek-official/deepseek-pro', label: 'DeepSeek Pro' },
    { value: 'anthropic/claude', label: 'Claude' },
    { value: 'plain-model', label: 'Plain' },
  ];
  assert.deepEqual(splitModelOptions(options, 'deepseek-official'), [
    { value: 'deepseek-flash', label: 'DeepSeek Flash' },
    { value: 'deepseek-pro', label: 'DeepSeek Pro' },
  ]);
  // 冒号编码也认
  assert.deepEqual(splitModelOptions([{ value: 'openai:gpt-5', label: 'GPT-5' }], 'openai'), [
    { value: 'gpt-5', label: 'GPT-5' },
  ]);
  // 没有任何带前缀的项（形状不同/脏数据）→ 原样返回，宁可多显示也不要空下拉
  assert.deepEqual(splitModelOptions([{ value: 'deepseek-flash', label: 'Flash' }], 'deepseek-official'), [
    { value: 'deepseek-flash', label: 'Flash' },
  ]);
  assert.deepEqual(splitModelOptions([], 'x'), []);
  assert.deepEqual(splitModelOptions([{ value: 'a', label: '' }], ''), [{ value: 'a', label: 'a' }]);
});

/* ── 409 判定 ─────────────────────────────────────────── */

test('revisionConflict：识别 409（axios response / 直接 status / 错误码 / 文案）', () => {
  assert.equal(revisionConflict({ response: { status: 409 } }), true);
  assert.equal(revisionConflict({ status: 409 }), true);
  assert.equal(revisionConflict({ code: 'revision-conflict' }), true);
  assert.equal(revisionConflict({ response: { status: 409, data: { code: 'revision_conflict' } } }), true);
  assert.equal(revisionConflict({ response: { status: 409, data: { error: '版本冲突，请刷新' } } }), true);
  // 409 但不带 revision 语义（插件切换没生效）：不是版本冲突，要透出服务端原话
  assert.equal(
    revisionConflict({ response: { status: 409, data: { code: 'plugin-toggle-failed', error: '插件没有生效' } } }),
    false,
  );
  assert.equal(revisionConflict({ response: { status: 500, data: { error: 'boom' } } }), false);
  assert.equal(revisionConflict({ message: 'Network Error' }), false);
  assert.equal(revisionConflict(null), false);
  assert.equal(revisionConflict(undefined), false);
  assert.equal(revisionConflict('409'), false);
});

/* ── 插件表单 / 清单 ──────────────────────────────────── */

test('pluginFormDefaults + pluginConfigPayload：schema→表单、表单→提交载荷', () => {
  const card = {
    key: 'web-search',
    title: '网页搜索',
    description: '',
    icon: '',
    fields: [
      { key: 'maxSearches', label: '单次请求最多搜索次数', type: 'number' as const, value: 5 },
      { key: 'enabled', label: '启用新版 API', type: 'boolean' as const, value: true },
      { key: 'baseURL', label: '基础地址', type: 'text' as const, value: 'https://api.deepseek.com' },
      { key: 'apiKey', label: 'API Key', type: 'secret' as const, value: 'should-not-leak', configured: true },
      { key: 'mode', label: '模式', type: 'select' as const, value: 'fast' },
    ],
    revisions: { 'web-search': 3 },
  };
  const form = pluginFormDefaults(card);
  assert.deepEqual(form, {
    maxSearches: '5',
    enabled: true,
    baseURL: 'https://api.deepseek.com',
    apiKey: '',
    mode: 'fast',
  });
  // 密钥不回显、表单里也没有 value
  assert.equal(form.apiKey, '');

  const payload = pluginConfigPayload(card, { ...form, maxSearches: '' }, { apiKey: '   ' });
  assert.deepEqual(payload.expectedRevisions, { 'web-search': 3 });
  assert.equal('apiKey' in payload.values, false, '密钥留空不能提交');
  assert.equal('maxSearches' in payload.values, false, '数字留空不能提交（保留原值）');

  const filled = pluginConfigPayload(card, { ...form, maxSearches: '12' }, { apiKey: ' sk-1 ' });
  assert.deepEqual(filled.values, {
    maxSearches: 12,
    enabled: true,
    baseURL: 'https://api.deepseek.com',
    apiKey: 'sk-1',
    mode: 'fast',
  });
});

test('groupInventory / inventoryStatusLabel：scope 分组与状态词兜底', () => {
  const grouped = groupInventory([
    { entryId: 'a', title: 'A', module: 'a', enabled: true, status: 'active', scope: 'session' },
    { entryId: 'b', title: 'B', module: 'b', enabled: false, status: 'disabled', scope: 'global' },
  ]);
  assert.deepEqual(grouped.session.map((item) => item.entryId), ['a']);
  assert.deepEqual(grouped.global.map((item) => item.entryId), ['b']);

  assert.deepEqual(inventoryStatusLabel('failed', true), { text: '启动失败', tone: 'warn' });
  assert.deepEqual(inventoryStatusLabel('启动失败', true), { text: '启动失败', tone: 'warn' });
  assert.deepEqual(inventoryStatusLabel('disabled', true), { text: '已停用', tone: 'muted' });
  assert.deepEqual(inventoryStatusLabel('conditional', false), { text: '条件启用', tone: 'muted' });
  assert.deepEqual(inventoryStatusLabel('preset', false), { text: '预设中启用', tone: 'ok' });
  assert.deepEqual(inventoryStatusLabel('active', true), { text: '已启用', tone: 'ok' });
  assert.deepEqual(inventoryStatusLabel('', true), { text: '已启用', tone: 'ok' });
  assert.deepEqual(inventoryStatusLabel('', false), { text: '已停用', tone: 'muted' });
});
