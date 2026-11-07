import type { AgentConfig } from '../assistant/config.js';
import { completeText, type ChatContentPart, type ChatMessage } from './modelClient.js';
import {
  VIDEO_MAX_TOKENS,
  getVideoConfig,
  videoConfigHint,
  videoModelConfig,
} from './videoConfig.js';
import { missingVideoModelFields, type ResolvedVideoModel } from './videoModel.js';

/**
 * 视频模型的调用入口：把「dsh 里解析到的模型配置」翻译成 modelClient 能用的 AgentConfig。
 *
 * 配置来源已改为内置 Agent 控制台的模型配置（lib/videoModel.ts 只读解析），
 * 这里不再读取 Engram 自己的 baseUrl/apiKey/model。
 *
 * 只走 openai-completions：视频输入是厂商扩展（video_url 内容块），官方 OpenAI / Anthropic
 * 协议里没有这个块；modelClient 会对不支持的协议明确抛 ModelCapabilityError。
 */

function videoAgentConfig(model: ResolvedVideoModel): AgentConfig {
  return { baseUrl: model.baseUrl, apiKey: model.apiKey, model: model.model, api: 'openai-completions' };
}

export interface VideoCompleteOptions {
  signal?: AbortSignal;
  /** 仅供测试注入 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxTokens?: number;
  /** 测试/调用方显式指定模型；缺省读 dsh 配置 */
  model?: ResolvedVideoModel;
}

export interface VideoCompleteResult {
  text: string;
  model: string;
}

/** 发一次多模态请求（text + video_url 内容块）。配置不全时抛可读中文原因。 */
export async function completeVideo(
  parts: ChatContentPart[],
  options: VideoCompleteOptions = {}
): Promise<VideoCompleteResult> {
  const model = options.model ?? videoModelConfig().provider;
  const hint = videoConfigHint(getVideoConfig(), model);
  if (hint) throw new Error(hint);
  const messages: ChatMessage[] = [{ role: 'user', content: parts }];
  const result = await completeText(messages, {
    maxTokens: options.maxTokens ?? VIDEO_MAX_TOKENS,
    temperature: 0.2,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs ?? 600_000,
    config: videoAgentConfig(model),
  });
  return { text: result.text, model: result.model };
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  sample?: string;
  model?: string;
  error?: string;
}

/**
 * 设置面板的「测试连通性」：用当前生效的模型配置发一个最小文本请求，不消耗视频额度。
 *
 * 不看总开关：用户可以先测连通性再决定是否开启；只看模型/Key 是否齐全。
 */
export async function probeVideoModel(): Promise<ProbeResult> {
  const started = Date.now();
  const model = videoModelConfig().provider;
  const missing = missingVideoModelFields(model);
  if (missing.length) {
    return { ok: false, latencyMs: 0, error: '视频理解模型还缺：' + missing.join('、') + '（去 内置 Agent 控制台 → 模型 补齐）' };
  }
  try {
    const result = await completeText([{ role: 'user', content: '只回复两个字：已连通' }], {
      maxTokens: 64,
      temperature: 0,
      timeoutMs: 60_000,
      config: videoAgentConfig(model),
    });
    return { ok: true, latencyMs: Date.now() - started, sample: result.text.slice(0, 200), model: result.model };
  } catch (error: any) {
    return { ok: false, latencyMs: Date.now() - started, error: String(error?.message || error) };
  }
}
