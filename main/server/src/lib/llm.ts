import crypto from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import type { ZodType } from 'zod';
import { Agent } from 'undici';
import { db } from './db.js';
import { recordLlmResultCacheHit, recordLlmUsage, type LlmOperation, type LlmUsageIdentity } from './llmUsage.js';
import {
  resolveImageInputCapability,
  type ImageInputCapability,
  type ImageInputSource,
  type ImageInputStatus,
} from './modelCapabilities.js';
import {
  getActiveModelEntry,
  markEntryDialect,
  resolveEntrySecretKey,
  type ModelDialect,
  type ModelEntry,
} from './modelConfig.js';
import { protocolAdapter, type ProtocolAdapter, type ProtocolKind } from './llmProtocols.js';

export type { ModelEntry, ModelDialect };

export function getActiveChat(): ModelEntry | null {
  return getActiveModelEntry('chat');
}

export function getActiveEmbedding(): ModelEntry | null {
  return getActiveModelEntry('embedding');
}

export function getActiveDocument(): ModelEntry | null {
  return getActiveModelEntry('document');
}

export function getActiveRerank(): ModelEntry | null {
  return getActiveModelEntry('rerank');
}

export function getEffectiveDocumentModel(): ModelEntry | null {
  const dedicated = getActiveDocument();
  if (dedicated?.apiKey) return dedicated;
  const chat = getActiveChat();
  if (!chat?.apiKey) return null;
  return resolveImageInputCapability(chat).status === 'supported' ? chat : null;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  chatProtocol: ProtocolKind;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  embeddingDim: number;
}

