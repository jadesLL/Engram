import type { AgentConfig } from '../assistant/config.js';
import { completeText, type ChatContentPart, type ChatMessage } from './modelClient.js';
import { getVideoConfig, videoConfigHint, type VideoConfig } from './videoConfig.js';

/**
 * 视频模型的调用入口：把「视频配置」翻译成 modelClient 能用的 AgentConfig。
 *
 * 只走 openai-completions：视频输入是厂商扩展（video_url 内容块），官方 OpenAI / Anthropic
 * 协议里没有这个块；modelClient 会对不支持的协议明确抛 ModelCapabilityError。
 */

function videoAgentConfig(config: VideoConfig): AgentConfig {
  return { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, api: 'openai-completions' };
}

export interface VideoCompleteOptions {
  signal?: AbortSignal;
  /** 仅供测试注入 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxTokens?: number;
  config?: VideoConfig;
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
  const config = options.config ?? getVideoConfig();
  const hint = videoConfigHint(config);
  if (hint) throw new Error(hint);
  const messages: ChatMessage[] = [{ role: 'user', content: parts }];
  const result = await completeText(messages, {
    maxTokens: options.maxTokens ?? config.maxTokens,
    temperature: 0.2,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs ?? 600_000,
    config: videoAgentConfig(config),
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

/** 设置面板的「测试连通性」：发一个最小文本请求，不消耗视频额度 */
export async function probeVideoModel(input: {
  baseUrl: string;
  model: string;
  apiKey?: string;
}): Promise<ProbeResult> {
  const started = Date.now();
  const baseUrl = String(input.baseUrl || '').trim();
  const model = String(input.model || '').trim();
  const apiKey = String(input.apiKey || '').trim() || getVideoConfig().apiKey;
  if (!baseUrl || !model) return { ok: false, latencyMs: 0, error: 'Base URL 与模型名都要填' };
  if (!apiKey) return { ok: false, latencyMs: 0, error: '没有 API Key：先填写（或保存一次）再测试' };
  try {
    const result = await completeText([{ role: 'user', content: '只回复两个字：已连通' }], {
      maxTokens: 64,
      temperature: 0,
      timeoutMs: 60_000,
      config: { baseUrl, apiKey, model, api: 'openai-completions' },
    });
    return { ok: true, latencyMs: Date.now() - started, sample: result.text.slice(0, 200), model: result.model };
  } catch (error: any) {
    return { ok: false, latencyMs: Date.now() - started, error: String(error?.message || error) };
  }
}
