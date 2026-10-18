import { getAgentConfig, type AgentConfig } from '../assistant/config.js';
import { customRoute } from '../assistant/agentSettings.js';

/**
 * 服务端直接调模型的最小客户端。
 *
 * 内置 Agent 走的是 dsh 子进程（MCP 工具那套），但「点一下就把这份文件转成 Markdown」
 * 这类确定性作业不该占用一次对话，也不该要求用户先把 Agent 打开——所以服务端自己发请求。
 * 路由复用内置 Agent 已配置的同一条（官方地址或自定义地址），没配凭据就明确失败，
 * 绝不静默降级成「只做格式转换」。
 *
 * 与 `assistant/title.ts` 的取名请求共用同一套线协议口径（openai-completions /
 * openai-responses / anthropic-messages），差异只在消息形状与 token 上限。
 */

/** 官方路由地址与默认模型（与 assistant/title.ts 保持一致） */
const OFFICIAL_BASE_URL = 'https://api.deepseek.com';
const OFFICIAL_MODEL = 'deepseek-v4-flash';

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface ModelRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  pick: (json: any) => string;
  /** 响应是否被**输出上限**截断（不同线协议字段不同，见下方各 pick 实现） */
  truncated: (json: any) => boolean;
  /** 错误信息用的响应诊断（finish_reason / 用量等），没有可说的返回空串 */
  describe: (json: any) => string;
  model: string;
}

/** 没配置凭据时抛这个，调用方据此给用户可操作的提示 */
export class ModelUnavailableError extends Error {}

/**
 * 模型输出被输出上限截断。
 *
 * 推理型模型（deepseek-flash 等）会把 max_tokens 预算先花在 reasoning 上：
 * 预算不够时 finish_reason=length、content 为空——调用方若只看到「模型没返回内容」
 * 就会误判成上游故障。这个错误带用量诊断，批量作业可以据此缩小输入重试。
 */
export class ModelOutputTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelOutputTruncatedError';
  }
}

/** 正文为空且不是截断造成：上游确实没给内容 */
export class ModelEmptyResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelEmptyResponseError';
  }
}

