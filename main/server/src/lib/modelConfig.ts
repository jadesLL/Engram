/** 模型配置存储：结构化表 model_entries（建表 DDL 位于 db.ts 的 migrate）取代
 *  settings 表里的 JSON 大字段。读取路径带「旧 settings key 回落」：生产环境启动时
 *  一次性迁移旧数据并删除旧 key；该回落同时保证直接以 setSetting('chat_models')
 *  种子化的存量测试无需改动。全部数据访问使用 ? / @name 占位符参数绑定。 */
import { db, getSetting, setSetting, now, newId } from './db.js';
import type { ProviderProtocol } from './modelCatalog.js';

export type ModelKind = 'chat' | 'embedding' | 'document';
export type ImageInputStatus = 'supported' | 'unsupported' | 'unknown';
export type ImageInputSource = 'stored' | 'catalog' | 'metadata' | 'probe';

/** 供应商不兼容参数的持久化降级声明（原进程内 Set 的落库形态） */
export interface ModelDialect {
  /** 供应商对 thinking 参数返回 400，请求不再携带 */
  thinkingRejected?: boolean;
  /** 供应商对 stream_options 返回 400，流式请求不再携带 */
  streamUsageRejected?: boolean;
}

export interface ModelEntry {
  id: string;
  name: string;      // 备注名
  provider: string;  // 预设 id
  line?: string;     // 线路 id
  baseUrl: string;
  modelsUrl?: string;
  logo?: string;
  model: string;
  apiKey: string;
  /** 请求协议：缺省按 OpenAI 兼容处理 */
  protocol?: ProviderProtocol;
  /** 模型列表拉取协议（anthropic 线路复用厂商 OpenAI /models 时为 openai） */
  modelsProtocol?: ProviderProtocol;
  /** 免鉴权线路（本地推理）：无 Key 也可调用 */
  authOptional?: boolean;
  /** 模型列表接口匿名可访问（拉取不需要 Key） */
  modelsAnonymous?: boolean;
  dim?: number;      // embedding 维度
  supportsDimensions?: boolean;
  imageInput?: ImageInputStatus;
  imageInputSource?: ImageInputSource;
  imageInputCheckedAt?: string;
  dialect?: ModelDialect;
}

interface ModelEntryRow {
  id: string;
  kind: string;
  name: string;
  provider: string;
  line: string | null;
  base_url: string;
  models_url: string | null;
  logo: string | null;
  model: string;
  api_key: string;
  protocol: string | null;
  models_protocol: string | null;
  auth_optional: number | null;
  models_anonymous: number | null;
  dim: number | null;
  supports_dimensions: number | null;
  image_input: string | null;
  image_input_source: string | null;
  image_input_checked_at: string | null;
  dialect: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const KIND_SETTINGS_KEY: Record<ModelKind, string> = {
  chat: 'chat_models',
  embedding: 'embedding_models',
  document: 'document_models',
};

const KIND_ACTIVE_KEY: Record<ModelKind, string> = {
  chat: 'active_chat_model',
  embedding: 'active_embedding_model',
  document: 'active_document_model',
};

const KIND_NEW_ACTIVE_KEY: Record<ModelKind, string> = {
  chat: 'model_active_chat',
  embedding: 'model_active_embedding',
  document: 'model_active_document',
};

function safeParseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** 旧 settings key 的 JSON 列表解析（兼容未迁移数据与测试种子） */
export function parseLegacyEntries(kind: ModelKind): ModelEntry[] {
  const raw = getSetting(KIND_SETTINGS_KEY[kind]);
  const parsed = safeParseJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is ModelEntry =>
    Boolean(item && typeof item === 'object' && typeof (item as any).id === 'string'));
}

function rowToEntry(row: ModelEntryRow): ModelEntry {
  const dialect = safeParseJson(row.dialect) as ModelDialect | null;
  const protocol = row.protocol === 'anthropic' ? 'anthropic' : 'openai';
  const modelsProtocol = row.models_protocol === 'anthropic'
    ? 'anthropic'
    : row.models_protocol === 'openai' ? 'openai' : undefined;
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    ...(row.line ? { line: row.line } : {}),
    baseUrl: row.base_url,
    ...(row.models_url ? { modelsUrl: row.models_url } : {}),
    ...(row.logo ? { logo: row.logo } : {}),
    model: row.model,
    apiKey: row.api_key,
    ...(protocol !== 'openai' ? { protocol } : {}),
    ...(modelsProtocol ? { modelsProtocol } : {}),
    ...(row.auth_optional ? { authOptional: true } : {}),
    ...(row.models_anonymous ? { modelsAnonymous: true } : {}),
    ...(row.dim !== null && row.dim !== undefined ? { dim: row.dim } : {}),
    ...(row.supports_dimensions ? { supportsDimensions: true } : {}),
    ...(row.image_input ? { imageInput: row.image_input as ImageInputStatus } : {}),
    ...(row.image_input_source ? { imageInputSource: row.image_input_source as ImageInputSource } : {}),
    ...(row.image_input_checked_at ? { imageInputCheckedAt: row.image_input_checked_at } : {}),
    ...(dialect && Object.keys(dialect).length ? { dialect } : {}),
  };
}

