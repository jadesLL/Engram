import { api } from '../api';

/**
 * 内置 Agent 控制台（原生）的服务端 BFF 客户端。
 *
 * 唯一数据来源是 `/api/agent-console/*`（server 端代理到本机 dsh 的 HTTP RPC）——
 * 前端不直连 dsh，也不持有 dsh 的一次性 token。所有端点 owner 鉴权（浏览器同源 cookie），
 * 401 由 api.ts 的统一拦截器跳登录。
 *
 * 命名约定：
 * - `getXxx` 读，返回完整 payload；
 * - `putXxx` / `patchXxx` 写，**服务端返回完整的新 payload**（前端直接 set 状态，不本地拼）；
 * - 写接口带 `expectedRevision`，服务端发现版本落后返回 409（前端刷新后提示重试）。
 */

/** 统一错误体：{ error, code?, detail? } */
export interface AgentConsoleErrorBody {
  error?: string;
  code?: string;
  detail?: string;
  message?: string;
}

export interface SelectOption {
  value: string;
  label: string;
  /** 模型选项专用：该模型属于哪个 provider（BFF 的 modelOptions 会带上；旧形状可能没有） */
  provider?: string;
}

/* ===== 1.1 状态 ===== */

export interface ConsoleStatusPayload {
  running: boolean;
  startedAt: number | null;
  dshVersion: string | null;
  /** 启动/运行失败的人话；空串表示没有错误 */
  error: string;
  /** 控制台对外 origin（服务端按请求地址还原） */
  origin: string;
  /** 上游 dsh HTTP 是否可读（running 但上游还没就绪时为 false） */
  upstreamReady: boolean;
}

/* ===== 1.2 模型 ===== */

export interface ModelDefaultPayload {
  provider: string;
  model: string;
  reasoningEffort?: string | null;
  revision: number;
  providerOptions: SelectOption[];
  modelOptions: SelectOption[];
}

/** 模型输入类型：dsh 官方模型目录用 inputModalities，pi-ai 自定义提供商模型用 input */
export type ModelInputModality = 'text' | 'image';

export interface OfficialModelEntry {
  id: string;
  name: string;
  contextWindow?: number;
  /** 官方模型目录支持读取的输入类型（缺省表示未声明，界面上按文本+图片回填） */
  inputModalities?: ModelInputModality[];
}

export interface OfficialProviderPayload {
  providerId: string;
  title: string;
  apiKey: {
    configured: boolean;
    ref: string;
    writable: boolean;
    hint: string;
  };
  baseURL: {
    value: string;
    placeholder: string;
  };
  models: OfficialModelEntry[];
  maxTokens: number;
  revision: number;
}

export interface CustomProviderModelEntry {
  id: string;
  name: string;
  /** pi-ai 提供者模型支持读取的输入类型（字段名就是 input；缺省表示未声明） */
  input?: ModelInputModality[];
}

export interface CustomProviderPayload {
  id: string;
  displayName: string;
  api: string;
  baseURL: string;
  apiKeyConfigured: boolean;
  models: CustomProviderModelEntry[];
  revision: number;
}

/** 声明式提供者（BFF 从 dsh 的 llm/listConfigurableProviders 得到，供「添加模型提供商」选择） */
export interface DeclaredProviderPayload {
  provider: string;
  displayName: string;
  defaultBaseURL: string;
  nativeAuth: boolean;
}

export interface ModelsPayload {
  writable: boolean;
  default: ModelDefaultPayload;
  official: OfficialProviderPayload | null;
  customProviders: CustomProviderPayload[];
  /** 内置目录里可直接添加的声明式提供者（如 anthropic / openai） */
  declaredProviders: DeclaredProviderPayload[];
  /** 可选协议：openai-completions / openai-responses / anthropic-messages */
  apiProtocols: string[];
}