export function getLlmConfig(): LlmConfig {
  const chat = getActiveChat();
  const emb = getActiveEmbedding();
  return {
    baseUrl: (chat?.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    apiKey: chat?.apiKey || '',
    chatModel: chat?.model || 'deepseek-v4-flash',
    chatProtocol: chat?.protocol === 'anthropic' ? 'anthropic' : 'openai',
    embeddingBaseUrl: (emb?.baseUrl || chat?.baseUrl || '').replace(/\/+$/, ''),
    embeddingApiKey: emb?.apiKey || chat?.apiKey || '',
    embeddingModel: emb?.model || 'text-embedding-3-small',
    embeddingDim: emb?.dim || 1536,
  };
}

export function llmReady(): boolean {
  return Boolean(getActiveChat()?.apiKey);
}

export function documentModelReady(): boolean {
  return Boolean(getEffectiveDocumentModel()?.apiKey);
}

export class LlmError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

type LlmRequestOptions = {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  provider?: string;
  model?: string;
  operation?: LlmOperation;
  tag?: string;
  /** 请求协议（缺省 OpenAI 兼容）；决定 URL/headers/body 与响应转换 */
  protocol?: ProtocolKind;
  /** 免鉴权线路（本地推理）：无 Key 放行且不带鉴权头 */
  authOptional?: boolean;
  /** 关联配置条目 id：供应商参数降级记忆的持久化锚点 */
  entryId?: string;
  /** 条目已持久化的降级声明（发送前预检，避免重启后重复 400 往返） */
  dialect?: ModelDialect;
  /** 重试/长调用期间刷新任务心跳，防止无进度探针在网关挂起重试链中被误触发 */
  onRetry?: () => void;
  usageContext?: {
    scope: string;
    refId: string;
    stage: string;
    prefixHash: string;
    historyMessages: number;
    promptVersion?: string;
    cacheScope?: string;
    dependencyHash?: string;
    resultCacheHit?: boolean;
    retryReason?: string;
  };
};

type LlmHttpResponse = {
  response: Response;
  identity: LlmUsageIdentity;
  startedAt: number;
  adapter: ProtocolAdapter;
};

function responseIdentity(
  path: string,
  body: unknown,
  opts: LlmRequestOptions | undefined,
): LlmUsageIdentity {
  const active = path === '/embeddings' ? getActiveEmbedding() : getActiveChat();
  const defaultOperation = path === '/embeddings' ? 'embedding' : path === '/rerank' ? 'rerank' : 'chat';
  const operation = opts?.operation || defaultOperation;
  return {
    provider: opts?.provider || active?.provider || 'custom',
    model: opts?.model || String((body as any)?.model || active?.model || 'unknown'),
    operation,
    tag: opts?.tag || operation,
    scope: opts?.usageContext?.scope,
    refId: opts?.usageContext?.refId,
    stage: opts?.usageContext?.stage,
    prefixHash: opts?.usageContext?.prefixHash,
    historyMessages: opts?.usageContext?.historyMessages,
    promptVersion: opts?.usageContext?.promptVersion,
    cacheScope: opts?.usageContext?.cacheScope,
    dependencyHash: opts?.usageContext?.dependencyHash,
    resultCacheHit: opts?.usageContext?.resultCacheHit,
    retryReason: opts?.usageContext?.retryReason,
  };
}

function captureUsage(result: LlmHttpResponse, rawUsage: unknown): void {
  try {
    recordLlmUsage(result.identity, rawUsage, Date.now() - result.startedAt);
  } catch (error: any) {
    console.warn('[llm.usage] 用量记录失败', error?.message || error);
  }
}

async function readJsonResponse<T = any>(result: LlmHttpResponse): Promise<T> {
  const raw = await result.response.json() as T;
  // anthropic 协议在边界转成 OpenAI 风格 payload，抽取与用量记账逻辑零改动复用
  const payload = result.adapter.kind === 'anthropic'
    ? (result.adapter.parseResponse(raw) as T)
    : raw;
  captureUsage(result, (payload as any)?.usage);
  return payload;
}

async function request(
  path: string,
  body: unknown,
  opts?: LlmRequestOptions,
): Promise<LlmHttpResponse> {
  const cfg = getLlmConfig();
  const baseUrl = opts?.baseUrl || cfg.baseUrl;
  const apiKey = opts?.apiKey || cfg.apiKey;
  // 免鉴权线路（本地推理 Ollama/LM Studio）：无 Key 也放行，请求不带鉴权头
  if (!apiKey && !opts?.authOptional) {
    throw new LlmError('尚未配置 LLM API Key（设置页 → LLM）');
  }
  const attempt = async (nth: number): Promise<LlmHttpResponse> => {
    try {
      return await requestOnce(path, body, opts, baseUrl, apiKey);
    } catch (error: any) {
      // 瞬时故障不属于内容问题，同参数静默重试再上抛，避免上层把网络抖动固化成
      // 整条任务的失败。覆盖：超时、网络层异常（fetch failed）、408/429/5xx、
      // 以及网关间歇性 401/403（实测自建网关在并发压力下会误报 Invalid API key，
      // 随后同 key 请求恢复）。
      const msg = error.message || '';
      // thinking 参数被供应商/中转网关拒绝时同参重试必然复现（400/422 本就不重试，
      // 502 upstream_error 形态会被下方 5xx 规则误重试），直接上抛给
      // requestChatWithThinkingFallback 删参重试，省掉整段退避等待。
      const isThinkingUpstreamRejection = thinkingErrorDetail(error).rejectsParam
        && Boolean((body as any)?.thinking);
      const retriable = !isThinkingUpstreamRejection
        && error instanceof LlmError
        && !opts?.signal?.aborted
        && (msg === 'LLM 请求超时'
          || msg.startsWith('LLM 网络异常')
          || msg.startsWith('LLM 请求失败 5')
          || /^LLM 请求失败 408/.test(msg)
          || /^LLM 请求失败 429/.test(msg)
          || /^LLM 请求失败 40[13]/.test(msg));
      if (!retriable || nth >= 5) throw error;
      // 429 过载专用长退避（30/60/90/120s，来自 hermes-agent 对 GLM 网关
      // 429 code 1305 过载的实测：短退避会反复撞同一个过载窗口）；
      // 其余瞬时故障维持短退避 3/6/9/12/15s
      const is429 = /^LLM 请求失败 429/.test(msg);
      const delay = is429
        ? [30_000, 60_000, 90_000, 120_000, 120_000][nth] ?? 120_000
        : Math.min(15_000, 3_000 * nth);
      console.warn(`[llm.request] ${error.message.slice(0, 120)}，${delay / 1000} 秒后自动重试（第 ${nth + 1}/5 次）`);
      // 网关挂起 + 多级重试的累计时长可能很长（150s × 4 次），重试前刷新
      // 调用方心跳，防止无进度探针误杀仍在重试链中的任务
      try { opts?.onRetry?.(); } catch { /* 心跳失败不阻塞重试 */ }
      await new Promise((resolve) => setTimeout(resolve, delay));
      return attempt(nth + 1);
    }
  };
  return attempt(0);

}

/** LLM 专用 dispatcher：不复用连接、headersTimeout 放宽到 20 分钟。
 *  全局 fetch（undici 默认 dispatcher）的两个坑：
 *  1) headersTimeout 默认 300s，慢响应（大 max_tokens 长输出）先于我们的动态
 *     超时被 undici 掐断（Headers Timeout Error），随后重试又复用同一个
 *     keep-alive 坏连接 → 连续失败的重试风暴；
 *  2) keep-alive 连接池里挂起过的连接会污染后续请求。 */
const llmDispatcher = new Agent({
  keepAliveTimeout: 1,          // 实质上禁用连接复用
  keepAliveMaxTimeout: 1,
  headersTimeout: 20 * 60_000,  // 与动态超时上限对齐
  bodyTimeout: 20 * 60_000,
  connections: 16,
});

async function requestOnce(
  path: string,
  body: unknown,
  opts: LlmRequestOptions | undefined,
  baseUrl: string,
  apiKey: string,
): Promise<LlmHttpResponse> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const signal = opts?.signal
    ? AbortSignal.any([controller.signal, opts.signal])
    : controller.signal;
  // 超时按输出预算动态估算：实测网关吞吐 ~11s/1000 completion tokens（8k 输出
  // 约 90-140s）。固定值会把「正常的长输出请求」误判为超时，陷入重试死循环
  //（重发同样的请求又是同样的长输出）。按 max_tokens 0.03s/token 估算并留足
  // 余量，下限 150s。
  const budgetTokens = typeof (body as any)?.max_tokens === 'number' ? (body as any).max_tokens : 4000;
  const estimatedMs = Math.max(150_000, Math.ceil(budgetTokens * 30));
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? estimatedMs);
  const adapter = protocolAdapter(opts?.protocol);
  try {
    const res = await fetch(adapter.url(baseUrl, path), {
      method: 'POST',
      headers: apiKey ? adapter.headers(apiKey) : { 'Content-Type': 'application/json' },
      body: JSON.stringify(adapter.buildBody(body as Record<string, unknown> & { model: string; messages: unknown[] })),
      signal,
      // Node fetch 支持 dispatcher 选项（undici）；类型定义未包含，断言绕过
      dispatcher: llmDispatcher,
    } as unknown as RequestInit);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LlmError(`LLM 请求失败 ${res.status}: ${text.slice(0, 300)}`, res.status);
    }
    return {
      response: res,
      identity: responseIdentity(path, body, opts),
      startedAt,
      adapter,
    };
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new LlmError(opts?.signal?.aborted ? 'AI 请求已取消' : 'LLM 请求超时');
    }
    // 网络层异常（连接重置/DNS/TLS）：undici 包成 TypeError 'fetch failed'，
    // 统一转 LlmError 交给网络层重试（不重试的话瞬时断连会固化成任务失败）
    if (error instanceof TypeError && /fetch failed/i.test(error?.message || '')) {
      const cause = (error as any)?.cause ? `（${String((error as any).cause.message || (error as any).cause).slice(0, 80)}）` : '';
      throw new LlmError(`LLM 网络异常 fetch failed${cause}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

export interface ChatToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatToolResult {
  content: string;
  toolCalls: ChatToolCall[];
  finishReason?: string;
}

export interface DocumentImagePart {
  type: 'image_url';
  image_url: { url: string };
}

export interface DocumentTextPart {
  type: 'text';
  text: string;
}

export function buildDocumentRequestBody(
  entry: Pick<ModelEntry, 'model'>,
  imageDataUrl: string,
  prompt: string,
  maxTokens = 8192,
): Record<string, unknown> {
  return {
    model: entry.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageDataUrl } } satisfies DocumentImagePart,
        { type: 'text', text: prompt } satisfies DocumentTextPart,
      ],
    }],
    temperature: 0,
    max_tokens: maxTokens,
  };
}

export interface ImageCapabilityChallenge {
  code: string;
  dataUrl: string;
  prompt: string;
}

export function createImageCapabilityChallenge(code?: string): ImageCapabilityChallenge {
  const challengeCode = code || String(crypto.randomInt(100_000, 1_000_000));
  const canvas = createCanvas(320, 120);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#c7c7c7';
  context.lineWidth = 2;
  context.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
  context.fillStyle = '#111111';
  context.font = 'bold 52px sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(challengeCode, canvas.width / 2, canvas.height / 2);
  return {
    code: challengeCode,
    dataUrl: `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`,
    prompt: '读取图片中央的六位数字。只回复数字，不要解释。',
  };
}

function messageText(message: any): string {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part: any) => typeof part === 'string' ? part : String(part?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export async function recognizeDocumentImage(
  imageDataUrl: string,
  prompt: string,
  options: {
    entry?: ModelEntry;
    maxTokens?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  const entry = options.entry || getEffectiveDocumentModel();
  if (!entry?.apiKey) {
    throw new LlmError('当前对话模型不支持图片输入，且尚未配置视觉模型（设置页 → 模型配置 → 视觉模型）');
  }
  const response = await request(
    '/chat/completions',
    buildDocumentRequestBody(entry, imageDataUrl, prompt, options.maxTokens),
    {
      baseUrl: entry.baseUrl.replace(/\/+$/, ''),
      apiKey: entry.apiKey,
      timeoutMs: options.timeoutMs ?? 180_000,
      provider: entry.provider,
      model: entry.model,
      operation: 'document',
      tag: 'document-ocr',
      signal: options.signal,
      protocol: entry.protocol,
      authOptional: entry.authOptional,
      entryId: entry.id,
      dialect: entry.dialect,
    },
  );
  const payload = await readJsonResponse(response);
  const content = messageText(payload?.choices?.[0]?.message).trim();
  if (!content) throw new LlmError('视觉模型返回了空内容');
  return content;
}

function normalizedChallengeAnswer(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function explicitlyRejectsImageInput(error: unknown): boolean {
  if (!(error instanceof LlmError) || ![400, 415, 422].includes(error.status || 0)) return false;
  const message = error.message.toLowerCase();
  const mentionsImage = /(image_url|image input|image content|vision|visual|multimodal)/.test(message);
  const rejectsInput = /(not support|unsupported|does not support|invalid|must be|string content)/.test(message);
  return mentionsImage && rejectsInput;
}

export async function probeImageInput(
  entry: ModelEntry,
  options: { force?: boolean; challenge?: ImageCapabilityChallenge; timeoutMs?: number } = {},
): Promise<ImageInputCapability> {
  if (!entry.apiKey && !entry.authOptional) {
    return { status: 'unknown', source: 'probe', detail: '未填写 API Key，无法检测图片能力。' };
  }
  if (!options.force) {
    const known = resolveImageInputCapability(entry);
    if (known.status !== 'unknown') return known;
  }

  const challenge = options.challenge || createImageCapabilityChallenge();
  try {
    const response = await request(
      '/chat/completions',
      // 2048：「始终思考」模型（GLM-5.3 网关）的 reasoning 也占 max_tokens，
      // 给太小会截断到正文为空，探测永远 unknown
      buildDocumentRequestBody(entry, challenge.dataUrl, challenge.prompt, 2048),
      {
        baseUrl: entry.baseUrl.replace(/\/+$/, ''),
        apiKey: entry.apiKey,
        timeoutMs: options.timeoutMs ?? 45_000,
        provider: entry.provider,
        model: entry.model,
        operation: 'document',
        tag: 'image-capability-probe',
        protocol: entry.protocol,
        authOptional: entry.authOptional,
        entryId: entry.id,
        dialect: entry.dialect,
      },
    );
    const payload = await readJsonResponse(response);
    const message = payload?.choices?.[0]?.message;
    const content = messageText(message).trim();
    // 部分思考模型把读图结果写在 reasoning_content，正文被截断或为空时兜底扫推理文本
    const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content : '';
    if (normalizedChallengeAnswer(content).includes(challenge.code)
      || (!content && normalizedChallengeAnswer(reasoning).includes(challenge.code))) {
      return { status: 'supported', source: 'probe' };
    }
    return {
      status: 'unknown',
      source: 'probe',
      detail: content
        ? `模型已响应，但未能读出测试图片中的数字：${content.slice(0, 80)}`
        : reasoning.trim()
          ? `模型仅返回了思考过程，未输出正文：${reasoning.trim().slice(0, 80)}`
          : '模型已响应，但未返回可验证的图片内容。',
    };
  } catch (error: any) {
    if (explicitlyRejectsImageInput(error)) {
      return {
        status: 'unsupported',
        source: 'probe',
        detail: '接口明确拒绝了图片输入。',
      };
    }
    return {
      status: 'unknown',
      source: 'probe',
      detail: error?.message || '图片能力检测失败。',
    };
  }
}

/** 模型 thinking 适配状态（key 为 baseUrl|model）。两类供应商：
 *  1) 非思考模型：带 thinking 参数直接 400 → 完全删除该参数重试；
 *  2) 「始终思考」模型（如 GLM-5.3）：拒绝 {type:'disabled'}，提示只支持 low/high/max
 *     → 必须以思考模式使用，固定 {type:'low'}。降级记忆走条目 dialect 字段
 *     （markEntryDialect，重启后仍生效，不重复撞 400）。
 *     这类模型 reasoning_content 无法关闭，靠 max_tokens 截断识别
 *     （chat() 的 hasReasoning 分支翻倍重试）兜底。 */
const thinkingUnsupported = new Set<string>();
const thinkingLevelOnly = new Set<string>();

function thinkingErrorDetail(error: unknown): { rejectsParam: boolean; requiresLevel: boolean } {
  if (!(error instanceof LlmError)) return { rejectsParam: false, requiresLevel: false };
  // 部分网关把上游 400 包装成 502 upstream_error（实测 GLM-5.3 网关两种都有），一并接受
  if (![400, 422, 502].includes(error.status || 0)) {
    return { rejectsParam: false, requiresLevel: false };
  }
  const msg = error.message || '';
  // 供应商报错文案两类：带英文参数名 "thinking"，或纯中文「该模型始终思考，不支持关闭思考」
  //（实测 GLM-5.3 的 400 文案完全不含 "thinking"，只认中文关键词）。
  const mentionsThinking = /thinking/i.test(msg) || /思考/i.test(msg);
  if (!mentionsThinking) return { rejectsParam: false, requiresLevel: false };
  // 「始终思考，不支持关闭思考；请使用 low、high 或 max」一类错误：参数本身被接受，
  // 但 disabled 值非法，必须以思考模式（low 档）使用而非删除参数。
  // level 词用 \b 词边界匹配，排除 max_tokens 报错形态（"max" 后跟 "_" 不构成边界）。
  const requiresLevel =
    /\b(low|high|max)\b/i.test(msg) ||
    /始终思考|不支持关闭|cannot be disabled|always think/i.test(msg);
  return { rejectsParam: true, requiresLevel };
}

/** 发送 /chat/completions 请求；供应商拒绝 thinking 参数时自动降级重试。
 *  降级记忆双写：进程内 Set（热路径零开销）+ 条目 dialect 字段（重启后免重复 400）。
 *  两类拒绝：完全不支持 thinking 参数（删除重试）与「始终思考」只接受
 *  low/high/max（GLM-5.3 一类，降级 {type:'low'} 以思考模式使用）。 */
async function requestChatWithThinkingFallback(
  body: Record<string, unknown>,
  capabilityKey: string,
  opts: LlmRequestOptions,
): Promise<LlmHttpResponse> {
  const configuredLevel = body.thinking && (body.thinking as any).type !== 'disabled';
  // 用户显式配置 low/high/max 时，能力记忆不得删除/覆盖用户选择
  if (!configuredLevel && body.thinking) {
    if (thinkingUnsupported.has(capabilityKey) || opts.dialect?.thinkingRejected) {
      delete body.thinking;
    } else if (thinkingLevelOnly.has(capabilityKey) || opts.dialect?.thinkingLevelOnly) {
      body.thinking = { type: 'low' };
    }
  }
  try {
    return await request('/chat/completions', body, opts);
  } catch (error) {
    if (!body.thinking) throw error;
    const detail = thinkingErrorDetail(error);
    if (!detail.rejectsParam) throw error;
    if (configuredLevel) {
      throw new LlmError(`模型拒绝用户选择的思考等级 ${(body.thinking as any).type}：${error instanceof Error ? error.message : String(error)}`);
    }
    if (detail.requiresLevel) {
      body.thinking = { type: 'low' };
      const res = await request('/chat/completions', body, opts);
      thinkingLevelOnly.add(capabilityKey);
      if (opts.entryId) markEntryDialect(opts.entryId, { thinkingLevelOnly: true });
      return res;
    }
    delete body.thinking;
    const res = await request('/chat/completions', body, opts);
    thinkingUnsupported.add(capabilityKey);
    if (opts.entryId) markEntryDialect(opts.entryId, { thinkingRejected: true });
    return res;
  }
}


/** 构造思考参数。两类模型用不同旋钮（参考 NousResearch/hermes-agent zai 插件）：
 *  - GLM-5.2/5.3（OpenAI 兼容线）：`reasoning_effort` 是思考力度旋钮
 *    （low/medium/high/max，GLM-5.3 全档），实测可控思考量——这才是
 *    控制思考的正道；`thinking:{type}` 只是开关，不控制力度且实测显式
 *    发送会诱导思考膨胀。未配置时默认 high（GLM 推荐档，hermes 同款默认）
 *  - 其他思考模型：`thinking:{type}` 开关语义，未配置不显式发送
 *  Anthropic 协议两者都不支持，明确报错。 */
function applyConfiguredThinking(body: Record<string, unknown>, entry: ModelEntry | null): void {
  if (entry?.protocol === 'anthropic' && entry?.thinkingLevel) {
    throw new LlmError('当前 Anthropic 协议不支持 low/high/max thinking 参数，请改用 OpenAI 兼容线路');
  }
  const model = (entry?.model || '').toLowerCase();
  // GLM-5.2/5.3 家族（含中继别名 glm-5-3/glm-5p3 等）走 reasoning_effort；
  // 未配置默认 high（GLM 推荐档）
  if (/glm-5[.-]?[23]|glm-5p[23]/.test(model)) {
    body.reasoning_effort = entry?.thinkingLevel || 'high';
    return;
  }
  if (!entry?.thinkingLevel) return;
  body.thinking = { type: entry.thinkingLevel };
}

type ChatOptions = {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  json?: boolean;
  signal?: AbortSignal;
  tag?: string;
  usageContext?: LlmRequestOptions['usageContext'];
  disableThinking?: boolean;
  /** 网络层重试期间刷新（任务心跳） */
  onRetry?: () => void;
};

/** 流式读取一次 SSE 响应并累积为完整文本。
 *  返回 content 拼接结果与截断判定所需信息；用量经 captureUsage 精确记账
 *  （含 stream_options.include_usage 的最终 usage 帧）。
 *  思考失控熔断：思考增量累计超过阈值且正文仍为空时提前中止——
 *  实测思考量随机波动，小预算下重发往往恢复正常，远优于干等思考耗尽预算。 */
async function readStreamResponse(
  result: LlmHttpResponse,
  opts?: { json?: boolean },
): Promise<{ content: string; finishReason: string; hasReasoning: boolean; reasoningChars: number }> {
  if (!result.response.body) throw new LlmError('LLM 无流式响应体');
  // 部分网关忽略 stream 参数直接返回整包 JSON（Content-Type: application/json）。
  // 读取整个 body 按非流式响应解析，与旧 chat 行为等价
  const contentType = result.response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = await readJsonResponse(result);
    const choice = json?.choices?.[0];
    const msg = choice?.message;
    return {
      content: typeof msg?.content === 'string' ? msg.content : '',
      finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : '',
      hasReasoning: typeof msg?.reasoning_content === 'string' && msg.reasoning_content.length > 0,
      reasoningChars: typeof msg?.reasoning_content === 'string' ? msg.reasoning_content.length : 0,
    };
  }
  const parser = result.adapter.createStreamParser();
  const reader = result.response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let finishReason = '';
  let usageCaptured = false;
  // 熔断阈值：正文为空时思考累计字符上限。正常思考 2-3k chars，失控时 10k+；
  // 按 ~1.6 chars/token 折算约 9k token 思考预算，超限即止损
  const reasoningLimit = 16_000;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 空闲超时：相邻 chunk 间隔超过 60s 视为挂起。流式下正常间隔为亚秒级
    const idleTimeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void reader.cancel();
        reject(new LlmError('LLM 流式响应超时'));
      }, 60_000);
    });
    const { done, value } = await Promise.race([reader.read(), idleTimeout])
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const parsed = parser.feed(t.slice(5).trim());
      if (parsed.done) {
        if (parsed.finishReason) finishReason = parsed.finishReason;
        return { content, finishReason, hasReasoning: reasoning.length > 0, reasoningChars: reasoning.length };
      }
      if (parsed.text) content += parsed.text;
      if (parsed.reasoning) reasoning += parsed.reasoning;
      if (!usageCaptured && parsed.usage) {
        captureUsage(result, parsed.usage);
        usageCaptured = true;
      }
      // 熔断：思考已远超正常量而正文一个字没出——继续等只会耗尽 max_tokens
      if (!content && !opts?.json && reasoning.length > reasoningLimit) {
        void reader.cancel().catch(() => {});
        throw new LlmError('输出被截断（思考失控熔断）');
      }
    }
  }
  return { content, finishReason, hasReasoning: reasoning.length > 0, reasoningChars: reasoning.length };
}

/** json_object 契约守卫：OpenAI 系规范要求提示词含 "json" 字样，DeepSeek/OpenAI
 *  官方严格校验（缺失直接 400 invalid_request_error，且 400 不在网络层重试白名单，
 *  阶段/任务当场判死）；GLM/通义等宽松实现不校验。仅在整组消息缺失该字样时把
 *  一句指令追加到首条 system 消息末尾补齐契约（无 system 则前置一条）——不改各
 *  阶段提示词文本与消息顺序，「末条消息=阶段输入」约定、语义缓存键（更上层按
 *  input 计算）与网关前缀缓存（SHARED_HEADER 在 system 开头，块前缀不变）均不受
 *  影响。实测网关按 /json/i 不区分大小写。 */
const JSON_CONTRACT_LINE = '输出必须是合法的 JSON（json）对象，不要包含解释或 Markdown 围栏。';

export function withJsonContractMessage(messages: ChatMessage[]): ChatMessage[] {
  if (messages.some((message) => typeof message.content === 'string' && /json/i.test(message.content))) {
    return messages;
  }
  const [first, ...rest] = messages;
  if (first?.role === 'system') {
    return [{ ...first, content: `${first.content}\n${JSON_CONTRACT_LINE}` }, ...rest];
  }
  return [{ role: 'system', content: JSON_CONTRACT_LINE }, ...messages];
}

/** 对话：底层一律流式传输（思考模型网关下非流式长等待易被中间层掐断；
 *  SSE 边收边拼，用量含缓存命中精确记账），对外仍返回完整文本 */
export async function chat(
  messages: ChatMessage[],
  opts?: ChatOptions
): Promise<string> {
  const cfg = getLlmConfig();
  const body: Record<string, unknown> = {
    model: cfg.chatModel,
    messages,
    temperature: opts?.temperature ?? 0.3,
    stream: true,
  };
  if (opts?.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts?.topP !== undefined) body.top_p = opts.topP;
  if (opts?.json) {
    body.response_format = { type: 'json_object' };
    body.messages = withJsonContractMessage(messages);
  }
  const active = getActiveChat();
  if (opts?.disableThinking) body.thinking = { type: 'disabled' };
  else applyConfiguredThinking(body, active);
  const capabilityKey = `${cfg.baseUrl}|${cfg.chatModel}`;
  // include_usage 让最终帧带精确用量（prompt/cache/completion），缺失的网关由非流式形态回退
  const useStreamOptions =
    !streamUsageUnsupported.has(capabilityKey) && !(active?.dialect?.streamUsageRejected);
  if (useStreamOptions && active?.protocol !== 'anthropic') {
    body.stream_options = { include_usage: true };
  }
  const streamOpts = {
    signal: opts?.signal,
    tag: opts?.tag || 'chat',
    usageContext: opts?.usageContext,
    protocol: active?.protocol,
    authOptional: active?.authOptional,
    entryId: active?.id,
    dialect: active?.dialect,
    onRetry: opts?.onRetry,
  } satisfies LlmRequestOptions;

  let content = '';
  let finishReason = '';
  let hasReasoning = false;
  try {
    let res = await requestChatWithThinkingFallback(body, capabilityKey, streamOpts);
    try {
      const parsed = await readStreamResponse(res, { json: opts?.json });
      content = parsed.content;
      finishReason = parsed.finishReason;
      hasReasoning = parsed.hasReasoning;
    } catch (error: any) {
      // stream_options 不被支持（400）时去掉重发；流中断/熔断错误原样上抛
      const streamUsageRejected =
        error instanceof LlmError && [400, 422].includes(error.status || 0) && body.stream_options;
      if (!streamUsageRejected) throw error;
      delete body.stream_options;
      res = await requestChatWithThinkingFallback(body, capabilityKey, streamOpts);
      streamUsageUnsupported.add(capabilityKey);
      if (active?.id) markEntryDialect(active.id, { streamUsageRejected: true });
      const parsed = await readStreamResponse(res, { json: opts?.json });
      content = parsed.content;
      finishReason = parsed.finishReason;
      hasReasoning = parsed.hasReasoning;
    }
  } catch (error: any) {
    // 网关明确拒绝 stream 参数（400/422 且报错提及 stream）时回退非流式重试。
    // 5xx 不在此列：那是服务端故障，走网络层统一重试，删 stream 重发只会
    // 把失败链拉长一倍（每次 request 调用各有独立重试预算）
    const streamRejected =
      error instanceof LlmError &&
      [400, 422].includes(error.status || 0) &&
      /stream/i.test(error.message || '') &&
      body.stream;
    if (streamRejected) {
      delete body.stream;
      delete body.stream_options;
      const res = await requestChatWithThinkingFallback(body, capabilityKey, streamOpts);
      const json = await readJsonResponse(res);
      const choice = json?.choices?.[0];
      const msg = choice?.message;
      content = typeof msg?.content === 'string' ? msg.content : '';
      finishReason = choice?.finish_reason || '';
      hasReasoning = typeof msg?.reasoning_content === 'string' && msg.reasoning_content.length > 0;
    } else {
      throw error;
    }
  }

  if (!content) {
    // content 为空的三类诱因，分别给出可被上层重试逻辑识别的错误：
    // 1) finish_reason='length'：max_tokens 真截断
    // 2) 推理模型 reasoning_content 吃光预算但 content 为空（finish_reason 常为 stop）
    // 3) 真·空内容（疑似服务商内容过滤）→ 格式异常，按提示重试
    console.warn('[llm.chat] 返回内容为空', { model: cfg.chatModel, finishReason, hasReasoning });
    throw new LlmError(
      finishReason === 'length' || hasReasoning
        ? '输出被截断（推理占用 max_tokens，content 为空）'
        : 'LLM 返回格式异常',
    );
  }
  return content;
}

/** OpenAI-compatible native tool calling. Unsupported providers are handled by the caller's JSON fallback. */
export async function chatWithTools(
  messages: ChatMessage[],
  tools: ChatToolDefinition[],
  opts?: Omit<ChatOptions, 'json'>
): Promise<ChatToolResult> {
  const cfg = getLlmConfig();
  const body: Record<string, unknown> = {
    model: cfg.chatModel,
    messages,
    tools,
    tool_choice: 'auto',
    temperature: opts?.temperature ?? 0.2,
  };
  if (opts?.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts?.topP !== undefined) body.top_p = opts.topP;
  const active = getActiveChat();
  if (active?.thinkingLevel) applyConfiguredThinking(body, active);
  else if (opts?.disableThinking) body.thinking = { type: 'disabled' };
  const res = await requestChatWithThinkingFallback(body, `${cfg.baseUrl}|${cfg.chatModel}`, {
    signal: opts?.signal,
    tag: opts?.tag || 'chat-tools',
    usageContext: opts?.usageContext,
    protocol: active?.protocol,
    authOptional: active?.authOptional,
    entryId: active?.id,
    dialect: active?.dialect,
    onRetry: opts?.onRetry,
  });
  const payload = await readJsonResponse(res);
  const choice = payload?.choices?.[0];
  const message = choice?.message;
  const toolCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls
      .filter((call: any) =>
        typeof call?.id === 'string' &&
        call?.type === 'function' &&
        typeof call?.function?.name === 'string' &&
        typeof call?.function?.arguments === 'string'
      )
      .map((call: any) => ({
        id: call.id,
        type: 'function' as const,
        function: {
          name: call.function.name,
          arguments: call.function.arguments,
        },
      }))
    : [];
  const content = typeof message?.content === 'string'
    ? message.content
    : (!toolCalls.length && typeof message?.reasoning_content === 'string' ? message.reasoning_content : '');
  if (!content && !toolCalls.length) {
    throw new LlmError('LLM 工具调用返回格式异常');
  }
  return { content, toolCalls, finishReason: choice?.finish_reason };
}

/** 容错的 JSON 对话：优先 json 模式；解析失败自动剥离围栏/重试，最终失败抛错（不静默返回空）。
 *  输出被 max_tokens 截断时，重试自动翻倍 max_tokens。 */
export async function chatJson<T = any>(
  messages: ChatMessage[],
  opts?: Omit<ChatOptions, 'json'> & { retries?: number; truncationRetries?: number; tag?: string }
): Promise<T> {
  const tag = opts?.tag || 'chatJson';
  const retries = opts?.retries ?? 1;
  // 截断翻倍独立预算：思考模型的思考量随机波动导致的长度截断，与内容质量无关，
  // 允许调用方（chatJsonSchema 内层 retries=0 时）保留一次翻倍自愈
  let truncationRetriesLeft = opts?.truncationRetries ?? 1;
  let lastErr = '';
  let retryReason = opts?.usageContext?.retryReason || '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    let raw: string;
    try {
      raw = await chat(messages, {
        ...opts,
        json: true,
        maxTokens: opts?.maxTokens,
        usageContext: opts?.usageContext
          ? { ...opts.usageContext, retryReason }
          : undefined,
      });
    } catch (e: any) {
      lastErr = `请求失败: ${e.message}`;
      console.warn(`[llm.chatJson:${tag}] 请求失败`, e.message);
      if (opts?.signal?.aborted) throw e;
      const isTruncation = e.message.includes('截断');
      // 截断走独立预算（truncationRetries）：思考模型的思考量随机波动导致的
      // 长度问题与内容质量无关；不放大 max_tokens（实测预算越大思考越长），
      // 原样重发一次，波动消退即可通过
      const canTruncationRetry = isTruncation && truncationRetriesLeft > 0;
      if (attempt < retries || canTruncationRetry) {
        if (isTruncation) {
          if (!canTruncationRetry) throw e;
          truncationRetriesLeft--;
          retryReason = 'output_truncated';
          continue;
        }
        retryReason = 'request_failed';
        messages = [...messages, { role: 'user' as const, content: '上一轮请求失败或返回空内容。请直接输出完整的 JSON 对象，不要省略或返回空响应。' }];
        continue;
      }
      throw new LlmError(`[${tag}] ${lastErr}`);
    }
    const parsed = tryParseJson<T>(raw);
    if (parsed.ok) return parsed.value;
    // 看起来像被截断的 JSON（以 { 或 [ 开头，但末尾没有对应的 } 或 ]）
    const trimmed = raw.trim();
    const looksTruncated =
      (trimmed.startsWith('{') && !trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && !trimmed.endsWith(']'));
    lastErr = `无法解析为 JSON（前80字: ${trimmed.slice(0, 80).replace(/\n/g, ' ')}）`;
    console.warn(`[llm.chatJson:${tag}] 解析失败${looksTruncated ? '（疑似截断）' : ''}`, lastErr);
    if (attempt < retries) {
      if (looksTruncated) {
        // 截断：原样重发（思考波动随机，重发即可能恢复），不追加消息、不放大预算
        if (truncationRetriesLeft <= 0 && attempt >= retries) break;
        truncationRetriesLeft--;
        retryReason = 'json_truncated';
        continue;
      }
      retryReason = 'json_parse_failed';
      messages = [
        ...messages,
        { role: 'assistant' as const, content: raw },
        {
          role: 'user' as const,
          content: '你上一轮的输出无法解析为合法 JSON。请只输出 JSON 对象本身，不要包含任何解释、Markdown 代码围栏或多余文字。',
        },
      ];
    }
  }
  throw new LlmError(`[${tag}] ${lastErr}`);
}

/** JSON 对话并用 Zod 做运行时校验；校验失败时带错误详情重试一次。 */
export async function chatJsonSchema<T>(
  schema: ZodType<T>,
  messages: ChatMessage[],
  opts?: Omit<ChatOptions, 'json'> & { retries?: number; truncationRetries?: number; tag?: string }
): Promise<T> {
  const tag = opts?.tag || 'chatJsonSchema';
  const attempts = opts?.retries ?? 1;
  let current = messages;
  let lastError = 'schema validation failed';
  for (let attempt = 0; attempt <= attempts; attempt++) {
    opts?.signal?.throwIfAborted();
    // 拆除嵌套乘法：schema 层独占内容重试预算；但「截断翻倍」是长度修复
    // 而非内容重试（思考模型思考量随机波动，8k 预算 1/3 概率被思考吃光），
    // 内层保留一次截断翻倍能力，与 schema 层不叠加
    const value = await chatJson<unknown>(current, {
      ...opts,
      retries: 0,
      truncationRetries: 1,
      tag,
      usageContext: opts?.usageContext
        ? {
            ...opts.usageContext,
            retryReason: attempt ? 'schema_validation_failed' : opts.usageContext.retryReason,
          }
        : undefined,
    });
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    lastError = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    current = [...current, { role: 'user', content: `输出未通过结构校验：${lastError}。请按原格式完整重输 JSON。` }];
  }
  throw new LlmError(`[${tag}] ${lastError}`);
}

/** 工具调用式结构化输出：用 function calling 取代 JSON mode，规避推理模型在 JSON mode 下
 *  返回纯文本正文（非 JSON）导致解析失败。对称 chatJsonSchema：tool arguments → JSON.parse →
 *  Zod 校验，失败带详情重试。结构化输出场景一律关闭 thinking。 */
export interface ToolSchemaOptions {
  toolName: string;
  toolDescription: string;
  parameters: Record<string, unknown>;
}

export async function chatToolSchema<T>(
  schema: ZodType<T>,
  tool: ToolSchemaOptions,
  messages: ChatMessage[],
  opts?: Omit<ChatOptions, 'json'> & { retries?: number; tag?: string }
): Promise<T> {
  const tag = opts?.tag || 'chatToolSchema';
  const attempts = opts?.retries ?? 1;
  let current = messages;
  let lastError = 'tool schema validation failed';
  let curMaxTokens = opts?.maxTokens;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    opts?.signal?.throwIfAborted();
    const def: ChatToolDefinition = {
      type: 'function',
      function: {
        name: tool.toolName,
        description: tool.toolDescription,
        parameters: tool.parameters,
      },
    };
    const result = await chatWithTools(current, [def], {
      ...opts,
      maxTokens: curMaxTokens,
      disableThinking: true,
      tag,
    });
    const call = result.toolCalls[0];
    if (!call) {
      lastError = result.content
        ? `模型未调用工具，返回了纯文本（前80字: ${result.content.slice(0, 80).replace(/\n/g, ' ')}）`
        : '模型未返回工具调用或文本';
      console.warn(`[llm.chatToolSchema:${tag}] 未调用工具`, lastError);
      if (attempt < attempts) {
        current = [
          ...current,
          { role: 'assistant', content: result.content || '' },
          { role: 'user', content: '请调用工具提交结构化结果，不要直接输出文本。' },
        ];
        continue;
      }
      throw new LlmError(`[${tag}] ${lastError}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.function.arguments);
    } catch {
      lastError = `工具参数无法解析为 JSON（前80字: ${call.function.arguments.slice(0, 80).replace(/\n/g, ' ')}）`;
      console.warn(`[llm.chatToolSchema:${tag}] 参数解析失败`, lastError);
      if (attempt < attempts) {
        // 参数以 { 或 [ 开头但无法解析时大概率是 max_tokens 截断：翻倍重试，
        // 与 chatJson 的截断策略对齐；追加上一轮失败参数反而会把截断样本再灌进上下文。
        const trimmed = call.function.arguments.trim();
        const looksTruncated =
          (trimmed.startsWith('{') && !trimmed.endsWith('}')) ||
          (trimmed.startsWith('[') && !trimmed.endsWith(']'));
        if (looksTruncated) {
          curMaxTokens = Math.min(32_000, (curMaxTokens || 4000) * 2);  // 翻倍仅一次空间
        }
        current = [
          ...current,
          { role: 'assistant', content: '', tool_calls: [{ id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } }] },
          { role: 'tool', tool_call_id: call.id, content: '参数无法解析为合法 JSON。请重新调用工具，提供完整的 JSON 参数。' },
        ];
        continue;
      }
      throw new LlmError(`[${tag}] ${lastError}`);
    }
    const validated = schema.safeParse(parsed);
    if (validated.success) return validated.data;
    lastError = validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    console.warn(`[llm.chatToolSchema:${tag}] 结构校验失败`, lastError);
    if (attempt < attempts) {
      current = [
        ...current,
        { role: 'assistant', content: '', tool_calls: [{ id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } }] },
        { role: 'tool', tool_call_id: call.id, content: `输出未通过结构校验：${lastError}。请按工具参数结构重新调用，提供完整且合法的参数。` },
      ];
      continue;
    }
    throw new LlmError(`[${tag}] ${lastError}`);
  }
  throw new LlmError(`[${tag}] ${lastError}`);
}