function entryToRow(entry: ModelEntry, kind: ModelKind, sortOrder: number): ModelEntryRow {
  const ts = now();
  return {
    id: entry.id || newId(),
    kind,
    name: entry.name || '',
    provider: entry.provider || 'custom',
    line: entry.line || null,
    base_url: (entry.baseUrl || '').replace(/\/+$/, ''),
    models_url: entry.modelsUrl || null,
    logo: entry.logo || null,
    model: entry.model || '',
    api_key: entry.apiKey || '',
    protocol: entry.protocol === 'anthropic' ? 'anthropic' : 'openai',
    models_protocol: entry.modelsProtocol || null,
    auth_optional: entry.authOptional ? 1 : 0,
    models_anonymous: entry.modelsAnonymous ? 1 : 0,
    dim: entry.dim ?? null,
    supports_dimensions: entry.supportsDimensions ? 1 : 0,
    image_input: entry.imageInput || null,
    image_input_source: entry.imageInputSource || null,
    image_input_checked_at: entry.imageInputCheckedAt || null,
    dialect: JSON.stringify(entry.dialect || {}),
    sort_order: sortOrder,
    created_at: ts,
    updated_at: ts,
  };
}

/** 读取某池全部条目：新表优先，为空时回落旧 settings key。 */
export function listModelEntries(kind: ModelKind): ModelEntry[] {
  let rows: ModelEntryRow[] = [];
  try {
    rows = db
      .prepare('SELECT * FROM model_entries WHERE kind = ? ORDER BY sort_order, created_at')
      .all(kind) as ModelEntryRow[];
  } catch (error: any) {
    if (String(error?.message || error).includes('no such table: model_entries')) {
      return parseLegacyEntries(kind);
    }
    throw error;
  }
  if (rows.length > 0) return rows.map(rowToEntry);
  return parseLegacyEntries(kind);
}

/** 激活条目 id：新 key 优先，回落旧 key。 */
export function activeModelId(kind: ModelKind): string {
  return getSetting(KIND_NEW_ACTIVE_KEY[kind])
    || getSetting(KIND_ACTIVE_KEY[kind])
    || listModelEntries(kind)[0]?.id
    || '';
}

export function getActiveModelEntry(kind: ModelKind): ModelEntry | null {
  const list = listModelEntries(kind);
  const activeId = activeModelId(kind);
  return list.find((entry) => entry.id === activeId) || list[0] || null;
}

/** 设置激活条目（Agent 工具 switch_active_model 与设置页共用）。 */
export function setActiveModelId(kind: ModelKind, id: string): void {
  setSetting(KIND_NEW_ACTIVE_KEY[kind], id);
}

export interface ModelConfigPayload {
  chat?: ModelEntry[];
  embedding?: ModelEntry[];
  document?: ModelEntry[];
  activeChat?: string;
  activeEmbedding?: string;
  activeDocument?: string;
}

/** 全量保存模型配置（前端语义：整列表回传）。
 *  API Key 留空的既有条目自动沿用库中原值，前端无需持有明文 key。 */
export function saveModelConfig(payload: ModelConfigPayload): void {
  const persist = db.transaction(() => {
    saveKindEntries('chat', payload.chat);
    saveKindEntries('embedding', payload.embedding);
    saveKindEntries('document', payload.document);
    if (payload.activeChat !== undefined) setSetting(KIND_NEW_ACTIVE_KEY.chat, payload.activeChat);
    if (payload.activeEmbedding !== undefined) setSetting(KIND_NEW_ACTIVE_KEY.embedding, payload.activeEmbedding);
    if (payload.activeDocument !== undefined) setSetting(KIND_NEW_ACTIVE_KEY.document, payload.activeDocument);
  });
  persist();
}

function saveKindEntries(kind: ModelKind, entries: ModelEntry[] | undefined): void {
  if (!Array.isArray(entries)) return;
  const existing = new Map(
    (db.prepare('SELECT id, api_key, dialect FROM model_entries WHERE kind = ?').all(kind) as
      { id: string; api_key: string; dialect: string }[])
      .map((row) => [row.id, row]),
  );
  db.prepare('DELETE FROM model_entries WHERE kind = ?').run(kind);
  const insert = db.prepare(
    'INSERT INTO model_entries (id, kind, name, provider, line, base_url, models_url, logo, model, api_key, protocol, models_protocol, auth_optional, models_anonymous, dim, supports_dimensions, image_input, image_input_source, image_input_checked_at, dialect, sort_order, created_at, updated_at) VALUES (@id, @kind, @name, @provider, @line, @base_url, @models_url, @logo, @model, @api_key, @protocol, @models_protocol, @auth_optional, @models_anonymous, @dim, @supports_dimensions, @image_input, @image_input_source, @image_input_checked_at, @dialect, @sort_order, @created_at, @updated_at)'
  );
  entries.forEach((entry, index) => {
    const row = entryToRow(entry, kind, index);
    const prev = existing.get(row.id);
    // 空 key 或掩码回传（列表通道脱敏下发后原样保存）都视为沿用库中原值，
    // 防止掩码字面量覆盖明文
    if (prev && (!row.api_key || row.api_key.includes('*'))) row.api_key = prev.api_key;
    if (prev && !entry.dialect) row.dialect = prev.dialect;
    insert.run(row as unknown as Record<string, unknown>);
  });
}