export interface UpdateDefaultModelBody {
  provider: string;
  model: string;
  reasoningEffort?: string | null;
  expectedRevision: number;
}

export interface UpdateOfficialModelsBody {
  apiKey?: string;
  clearApiKey?: boolean;
  baseURL?: string;
  models?: OfficialModelEntry[];
  maxTokens?: number;
  expectedRevision: number;
}

export interface UpsertProviderBody {
  displayName: string;
  api: string;
  baseURL: string;
  models: CustomProviderModelEntry[];
  apiKey?: string;
  clearApiKey?: boolean;
  expectedRevision?: number;
}

export interface DiscoverModelsBody {
  provider?: string;
  baseURL?: string;
  apiKey?: string;
}

/* ===== 1.3 插件 ===== */

export type PluginFieldType = 'number' | 'boolean' | 'text' | 'secret' | 'select';

export interface PluginFieldPayload {
  key: string;
  label: string;
  hint?: string;
  type: PluginFieldType;
  value?: unknown;
  options?: SelectOption[];
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  /** secret 字段用：是否已配置密钥 */
  configured?: boolean;
}

export interface PluginCardPayload {
  key: string;
  title: string;
  description: string;
  icon: string;
  fields: PluginFieldPayload[];
  /** 命名空间 -> revision */
  revisions: Record<string, number>;
}

export interface ExperimentalPluginPayload {
  key: string;
  title: string;
  description: string;
  tag: string;
  enabled: boolean;
  kind: 'bundle' | 'plugin';
  id: string;
}

export interface PluginInventoryItemPayload {
  entryId: string;
  title: string;
  description?: string;
  module: string;
  enabled: boolean;
  status: string;
  scope: 'session' | 'global';
}

export interface PluginsPayload {
  writable: boolean;
  cards: PluginCardPayload[];
  experimental: ExperimentalPluginPayload[];
  inventory: PluginInventoryItemPayload[];
}

export interface PatchPluginConfigBody {
  values: Record<string, unknown>;
  expectedRevisions: Record<string, number>;
}

export interface TogglePluginBody {
  kind: 'bundle' | 'plugin';
  id: string;
  enabled: boolean;
}

/* ===== 1.4 Agent 预设 ===== */

export interface PresetItemPayload {
  id: string;
  title: string;
  description: string;
  tag?: string;
  /** 预设加载失败的原因（BFF 透传 dsh 的 broken 字段） */
  broken?: string;
}

export interface PresetsPayload {
  writable: boolean;
  selected: string;
  revision: number;
  presets: PresetItemPayload[];
}

export interface SetDefaultPresetBody {
  id: string;
  expectedRevision: number;
}

/* ===== 1.5 高级 ===== */

export interface AdvancedPayload {
  writable: boolean;
  sessionLog: { enabled: boolean; revision: number };
  console: { dshVersion: string | null; home: string };
}

export interface SessionLogBody {
  enabled: boolean;
  expectedRevision: number;
}

/* ===== 端点函数（thin：只做请求与解包，形状归一化在 agentConsoleUi.ts） ===== */

export async function getConsoleStatus(): Promise<ConsoleStatusPayload> {
  const { data } = await api.get<ConsoleStatusPayload>('/api/agent-console/status');
  return data;
}

/** 重启（也用于「启动控制台」：进程没跑时等价于起来） */
export async function restartConsole(): Promise<ConsoleStatusPayload> {
  const { data } = await api.post<ConsoleStatusPayload>('/api/agent-console/restart', {});
  return data;
}

export async function stopConsole(): Promise<ConsoleStatusPayload> {
  const { data } = await api.post<ConsoleStatusPayload>('/api/agent-console/stop', {});
  return data;
}

export async function getModels(): Promise<ModelsPayload> {
  const { data } = await api.get<ModelsPayload>('/api/agent-console/models');
  return data;
}