/** 多策略 JSON 解析：直接解析 -> 剥离 ```json 围栏 -> 截取首个 {...} 或 [...] */
function tryParseJson<T>(raw: string): { ok: true; value: T } | { ok: false } {
  const candidates: string[] = [raw];
  // 剥离 ```json ... ``` 围栏
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  // 截取首个 {...}
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) candidates.push(obj[0]);
  // 截取首个 [...]
  const arr = raw.match(/\[[\s\S]*\]/);
  if (arr) candidates.push(arr[0]);
  for (const c of candidates) {
    try {
      return { ok: true, value: JSON.parse(c) as T };
    } catch {
      /* 试下一个 */
    }
  }
  return { ok: false };
}

const streamUsageUnsupported = new Set<string>();

/** 流式对话：逐段回调。anthropic 协议走事件型 SSE，由 adapter 的流解析器统一差异。 */
export async function chatStream(
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  opts?: Omit<ChatOptions, 'json'>
): Promise<void> {
  const cfg = getLlmConfig();
  const body: Record<string, unknown> = {
    model: cfg.chatModel,
    messages,
    temperature: opts?.temperature ?? 0.3,
    stream: true,
  };
  if (opts?.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts?.topP !== undefined) body.top_p = opts.topP;
  const active = getActiveChat();
  applyConfiguredThinking(body, active);
  const capabilityKey = `${cfg.baseUrl}|${cfg.chatModel}`;
  const streamOpts = {
    signal: opts?.signal,
    tag: opts?.tag || 'chat-stream',
    usageContext: opts?.usageContext,
    protocol: active?.protocol,
    authOptional: active?.authOptional,
    entryId: active?.id,
    dialect: active?.dialect,
    onRetry: opts?.onRetry,
  } satisfies LlmRequestOptions;
  const useStreamOptions =
    !streamUsageUnsupported.has(capabilityKey) && !(active?.dialect?.streamUsageRejected);
  if (useStreamOptions && active?.protocol !== 'anthropic') {
    body.stream_options = { include_usage: true };
  }
  let res: LlmHttpResponse;
  try {
    res = await requestChatWithThinkingFallback(body, capabilityKey, streamOpts);
  } catch (error) {
    const unsupported =
      error instanceof LlmError &&
      [400, 422].includes(error.status || 0);
    if (!unsupported || !body.stream_options) throw error;
    delete body.stream_options;
    res = await requestChatWithThinkingFallback(body, capabilityKey, streamOpts);
    streamUsageUnsupported.add(capabilityKey);
    if (active?.id) markEntryDialect(active.id, { streamUsageRejected: true });
  }
  if (!res.response.body) throw new LlmError('LLM 无流式响应体');
  const parser = res.adapter.createStreamParser();
  const reader = res.response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usageCaptured = false;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idleTimeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void reader.cancel();
        reject(new LlmError('LLM 流式响应超时'));
      }, 45_000);
    });
    const { done, value } = await Promise.race([reader.read(), idleTimeout])
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const parsed = parser.feed(t.slice(5).trim());
      if (parsed.done) return;
      if (parsed.text) onDelta(parsed.text);
      if (!usageCaptured && parsed.usage) {
        captureUsage(res, parsed.usage);
        usageCaptured = true;
      }
    }
  }
}