/** 旧 settings JSON → model_entries 一次性迁移（db.ts 的 migrate 启动时调用）。
 *  返回迁移条数；迁移后删除旧 key，读取路径自此全部走新表。
 *  前置条件：model_entries 表已由 db.ts 的 DDL 块创建。 */
export function migrateLegacyModelConfig(): number {
  const counts = db.prepare('SELECT kind, COUNT(*) AS n FROM model_entries GROUP BY kind')
    .all() as { kind: string; n: number }[];
  const hasRows = counts.some((row) => row.n > 0);
  const legacyPayload: ModelConfigPayload = {};
  let migrated = 0;
  legacyPayload.chat = parseLegacyEntries('chat');
  legacyPayload.embedding = parseLegacyEntries('embedding');
  legacyPayload.document = parseLegacyEntries('document');
  migrated = legacyPayload.chat.length + legacyPayload.embedding.length + legacyPayload.document.length;
  if (hasRows || migrated === 0) return 0;
  // 旧 key 里的激活 id 一并搬迁；迁移成功后写入新 key 并删除旧 key，
  // 读取路径自此全部走新表
  legacyPayload.activeChat = getSetting(KIND_ACTIVE_KEY.chat) || undefined;
  legacyPayload.activeEmbedding = getSetting(KIND_ACTIVE_KEY.embedding) || undefined;
  legacyPayload.activeDocument = getSetting(KIND_ACTIVE_KEY.document) || undefined;
  const run = db.transaction(() => {
    saveModelConfig(legacyPayload);
    for (const kind of ['chat', 'embedding', 'document'] as ModelKind[]) {
      db.prepare('DELETE FROM settings WHERE key = ?').run(KIND_SETTINGS_KEY[kind]);
      db.prepare('DELETE FROM settings WHERE key = ?').run(KIND_ACTIVE_KEY[kind]);
    }
  });
  run();
  return migrated;
}

/** API Key 打码（列表/回显通道不回传明文） */
export function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 4) return '*'.repeat(key.length);
  if (key.length <= 8) return `${key.slice(0, 2)}****${key.slice(-2)}`;
  return `${key.slice(0, 4)}********${key.slice(-4)}`;
}

export function maskEntryKey(entry: ModelEntry): ModelEntry {
  return { ...entry, apiKey: maskApiKey(entry.apiKey) };
}

/** 查询条目明文 Key（设置页「查看完整 Key」） */
export function revealModelKey(id: string): string | undefined {
  const row = db.prepare('SELECT api_key FROM model_entries WHERE id = ?')
    .get(id) as { api_key: string } | undefined;
  if (row) return row.api_key;
  for (const kind of ['chat', 'embedding', 'document'] as ModelKind[]) {
    const legacy = parseLegacyEntries(kind).find((entry) => entry.id === id);
    if (legacy) return legacy.apiKey;
  }
  return undefined;
}

/** 按 id 补全真实 Key：测试/探测请求带回的 entry.apiKey 为空或掩码时使用库中原值。 */
export function resolveEntrySecretKey(entry: ModelEntry): string {
  if (entry.apiKey && !entry.apiKey.includes('*')) return entry.apiKey;
  const stored = revealModelKey(entry.id);
  if (stored) return stored;
  // 掩码但库里查不到（未迁移旧数据）时在旧池里按 同 provider+baseUrl+model 兜底；
  // 未保存的新条目：前端刚输入的明文 key（非掩码）已在前面的分支返回
  for (const kind of ['chat', 'embedding', 'document'] as ModelKind[]) {
    const hit = parseLegacyEntries(kind).find((candidate) =>
      candidate.provider === entry.provider
      && candidate.baseUrl.replace(/\/+$/, '') === entry.baseUrl.replace(/\/+$/, '')
      && candidate.model === entry.model
      && candidate.apiKey);
    if (hit) return hit.apiKey;
  }
  return entry.apiKey;
}

/** 持久化供应商参数降级记忆（thinking/stream_options 试错结果）。
 *  仅在状态发生变化时写库，热路径无额外开销；未保存的临时条目静默跳过。 */
export function markEntryDialect(id: string, patch: ModelDialect): void {
  if (!id) return;
  try {
    const row = db.prepare('SELECT dialect FROM model_entries WHERE id = ?')
      .get(id) as { dialect: string } | undefined;
    if (!row) return;
    const current = (safeParseJson(row.dialect) as ModelDialect | null) || {};
    const next = { ...current, ...patch };
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    db.prepare('UPDATE model_entries SET dialect = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(next), now(), id);
  } catch { /* 记忆落库失败不影响请求本身 */ }
}