/** 拼 URL：baseUrl 末尾斜杠不重复 */
function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, '')}${suffix}`;
}

/** anthropic 协议的 messages 端点：baseUrl 已带 /v1 时不重复 */
function anthropicMessagesUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return /\/v\d+$/.test(trimmed) ? `${trimmed}/messages` : `${trimmed}/v1/messages`;
}

/** 把 usage 里的关键数字压成一行，便于在任务错误里看出「预算被 reasoning 吃光」 */
function usageSummary(json: any): string {
  const usage = json?.usage;
  if (!usage || typeof usage !== 'object') return '';
  const details = usage.completion_tokens_details || usage.output_tokens_details;
  const reasoning = details?.reasoning_tokens ?? details?.reasoningTokens;
  const completion = usage.completion_tokens ?? usage.output_tokens;
  const prompt = usage.prompt_tokens ?? usage.input_tokens;
  return [
    Number.isFinite(completion) ? `输出 ${completion} tokens` : '',
    Number.isFinite(reasoning) ? `其中推理 ${reasoning}` : '',
    Number.isFinite(prompt) ? `输入 ${prompt}` : '',
  ].filter(Boolean).join('，');
}

function describeChat(json: any): string {
  const finish = json?.choices?.[0]?.finish_reason;
  return [finish ? `finish_reason=${finish}` : '', usageSummary(json)].filter(Boolean).join('；');
}

function describeResponses(json: any): string {
  const status = json?.status;
  const reason = json?.incomplete_details?.reason;
  return [status ? `status=${status}` : '', reason ? `incomplete=${reason}` : '', usageSummary(json)]
    .filter(Boolean).join('；');
}

function describeAnthropic(json: any): string {
  const stop = json?.stop_reason;
  return [stop ? `stop_reason=${stop}` : '', usageSummary(json)].filter(Boolean).join('；');
}

/** 诊断后缀：有内容才加括号，没有就空串（错误文案保持干净） */
function withDiagnostics(base: string, details: string): string {
  return details ? `${base}（${details}）` : base;
}

function pickChatCompletions(json: any): string {
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block: any) => (typeof block?.text === 'string' ? block.text : '')).join('');
  }
  return '';
}

function pickResponses(json: any): string {
  if (typeof json?.output_text === 'string') return json.output_text;
  const output = Array.isArray(json?.output) ? json.output : [];
  const parts: string[] = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) if (typeof block?.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

function pickAnthropic(json: any): string {
  const content = Array.isArray(json?.content) ? json.content : [];
  return content.map((block: any) => (typeof block?.text === 'string' ? block.text : '')).join('');
}

/**
 * 按当前内置 Agent 配置拼出一次补全请求（纯函数，便于单测钉住三种线协议）。
 * 没配 API Key 抛 `ModelUnavailableError`。
 */
export function modelRequest(
  config: AgentConfig,
  messages: ChatMessage[],
  options: { maxTokens?: number; temperature?: number } = {}
): ModelRequest {
  const apiKey = (config.apiKey || '').trim();
  if (!apiKey) {
    throw new ModelUnavailableError('未配置模型凭据：请到 设置 → Agent 接入 → 内置 Agent 填写 API Key');
  }
  const maxTokens = options.maxTokens ?? 8192;
  const temperature = options.temperature ?? 0.3;
  const route = customRoute(config);
  const system = messages.filter((message) => message.role === 'system').map((m) => m.content).join('\n\n');
  const user = messages.filter((message) => message.role === 'user').map((m) => m.content).join('\n\n');

  if (!route) {
    return {
      url: joinUrl((process.env.DEEPSEEK_BASE_URL || '').trim() || OFFICIAL_BASE_URL, '/chat/completions'),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: {
        model: (config.model || '').trim() || OFFICIAL_MODEL,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        temperature,
        stream: false,
      },
      pick: pickChatCompletions,
      truncated: (json) => json?.choices?.[0]?.finish_reason === 'length',
      describe: describeChat,
      model: (config.model || '').trim() || OFFICIAL_MODEL,
    };
  }

  if (route.api === 'anthropic-messages') {
    return {
      url: anthropicMessagesUrl(route.baseUrl),
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: route.model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        temperature,
        messages: [{ role: 'user', content: user }],
      },
      pick: pickAnthropic,
      truncated: (json) => json?.stop_reason === 'max_tokens',
      describe: describeAnthropic,
      model: route.model,
    };
  }

  if (route.api === 'openai-responses') {
    return {
      url: joinUrl(route.baseUrl, '/responses'),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: {
        model: route.model,
        ...(system ? { instructions: system } : {}),
        input: user,
        max_output_tokens: maxTokens,
      },
      pick: pickResponses,
      // Responses API 截断时 status=incomplete（incomplete_details.reason=max_output_tokens），
      // 推理模型可能只留下 reasoning 条目、没有任何 message，正文因此为空
      truncated: (json) => json?.status === 'incomplete',
      describe: describeResponses,
      model: route.model,
    };
  }

  return {
    url: joinUrl(route.baseUrl, '/chat/completions'),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: {
      model: route.model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature,
      stream: false,
    },
    pick: pickChatCompletions,
    truncated: (json) => json?.choices?.[0]?.finish_reason === 'length',
    describe: describeChat,
    model: route.model,
  };
}

export interface CompleteOptions {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  config?: AgentConfig;
  fetchImpl?: typeof fetch;
}

export interface CompleteResult {
  text: string;
  model: string;
}

/**
 * 调一次模型并取回文本。失败抛带可读原因的 Error（调用方把它写进任务错误里给用户看）。
 *
 * 两类失败刻意分开：`ModelOutputTruncatedError`（预算被推理/输出吃满，批量作业可缩小输入重试）
 * 与 `ModelEmptyResponseError`（上游确实没给内容）。两者都带 finish_reason/用量诊断。
 */
export async function completeText(messages: ChatMessage[], options: CompleteOptions = {}): Promise<CompleteResult> {
  const config = options.config ?? getAgentConfig();
  const fetchImpl = options.fetchImpl ?? fetch;
  const send = async (maxTokens: number | undefined) => {
    const request = modelRequest(config, messages, {
      maxTokens,
      temperature: options.temperature,
    });
    const response = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 300_000),
    });
    const raw = await response.text();
    return { request, response, raw };
  };

  let sent = await send(options.maxTokens);
  // 自定义网关对 max_tokens 上限的口径可能比官方小：被明确拒绝时退到保守预算再试一次，
  // 而不是让一次「参数不合法」直接判转换失败。
  if (!sent.response.ok && (options.maxTokens ?? 0) > 8192 && tokenLimitRejected(sent.raw)) {
    sent = await send(8192);
  }
  const { request, response, raw } = sent;
  if (!response.ok) {
    throw new Error(`模型请求失败（${response.status}）：${raw.slice(0, 300)}`);
  }
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`模型响应不是 JSON：${raw.slice(0, 200)}`);
  }
  const text = request.pick(json).trim();
  const details = request.describe(json);
  if (request.truncated(json)) {
    throw new ModelOutputTruncatedError(withDiagnostics(
      text ? '模型输出达到上限，正文被截断' : '模型输出达到上限，正文为空（token 预算被推理等占满）',
      details
    ));
  }
  if (!text) throw new ModelEmptyResponseError(withDiagnostics('模型没有返回内容', details));
  return { text, model: request.model };
}

/** 上游是否在报「max_tokens 超限」；只认明确提到 token 上限的报文，避免把普通 400 也重试一遍 */
function tokenLimitRejected(raw: string): boolean {
  return /max[_ ]?(completion_)?tokens|max_output_tokens|maximum.*tokens|token.*(limit|上限)/i.test(raw);
}
