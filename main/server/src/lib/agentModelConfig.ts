import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { profilePatchPath } from '../assistant/agentSettings.js';
import {
  findTopLevelEntry,
  indentOf,
  isSkippable,
  modelKeyRef,
  parseCredentialRefs,
  parseDshProviders,
  parseStringList,
  unquoteScalar,
  type DshProviderModel,
} from './videoModel.js';

/**
 * 内置 Agent 模型配置的读取 / 合并 / 写回（多端同步 `agent_model_config` 的数据面）。
 *
 * 为什么直接读写 dsh 的两个文件、而不是调控制台 RPC：
 *  - 收到对端配置时控制台未必在跑，起 dsh 进程会引入 origin / 权限耦合，还会打断同步轮；
 *  - dsh 的模型配置本来就只有两个真源：`profiles/web/cordis.patch.yml`（llm-pi-ai /
 *    llm-deepseek / agent-default-model 三个顶层条目）与 `.credentials.yaml`（refs 段）。
 *
 * 写入策略是**文本级保守编辑**：只动上面三类条目里本方负责的字段，其它顶层条目、注释、
 * 缩进与 `records` 等段落逐字保留；写前各留一份 `*.engram-bak`。不做整份 YAML 重排——
 * dsh 的 patch 允许用户手写 `!!js` 等标签，引入 YAML 依赖或全量序列化都可能把用户配置改坏。
 *
 * 所有解析都容忍坏输入：文件不存在 / JSON 不是对象 / 行结构不认识 → 当空配置返回，绝不抛。
 */

/** 同步偏好项 key（走 preference 管道，归属「设置」分类） */
export const AGENT_MODEL_CONFIG_KEY = 'agent_model_config';
/** 同步值上限（契约 256KB；mergePreference 另有 1MB 兜底） */
export const AGENT_MODEL_CONFIG_MAX_BYTES = 256 * 1024;

/** 第三方 / 自定义提供商的模型条目（dsh llm-pi-ai 的 models） */
export interface SyncedProviderModel {
  id: string;
  name?: string;
  contextWindow?: number;
  /** pi-ai 的输入能力字段名是 input（缺省表示继承提供商默认） */
  input?: string[];
}

/** 第三方 / 自定义提供商（llm-pi-ai 的 config.providers.<id>） */
export interface SyncedProviderConfig {
  displayName?: string;
  /** 线协议，默认 openai-completions */
  api?: string;
  baseURL?: string;
  /** 缺省 = <ID>_API_KEY */
  apiKeyEnv?: string;
  models: SyncedProviderModel[];
}

/** 官方 DeepSeek 模型条目（llm-deepseek 的 config） */
export interface SyncedOfficialModel {
  id: string;
  name?: string;
  contextWindow?: number;
  inputModalities?: string[];
}

export interface SyncedOfficialConfig {
  apiKeyEnv?: string;
  /** 空 = 官方地址（同步值里保留空串表示「对端就是官方地址」，写回时据此清掉本机自定义地址） */
  baseURL?: string;
  maxTokens?: number;
  models?: SyncedOfficialModel[];
}

