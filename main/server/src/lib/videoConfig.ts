import { getSetting, setSetting } from './db.js';
import { bundledDshHome } from '../assistant/config.js';
import { AGENT_MODEL_CONFIG_KEY, parseAgentModelConfig, type SyncedAgentModelConfig } from './agentModelConfig.js';
import {
  missingVideoModelFields,
  resolveVideoModel,
  type DshProvider,
  type ResolvedVideoModel,
  type VideoModelFallback,
  type VideoModelResolution,
} from './videoModel.js';
import { preferenceValue } from '../sync/preferences.js';

/**
 * 视频理解模型的总开关 + 状态（2026-11 起）。
 *
 * 模型本身（提供商 / 地址 / 模型名 / API Key）不再存在这里：它们复用 dsh 的模型配置
 * （设置 → Agent 与自动化 → 内置 Agent 控制台 → 模型，见 lib/videoModel.ts）。
 * Engram 只保留「是否启用视频理解」这一个开关，避免同一份模型凭据维护两遍。
 *
 * 历史兼容：v1.5.x 的 video_config 里还有 baseUrl/apiKey/model/maxTokens/quality/douyinBrowser，
 * 旧客户端（手机 APK 里的旧 Web 包）仍会 POST 这些字段进来：这里一律忽略、只认 enabled，
 * 返回给前端的脱敏 JSON 也只带 enabled（不会再回显旧 Key）。
 */

export const VIDEO_CONFIG_KEY = 'video_config';

/** 单次纪要请求的输出上限（旧面板字段，现固定；改这里即可） */
export const VIDEO_MAX_TOKENS = 4096;
/** B站 / 抖音的下载清晰度：64=720P / 32=480P / 16=360P（旧面板字段，现固定 720P） */
export const VIDEO_QUALITY = 64;
/** 抖音接口抓取失败时是否用本机浏览器兜底（旧面板字段，现固定关闭） */
export const VIDEO_DOUYIN_BROWSER = false;

export interface VideoConfig {
  /** 总开关：关掉后收集箱视频条目不再可提炼（给「先开开关」的明确提示） */
  enabled: boolean;
}

const DEFAULTS: VideoConfig = {
  // 「内置 Agent 与视频理解都默认上」：默认开启，用户只需要去控制台填一个 API Key
  enabled: true,
};

function normalize(raw: unknown): VideoConfig {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { enabled: source.enabled !== false };
}

export function getVideoConfig(): VideoConfig {
  const text = getSetting(VIDEO_CONFIG_KEY);
  if (!text) return { ...DEFAULTS };
  try {
    return normalize(JSON.parse(text));
  } catch {
    return { ...DEFAULTS };
  }
}

/** 部分更新；返回合并后的完整配置（与 assistant 的 setAgentConfig 同一套语义） */
export function setVideoConfig(patch: Partial<VideoConfig>): VideoConfig {
  const next = normalize({ ...getVideoConfig(), ...(patch || {}) });
  setSetting(VIDEO_CONFIG_KEY, JSON.stringify(next));
  return next;
}

/**
 * 读给前端的脱敏 JSON：只带 enabled（这里根本没有 Key 可回显）。
 * 旧的「删掉 apiKey 再序列化」口径保留兼容：坏 JSON 按默认值返回，不让设置页被损坏配置打挂。
 */
export function videoConfigForClient(): string {
  const raw = getSetting(VIDEO_CONFIG_KEY) || '';
  if (!raw) return '';
  try {
    JSON.parse(raw);
  } catch {
    return JSON.stringify(DEFAULTS);
  }
  return JSON.stringify({ enabled: getVideoConfig().enabled });
}

/**
 * 解析写入口径（GET/PUT /api/settings 与 /api/settings/video-config 共用）：
 *  - 对象或 JSON 字符串都接受；
 *  - 只认 enabled（布尔），旧字段（baseUrl/apiKey/model/…）一律忽略；
 *  - enabled 缺省时不改（保持原值）。
 */
export function parseVideoConfigInput(input: unknown): Partial<VideoConfig> {
  let incoming: Record<string, unknown> = {};
  if (typeof input === 'string') {
    try {
      incoming = JSON.parse(input) as Record<string, unknown>;
    } catch {
      incoming = {};
    }
  } else if (input && typeof input === 'object') {
    incoming = { ...(input as Record<string, unknown>) };
  }
  const patch: Partial<VideoConfig> = {};
  if (typeof incoming.enabled === 'boolean') patch.enabled = incoming.enabled;
  return patch;
}

/** 保存入口，返回是否真的变了 + 合并后的完整配置 */
export function applyVideoConfigInput(input: unknown): { changed: boolean; next: VideoConfig } {
  const before = getSetting(VIDEO_CONFIG_KEY) || '';
  const next = setVideoConfig(parseVideoConfigInput(input));
  return { changed: JSON.stringify(next) !== before, next };
}

/**
 * 同步下来的模型配置 → 视频回退数据（多端同步的 agent_model_config）。
 *
 * 直接读偏好值而不是走 sync/agentModelSync：这里只做只读展示/调用，没必要把同步队列模块拉进来；
 * 合并后的偏好值就是本机已知的最新一份（应用远端后会把合并结果写回偏好）。
 */
