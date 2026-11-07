import type {
  AdvancedPayload,
  ConsoleStatusPayload,
  CustomProviderModelEntry,
  DeclaredProviderPayload,
  ExperimentalPluginPayload,
  ModelInputModality,
  ModelsPayload,
  OfficialModelEntry,
  OfficialProviderPayload,
  PluginCardPayload,
  PluginFieldPayload,
  PluginInventoryItemPayload,
  PluginsPayload,
  PresetItemPayload,
  PresetsPayload,
  SelectOption,
} from './agentConsoleApi';
import { consoleStateLabel, formatStartedAt } from './agentConsole.ts';

/**
 * 内置 Agent 控制台的「服务端 JSON → 界面可用状态」纯函数（便于单测）。
 *
 * 服务端 BFF 按理该给完整 payload，但真实环境里版本错配、上游 dsh 返回缺字段都可能发生：
 * 这里所有归一化都遵守两条——① 缺字段给安全默认值（不白屏、不把 undefined 塞进 v-model）；
 * ② 脏成员（非对象、空 id、类型不对）直接丢弃，而不是让列表渲染出一堆空卡片。
 * 写到界面的状态一律 locked（writable=false）除非服务端明确 writable=true。
 */

/** 状态文案 / 启动时间格式化沿用旧控制台模块（它的单测已锁住口径） */
export { consoleStateLabel, formatStartedAt };

/** 服务端没给协议列表时的兜底（BFF 契约 §1.2） */
export const DEFAULT_API_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'];

export type StatusTone = 'ok' | 'warn' | 'muted';

/* ── 基础清洗 ─────────────────────────────────────────── */

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function trimmed(value: unknown): string {
  return text(value).trim();
}

function finiteNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/** revision 一类的非负整数 */
function revision(value: unknown): number {
  return Math.max(0, Math.trunc(finiteNumber(value, 0)));
}

function optionalNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = finiteNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 输入类型只认 text / image；去重按首次出现顺序，缺省/脏数据返回空数组（界面再决定是否回填默认值） */
const MODEL_INPUT_MODALITIES: ReadonlySet<string> = new Set(['text', 'image']);

export function normalizeInputModalities(value: unknown): ModelInputModality[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const list: ModelInputModality[] = [];
  for (const item of value) {
    const modality = trimmed(item);
    if (!MODEL_INPUT_MODALITIES.has(modality) || seen.has(modality)) continue;
    seen.add(modality);
    list.push(modality as ModelInputModality);
  }
  return list;
}

function options(value: unknown): SelectOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const list: SelectOption[] = [];
  for (const item of value) {
    const source = record(item);
    const optionValue = trimmed(source.value);
    const provider = trimmed(source.provider);
    // 模型选项的 value 只是模型 id：不同 provider 可以有同名模型，去重键必须带上 provider
    const key = provider ? `${provider}::${optionValue}` : optionValue;
    if (!optionValue || seen.has(key)) continue;
    seen.add(key);
    list.push({ value: optionValue, label: trimmed(source.label) || optionValue, ...(provider ? { provider } : {}) });
  }
  return list;
}

/** 当前值不在选项里时补一条，保证 AppSelect 能显示实际生效的配置而不是「请选择」 */
function withCurrentOption(list: SelectOption[], value: string, label = value): SelectOption[] {
  if (!value || list.some((option) => option.value === value)) return list;
  return [...list, { value, label }];
}

/* ── 1.1 状态 ─────────────────────────────────────────── */

export function normalizeConsoleState(raw: unknown): ConsoleStatusPayload {
  const source = record(raw);
  return {
    running: source.running === true,
    startedAt: optionalNumber(source.startedAt),
    dshVersion: source.dshVersion == null ? null : trimmed(source.dshVersion) || null,
    error: trimmed(source.error),
    origin: trimmed(source.origin),
    upstreamReady: source.upstreamReady === true,
  };
}

/* ── 1.2 模型 ─────────────────────────────────────────── */