export async function putDefaultModel(body: UpdateDefaultModelBody): Promise<ModelsPayload> {
  const { data } = await api.put<ModelsPayload>('/api/agent-console/models/default', body);
  return data;
}

export async function putOfficialModels(body: UpdateOfficialModelsBody): Promise<ModelsPayload> {
  const { data } = await api.put<ModelsPayload>('/api/agent-console/models/official', body);
  return data;
}

export async function putProvider(id: string, body: UpsertProviderBody): Promise<ModelsPayload> {
  const { data } = await api.put<ModelsPayload>(`/api/agent-console/models/providers/${encodeURIComponent(id)}`, body);
  return data;
}

export async function deleteProvider(id: string): Promise<ModelsPayload> {
  const { data } = await api.delete<ModelsPayload>(`/api/agent-console/models/providers/${encodeURIComponent(id)}`);
  return data;
}

export async function discoverModels(body: DiscoverModelsBody): Promise<{ models: Array<{ id: string; name: string }> }> {
  const { data } = await api.post<{ models: Array<{ id: string; name: string }> }>(
    '/api/agent-console/models/discover',
    body,
  );
  return data;
}

export async function getPlugins(): Promise<PluginsPayload> {
  const { data } = await api.get<PluginsPayload>('/api/agent-console/plugins');
  return data;
}

export async function patchPluginConfig(cardKey: string, body: PatchPluginConfigBody): Promise<PluginsPayload> {
  const { data } = await api.patch<PluginsPayload>(
    `/api/agent-console/plugins/config/${encodeURIComponent(cardKey)}`,
    body,
  );
  return data;
}

export async function togglePlugin(body: TogglePluginBody): Promise<PluginsPayload> {
  const { data } = await api.patch<PluginsPayload>('/api/agent-console/plugins/toggle', body);
  return data;
}

export async function getPresets(): Promise<PresetsPayload> {
  const { data } = await api.get<PresetsPayload>('/api/agent-console/presets');
  return data;
}

export async function putDefaultPreset(body: SetDefaultPresetBody): Promise<PresetsPayload> {
  const { data } = await api.put<PresetsPayload>('/api/agent-console/presets/default', body);
  return data;
}

export async function getAdvanced(): Promise<AdvancedPayload> {
  const { data } = await api.get<AdvancedPayload>('/api/agent-console/advanced');
  return data;
}

export async function putSessionLog(body: SessionLogBody): Promise<AdvancedPayload> {
  const { data } = await api.put<AdvancedPayload>('/api/agent-console/advanced/session-log', body);
  return data;
}

/* ===== 错误文案 ===== */

/** 从 axios 错误里取人话：优先服务端 { error } / { detail } / { message }，其次按 HTTP 状态兜底 */
export function errorMessage(error: unknown, fallback = '请求失败'): string {
  const err = (error && typeof error === 'object' ? error : {}) as Record<string, unknown>;
  const response = (err.response && typeof err.response === 'object' ? err.response : {}) as Record<string, unknown>;
  const data = response.data;
  if (typeof data === 'string' && data.trim()) return data.trim();
  if (data && typeof data === 'object') {
    const body = data as AgentConsoleErrorBody;
    const message = String(body.error || body.detail || body.message || '').trim();
    if (message) return message;
  }
  const plain = String(err.message || '').trim();
  if (plain && !/^Request failed with status code/i.test(plain) && !/^Network Error$/i.test(plain)) return plain;
  const status = Number(response.status);
  if (status === 401) return '登录状态已失效，请重新登录';
  if (status === 403) return '当前账号无权管理内置 Agent 控制台';
  if (status === 409) return '配置已在别处被修改，已为你刷新，请重试';
  if (status === 502) return '内置 Agent 控制台暂时不可用，可尝试重启控制台';
  if (status === 503) return '内置 Agent 控制台尚未就绪，请稍后重试';
  if (status === 404) return '接口不存在：服务端可能还没升级到该版本';
  return fallback;
}
