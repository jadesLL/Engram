/**
 * 「内置 Agent 运行时」面板的纯函数：类型、归一化、中文口径、过滤 / 分组 / 排序。
 *
 * 数据全部来自服务端 `GET /api/assistant/inventory`（契约见 docs/AGENT-RUNTIME-INVENTORY.md
 * 第 5 节）：dsh 自己 `--dump-config` / `--dump-config-schema` 的结果由服务端归一成
 * plugins[] / settings[]，前端**不**自己推导插件归属或配置来源，只负责「怎么说」（中文标签、
 * 色调）与「怎么筛 / 怎么排」。把这些口径集中在这里，组件里只剩模板，测试也只测这一层。
 *
 * 为什么归一化要在前端再做一遍（normalizeInventory）：dump 解析是跨 dsh 版本的，0.2.x 之间
 * 字段可能增删；面板宁可按空清单 / 未知值降级展示，也不能因为一个字段缺失整块白屏。
 */

/** dump 里的层归属：Engram 注入 / 用户配置 / 无法归属 / 随包的两个 bundle */
export type InventoryLayer = 'engram' | 'user' | 'unknown' | 'dsh-base' | 'dsh-sdk-app';
/** 插件状态：启用 / 配置里 disabled / 按 !!js 条件加载 / schema 标 absent（未激活） */
export type InventoryPluginStatus = 'active' | 'disabled' | 'conditional' | 'absent';
/** 设置项最终生效的来源层 */
export type InventorySettingSource = 'bundle' | 'profile-patch' | 'engram' | 'env' | 'default';
/** 面板三块内容 */
export type InventoryTab = 'plugins' | 'settings' | 'advanced';

export interface InventoryRuntime {
  dshVersion: string;
  sdkClientVersion: string;
  profile: string;
  bundles: string[];
  home: string;
  profileDir: string;
  patchFile: string;
  /** Engram 写进 patch 的条目 id（mcp-engram / llm-pi-ai / agent-default-model） */
  engramEntries: string[];
}

export interface InventoryPlugin {
  entryId: string;
  name: string;
  shortName: string;
  /** 由包名解析本机 package.json 得到；解析不到为 null（界面显示「版本未知」） */
  version: string | null;
  layer: InventoryLayer | string;
  status: InventoryPluginStatus | string;
  /** status === 'conditional' 时是那条 !!js 表达式 */
  disabled: string | null;
  configKeys: string[];
  config: Record<string, unknown>;
}

export interface InventorySetting {
  entryId: string;
  plugin: string;
  path: string;
  type: string;
  required: boolean;
  default: unknown;
  current: unknown;
  source: InventorySettingSource | string;
  /** 敏感项：服务端已把值替换成 ••••，界面只追加锁形提示 */
  secret: boolean;
  volatile: boolean;
  description: string;
}

export interface AgentInventory {
  generatedAt: string;
  /** 本次是缓存兜底（dump 失败 / 未重跑），界面提示「可能过期」 */
  stale: boolean;
  runtime: InventoryRuntime;
  plugins: InventoryPlugin[];
  settings: InventorySetting[];
  errors: string[];
}

export interface PluginLayerGroup {
  layer: string;
  label: string;
  /** 这一层是什么（分组头部的说明） */
  note: string;
  plugins: InventoryPlugin[];
  expandedByDefault: boolean;
}

export interface SettingsEntryGroup {
  /** 分组键：entryId，缺省退回 plugin，再缺省 (`unknown`) */
  key: string;
  entryId: string;
  plugin: string;
  /** 分组标题：优先插件名（包名），没有包名时用 entryId */
  label: string;
  rows: InventorySetting[];
}

export interface RuntimeFingerprintItem {
  key: string;
  label: string;
  value: string;
  /** 版本号 / 路径 / 时间这类值用等宽字体，bundles 用正文（有分隔符，等宽反而难读） */
  mono: boolean;
}

/* ------------------------------------------------------------------ *
 * 中文口径（标签 / 色调 / 说明）
 * ------------------------------------------------------------------ */

const LAYER_LABELS: Record<string, string> = {
  engram: 'Engram 注入',
  user: '用户配置',
  unknown: '未归属',
  'dsh-base': '随包 dsh-base',
  'dsh-sdk-app': '随包 dsh-sdk-app',
};

const LAYER_NOTES: Record<string, string> = {
  engram: 'Engram 写进 engram.cordis.yml 的 patch：MCP 工具与模型路由',
  user: '你自己在 dsh 配置里加的条目（profile / home 级 patch）',
  unknown: 'dump 里没有层归属标记的条目，通常是 entry 被别处引用',
  'dsh-base': '随包 @deepseek-ai/dsh-base 提供的条目：量大，默认折叠',
  'dsh-sdk-app': '随包 @deepseek-ai/dsh-sdk-app 提供的条目：量大，默认折叠',
};