function normalizeOfficialModel(value: unknown): OfficialModelEntry | null {
  const source = record(value);
  const id = trimmed(source.id);
  if (!id) return null;
  const contextWindow = optionalNumber(source.contextWindow);
  const inputModalities = normalizeInputModalities(source.inputModalities);
  return {
    id,
    name: trimmed(source.name) || id,
    ...(contextWindow != null && contextWindow > 0 ? { contextWindow: Math.trunc(contextWindow) } : {}),
    ...(inputModalities.length ? { inputModalities } : {}),
  };
}

function normalizeOfficial(value: unknown): OfficialProviderPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = record(value);
  const providerId = trimmed(source.providerId);
  const apiKey = record(source.apiKey);
  const baseURL = record(source.baseURL);
  const models = Array.isArray(source.models)
    ? source.models.map(normalizeOfficialModel).filter((item): item is OfficialModelEntry => item != null)
    : [];
  return {
    providerId,
    title: trimmed(source.title) || providerId || 'DeepSeek',
    apiKey: {
      configured: apiKey.configured === true,
      ref: trimmed(apiKey.ref),
      writable: apiKey.writable !== false,
      hint: trimmed(apiKey.hint),
    },
    baseURL: {
      value: trimmed(baseURL.value),
      placeholder: trimmed(baseURL.placeholder),
    },
    models,
    maxTokens: Math.max(0, Math.trunc(finiteNumber(source.maxTokens, 4096))),
    revision: revision(source.revision),
  };
}

function normalizeCustomProvider(value: unknown) {
  const source = record(value);
  const id = trimmed(source.id);
  if (!id) return null;
  const models = Array.isArray(source.models)
    ? source.models
      .map((item): CustomProviderModelEntry | null => {
        const model = record(item);
        const modelId = trimmed(model.id);
        if (!modelId) return null;
        const input = normalizeInputModalities(model.input);
        return {
          id: modelId,
          name: trimmed(model.name) || modelId,
          ...(input.length ? { input } : {}),
        };
      })
      .filter((item): item is CustomProviderModelEntry => item != null)
    : [];
  return {
    id,
    displayName: trimmed(source.displayName) || id,
    api: trimmed(source.api),
    baseURL: trimmed(source.baseURL),
    apiKeyConfigured: source.apiKeyConfigured === true,
    models,
    revision: revision(source.revision),
  };
}

function normalizeDeclaredProvider(value: unknown): DeclaredProviderPayload | null {
  const source = record(value);
  const provider = trimmed(source.provider);
  if (!provider) return null;
  return {
    provider,
    displayName: trimmed(source.displayName) || provider,
    defaultBaseURL: trimmed(source.defaultBaseURL),
    nativeAuth: source.nativeAuth === true,
  };
}

export function normalizeModels(raw: unknown): ModelsPayload {
  const source = record(raw);
  const defaultSource = record(source.default);
  const provider = trimmed(defaultSource.provider);
  const model = trimmed(defaultSource.model);
  const reasoningEffort = defaultSource.reasoningEffort == null
    ? null
    : trimmed(defaultSource.reasoningEffort) || null;
  const providerOptions = withCurrentOption(options(defaultSource.providerOptions), provider);
  const rawModelOptions = options(defaultSource.modelOptions);
  const modelOptions = model && !rawModelOptions.some((option) => option.value === model)
    ? [...rawModelOptions, { value: model, label: model, ...(provider ? { provider } : {}) }]
    : rawModelOptions;
  const customProviders = Array.isArray(source.customProviders)
    ? source.customProviders
      .map(normalizeCustomProvider)
      .filter((item): item is NonNullable<typeof item> => item != null)
    : [];
  const declaredProviders = Array.isArray(source.declaredProviders)
    ? source.declaredProviders
      .map(normalizeDeclaredProvider)
      .filter((item): item is DeclaredProviderPayload => item != null)
    : [];
  const protocols = Array.isArray(source.apiProtocols)
    ? source.apiProtocols.map(trimmed).filter(Boolean)
    : [];
  return {
    writable: source.writable === true,
    default: {
      provider,
      model,
      reasoningEffort,
      revision: revision(defaultSource.revision),
      providerOptions,
      modelOptions,
    },
    official: normalizeOfficial(source.official),
    customProviders,
    declaredProviders,
    apiProtocols: protocols.length ? protocols : [...DEFAULT_API_PROTOCOLS],
  };
}