/** 默认模型（agent-default-model） */
export interface SyncedDefaultModel {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/**
 * 同步偏好项 `agent_model_config` 的值结构（契约见 docs/AGENT-MODEL-SYNC.md）。
 * 注意：`keys` 含明文，只允许在本机与同步群组内传输，任何接口 / 日志都不得回显。
 */
export interface SyncedAgentModelConfig {
  version: 1;
  official: SyncedOfficialConfig;
  providers: Record<string, SyncedProviderConfig>;
  default: SyncedDefaultModel;
  keys: Record<string, string>;
}

export interface AgentModelWriteResult {
  patchChanged: boolean;
  credentialsChanged: boolean;
}

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function splitLines(text: string): string[] {
  const normalized = text.replace(/^\uFEFF/, '');
  if (!normalized) return [];
  return normalized.split(/\r?\n/);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function trimmedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

/** 需要引号时才用单引号包（中文 / 括号 / 斜杠都可以直接写，保持与 dsh 设置页一致的朴素写法） */
function yamlScalar(value: string): string {
  const needsQuoting = value.length === 0
    || /^[-?:,[\]{}#&*!|>'"%@`]/.test(value)
    || value.includes(': ')
    || value.includes(' #')
    || /^\s|\s$/.test(value)
    || /[\r\n]/.test(value);
  return needsQuoting ? "'" + value.replace(/'/g, "''") + "'" : value;
}

/** 末尾可跳过的行（空行 / 注释）不参与块范围，插入时插到最后一个内容行之后 */
function trimmedEnd(lines: string[], start: number, end: number): number {
  let at = end;
  while (at > start && isSkippable(lines[at - 1])) at -= 1;
  return at;
}

/**
 * 一个 YAML 映射块（缩进固定）里的条目：key → 行区间 [line, end)。
 * 只认 `key: value` 形式的行（序列项 `- id:` 不算映射条目），子块行归入上一条目。
 */
interface MappingEntry {
  key: string;
  line: number;
  end: number;
  /** 行内值原文（不含 key 与冒号）；多行块为空串 */
  value: string;
}

function mappingEntries(lines: string[], start: number, end: number, indent: number): MappingEntry[] {
  const entries: MappingEntry[] = [];
  let index = start;
  while (index < end) {
    const line = lines[index];
    if (isSkippable(line) || indentOf(line) !== indent) {
      index += 1;
      continue;
    }
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line.trim());
    if (!match) {
      index += 1;
      continue;
    }
    let cursor = index + 1;
    while (cursor < end) {
      const next = lines[cursor];
      if (isSkippable(next)) {
        cursor += 1;
        continue;
      }
      if (indentOf(next) <= indent) break;
      cursor += 1;
    }
    entries.push({ key: match[1], line: index, end: cursor, value: match[2] });
    index = cursor;
  }
  return entries;
}

/**
 * 映射块末尾的插入位置（跳过尾部空行 / 注释）。
 *
 * 必须用块的整体末尾而不是「最后一条映射条目」的位置：序列块（models:）的子项
 * 缩进与字段相同，条目级 end 会停在第一条 '-' 上，插在那里会把新字段塞进序列里。
 */
function mappingInsertIndex(lines: string[], start: number, end: number): number {
  return Math.max(start, trimmedEnd(lines, start, end));
}

/** 序列块（models: 下用 '-' 开头的行）的范围：同缩进的 '-' 行及其续行 */
function sequenceEnd(lines: string[], line: number, limit: number, indent: number): number {
  let end = line + 1;
  while (end < limit) {
    const current = lines[end];
    if (isSkippable(current)) {
      end += 1;
      continue;
    }
    const currentIndent = indentOf(current);
    if (currentIndent < indent) break;
    if (currentIndent === indent && !current.trim().startsWith('-')) break;
    end += 1;
  }
  return trimmedEnd(lines, line + 1, end);
}

/** 顶层条目里的 config 块：返回 config 行之后的行区间与 config 行缩进 */
function findConfigRange(lines: string[], entry: { start: number; end: number }): { start: number; end: number; indent: number } | null {
  for (let index = entry.start; index < entry.end; index += 1) {
    if (!/^\s*config:\s*(#.*)?$/.test(lines[index])) continue;
    const indent = indentOf(lines[index]);
    let end = index + 1;
    while (end < entry.end) {
      const line = lines[end];
      if (isSkippable(line)) {
        end += 1;
        continue;
      }
      if (indentOf(line) <= indent) break;
      end += 1;
    }
    return { start: index + 1, end, indent };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 读取（本机 dsh 配置 → 同步结构）
 * ------------------------------------------------------------------ */

/** llm-deepseek 的 config → 官方配置 */
function readOfficialConfig(patchText: string): SyncedOfficialConfig {
  const lines = splitLines(patchText);
  const entry = findTopLevelEntry(lines, 'llm-deepseek');
  if (!entry) return {};
  const config = findConfigRange(lines, entry);
  if (!config) return {};
  const indent = config.indent + 2;
  const out: SyncedOfficialConfig = {};
  for (const field of mappingEntries(lines, config.start, config.end, indent)) {
    if (field.key === 'apiKeyEnv') {
      const value = unquoteScalar(field.value);
      if (value) out.apiKeyEnv = value;
    } else if (field.key === 'baseURL') {
      // 官方地址允许是空串（= 用官方地址）；这里保留空串，写回时据此清掉本机自定义地址
      const value = unquoteScalar(field.value);
      if (value !== undefined) out.baseURL = value;
    } else if (field.key === 'maxTokens') {
      const parsed = Number(unquoteScalar(field.value));
      if (Number.isFinite(parsed) && parsed > 0) out.maxTokens = parsed;
    } else if (field.key === 'models') {
      // models 的序列项缩进与字段相同：条目级 end 只到第一条 '-'，必须用序列范围
      const models = readModelSequence(lines, { ...field, end: sequenceEnd(lines, field.line, config.end, indent) });
      if (models.length) out.models = models.map((model) => ({
        id: model.id,
        ...(model.name ? { name: model.name } : {}),
        ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
        ...(model.inputModalities?.length
          ? { inputModalities: model.inputModalities }
          : model.input?.length
            ? { inputModalities: model.input }
            : {}),
      }));
    }
  }
  return out;
}

/** 读 models: 序列（官方 llm-deepseek；provider 的 models 由 videoModel.parseDshProviders 读） */
function readModelSequence(lines: string[], entry: MappingEntry): DshProviderModel[] {
  const models: DshProviderModel[] = [];
  let pendingList: 'input' | 'inputModalities' | null = null;
  for (let index = entry.line + 1; index < entry.end; index += 1) {
    const line = lines[index];
    if (isSkippable(line)) continue;
    const text = line.trim();
    const idMatch = /^-\s+id:\s*(.+)$/.exec(text);
    if (idMatch) {
      models.push({ id: unquoteScalar(idMatch[1]) });
      pendingList = null;
      continue;
    }
    if (!models.length) continue;
    const last = models[models.length - 1];
    if (text.startsWith('-') && pendingList) {
      const item = unquoteScalar(text.replace(/^-\s*/, ''));
      if (item) {
        const list = pendingList === 'input' ? (last.input ?? []) : (last.inputModalities ?? []);
        list.push(item);
        if (pendingList === 'input') last.input = list;
        else last.inputModalities = list;
      }
      continue;
    }
    const field = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(text);
    if (!field) continue;
    const key = field[1];
    const raw = field[2];
    if (key === 'name') {
      last.name = unquoteScalar(raw);
    } else if (key === 'contextWindow') {
      const parsed = Number(unquoteScalar(raw));
      if (Number.isFinite(parsed)) last.contextWindow = parsed;
    } else if (key === 'input' || key === 'inputModalities') {
      pendingList = null;
      const inline = parseStringList(raw);
      if (inline.length) {
        if (key === 'input') last.input = inline;
        else last.inputModalities = inline;
      } else if (!unquoteScalar(raw)) {
        if (key === 'input') {
          last.input = [];
          pendingList = 'input';
        } else {
          last.inputModalities = [];
          pendingList = 'inputModalities';
        }
      }
    }
  }
  return models;
}

/** agent-default-model 的 config → 默认模型 */
function readDefaultModel(patchText: string): SyncedDefaultModel {
  const lines = splitLines(patchText);
  const entry = findTopLevelEntry(lines, 'agent-default-model');
  const empty: SyncedDefaultModel = { provider: '', model: '' };
  if (!entry) return empty;
  const config = findConfigRange(lines, entry);
  if (!config) return empty;
  const fields = mappingEntries(lines, config.start, config.end, config.indent + 2);
  const readKey = (key: string): string => {
    const field = fields.find((item) => item.key === key);
    return field ? unquoteScalar(field.value) : '';
  };
  const provider = readKey('provider');
  const model = readKey('model');
  const reasoningEffort = readKey('reasoningEffort');
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

/** 官方配置的凭据引用名（缺省 DEEPSEEK_API_KEY） */
export function officialKeyRef(official: SyncedOfficialConfig): string {
  return (official.apiKeyEnv || '').trim() || 'DEEPSEEK_API_KEY';
}

/**
 * 读本机 dsh 的模型配置（纯读文件，不启动 dsh）。
 * 读不到 / 没有配置时返回空结构（providers 与 official 都为空）。
 */
export function readAgentModelConfig(home: string): SyncedAgentModelConfig {
  const patchText = readText(profilePatchPath(home));
  const credentialsText = readText(path.join(home, '.credentials.yaml'));
  const providers: Record<string, SyncedProviderConfig> = {};
  for (const provider of parseDshProviders(patchText)) {
    providers[provider.id] = {
      ...(provider.displayName ? { displayName: provider.displayName } : {}),
      ...(provider.api ? { api: provider.api } : {}),
      ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
      ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
      models: provider.models.map((model) => ({
        id: model.id,
        ...(model.name ? { name: model.name } : {}),
        ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
        ...(model.input?.length ? { input: [...model.input] } : {}),
      })),
    };
  }
  const official = readOfficialConfig(patchText);
  const defaultModel = readDefaultModel(patchText);
  // 只取被 official / providers 引用到的 Key：其它凭据（如 browser-session）不参与同步
  const wantedRefs = new Set<string>();
  for (const [id, provider] of Object.entries(providers)) wantedRefs.add(modelKeyRef(id, provider.apiKeyEnv));
  if (Object.keys(official).length > 0) wantedRefs.add(officialKeyRef(official));
  const refs = parseCredentialRefs(credentialsText);
  const keys: Record<string, string> = {};
  for (const ref of wantedRefs) {
    // 与 resolveVideoModel 同口径：凭据文件优先，没有该 ref 时回退同名环境变量
    const value = String(refs[ref] ?? process.env[ref] ?? '').trim();
    if (value) keys[ref] = value;
  }
  return { version: 1, official, providers, default: defaultModel, keys };
}

/** 本机是否真的读到了模型配置（空配置不上传） */
export function hasAgentModelConfig(config: SyncedAgentModelConfig): boolean {
  return Object.keys(config.providers).length > 0 || Object.keys(config.official).length > 0;
}

/* ------------------------------------------------------------------ *
 * 归一化 / 合并 / digest
 * ------------------------------------------------------------------ */

function normalizeProvider(id: string, raw: Record<string, unknown>): SyncedProviderConfig | null {
  const models: SyncedProviderModel[] = [];
  if (Array.isArray(raw.models)) {
    for (const item of raw.models) {
      if (!isPlainObject(item)) continue;
      const modelId = trimmedText(item.id);
      if (!modelId) continue;
      const input = Array.isArray(item.input)
        ? item.input.filter((value): value is string => typeof value === 'string' && value.length > 0)
        : undefined;
      models.push({
        id: modelId,
        ...(trimmedText(item.name) ? { name: trimmedText(item.name) } : {}),
        ...(typeof item.contextWindow === 'number' && Number.isFinite(item.contextWindow) && item.contextWindow > 0
          ? { contextWindow: item.contextWindow }
          : {}),
        ...(input?.length ? { input } : {}),
      });
    }
  }
  const provider: SyncedProviderConfig = {
    ...(trimmedText(raw.displayName) ? { displayName: trimmedText(raw.displayName) } : {}),
    ...(trimmedText(raw.api) ? { api: trimmedText(raw.api) } : {}),
    ...(optionalString(raw.baseURL) ? { baseURL: optionalString(raw.baseURL) } : {}),
    ...(optionalString(raw.apiKeyEnv) ? { apiKeyEnv: optionalString(raw.apiKeyEnv) } : {}),
    models,
  };
  // id 必须可用；没有模型、也没有地址的条目对 dsh 没意义，直接丢弃
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return null;
  if (!provider.models.length && !provider.baseURL) return null;
  return provider;
}

function normalizeOfficial(raw: Record<string, unknown>): SyncedOfficialConfig {
  const out: SyncedOfficialConfig = {};
  if (optionalString(raw.apiKeyEnv)) out.apiKeyEnv = optionalString(raw.apiKeyEnv);
  // baseURL 的空串有意义（官方地址）：保留，写回时据此清掉本机自定义地址
  if (typeof raw.baseURL === 'string') out.baseURL = raw.baseURL.trim();
  if (typeof raw.maxTokens === 'number' && Number.isFinite(raw.maxTokens) && raw.maxTokens > 0) {
    out.maxTokens = Math.floor(raw.maxTokens);
  }
  if (Array.isArray(raw.models)) {
    const models: SyncedOfficialModel[] = [];
    for (const item of raw.models) {
      if (!isPlainObject(item)) continue;
      const modelId = trimmedText(item.id);
      if (!modelId) continue;
      const inputModalities = Array.isArray(item.inputModalities)
        ? item.inputModalities.filter((value): value is string => typeof value === 'string' && value.length > 0)
        : undefined;
      models.push({
        id: modelId,
        ...(trimmedText(item.name) ? { name: trimmedText(item.name) } : {}),
        ...(typeof item.contextWindow === 'number' && Number.isFinite(item.contextWindow) && item.contextWindow > 0
          ? { contextWindow: item.contextWindow }
          : {}),
        ...(inputModalities?.length ? { inputModalities } : {}),
      });
    }
    if (models.length) out.models = models;
  }
  return out;
}

/**
 * 把任意输入归一化成同步结构；不是对象 / 读不出东西时返回 null（坏值按「没有配置」处理）。
 */
export function normalizeAgentModelConfig(input: unknown): SyncedAgentModelConfig | null {
  if (!isPlainObject(input)) return null;
  const providers: Record<string, SyncedProviderConfig> = {};
  if (isPlainObject(input.providers)) {
    for (const [id, raw] of Object.entries(input.providers)) {
      if (!isPlainObject(raw)) continue;
      const provider = normalizeProvider(id, raw);
      if (provider) providers[id] = provider;
    }
  }
  const official = isPlainObject(input.official) ? normalizeOfficial(input.official) : {};
  const defaultRaw = isPlainObject(input.default) ? input.default : {};
  const defaultModel: SyncedDefaultModel = {
    provider: trimmedText(defaultRaw.provider),
    model: trimmedText(defaultRaw.model),
    ...(trimmedText(defaultRaw.reasoningEffort) ? { reasoningEffort: trimmedText(defaultRaw.reasoningEffort) } : {}),
  };
  const keys: Record<string, string> = {};
  if (isPlainObject(input.keys)) {
    for (const [ref, value] of Object.entries(input.keys)) {
      if (typeof value === 'string' && value.length > 0) keys[ref] = value;
    }
  }
  return { version: 1, official, providers, default: defaultModel, keys };
}

/** 偏好项字符串 → 同步结构（坏 JSON / 坏结构返回 null） */
export function parseAgentModelConfig(raw: string | null | undefined): SyncedAgentModelConfig | null {
  if (!raw) return null;
  try {
    return normalizeAgentModelConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

function cloneProvider(provider: SyncedProviderConfig): SyncedProviderConfig {
  return {
    ...provider,
    models: provider.models.map((model) => ({
      ...model,
      ...(model.input ? { input: [...model.input] } : {}),
    })),
  };
}

function mergeProvider(local: SyncedProviderConfig, remote: SyncedProviderConfig): SyncedProviderConfig {
  const merged = cloneProvider(local);
  if (remote.displayName !== undefined) merged.displayName = remote.displayName;
  if (remote.api !== undefined) merged.api = remote.api;
  if (remote.baseURL !== undefined) merged.baseURL = remote.baseURL;
  if (remote.apiKeyEnv !== undefined) merged.apiKeyEnv = remote.apiKeyEnv;
  if (remote.models.length) merged.models = remote.models.map((model) => ({ ...model }));
  return merged;
}

/**
 * 合并口径 = 并集：本机独有保留；同 provider id / 同 key ref 远端胜；
 * official / default 只在远端有值时才覆盖；删除不传播（删掉的提供商会由对端带回来）。
 */
export function mergeAgentModelConfig(
  local: SyncedAgentModelConfig,
  remote: SyncedAgentModelConfig
): SyncedAgentModelConfig {
  const providers: Record<string, SyncedProviderConfig> = {};
  for (const [id, provider] of Object.entries(local.providers)) providers[id] = cloneProvider(provider);
  for (const [id, provider] of Object.entries(remote.providers)) {
    providers[id] = providers[id] ? mergeProvider(providers[id], provider) : cloneProvider(provider);
  }
  const official: SyncedOfficialConfig = { ...local.official };
  if (remote.official.apiKeyEnv !== undefined) official.apiKeyEnv = remote.official.apiKeyEnv;
  if (remote.official.baseURL !== undefined) official.baseURL = remote.official.baseURL;
  if (remote.official.maxTokens !== undefined) official.maxTokens = remote.official.maxTokens;
  if (remote.official.models !== undefined) official.models = remote.official.models.map((model) => ({ ...model }));
  const defaultModel: SyncedDefaultModel = remote.default.provider && remote.default.model
    ? {
        provider: remote.default.provider,
        model: remote.default.model,
        ...(remote.default.reasoningEffort ? { reasoningEffort: remote.default.reasoningEffort } : {}),
      }
    : { ...local.default };
  return {
    version: 1,
    official,
    providers,
    default: defaultModel,
    keys: { ...local.keys, ...remote.keys },
  };
}

/** 稳定序列化（对象 key 排序）：digest 与偏好值都用它，避免 key 顺序造成「假变化」 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record)
    .sort()
    .map((key) => JSON.stringify(key) + ':' + stableStringify(record[key]))
    .join(',') + '}';
}

/** 配置内容指纹（sha256(稳定序列化)）：镜像/回声抑制共用同一判定 */
export function agentModelConfigDigest(config: SyncedAgentModelConfig): string {
  return createHash('sha256').update(stableStringify(config)).digest('hex');
}

/* ------------------------------------------------------------------ *
 * 写回 dsh 配置（文本级保守编辑）
 * ------------------------------------------------------------------ */

/** 确保某个顶层条目存在（不存在就追加到文件末尾）；返回新行数组 */
function ensureEntryWithConfig(lines: string[], entryId: string): string[] {
  const block = findTopLevelEntry(lines, entryId);
  if (!block) {
    const out = [...lines];
    // 只去掉尾部空行；尾部注释是用户的文档内容，必须保留（注释跟着哪个条目走不该由我们判断）
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    if (out.length) out.push('');
    out.push('- id: ' + entryId, '  config:');
    return out;
  }
  if (findConfigRange(lines, block)) return lines;
  // 条目在、但没有 config（例如手写了 name: 等字段）：在条目末尾补 config:
  const insertAt = trimmedEnd(lines, block.start + 1, block.end);
  lines.splice(insertAt, 0, '  config:');
  return lines;
}

/** 在条目 config 块里找一个字段（没有就返回 null） */
function findEntryField(
  lines: string[],
  entryId: string,
  key: string
): { config: { start: number; end: number; indent: number }; field: MappingEntry } | null {
  const block = findTopLevelEntry(lines, entryId);
  if (!block) return null;
  const config = findConfigRange(lines, block);
  if (!config) return null;
  const field = mappingEntries(lines, config.start, config.end, config.indent + 2).find((item) => item.key === key);
  return field ? { config, field } : null;
}

/** 设置条目 config 里的标量字段（字符串已序列化） */
function setEntryScalar(lines: string[], entryId: string, key: string, serialized: string): string[] {
  const found = findEntryField(lines, entryId, key);
  if (!found) {
    const block = findTopLevelEntry(lines, entryId);
    if (!block) return lines;
    const config = findConfigRange(lines, block);
    if (!config) return lines;
    const indent = config.indent + 2;
    const insertAt = mappingInsertIndex(lines, config.start, config.end);
    lines.splice(insertAt, 0, ' '.repeat(indent) + key + ': ' + serialized);
    return lines;
  }
  const indent = found.config.indent + 2;
  lines[found.field.line] = ' '.repeat(indent) + key + ': ' + serialized;
  return lines;
}

/** 删除条目 config 里的标量字段（不存在时什么都不做） */
function removeEntryScalar(lines: string[], entryId: string, key: string): string[] {
  const found = findEntryField(lines, entryId, key);
  if (!found) return lines;
  lines.splice(found.field.line, 1);
  return lines;
}

/** 设置条目 config 里的 models: 序列 */
function setEntryModels(
  lines: string[],
  entryId: string,
  models: Array<SyncedProviderModel | SyncedOfficialModel>,
  listKey: 'input' | 'inputModalities'
): string[] {
  const block = findTopLevelEntry(lines, entryId);
  if (!block) return lines;
  const config = findConfigRange(lines, block);
  if (!config) return lines;
  const indent = config.indent + 2;
  const serialized: string[] = [' '.repeat(indent) + 'models:'];
  for (const model of models) {
    const itemIndent = indent;
    serialized.push(' '.repeat(itemIndent) + '- id: ' + yamlScalar(model.id));
    const childIndent = ' '.repeat(itemIndent + 2);
    if (model.name) serialized.push(childIndent + 'name: ' + yamlScalar(model.name));
    if (typeof model.contextWindow === 'number' && model.contextWindow > 0) {
      serialized.push(childIndent + 'contextWindow: ' + model.contextWindow);
    }
    const list = listKey === 'input'
      ? (model as SyncedProviderModel).input
      : (model as SyncedOfficialModel).inputModalities;
    if (list?.length) {
      serialized.push(childIndent + listKey + ':');
      for (const item of list) serialized.push(childIndent + '- ' + yamlScalar(item));
    }
  }
  const existing = mappingEntries(lines, config.start, config.end, indent).find((item) => item.key === 'models');
  if (existing) {
    const end = sequenceEnd(lines, existing.line, config.end, indent);
    lines.splice(existing.line, end - existing.line, ...serialized);
    return lines;
  }
  const insertAt = mappingInsertIndex(lines, config.start, config.end);
  lines.splice(insertAt, 0, ...serialized);
  return lines;
}

/** 确保 llm-pi-ai 的 config.providers: 映射存在 */
function ensureProvidersMapping(lines: string[]): string[] {
  const out = ensureEntryWithConfig(lines, 'llm-pi-ai');
  const block = findTopLevelEntry(out, 'llm-pi-ai');
  if (!block) return out;
  const config = findConfigRange(out, block);
  if (!config) return out;
  const indent = config.indent + 2;
  const existing = mappingEntries(out, config.start, config.end, indent).find((item) => item.key === 'providers');
  if (existing) return out;
  const insertAt = mappingInsertIndex(out, config.start, config.end);
  out.splice(insertAt, 0, ' '.repeat(indent) + 'providers:');
  return out;
}

interface ProviderLocation {
  /** provider id 行缩进（providers: 行缩进 + 2） */
  idIndent: number;
  /** provider 字段缩进（idIndent + 2） */
  fieldIndent: number;
  providersLine: number;
  providerLine: number;
  providerEnd: number;
}

function locateProvider(lines: string[], providerId: string): ProviderLocation | null {
  const block = findTopLevelEntry(lines, 'llm-pi-ai');
  if (!block) return null;
  const config = findConfigRange(lines, block);
  if (!config) return null;
  const providersLine = mappingEntries(lines, config.start, config.end, config.indent + 2)
    .find((item) => item.key === 'providers');
  if (!providersLine) return null;
  const idIndent = config.indent + 4;
  const provider = mappingEntries(lines, providersLine.line + 1, providersLine.end, idIndent)
    .find((item) => item.key === providerId);
  if (!provider) return null;
  return {
    idIndent,
    fieldIndent: idIndent + 2,
    providersLine: providersLine.line,
    providerLine: provider.line,
    providerEnd: provider.end,
  };
}

/** 设置某个提供商的标量字段（displayName / api / baseURL / apiKeyEnv） */
function setProviderScalar(lines: string[], providerId: string, key: string, serialized: string): string[] {
  const location = locateProvider(lines, providerId);
  if (!location) return lines;
  const fields = mappingEntries(lines, location.providerLine + 1, location.providerEnd, location.fieldIndent);
  const existing = fields.find((item) => item.key === key);
  if (existing) {
    lines[existing.line] = ' '.repeat(location.fieldIndent) + key + ': ' + serialized;
    return lines;
  }
  const insertAt = mappingInsertIndex(lines, location.providerLine + 1, location.providerEnd);
  lines.splice(insertAt, 0, ' '.repeat(location.fieldIndent) + key + ': ' + serialized);
  return lines;
}

/** 设置某个提供商的 models: 序列 */
function setProviderModels(lines: string[], providerId: string, models: SyncedProviderModel[]): string[] {
  const location = locateProvider(lines, providerId);
  if (!location) return lines;
  const serialized: string[] = [' '.repeat(location.fieldIndent) + 'models:'];
  for (const model of models) {
    serialized.push(' '.repeat(location.fieldIndent) + '- id: ' + yamlScalar(model.id));
    const childIndent = ' '.repeat(location.fieldIndent + 2);
    if (model.name) serialized.push(childIndent + 'name: ' + yamlScalar(model.name));
    if (typeof model.contextWindow === 'number' && model.contextWindow > 0) {
      serialized.push(childIndent + 'contextWindow: ' + model.contextWindow);
    }
    if (model.input?.length) {
      serialized.push(childIndent + 'input:');
      for (const item of model.input) serialized.push(childIndent + '- ' + yamlScalar(item));
    }
  }
  const fields = mappingEntries(lines, location.providerLine + 1, location.providerEnd, location.fieldIndent);
  const existing = fields.find((item) => item.key === 'models');
  if (existing) {
    const end = sequenceEnd(lines, existing.line, location.providerEnd, location.fieldIndent);
    lines.splice(existing.line, end - existing.line, ...serialized);
    return lines;
  }
  const insertAt = mappingInsertIndex(lines, location.providerLine + 1, location.providerEnd);
  lines.splice(insertAt, 0, ...serialized);
  return lines;
}

/** 序列化一个完整 provider 块（远端独有、本机要新增时用） */
function serializeProviderBlock(providerId: string, provider: SyncedProviderConfig, idIndent: number): string[] {
  const fieldIndent = idIndent + 2;
  const lines: string[] = [' '.repeat(idIndent) + providerId + ':'];
  if (provider.displayName) lines.push(' '.repeat(fieldIndent) + 'displayName: ' + yamlScalar(provider.displayName));
  if (provider.apiKeyEnv) lines.push(' '.repeat(fieldIndent) + 'apiKeyEnv: ' + yamlScalar(provider.apiKeyEnv));
  if (provider.api) lines.push(' '.repeat(fieldIndent) + 'api: ' + yamlScalar(provider.api));
  if (provider.baseURL) lines.push(' '.repeat(fieldIndent) + 'baseURL: ' + yamlScalar(provider.baseURL));
  if (provider.models.length) {
    lines.push(' '.repeat(fieldIndent) + 'models:');
    for (const model of provider.models) {
      lines.push(' '.repeat(fieldIndent) + '- id: ' + yamlScalar(model.id));
      const childIndent = ' '.repeat(fieldIndent + 2);
      if (model.name) lines.push(childIndent + 'name: ' + yamlScalar(model.name));
      if (typeof model.contextWindow === 'number' && model.contextWindow > 0) {
        lines.push(childIndent + 'contextWindow: ' + model.contextWindow);
      }
      if (model.input?.length) {
        lines.push(childIndent + 'input:');
        for (const item of model.input) lines.push(childIndent + '- ' + yamlScalar(item));
      }
    }
  }
  return lines;
}

/** 把同步结构里的 providers 合并进 llm-pi-ai（同 id 只覆盖字段，不删除本机独有内容） */
function editProvidersEntry(lines: string[], providers: Record<string, SyncedProviderConfig>): string[] {
  let out = ensureProvidersMapping(lines);
  const ids = Object.keys(providers).sort();
  for (const providerId of ids) {
    const provider = providers[providerId];
    const location = locateProvider(out, providerId);
    if (location) {
      if (provider.displayName !== undefined) out = setProviderScalar(out, providerId, 'displayName', yamlScalar(provider.displayName));
      if (provider.api !== undefined) out = setProviderScalar(out, providerId, 'api', yamlScalar(provider.api));
      if (provider.baseURL !== undefined) out = setProviderScalar(out, providerId, 'baseURL', yamlScalar(provider.baseURL));
      if (provider.apiKeyEnv !== undefined) out = setProviderScalar(out, providerId, 'apiKeyEnv', yamlScalar(provider.apiKeyEnv));
      // models 远端有内容才覆盖：远端空模型列表不把本机可用配置清空（并集语义）
      if (provider.models.length) out = setProviderModels(out, providerId, provider.models);
      continue;
    }
    // 远端独有的提供商：追加到 providers 映射末尾
    const block = findTopLevelEntry(out, 'llm-pi-ai');
    if (!block) continue;
    const config = findConfigRange(out, block);
    if (!config) continue;
    const providersMapping = mappingEntries(out, config.start, config.end, config.indent + 2)
      .find((item) => item.key === 'providers');
    if (!providersMapping) continue;
    const idIndent = config.indent + 4;
    const insertAt = trimmedEnd(out, providersMapping.line + 1, providersMapping.end);
    out.splice(insertAt, 0, ...serializeProviderBlock(providerId, provider, idIndent));
  }
  return out;
}

/** 把同步结构里的 official 合并进 llm-deepseek（远端有值才覆盖对应字段） */
function editOfficialEntry(lines: string[], official: SyncedOfficialConfig): string[] {
  let out = ensureEntryWithConfig(lines, 'llm-deepseek');
  if (official.apiKeyEnv !== undefined) out = setEntryScalar(out, 'llm-deepseek', 'apiKeyEnv', yamlScalar(official.apiKeyEnv));
  if (official.baseURL !== undefined) {
    if (official.baseURL === '') out = removeEntryScalar(out, 'llm-deepseek', 'baseURL');
    else out = setEntryScalar(out, 'llm-deepseek', 'baseURL', yamlScalar(official.baseURL));
  }
  if (official.maxTokens !== undefined) {
    if (official.maxTokens > 0) out = setEntryScalar(out, 'llm-deepseek', 'maxTokens', String(official.maxTokens));
    else out = removeEntryScalar(out, 'llm-deepseek', 'maxTokens');
  }
  if (official.models !== undefined) out = setEntryModels(out, 'llm-deepseek', official.models, 'inputModalities');
  return out;
}

/** 把同步结构里的 default 合并进 agent-default-model（远端有值才覆盖） */
function editDefaultEntry(lines: string[], defaultModel: SyncedDefaultModel): string[] {
  if (!defaultModel.provider || !defaultModel.model) return lines;
  let out = ensureEntryWithConfig(lines, 'agent-default-model');
  out = setEntryScalar(out, 'agent-default-model', 'provider', yamlScalar(defaultModel.provider));
  out = setEntryScalar(out, 'agent-default-model', 'model', yamlScalar(defaultModel.model));
  if (defaultModel.reasoningEffort) {
    out = setEntryScalar(out, 'agent-default-model', 'reasoningEffort', yamlScalar(defaultModel.reasoningEffort));
  }
  return out;
}

/** 同步结构 → 新的 patch 文本（只改三个模型条目，其余逐字保留） */
export function applyAgentModelConfigToPatch(text: string, config: SyncedAgentModelConfig): string {
  let lines = splitLines(text);
  if (Object.keys(config.providers).length) lines = editProvidersEntry(lines, config.providers);
  if (Object.keys(config.official).length) lines = editOfficialEntry(lines, config.official);
  lines = editDefaultEntry(lines, config.default);
  // 只去掉我们编辑过程中可能留下的尾部空行，保留用户原有的结尾注释
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (!lines.length) return '';
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * 写回凭据文件（只重写顶层 refs: 段）
 * ------------------------------------------------------------------ */

/** 同步结构里的 keys → 新的凭据文本（保留 version / records 等段落） */
export function applyAgentModelConfigToCredentials(text: string, keys: Record<string, string>): string {
  if (!Object.keys(keys).length) return text;
  const lines = splitLines(text);
  const existing = parseCredentialRefs(text);
  // 同 ref 远端胜；本机其它凭据（browser-session 等）原样保留
  const merged: Record<string, string> = { ...existing, ...keys };
  // 内容没变就原样返回：否则每次同步都会把 flow map 重排成「块状 + 排序」，文本一变
  // 就被判成 changed，导致凭据文件在两端之间反复改写（与 patch 的幂等口径不一致）
  const existingRefs = Object.keys(existing).sort();
  const mergedRefs = Object.keys(merged).sort();
  const unchanged = existingRefs.length === mergedRefs.length
    && mergedRefs.every((ref) => existing[ref] === merged[ref]);
  if (unchanged) return text;
  const refs = mergedRefs;
  const refLines = ['refs:', ...refs.map((ref) => '  ' + ref + ": '" + merged[ref].replace(/'/g, "''") + "'")];
  let refsIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^refs:\s*(#.*)?$/.test(lines[index])) {
      refsIndex = index;
      break;
    }
  }
  if (refsIndex < 0) {
    const out = [...lines];
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    // 全新凭据文件：与 dsh 实际写出的格式一致（version: 1），避免格式兼容性未知
    if (!out.length) out.push('version: 1');
    out.push(...refLines);
    return out.join('\n') + '\n';
  }
  let end = refsIndex + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (isSkippable(line)) {
      end += 1;
      continue;
    }
    if (indentOf(line) === 0) break;
    end += 1;
  }
  const contentEnd = trimmedEnd(lines, refsIndex + 1, end);
  const out = [...lines.slice(0, refsIndex), ...refLines, ...lines.slice(contentEnd)];
  // 统一收尾：不保留文件末尾的多个空行，避免反复写时每轮多出一个空行（幂等）
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * 落盘
 * ------------------------------------------------------------------ */

function writeWithBackup(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 同一次写覆盖旧备份：备份只用于「刚被同步改坏」时的手工回滚，不需要历史版本
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.engram-bak');
  const temp = file + '.engram-tmp';
  fs.writeFileSync(temp, text, 'utf8');
  fs.renameSync(temp, file);
}

/**
 * 把合并后的配置写回本机 dsh 的两个文件（写前各留 .engram-bak）。
 * 失败时抛出 Error（由调用方记 pending + warn，不能把同步轮打断）。
 */
export function writeAgentModelConfig(home: string, config: SyncedAgentModelConfig): AgentModelWriteResult {
  const patchFile = profilePatchPath(home);
  const credentialsFile = path.join(home, '.credentials.yaml');
  const patchBefore = readText(patchFile);
  const patchAfter = applyAgentModelConfigToPatch(patchBefore, config);
  // 写后为空说明本来就没内容且这次也没配上：不创建空文件
  const patchChanged = patchAfter.trim().length > 0 && patchAfter !== patchBefore;
  const credentialsBefore = readText(credentialsFile);
  const credentialsAfter = applyAgentModelConfigToCredentials(credentialsBefore, config.keys);
  const credentialsChanged = credentialsAfter !== credentialsBefore;
  if (patchChanged) writeWithBackup(patchFile, patchAfter);
  if (credentialsChanged) writeWithBackup(credentialsFile, credentialsAfter);
  // dsh 的 credentials-local 插件启动时会校验凭据文件「仅属主可读」（POSIX 上 mode 必须 600），
  // 否则控制台进程直接拒绝启动（实测报错：credentials-local: … is readable beyond its owner
  // (mode 644); run "chmod 600 …" before starting again）。写盘/改名后新文件是默认 umask 的
  // 644，必须显式收紧；Windows 上 chmod 近似 no-op，不会影响现有语义。
  if (credentialsChanged) {
    try {
      fs.chmodSync(credentialsFile, 0o600);
    } catch {
      /* 有些平台/文件系统不支持 chmod：读写逻辑不依赖它，dsh 侧报错时用户可手改 */
    }
  }
  return { patchChanged, credentialsChanged };
}