type EmbeddingRequestBody = {
  model: string;
  input: string[];
  dimensions?: number;
};

export interface RerankResult {
  index: number;
  score: number;
}

export function buildRerankRequestBody(
  entry: Pick<ModelEntry, 'model'>,
  query: string,
  documents: string[],
  topN: number,
): Record<string, unknown> {
  return { model: entry.model, query, documents, top_n: topN };
}

/** 解析 rerank 响应：兼容硅基流动/Jina/Cohere 的 results[].{index, relevance_score}。 */
export function parseRerankResponse(payload: unknown): RerankResult[] {
  const results = (payload as any)?.results;
  if (!Array.isArray(results)) return [];
  return results
    .map((item: any): RerankResult | null => {
      const index = Number(item?.index);
      const score = Number(item?.relevance_score ?? item?.score);
      if (!Number.isInteger(index) || index < 0 || !Number.isFinite(score)) return null;
      return { index, score };
    })
    .filter((item): item is RerankResult => item !== null);
}

export function rerankReady(): boolean {
  return Boolean(getActiveRerank()?.apiKey);
}

/** 调用重排接口精排候选文档。未配置返回 null；调用失败抛 LlmError（由调用方降级）。 */
export async function rerank(
  query: string,
  documents: string[],
  topN: number,
  options: { entry?: ModelEntry; timeoutMs?: number } = {},
): Promise<RerankResult[] | null> {
  const entry = options.entry || getActiveRerank();
  if (!entry?.apiKey) return null;
  const res = await request('/rerank', buildRerankRequestBody(entry, query, documents, topN), {
    baseUrl: entry.baseUrl.replace(/\/+$/, ''),
    apiKey: entry.apiKey,
    timeoutMs: options.timeoutMs ?? 30_000,
    provider: entry.provider,
    model: entry.model,
    operation: 'rerank',
    tag: 'rerank',
  });
  const payload = await readJsonResponse(res);
  const results = parseRerankResponse(payload);
  if (!results.length) throw new LlmError('重排接口返回格式异常（无 results）');
  return results;
}