/**
 * 默认模型的「当前 provider 下的模型选项」。
 *
 * 三层兼容：
 * 1. BFF 的 modelOptions 每项带 `provider` 字段（当前实现，见 server/routes/agentConsole.ts）——
 *    直接按 provider 过滤，当前 provider 没有模型就返回空列表（下拉显示「没有可选模型」）；
 * 2. 旧形状若把 provider 编码进 value（`provider/model` / `provider:model`）——按前缀过滤并去掉前缀；
 * 3. 都没有（脏数据/形状不同）——退回整份列表，宁可多显示也不要空下拉。
 */
export function splitModelOptions(modelOptions: SelectOption[], provider: string): SelectOption[] {
  const list = options(modelOptions);
  if (!provider) return list.map(({ value, label }) => ({ value, label }));
  if (list.some((option) => option.provider)) {
    return list
      .filter((option) => option.provider === provider)
      .map(({ value, label }) => ({ value, label }));
  }
  const prefixes = [`${provider}/`, `${provider}:`, `${provider}::`];
  const matched: SelectOption[] = [];
  for (const option of list) {
    const hit = prefixes.find((prefix) => option.value.startsWith(prefix) && option.value.length > prefix.length);
    if (!hit) continue;
    const value = option.value.slice(hit.length);
    matched.push({ value, label: option.label || value });
  }
  return matched.length ? matched : list.map(({ value, label }) => ({ value, label }));
}

/* ── 1.3 插件 ─────────────────────────────────────────── */

const FIELD_TYPES: ReadonlySet<string> = new Set(['number', 'boolean', 'text', 'secret', 'select']);

function normalizePluginField(value: unknown): PluginFieldPayload | null {
  const source = record(value);
  const key = trimmed(source.key);
  if (!key) return null;
  const rawType = trimmed(source.type);
  const type = (FIELD_TYPES.has(rawType) ? rawType : 'text') as PluginFieldPayload['type'];
  const field: PluginFieldPayload = {
    key,
    label: trimmed(source.label) || key,
    type,
  };
  const hint = trimmed(source.hint);
  if (hint) field.hint = hint;
  if (source.value !== undefined) field.value = source.value;
  if (Array.isArray(source.options)) field.options = options(source.options);
  const min = optionalNumber(source.min);
  const max = optionalNumber(source.max);
  const step = optionalNumber(source.step);
  if (min != null) field.min = min;
  if (max != null) field.max = max;
  if (step != null && step > 0) field.step = step;
  const placeholder = trimmed(source.placeholder);
  if (placeholder) field.placeholder = placeholder;
  if (source.configured === true) field.configured = true;
  return field;
}

function normalizePluginCard(value: unknown): PluginCardPayload | null {
  const source = record(value);
  const key = trimmed(source.key);
  if (!key) return null;
  const fields = Array.isArray(source.fields)
    ? source.fields.map(normalizePluginField).filter((item): item is PluginFieldPayload => item != null)
    : [];
  const revisions: Record<string, number> = {};
  for (const [ns, rawRevision] of Object.entries(record(source.revisions))) {
    if (!ns.trim()) continue;
    revisions[ns] = revision(rawRevision);
  }
  return {
    key,
    title: trimmed(source.title) || key,
    description: trimmed(source.description),
    icon: trimmed(source.icon),
    fields,
    revisions,
  };
}

function normalizeExperimental(value: unknown): ExperimentalPluginPayload | null {
  const source = record(value);
  const id = trimmed(source.id);
  const key = trimmed(source.key) || id;
  if (!id || !key) return null;
  return {
    key,
    title: trimmed(source.title) || id,
    description: trimmed(source.description),
    tag: trimmed(source.tag) || '实验性',
    enabled: source.enabled === true,
    kind: source.kind === 'bundle' ? 'bundle' : 'plugin',
    id,
  };
}