/**
 * 层分组顺序：Engram 注入置顶（用户最先关心自己这套配了什么），未知层紧跟用户层，
 * 随包的两个 bundle 垫底（上百条、默认折叠，翻到那里通常是为了排障）。
 */
export const LAYER_ORDER: readonly string[] = ['engram', 'user', 'unknown', 'dsh-base', 'dsh-sdk-app'];

export function layerLabel(layer: string): string {
  return LAYER_LABELS[layer] || String(layer || '') || '未归属';
}

export function layerNote(layer: string): string {
  return LAYER_NOTES[layer] || '层归属未知的条目';
}

/** 层在分组里的排序权重（未知层排在已知层之后，同级按层名兜底，保证顺序稳定） */
export function layerRank(layer: string): number {
  const index = LAYER_ORDER.indexOf(layer);
  return index >= 0 ? index : LAYER_ORDER.length;
}

/** 随包的两层默认折叠（占屏最多、日常不看）；Engram / 用户 / 未知层默认展开 */
export function layerExpandedByDefault(layer: string): boolean {
  return layer !== 'dsh-base' && layer !== 'dsh-sdk-app';
}

const STATUS_LABELS: Record<string, string> = {
  active: '启用',
  disabled: '已禁用',
  conditional: '按条件',
  absent: '未激活',
};

export type BadgeTone = 'ok' | 'warn' | 'accent' | 'muted';

export function pluginStatusLabel(status: string): string {
  return STATUS_LABELS[status] || String(status || '') || '未知';
}

/** 状态徽标色调：启用绿 / 禁用黄 / 条件加载强调色 / 未激活中性色 */
export function pluginStatusTone(status: string): BadgeTone {
  switch (status) {
    case 'active':
      return 'ok';
    case 'disabled':
      return 'warn';
    case 'conditional':
      return 'accent';
    default:
      return 'muted';
  }
}

/** 徽标 hover 说明：回答「为什么它不是启用」 */
export function pluginStatusHint(plugin: Pick<InventoryPlugin, 'status' | 'disabled'>): string {
  switch (plugin.status) {
    case 'active':
      return '已加载并生效';
    case 'disabled':
      return '配置里把它关掉了（disabled）';
    case 'conditional':
      return plugin.disabled ? `按条件加载：${plugin.disabled}` : '按条件加载（表达式为空）';
    default:
      return '未激活：schema 标 absent，或这条 entry 没有被加载';
  }
}

const SOURCE_LABELS: Record<string, string> = {
  bundle: '随包默认',
  'profile-patch': 'profile 补丁',
  engram: 'Engram 配置',
  env: '环境变量',
  default: '默认值',
};

export function settingSourceLabel(source: string): string {
  return SOURCE_LABELS[source] || String(source || '') || '未知来源';
}

/** 来源色调：Engram 自己写的高亮，环境变量提醒「改这里不会生效」，其余中性 */
export function settingSourceTone(source: string): BadgeTone {
  if (source === 'engram') return 'accent';
  if (source === 'env') return 'warn';
  return 'muted';
}

/* ------------------------------------------------------------------ *
 * 格式化
 * ------------------------------------------------------------------ */

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item)).filter(Boolean);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 包名短名：@deepseek-ai/dsh-tool-fs → tool-fs（服务端没给 shortName 时的兜底） */
export function pluginShortName(packageName: string): string {
  const base = String(packageName || '').split('/').pop() || '';
  return base.replace(/^dsh-/, '');
}

/** 版本解析不到（null / 空串）时的人话，不要留一个空白格 */
export function pluginVersionLabel(version: string | null | undefined): string {
  return text(version) || '版本未知';
}