export function buildEmbeddingRequestBody(
  entry: Pick<ModelEntry, 'model' | 'dim' | 'supportsDimensions'>,
  input: string[]
): EmbeddingRequestBody {
  const body: EmbeddingRequestBody = { model: entry.model, input };
  if (entry.supportsDimensions === true && entry.dim !== undefined) body.dimensions = entry.dim;
  return body;
}

export function validateEmbedding(embedding: unknown, dim?: number): asserts embedding is number[] {
  if (!Array.isArray(embedding)) throw new LlmError('Embedding 返回格式异常（embedding 不是数组）');
  if (dim !== undefined && embedding.length !== dim) {
    throw new LlmError(`Embedding 维度不匹配：配置维度 ${dim}，实际返回 ${embedding.length}`);
  }
}

/** 计算文本的 SHA-256 哈希（用于 embedding 缓存键） */
function embedTextHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** 批量向量化（可走独立的 embedding 服务商配置）。相同文本命中缓存后不调用 API。 */
export async function embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  if (texts.length === 0) return [];
  const cfg = getLlmConfig();
  const entry = getActiveEmbedding();
  if (!cfg.embeddingApiKey && !entry?.authOptional) {
    throw new LlmError('尚未配置向量模型 API Key（设置页 → 向量模型）');
  }
  const modelKey = `${cfg.embeddingBaseUrl}|${cfg.embeddingModel}|${entry?.dim || 0}`;

  // 查缓存：相同文本 + 相同模型 → 直接返回已缓存的嵌入向量
  const textHashes = texts.map(embedTextHash);
  const placeholders = textHashes.map(() => '?').join(',');
  const cacheMap = new Map<string, number[]>();
  const cachedIndices: number[] = [];
  try {
    const cached = db.prepare(
      `SELECT text_hash, embedding FROM embedding_cache WHERE model_key=? AND text_hash IN (${placeholders})`
    ).all(modelKey, ...textHashes) as { text_hash: string; embedding: Buffer }[];
    for (const c of cached) {
      const arr = new Float32Array(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength / 4);
      cacheMap.set(c.text_hash, Array.from(arr));
    }
    for (let i = 0; i < textHashes.length; i++) {
      if (cacheMap.has(textHashes[i])) cachedIndices.push(i);
    }
    if (cachedIndices.length > 0) {
      const ts = new Date().toISOString();
      const update = db.prepare(
        `UPDATE embedding_cache SET last_used_at=? WHERE text_hash=? AND model_key=?`
      );
      db.transaction(() => {
        for (const i of cachedIndices) update.run(ts, textHashes[i], modelKey);
      })();
      // 命中本地向量缓存的请求不再调用 API，但仍按一次「结果缓存命中」记账：
      // 不记账会让用量页把这些请求静默吞掉，同时拉低综合缓存命中率。
      try {
        const estTokens = Math.ceil(cachedIndices.reduce((total, i) => total + texts[i].length / 3, 0));
        recordLlmResultCacheHit({
          provider: entry?.provider || 'custom',
          model: cfg.embeddingModel,
          operation: 'embedding',
          tag: 'embedding',
          scope: 'embedding',
          stage: 'local-embedding-cache',
          dependencyHash: modelKey,
          resultCacheHit: true,
        }, 0, estTokens);
      } catch { /* 记账失败不影响向量化结果 */ }
    }
  } catch { /* embedding_cache 表可能尚未创建 */ }

  // 找出未缓存的文本
  const uncachedIndices: number[] = [];
  const uncachedTexts: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    if (!cacheMap.has(textHashes[i])) {
      uncachedIndices.push(i);
      uncachedTexts.push(texts[i]);
    }
  }

  // 调用 API 获取未缓存的嵌入
  let newEmbeddings: number[][] = [];
  if (uncachedTexts.length > 0) {
    const body = buildEmbeddingRequestBody(
      {
        model: cfg.embeddingModel,
        dim: entry?.dim,
        supportsDimensions: entry?.supportsDimensions,
      },
      uncachedTexts
    );
    const res = await request(
      '/embeddings',
      body,
      {
        baseUrl: cfg.embeddingBaseUrl,
        apiKey: cfg.embeddingApiKey,
        provider: entry?.provider,
        model: cfg.embeddingModel,
        operation: 'embedding',
        tag: 'embedding',
        authOptional: entry?.authOptional,
        signal,
      }
    );
    const json = await readJsonResponse(res);
    const data = json?.data;
    if (!Array.isArray(data)) throw new LlmError('Embedding 返回格式异常');
    newEmbeddings = data
      .sort((a: any, b: any) => a.index - b.index)
      .map((d: any) => {
        validateEmbedding(d?.embedding, entry?.dim);
        return d.embedding;
      });

    // 写入缓存
    try {
      const ts = new Date().toISOString();
      const insert = db.prepare(
        `INSERT OR REPLACE INTO embedding_cache(text_hash, model_key, embedding, created_at, last_used_at) VALUES(?, ?, ?, ?, ?)`
      );
      db.transaction(() => {
        for (let i = 0; i < uncachedTexts.length; i++) {
          const buf = Buffer.from(new Float32Array(newEmbeddings[i]).buffer);
          insert.run(textHashes[uncachedIndices[i]], modelKey, buf, ts, ts);
        }
      })();
    } catch { /* 缓存写入失败不影响结果 */ }
  }

  // 按原始顺序组装结果
  const result: number[][] = new Array(texts.length);
  let uncachedIdx = 0;
  for (let i = 0; i < texts.length; i++) {
    result[i] = cacheMap.get(textHashes[i]) ?? newEmbeddings[uncachedIdx++];
  }
  return result;
}