function normalizeInventoryItem(value: unknown): PluginInventoryItemPayload | null {
  const source = record(value);
  const entryId = trimmed(source.entryId);
  if (!entryId) return null;
  return {
    entryId,
    title: trimmed(source.title) || trimmed(source.module) || entryId,
    ...(trimmed(source.description) ? { description: trimmed(source.description) } : {}),
    module: trimmed(source.module),
    enabled: source.enabled === true,
    status: trimmed(source.status),
    scope: source.scope === 'session' ? 'session' : 'global',
  };
}

export function normalizePlugins(raw: unknown): PluginsPayload {
  const source = record(raw);
  return {
    writable: source.writable === true,
    cards: Array.isArray(source.cards)
      ? source.cards.map(normalizePluginCard).filter((item): item is PluginCardPayload => item != null)
      : [],
    experimental: Array.isArray(source.experimental)
      ? source.experimental.map(normalizeExperimental).filter((item): item is ExperimentalPluginPayload => item != null)
      : [],
    inventory: Array.isArray(source.inventory)
      ? source.inventory.map(normalizeInventoryItem).filter((item): item is PluginInventoryItemPayload => item != null)
      : [],
  };
}

/** 插件清单按 scope 分组（导航只读、默认收起；未知 scope 归全局） */
export function groupInventory(inventory: PluginInventoryItemPayload[]): {
  session: PluginInventoryItemPayload[];
  global: PluginInventoryItemPayload[];
} {
  const session: PluginInventoryItemPayload[] = [];
  const global: PluginInventoryItemPayload[] = [];
  for (const item of inventory) {
    if (item.scope === 'session') session.push(item);
    else global.push(item);
  }
  return { session, global };
}

/** 清单行状态文案 + 色调：后端 status 可能是英文枚举或中文，按关键词兜底 */
export function inventoryStatusLabel(status: string, enabled = false): { text: string; tone: StatusTone } {
  const key = (status || '').trim().toLowerCase();
  if (/(fail|error|broken|异常|失败)/.test(key)) return { text: '启动失败', tone: 'warn' };
  if (/(disable|停用|关闭)/.test(key)) return { text: '已停用', tone: 'muted' };
  if (/(condition|conditional|条件)/.test(key)) return { text: '条件启用', tone: 'muted' };
  if (/(preset|预设)/.test(key)) return { text: '预设中启用', tone: 'ok' };
  if (/(enable|active|running|启用|运行中|就绪)/.test(key)) return { text: '已启用', tone: 'ok' };
  return enabled ? { text: '已启用', tone: 'ok' } : { text: '已停用', tone: 'muted' };
}

/* ── 1.4 Agent 预设 ───────────────────────────────────── */

function normalizePreset(value: unknown): PresetItemPayload | null {
  const source = record(value);
  const id = trimmed(source.id);
  if (!id) return null;
  const preset: PresetItemPayload = {
    id,
    title: trimmed(source.title) || id,
    description: trimmed(source.description),
  };
  const tag = trimmed(source.tag);
  if (tag) preset.tag = tag;
  const broken = trimmed(source.broken);
  if (broken) preset.broken = broken;
  return preset;
}

export function normalizePresets(raw: unknown): PresetsPayload {
  const source = record(raw);
  return {
    writable: source.writable === true,
    selected: trimmed(source.selected),
    revision: revision(source.revision),
    presets: Array.isArray(source.presets)
      ? source.presets.map(normalizePreset).filter((item): item is PresetItemPayload => item != null)
      : [],
  };
}

/* ── 1.5 高级 ─────────────────────────────────────────── */

