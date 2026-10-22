import { getSetting, setSetting } from './db.js';

/**
 * 视频理解模型的配置（收集箱「视频链接 → 提炼」用）。
 *
 * 为什么单独一个 settings 键，而不是复用内置 Agent 的 agent_config：
 *  - agent_config 是 dsh 的**文本**路由，改它会接管聊天并让 dsh 运行时按新配置重启；
 *  - 视频输入是厂商扩展（OpenAI 官方没有 video 内容块），需要单独表达
 *    「OpenAI 兼容网关 + video_url 块」这一种形状；
 *  - 用户可能用文本模型写纪要、另一个多模态模型看视频，两者本来就该分开。
 *
 * 只支持 OpenAI 兼容的 chat/completions（请求体见 lib/videoModelClient.ts）。
 */

export type VideoQuality = 64 | 32 | 16;

export interface VideoConfig {
  /** 总开关：关掉后收集箱视频条目不再可提炼（给「先配模型再用」的明确提示） */
  enabled: boolean;
  /** OpenAI 兼容网关地址，通常以 /v1 结尾 */
  baseUrl: string;
  /** 网关凭据（明文存 settings，与本机数据目录同保护级别，与 agent_config 一致） */
  apiKey: string;
  model: string;
  maxTokens: number;
  /** B站下载清晰度：64=720P / 32=480P / 16=360P */
  quality: VideoQuality;
  /** 抖音：用本机浏览器（Edge/Chrome）打开页面取播放地址（实验，仅本机可用） */
  douyinBrowser: boolean;
}

export const VIDEO_CONFIG_KEY = 'video_config';

const DEFAULTS: VideoConfig = {
  enabled: false,
  baseUrl: '',
  apiKey: '',
  model: '',
  maxTokens: 4096,
  quality: 64,
  douyinBrowser: false,
};

export const VIDEO_QUALITIES: VideoQuality[] = [64, 32, 16];

function clampQuality(value: unknown): VideoQuality {
  const n = Number(value);
  return (VIDEO_QUALITIES as number[]).includes(n) ? (n as VideoQuality) : DEFAULTS.quality;
}

function clampTokens(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.maxTokens;
  return Math.max(256, Math.min(65_536, Math.round(n)));
}

function normalize(raw: Partial<VideoConfig> | null | undefined): VideoConfig {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: source.enabled === true,
    baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl.trim() : '',
    apiKey: typeof source.apiKey === 'string' ? source.apiKey.trim() : '',
    model: typeof source.model === 'string' ? source.model.trim() : '',
    maxTokens: clampTokens(source.maxTokens),
    quality: clampQuality(source.quality),
    douyinBrowser: source.douyinBrowser === true,
  };
}

export function getVideoConfig(): VideoConfig {
  const text = getSetting(VIDEO_CONFIG_KEY);
  if (!text) return { ...DEFAULTS };
  try {
    return normalize(JSON.parse(text) as Partial<VideoConfig>);
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

/** 缺哪一项就点哪一项：面板与错误文案共用这一个判定 */
export function videoConfigMissing(config: VideoConfig = getVideoConfig()): string[] {
  const missing: string[] = [];
  if (!config.baseUrl) missing.push('Base URL');
  if (!config.apiKey) missing.push('API Key');
  if (!config.model) missing.push('模型名');
  return missing;
}

/** 能不能直接提炼：开关打开且三项齐全 */
export function videoConfigReady(config: VideoConfig = getVideoConfig()): boolean {
  return config.enabled && videoConfigMissing(config).length === 0;
}

/** 不可用时的可读中文原因（界面 hint 与任务错误共用） */
export function videoConfigHint(config: VideoConfig = getVideoConfig()): string {
  if (!config.enabled) return '视频理解未启用：请到 设置 → Agent 与自动化 → 视频理解模型 打开开关并填写网关';
  const missing = videoConfigMissing(config);
  if (missing.length) return '视频理解模型还缺：' + missing.join('、') + '（设置 → Agent 与自动化 → 视频理解模型）';
  return '';
}

/** 给前端的状态摘要：永远不回显 apiKey，只给 hasKey */
export function videoConfigStatus() {
  const config = getVideoConfig();
  return {
    configured: videoConfigReady(config),
    enabled: config.enabled,
    baseUrl: config.baseUrl,
    model: config.model,
    hasKey: Boolean(config.apiKey),
    maxTokens: config.maxTokens,
    quality: config.quality,
    douyinBrowser: config.douyinBrowser,
    missing: videoConfigMissing(config),
  };
}