/** 测试连接：依次尝试激活的 chat 与 embedding（复用 testModel，标准一致）。 */
export async function testConnection(): Promise<{
  chat: boolean;
  embedding: boolean;
  document?: boolean;
  imageInput?: ImageInputStatus;
  error?: string;
}> {
  const result: {
    chat: boolean;
    embedding: boolean;
    document?: boolean;
    imageInput?: ImageInputStatus;
  } = {
    chat: false,
    embedding: false,
  };
  const chatModel = getActiveChat();
  if (!chatModel) return { ...result, error: '未配置对话模型' };
  const chatRes = await testModel(chatModel, 'chat');
  if (!chatRes.ok) return { ...result, error: `chat: ${chatRes.error}` };
  result.chat = true;
  const embModel = getActiveEmbedding();
  if (!embModel) return { ...result, error: '未配置向量模型' };
  const embRes = await testModel(embModel, 'embedding');
  if (!embRes.ok) return { ...result, error: `embedding: ${embRes.error}` };
  result.embedding = true;
  const documentModel = getActiveDocument();
  if (documentModel?.apiKey) {
    const documentResult = await testModel(documentModel, 'document');
    if (!documentResult.ok) return { ...result, document: false, error: `document: ${documentResult.error}` };
    result.document = true;
  } else {
    result.imageInput = resolveImageInputCapability(chatModel).status;
    result.document = result.imageInput === 'supported';
  }
  return result;
}