export function normalizeAdvanced(raw: unknown): AdvancedPayload {
  const source = record(raw);
  const sessionLog = record(source.sessionLog);
  const consoleInfo = record(source.console);
  return {
    writable: source.writable === true,
    sessionLog: {
      enabled: sessionLog.enabled === true,
      revision: revision(sessionLog.revision),
    },
    console: {
      dshVersion: consoleInfo.dshVersion == null ? null : trimmed(consoleInfo.dshVersion) || null,
      home: trimmed(consoleInfo.home),
    },
  };
}

/* ── 保存/冲突判定 ────────────────────────────────────── */

/**
 * 是否「revision 冲突」（HTTP 409 或错误体 code 暗示冲突）。
 * 写接口带 expectedRevision：409 时前端必须刷新并提示重试，不能把旧值再写一遍。
 */
const CONFLICT_CODES = ['revision-conflict', 'revision_conflict', 'conflict', 'revision-mismatch', 'stale-revision'];

export function revisionConflict(error: unknown): boolean {
  const source = record(error);
  const response = record(source.response);
  const responseData = record(response.data);
  const status = finiteNumber(response.status, finiteNumber(source.status, 0));
  const code = (trimmed(source.code) || trimmed(responseData.code)).toLowerCase();
  const message = (`${trimmed(source.message)} ${trimmed(responseData.error)} ${trimmed(responseData.detail)}`).toLowerCase();
  if (code) {
    if (CONFLICT_CODES.includes(code)) return true;
    // 409 不只表示版本冲突：例如 plugin-toggle-failed（dsh 返回 application != applied）——
    // 这类失败要把服务端原话透给用户，不能误报「配置已在别处被修改」。
    if (/toggle|failed|invalid|not-found|bad-request/.test(code) && !/revision|conflict/.test(code)) return false;
  }
  if (status === 409) return true;
  return /revision|版本冲突|已被修改|已被别处修改|conflict/.test(message);
}

/* ── 插件表单：schema → 表单默认值 / 表单 → 提交载荷 ───── */

/** 表单里的一个值：开关用 boolean，其余用字符串（number 也先转字符串，便于 v-model 输入） */
export type PluginFormValue = string | boolean;
export type PluginFormState = Record<string, PluginFormValue>;
export type PluginSecretState = Record<string, string>;

/** schema 默认值：缺失/类型不对的 field.value 不落进表单，避免 [object Object] */
export function pluginFormDefaults(card: Pick<PluginCardPayload, 'fields'>): PluginFormState {
  const form: PluginFormState = {};
  for (const field of card.fields) {
    if (field.type === 'boolean') form[field.key] = field.value === true;
    else if (field.type === 'number') {
      const parsed = optionalNumber(field.value);
      form[field.key] = parsed == null ? '' : String(parsed);
    } else if (field.type === 'secret') form[field.key] = '';
    else form[field.key] = text(field.value);
  }
  return form;
}

/**
 * 表单 → PATCH /plugins/config/:cardKey 的 values。
 * - secret 只有用户真的输入了才提交（留空 = 不改，服务端不回显）；
 * - number 输入非法/留空时不提交该键（保留原值），而不是传 NaN / 0 覆盖；
 * - 每个卡片带回服务端给的 `revisions`（ns -> revision）作为 expectedRevisions。
 */
export function pluginConfigPayload(
  card: Pick<PluginCardPayload, 'fields' | 'revisions'>,
  form: PluginFormState,
  secrets: PluginSecretState = {},
): { values: Record<string, unknown>; expectedRevisions: Record<string, number> } {
  const values: Record<string, unknown> = {};
  for (const field of card.fields) {
    if (field.type === 'secret') {
      const secret = text(secrets[field.key]).trim();
      if (secret) values[field.key] = secret;
      continue;
    }
    const raw = form[field.key];
    if (field.type === 'boolean') {
      values[field.key] = raw === true;
      continue;
    }
    if (field.type === 'number') {
      const parsed = optionalNumber(raw);
      if (parsed != null) values[field.key] = parsed;
      continue;
    }
    values[field.key] = text(raw);
  }
  return { values, expectedRevisions: { ...card.revisions } };
}