function syncedModelConfig(): SyncedAgentModelConfig | null {
  try {
    const preference = preferenceValue(AGENT_MODEL_CONFIG_KEY);
    return parseAgentModelConfig(preference?.value ?? getSetting(AGENT_MODEL_CONFIG_KEY));
  } catch {
    return null;
  }
}

function syncedVideoFallback(): VideoModelFallback {
  const config = syncedModelConfig();
  if (!config) return {};
  const providers: DshProvider[] = Object.entries(config.providers).map(([id, provider]) => ({
    id,
    ...(provider.displayName ? { displayName: provider.displayName } : {}),
    ...(provider.api ? { api: provider.api } : {}),
    ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
    ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
    models: provider.models.map((model) => ({ ...model })),
  }));
  return { providers, keys: config.keys };
}

/**
 * 当前解析到的视频模型（每次实时读 dsh 配置；文件很小，读盘成本可忽略）。
 *
 * 本机已配置（provider + Key 齐全）时一律用本机；缺 Key 或本机根本没提供商时，
 * 用同步下来的同款配置兜底——对端只同步到了配置、dsh 还没重读时视频理解也能直接用。
 */
export function videoModelConfig(): VideoModelResolution {
  const home = bundledDshHome();
  const local = resolveVideoModel(home);
  if (local.configured) return local;
  return resolveVideoModel(home, syncedVideoFallback());
}

/** 缺哪一项就点哪一项：面板与错误文案共用这一个判定 */
export function videoConfigMissing(model?: ResolvedVideoModel): string[] {
  return missingVideoModelFields(model ?? videoModelConfig().provider);
}

/** 能不能直接提炼：开关打开且 dsh 里模型与 Key 齐全 */
export function videoConfigReady(config: VideoConfig = getVideoConfig(), model?: ResolvedVideoModel): boolean {
  if (!config.enabled) return false;
  if (model) return missingVideoModelFields(model).length === 0;
  return videoModelConfig().configured;
}

/** 不可用时的可读中文原因（界面 hint 与任务错误共用） */
export function videoConfigHint(config: VideoConfig = getVideoConfig(), model?: ResolvedVideoModel): string {
  if (!config.enabled) return '视频理解未启用：请到 设置 → Agent 与自动化 → 视频理解模型 打开开关';
  const where = '（设置 → Agent 与自动化 → 视频理解模型 → 去配置，在内置 Agent 控制台的「模型」里填 DashScope API Key）';
  if (model) {
    const missing = missingVideoModelFields(model);
    return missing.length ? '视频理解模型还缺：' + missing.join('、') + where : '';
  }
  const resolution = videoModelConfig();
  if (!resolution.providerFound) {
    return '视频理解模型还没有初始化：打开 设置 → Agent 与自动化 → 视频理解模型 会自动预置 DashScope 提供商' + where;
  }
  return resolution.missing.length ? '视频理解模型还缺：' + resolution.missing.join('、') + where : '';
}

/**
 * 把库里旧的 video_config JSON 归一化成只含 enabled（清掉 v1.5.x 的 baseUrl/apiKey/model 等字段）。
 *
 * 必须在 stampPreference / recordLocalChange 之前跑：否则旧 JSON 里的陈旧 Key 会被当设置同步出去。
 * @returns 是否真的改写了设置（调用方据此 stamp + 入队一次）
 */
export function normalizeStoredVideoConfig(): boolean {
  const raw = getSetting(VIDEO_CONFIG_KEY) || '';
  if (!raw) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 坏 JSON 按默认值归一化：旧面板写坏的配置不再阻塞同步
    parsed = {};
  }
  const normalized = JSON.stringify(normalize(parsed));
  if (normalized === raw) return false;
  setSetting(VIDEO_CONFIG_KEY, normalized);
  return true;
}

/**
 * 给前端的状态摘要：永远不返回 API Key，只给 hasKey + keySource。
 * keySource：local=本机控制台配了 Key / synced=来自多端同步 / none=未配置（前端据此显示 Key 来源）。
 */
export function videoConfigStatus() {
  const config = getVideoConfig();
  const resolution = videoModelConfig();
  const model = resolution.provider;
  const syncedPreference = resolution.keySource === 'synced' ? preferenceValue(AGENT_MODEL_CONFIG_KEY) : null;
  return {
    configured: config.enabled && resolution.configured,
    enabled: config.enabled,
    provider: model.providerId,
    providerName: model.providerName,
    baseUrl: model.baseUrl,
    model: model.model,
    hasKey: Boolean(model.apiKey),
    keySource: resolution.keySource,
    ...(syncedPreference ? { keyFromNode: syncedPreference.nodeId } : {}),
    missing: config.enabled ? resolution.missing : [],
    // 旧面板字段：固定值，保持旧客户端能正常渲染（v1.5.x APK 里的旧 Web 包）
    maxTokens: VIDEO_MAX_TOKENS,
    quality: VIDEO_QUALITY,
    douyinBrowser: VIDEO_DOUYIN_BROWSER,
  };
}