/** 包名去掉 scope：指纹条一行放得下，也照样一眼认出是哪个 bundle */
export function shortPackageName(packageName: string): string {
  return String(packageName || '').replace(/^@[^/]+\//, '');
}

export function bundlesText(bundles: readonly string[] | null | undefined): string {
  const list = (bundles || []).map(shortPackageName).filter(Boolean);
  return list.length ? list.join(' · ') : '未知';
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 生成时间：本地时区的 YYYY-MM-DD HH:mm；坏输入原样返回，不显示 Invalid Date */
export function formatInventoryTime(iso: string | null | undefined): string {
  const raw = text(iso);
  if (!raw) return '';
  const at = new Date(raw);
  if (!Number.isFinite(at.getTime())) return raw;
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

/** 设置项的值：布尔 / 数字原样，空串给出人话，对象给紧凑 JSON，null 用破折号 */
export function formatSettingValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value === '' ? '（空字符串）' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 插件配置摘要（折叠区里的文本）：有配置给缩进 JSON，只有声明键时退化成键值对 */
export function pluginConfigSummary(plugin: Pick<InventoryPlugin, 'config' | 'configKeys'>): string {
  const config = record(plugin.config);
  const entries = Object.entries(config);
  if (entries.length) {
    try {
      return JSON.stringify(config, null, 2);
    } catch {
      return entries.map(([key, value]) => `${key}: ${formatSettingValue(value)}`).join('\n');
    }
  }
  const keys = plugin.configKeys || [];
  return keys.length ? keys.map((key) => `${key}: （未设置）`).join('\n') : '';
}

/** 配置项数量（配置块里的键为准；只有声明键时按声明数量算） */
export function pluginConfigCount(plugin: Pick<InventoryPlugin, 'config' | 'configKeys'>): number {
  const fromConfig = Object.keys(record(plugin.config)).length;
  return fromConfig || (plugin.configKeys ? plugin.configKeys.length : 0);
}

/* ------------------------------------------------------------------ *
 * 搜索 / 分组 / 排序
 * ------------------------------------------------------------------ */

export function normalizeQuery(query: string): string {
  return String(query ?? '').trim().toLowerCase();
}

/** 命中范围：短名、包名、entryId（用户手上可能只有其中任意一个） */
export function pluginMatchesQuery(plugin: InventoryPlugin, query: string): boolean {
  const needle = normalizeQuery(query);
  if (!needle) return true;
  return [plugin.shortName, plugin.name, plugin.entryId]
    .some((value) => String(value || '').toLowerCase().includes(needle));
}

export function filterPlugins(plugins: readonly InventoryPlugin[], query: string): InventoryPlugin[] {
  const needle = normalizeQuery(query);
  const list = [...plugins];
  return needle ? list.filter((plugin) => pluginMatchesQuery(plugin, needle)) : list;
}

function pluginSortKey(plugin: InventoryPlugin): string {
  return String(plugin.shortName || plugin.entryId || plugin.name || '').toLowerCase();
}

/** 层内按短名字母序：dump 的条目顺序随 dsh 版本变，字母序翻起来更可预期 */
export function sortPlugins(plugins: readonly InventoryPlugin[]): InventoryPlugin[] {
  return [...plugins].sort((a, b) => pluginSortKey(a).localeCompare(pluginSortKey(b)));
}

/** 按层分组 + 排序；空清单返回空数组（调用方负责空态文案） */
export function groupPluginsByLayer(plugins: readonly InventoryPlugin[]): PluginLayerGroup[] {
  const buckets = new Map<string, InventoryPlugin[]>();
  for (const plugin of plugins) {
    const layer = String(plugin.layer || 'unknown');
    const bucket = buckets.get(layer);
    if (bucket) bucket.push(plugin);
    else buckets.set(layer, [plugin]);
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => layerRank(left) - layerRank(right) || left.localeCompare(right))
    .map(([layer, list]) => ({
      layer,
      label: layerLabel(layer),
      note: layerNote(layer),
      plugins: sortPlugins(list),
      expandedByDefault: layerExpandedByDefault(layer),
    }));
}

/**
 * 设置项按 entryId 分组（契约里 entryId 是插件的 loader 标识；极少数只有 plugin 包名）。
 * 组内保持服务端给的顺序（同一插件的键按 schema 声明顺序读最顺），组间按标题字母序。
 */
export function groupSettingsByEntry(settings: readonly InventorySetting[]): SettingsEntryGroup[] {
  const buckets = new Map<string, InventorySetting[]>();
  for (const setting of settings) {
    const key = text(setting.entryId) || text(setting.plugin) || '(unknown)';
    const bucket = buckets.get(key);
    if (bucket) bucket.push(setting);
    else buckets.set(key, [setting]);
  }
  return [...buckets.entries()]
    .map(([key, rows]) => {
      const entryId = text(rows[0]?.entryId);
      const plugin = text(rows[0]?.plugin);
      return { key, entryId, plugin, label: plugin || entryId || key, rows };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/* ------------------------------------------------------------------ *
 * 面板级口径
 * ------------------------------------------------------------------ */

/** 内置 Agent 卡片顶部的一行摘要（status 接口的扩展字段；取不到就写「未知」） */
export function agentRuntimeSummary(status: { agentVersion?: unknown; profile?: unknown } | null | undefined): string {
  const version = text(status?.agentVersion) || '未知';
  const profile = text(status?.profile) || '未知';
  return `dsh ${version} · profile ${profile}`;
}

/** 指纹条的 8 项：版本 / SDK / profile / bundles / 数据目录 / profile 目录 / patch / 生成时间 */
export function runtimeFingerprint(
  runtime: Partial<InventoryRuntime> | null | undefined,
  generatedAt?: string | null,
): RuntimeFingerprintItem[] {
  // 显式标注：`runtime || {}` 的联合类型会让属性访问过不了 noUncheckedIndexedAccess 之外的严格检查
  const source: Partial<InventoryRuntime> = runtime || {};
  const orUnknown = (value: unknown) => text(value) || '未知';
  return [
    { key: 'dshVersion', label: 'dsh 版本', value: orUnknown(source.dshVersion), mono: true },
    { key: 'sdkClientVersion', label: 'SDK 客户端', value: orUnknown(source.sdkClientVersion), mono: true },
    { key: 'profile', label: 'profile', value: orUnknown(source.profile), mono: true },
    { key: 'bundles', label: 'bundles', value: bundlesText(source.bundles), mono: false },
    { key: 'home', label: 'DSH_HOME', value: orUnknown(source.home), mono: true },
    { key: 'profileDir', label: 'profile 目录', value: orUnknown(source.profileDir), mono: true },
    { key: 'patchFile', label: 'Engram patch', value: orUnknown(source.patchFile), mono: true },
    { key: 'generatedAt', label: '生成时间', value: formatInventoryTime(generatedAt) || '未知', mono: true },
  ];
}

/** 分组色带徽标：有错误 / 可能过期 / 插件总数（收起后也能看到面板状态） */
export function inventoryBadge(
  inventory: Pick<AgentInventory, 'stale' | 'errors' | 'plugins'> | null | undefined,
): { text: string; tone: 'warn' | 'muted' } {
  if (!inventory) return { text: '', tone: 'muted' };
  if (inventory.errors && inventory.errors.length) return { text: '有错误', tone: 'warn' };
  if (inventory.stale) return { text: '可能过期', tone: 'warn' };
  const count = inventory.plugins ? inventory.plugins.length : 0;
  return { text: `${count} 个插件`, tone: 'muted' };
}

/* ------------------------------------------------------------------ *
 * 归一化（服务端字段缺失 / 类型漂移时降级，不让面板白屏）
 * ------------------------------------------------------------------ */

function normalizeRuntime(raw: unknown): InventoryRuntime {
  const source = record(raw);
  return {
    dshVersion: text(source.dshVersion),
    sdkClientVersion: text(source.sdkClientVersion),
    profile: text(source.profile),
    bundles: stringList(source.bundles),
    home: text(source.home),
    profileDir: text(source.profileDir),
    patchFile: text(source.patchFile),
    engramEntries: stringList(source.engramEntries),
  };
}

function normalizePlugin(raw: unknown): InventoryPlugin {
  const source = record(raw);
  const entryId = text(source.entryId);
  const name = text(source.name);
  const shortName = text(source.shortName) || pluginShortName(name) || entryId;
  const config = record(source.config);
  const declaredKeys = stringList(source.configKeys);
  return {
    entryId: entryId || shortName,
    name,
    shortName,
    version: text(source.version) || null,
    layer: text(source.layer) || 'unknown',
    status: text(source.status) || 'absent',
    disabled: text(source.disabled) || text(source.disabledExpr) || null,
    configKeys: declaredKeys.length ? declaredKeys : Object.keys(config),
    config,
  };
}

function normalizeSetting(raw: unknown): InventorySetting {
  const source = record(raw);
  return {
    entryId: text(source.entryId),
    plugin: text(source.plugin),
    path: text(source.path),
    type: text(source.type),
    required: source.required === true,
    default: source.default !== undefined ? source.default : (source.defaultValue === undefined ? null : source.defaultValue),
    current: source.current === undefined ? null : source.current,
    source: text(source.source),
    secret: source.secret === true,
    volatile: source.volatile === true,
    description: text(source.description),
  };
}

/** 服务端响应 → 面板数据；非对象输入按空清单处理（界面显示空态而不是崩） */
export function normalizeInventory(raw: unknown): AgentInventory {
  const source = record(raw);
  const plugins = Array.isArray(source.plugins) ? source.plugins.map(normalizePlugin) : [];
  const settings = Array.isArray(source.settings) ? source.settings.map(normalizeSetting) : [];
  const errors = stringList(source.errors);
  return {
    generatedAt: text(source.generatedAt),
    stale: source.stale === true,
    runtime: normalizeRuntime(source.runtime),
    plugins,
    settings,
    errors,
  };
}
