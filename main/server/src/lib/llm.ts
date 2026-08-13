import crypto from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import type { ZodType } from 'zod';
import { getSetting } from './db.js';
import { recordLlmUsage, type LlmOperation, type LlmUsageIdentity } from './llmUsage.js';
import {
  resolveImageInputCapability,
  type ImageInputCapability,
  type ImageInputSource,
  type ImageInputStatus,
} from './modelCapabilities.js';

/** 模型库条目 */
export interface ModelEntry {
  id: string;
  name: string;      // 备注名
  provider: string;  // 预设 id
  baseUrl: string;
  modelsUrl?: string;
  logo?: string;
  model: string;
  apiKey: string;
  dim?: number;      // embedding 维度
  supportsDimensions?: boolean; // 是否支持通过请求参数指定 embedding 维度
  imageInput?: ImageInputStatus;
  imageInputSource?: ImageInputSource;
  imageInputCheckedAt?: string;
}

function parseList(key: string): ModelEntry[] {
  try {
    const parsed = JSON.parse(getSetting(key) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getActiveChat(): ModelEntry | null {
  const list = parseList('chat_models');
  const activeId = getSetting('active_chat_model');
  return list.find((m) => m.id === activeId) || list[0] || null;
}

export function getActiveEmbedding(): ModelEntry | null {
  const list = parseList('embedding_models');
  const activeId = getSetting('active_embedding_model');
  return list.find((m) => m.id === activeId) || list[0] || null;
}

export function getActiveDocument(): ModelEntry | null {
  const list = parseList('document_models');
  const activeId = getSetting('active_document_model');
  return list.find((m) => m.id === activeId) || list[0] || null;
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
  usageContext?: {
    scope: string;
    refId: string;
    stage: string;
    prefixHash: string;
    historyMessages: number;
  };
};

type LlmHttpResponse = {
  response: Response;
  identity: LlmUsageIdentity;
  startedAt: number;
};

function responseIdentity(
  path: string,
  body: unknown,
  opts: LlmRequestOptions | undefined,
): LlmUsageIdentity {
  const active = path === '/embeddings' ? getActiveEmbedding() : getActiveChat();
  const operation = opts?.operation || (path === '/embeddings' ? 'embedding' : 'chat');
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
  const payload = await result.response.json() as T;
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
  if (!apiKey) throw new LlmError('尚未配置 LLM API Key（设置页 → LLM）');
  const startedAt = Date.now();
  const controller = new AbortController();
  const signal = opts?.signal
    ? AbortSignal.any([controller.signal, opts.signal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 120_000);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LlmError(`LLM 请求失败 ${res.status}: ${text.slice(0, 300)}`, res.status);
    }
    return {
      response: res,
      identity: responseIdentity(path, body, opts),
      startedAt,
    };
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new LlmError(opts?.signal?.aborted ? 'AI 请求已取消' : 'LLM 请求超时');
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
  options: { entry?: ModelEntry; maxTokens?: number; timeoutMs?: number } = {},
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
  if (!entry.apiKey) {
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
      buildDocumentRequestBody(entry, challenge.dataUrl, challenge.prompt, 32),
      {
        baseUrl: entry.baseUrl.replace(/\/+$/, ''),
        apiKey: entry.apiKey,
        timeoutMs: options.timeoutMs ?? 45_000,
        provider: entry.provider,
        model: entry.model,
        operation: 'document',
        tag: 'image-capability-probe',
      },
    );
    const payload = await readJsonResponse(response);
    const content = messageText(payload?.choices?.[0]?.message).trim();
    if (normalizedChallengeAnswer(content).includes(challenge.code)) {
      return { status: 'supported', source: 'probe' };
    }
    return {
      status: 'unknown',
      source: 'probe',
      detail: content
        ? `模型已响应，但未能读出测试图片中的数字：${content.slice(0, 80)}`
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

type ChatOptions = {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  json?: boolean;
  signal?: AbortSignal;
  tag?: string;
  usageContext?: LlmRequestOptions['usageContext'];
};

/** 非流式对话 */
export async function chat(
  messages: ChatMessage[],
  opts?: ChatOptions
): Promise<string> {
  const cfg = getLlmConfig();
  const body: Record<string, unknown> = {
    model: cfg.chatModel,
    messages,
    temperature: opts?.temperature ?? 0.3,
  };
  if (opts?.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts?.topP !== undefined) body.top_p = opts.topP;
  // 部分服务商（DeepSeek/通义/Kimi/OpenAI）支持 json_object 模式；不支持的会忽略该字段
  if (opts?.json) body.response_format = { type: 'json_object' };
  // DeepSeek 推理模型默认开启思考，json 模式下 reasoning_content 会吃光 max_tokens
  // 导致 content 为空。结构化输出场景关闭思考，让模型直接产出 content。
  if (opts?.json && /deepseek/i.test(cfg.baseUrl)) {
    body.thinking = { type: 'disabled' };
    // 关闭思考后 temperature/top_p 才有效（思考模式下这些参数被忽略）
  }
  const res = await request('/chat/completions', body, {
    signal: opts?.signal,
    tag: opts?.tag || 'chat',
    usageContext: opts?.usageContext,
  });
  const json = await readJsonResponse(res);
  const choice = json?.choices?.[0];
  const msg = choice?.message;
  const finishReason = choice?.finish_reason;
  // json 模式下只接受 content（结构化输出）；reasoning_content 是推理过程，不是 JSON，
  // 回退用它会导致上层 JSON 解析失败。非 json 模式可回退 reasoning_content（普通对话）。
  let content = '';
  if (typeof msg?.content === 'string' && msg.content) {
    content = msg.content;
  } else if (!opts?.json && typeof msg?.reasoning_content === 'string' && msg.reasoning_content) {
    content = msg.reasoning_content;
  }
  if (!content) {
    const truncated = finishReason === 'length';
    console.warn('[llm.chat] 返回内容为空', { model: cfg.chatModel, finishReason, raw: JSON.stringify(json).slice(0, 300) });
    throw new LlmError(truncated ? '输出被截断（max_tokens 不足）' : 'LLM 返回格式异常');
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
  const res = await request('/chat/completions', body, {
    signal: opts?.signal,
    tag: opts?.tag || 'chat-tools',
    usageContext: opts?.usageContext,
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
  opts?: Omit<ChatOptions, 'json'> & { retries?: number; tag?: string }
): Promise<T> {
  const tag = opts?.tag || 'chatJson';
  const retries = opts?.retries ?? 1;
  let lastErr = '';
  let curMaxTokens = opts?.maxTokens;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let raw: string;
    try {
      raw = await chat(messages, { ...opts, json: true, maxTokens: curMaxTokens });
    } catch (e: any) {
      lastErr = `请求失败: ${e.message}`;
      console.warn(`[llm.chatJson:${tag}] 请求失败`, e.message);
      if (attempt < retries) {
        // 截断错误：翻倍 max_tokens 重试，不追加多余消息（问题在长度而非内容）
        if (e.message.includes('截断')) {
          curMaxTokens = (curMaxTokens || 4000) * 2;
          continue;
        }
        messages = [...messages, { role: 'user' as const, content: '上一轮请求失败，请重新输出合法 JSON。' }];
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
        // 截断：翻倍 max_tokens 重试，不追加消息
        curMaxTokens = (curMaxTokens || 4000) * 2;
        continue;
      }
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
  opts?: Omit<ChatOptions, 'json'> & { retries?: number; tag?: string }
): Promise<T> {
  const tag = opts?.tag || 'chatJsonSchema';
  const attempts = opts?.retries ?? 1;
  let current = messages;
  let lastError = 'schema validation failed';
  for (let attempt = 0; attempt <= attempts; attempt++) {
    // 保留 retries 给 chatJson 处理截断重试（翻倍 max_tokens）；
    // schema 校验失败的重试由本函数外层循环负责
    const value = await chatJson<unknown>(current, { ...opts, retries: opts?.retries ?? 1, tag });
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    lastError = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    current = [...current, { role: 'user', content: `输出未通过结构校验：${lastError}。请按原格式完整重输 JSON。` }];
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

/** 流式对话：逐段回调 */
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
  const capabilityKey = `${cfg.baseUrl}|${cfg.chatModel}`;
  if (!streamUsageUnsupported.has(capabilityKey)) {
    body.stream_options = { include_usage: true };
  }
  let res: LlmHttpResponse;
  try {
    res = await request('/chat/completions', body, {
      signal: opts?.signal,
      tag: opts?.tag || 'chat-stream',
      usageContext: opts?.usageContext,
    });
  } catch (error) {
    const unsupported =
      error instanceof LlmError &&
      [400, 422].includes(error.status || 0);
    if (!unsupported || !body.stream_options) throw error;
    delete body.stream_options;
    res = await request('/chat/completions', body, {
      signal: opts?.signal,
      tag: opts?.tag || 'chat-stream',
      usageContext: opts?.usageContext,
    });
    streamUsageUnsupported.add(capabilityKey);
  }
  if (!res.response.body) throw new LlmError('LLM 无流式响应体');
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
      const data = t.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) onDelta(delta);
        if (!usageCaptured && json?.usage) {
          captureUsage(res, json.usage);
          usageCaptured = true;
        }
      } catch {
        /* 忽略不完整行 */
      }
    }
  }
}

type EmbeddingRequestBody = {
  model: string;
  input: string[];
  dimensions?: number;
};

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

/** 批量向量化（可走独立的 embedding 服务商配置） */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const cfg = getLlmConfig();
  const entry = getActiveEmbedding();
  if (!cfg.embeddingApiKey) throw new LlmError('尚未配置向量模型 API Key（设置页 → 向量模型）');
  const body = buildEmbeddingRequestBody(
    {
      model: cfg.embeddingModel,
      dim: entry?.dim,
      supportsDimensions: entry?.supportsDimensions,
    },
    texts
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
    }
  );
  const json = await readJsonResponse(res);
  const data = json?.data;
  if (!Array.isArray(data)) throw new LlmError('Embedding 返回格式异常');
  return data
    .sort((a: any, b: any) => a.index - b.index)
    .map((d: any) => {
      validateEmbedding(d?.embedding, entry?.dim);
      return d.embedding;
    });
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
  kind: 'chat' | 'embedding' | 'document',
  options: { imageChallenge?: ImageCapabilityChallenge } = {},
): Promise<{ ok: boolean; error?: string }> {
  if (!entry.apiKey) return { ok: false, error: '未填写 API Key' };
  const baseUrl = entry.baseUrl.replace(/\/+$/, '');
  if (!baseUrl) return { ok: false, error: '未填写 Base URL' };
  if (!entry.model) return { ok: false, error: '未填写模型名' };
  try {
    if (kind === 'chat') {
      const res = await request(
        '/chat/completions',
        {
          model: entry.model,
          messages: [{ role: 'user', content: 'ping' }],
          temperature: 0.3,
          max_tokens: 64,
        },
        {
          baseUrl,
          apiKey: entry.apiKey,
          timeoutMs: 30_000,
          provider: entry.provider,
          model: entry.model,
          tag: 'connection-test-chat',
        }
      );
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
        buildEmbeddingRequestBody(entry, ['ping']),
        {
          baseUrl,
          apiKey: entry.apiKey,
          timeoutMs: 30_000,
          provider: entry.provider,
          model: entry.model,
          operation: 'embedding',
          tag: 'connection-test-embedding',
        }
      );
      const json = await readJsonResponse(res);
      if (!Array.isArray(json?.data)) return { ok: false, error: '返回格式异常（无 data 数组）' };
      validateEmbedding(json.data[0]?.embedding, entry.dim);
      return { ok: true };
    } else {
      const capability = await probeImageInput(entry, {
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
