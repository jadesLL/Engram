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
  model: string;
}

/** 没配置凭据时抛这个，调用方据此给用户可操作的提示 */
export class ModelUnavailableError extends Error {}

/** 拼 URL：baseUrl 末尾斜杠不重复 */
function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, '')}${suffix}`;
}

/** anthropic 协议的 messages 端点：baseUrl 已带 /v1 时不重复 */
function anthropicMessagesUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return /\/v\d+$/.test(trimmed) ? `${trimmed}/messages` : `${trimmed}/v1/messages`;
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
 */
export async function completeText(messages: ChatMessage[], options: CompleteOptions = {}): Promise<CompleteResult> {
  const request = modelRequest(options.config ?? getAgentConfig(), messages, {
    maxTokens: options.maxTokens,
    temperature: options.temperature,
  });
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 300_000),
  });
  const raw = await response.text();
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
  if (!text) throw new Error('模型没有返回内容');
  return { text, model: request.model };
}