/** 测试单个模型配置（不依赖激活状态，用于设置页逐个验证）。
 *  kind='chat' 发一条 ping 对话；kind='embedding' 对一个词做向量化。
 *  连接测试只需验证「能连通且返回合法响应结构」，不要求 chat content 非空
 *  （带推理的模型在 token 紧张时可能只产出 reasoning_content 而 content 为空）。 */
export async function testModel(
  entry: ModelEntry,
  kind: 'chat' | 'embedding' | 'document' | 'rerank',
  options: { imageChallenge?: ImageCapabilityChallenge } = {},
): Promise<{ ok: boolean; error?: string }> {
  // 前端带回的 entry.apiKey 可能是掩码（列表回显不再下发明文），测试前按 id 补全库中原值
  const resolved: ModelEntry = { ...entry, apiKey: resolveEntrySecretKey(entry) };
  if (!resolved.apiKey && !resolved.authOptional) return { ok: false, error: '未填写 API Key' };
  const baseUrl = resolved.baseUrl.replace(/\/+$/, '');
  if (!baseUrl) return { ok: false, error: '未填写 Base URL' };
  if (!resolved.model) return { ok: false, error: '未填写模型名' };
  try {
    if (kind === 'chat') {
      // 连接测试使用该条目真实的思考等级，保证测试参数与生产调用一致。
      const body: Record<string, unknown> = {
        model: resolved.model,
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0.3,
        max_tokens: 64,
      };
      applyConfiguredThinking(body, resolved);
      const res = await requestChatWithThinkingFallback(body, `${baseUrl}|${resolved.model}`, {
        baseUrl,
        apiKey: resolved.apiKey,
        timeoutMs: 30_000,
        provider: resolved.provider,
        model: resolved.model,
        tag: 'connection-test-chat',
        protocol: resolved.protocol,
        authOptional: resolved.authOptional,
        entryId: resolved.id,
        dialect: resolved.dialect,
      });
      const json = await readJsonResponse(res);
      // 只校验响应结构合法：有 choices 数组且含 message。content 可为空字符串
      // （推理类模型 token 紧张时可能 content="" 而 reasoning_content 非空）。
      const choice = json?.choices?.[0];
      if (!choice || !choice.message) {
        return { ok: false, error: `返回格式异常（无 choices/message）：${JSON.stringify(json).slice(0, 120)}` };
      }
      return { ok: true };
    } else if (kind === 'embedding') {
      const res = await request(
        '/embeddings',
        buildEmbeddingRequestBody(resolved, ['ping']),
        {
          baseUrl,
          apiKey: resolved.apiKey,
          timeoutMs: 30_000,
          provider: resolved.provider,
          model: resolved.model,
          operation: 'embedding',
          tag: 'connection-test-embedding',
          entryId: resolved.id,
        }
      );
      const json = await readJsonResponse(res);
      if (!Array.isArray(json?.data)) return { ok: false, error: '返回格式异常（无 data 数组）' };
      validateEmbedding(json.data[0]?.embedding, resolved.dim);
      return { ok: true };
    } else if (kind === 'rerank') {
      const results = await rerank('ping', ['知识库检索测试文档'], 1, {
        entry,
        timeoutMs: 30_000,
      });
      if (!results || !results.length) return { ok: false, error: '返回格式异常（无 results）' };
      return { ok: true };
    } else {
      const capability = await probeImageInput(resolved, {
        force: true,
        challenge: options.imageChallenge,
        timeoutMs: 45_000,
      });
      return capability.status === 'supported'
        ? { ok: true }
        : {
            ok: false,
            error: capability.status === 'unsupported'
              ? '当前模型不支持图片输入。'
              : capability.detail || '暂时无法确认模型是否支持图片输入。',
          };
    }
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
