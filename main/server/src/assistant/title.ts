import { getAgentConfig, type AgentConfig } from './config.js';
import { customRoute } from './agentSettings.js';

/**
 * 内置 Agent 的会话自动命名。
 *
 * 两级策略：
 *   1. 用户发出第一条消息时立刻用消息本身取一个标题（规则截断，零延迟零成本）；
 *   2. 首轮跑完后用模型按「整段对话的主要内容」总结一次，覆盖掉第 1 步的临时标题。
 *
 * 命名只写 title_source 为 default/auto 的会话：用户手动改过名（user）就不再自动覆盖。
 * 模型调用走内置 Agent 已配置的同一条路由（官方地址或自定义地址），失败一律静默保留
 * 临时标题——命名失败不该影响对话本身。
 */

/** 官方路由地址：与 dsh-llm-deepseek 的默认值一致（可用环境变量覆盖） */
export const OFFICIAL_BASE_URL = 'https://api.deepseek.com';
/** 官方路由的默认模型：与 dsh 的 deepseek-official 默认值一致 */
export const OFFICIAL_MODEL = 'deepseek-v4-flash';
/** 标题长度上限（字符数，中文按字算） */
export const TITLE_MAX_CHARS = 24;
/**
 * 命名请求的 token 预算。**不能压到几十**：推理型模型（官方路由的 deepseek-flash 实测如此）
 * 会先花 reasoning token，只给 64 时 finish_reason=length、content 为空，标题只能退化成
 * 规则标题（2026-09 预览验收实测）。命名本身很短，给足余量即可。
 */
export const TITLE_MAX_TOKENS = 512;
/** 送进提示词的对话正文上限 */
const PROMPT_INPUT_CHARS = 1200;

export interface TitleMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** 压成一行：换行/连续空白折成单个空格 */
function flatten(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * 规则标题：拿首条用户消息压成一行，去掉列表符号与寒暄式前后缀，超长截断。
 * 目的是「立刻有个像样的名字」，质量交给随后的模型总结。
 */
export function heuristicTitle(message: string, limit = TITLE_MAX_CHARS): string {
  let text = flatten(message)
    .replace(/^[#>\-*\d.、)）\s]+/, '')
    .replace(/^(你好|您好|hi|hello|hey)[，,。!！~\s]*/i, '')
    .trim();
  if (!text) text = flatten(message);
  // 有句读时优先断在第一个句子，避免标题里塞进整段问题
  const stop = text.search(/[。！？!?；;\n]/);
  if (stop > 0 && stop <= limit) text = text.slice(0, stop);
  if (text.length > limit) text = `${text.slice(0, limit)}…`;
  return text || '新对话';
}

/** 去首尾装饰：Markdown 强调符、引号、书名号、括号、句末标点（跑两轮，`**标题**。` 这类嵌套也吃得掉） */
function stripDecorations(value: string): string {
  return value
    .replace(/^[#>*_\-\s"'“”‘’`《【[(]+/, '')
    .replace(/[#*_\s"'“”‘’`》】\])]+$/, '')
    .replace(/[。.!！?？,，;；:：]+$/, '');
}

/** 模型输出归一化：只取第一行、去引号/前缀/句末标点，超长截断 */
export function normalizeTitle(raw: string, limit = TITLE_MAX_CHARS): string {
  const first = (raw || '').split(/\r?\n/).map(flatten).find((line) => line) || '';
  const withoutPrefix = first.replace(/^(标题|题目|title)\s*[:：]\s*/i, '');
  let text = stripDecorations(stripDecorations(withoutPrefix));
  if (text.length > limit) text = `${text.slice(0, limit)}…`;
  return text;
}

/** 命名提示词：只给对话要点，要求一句话、无装饰 */
export function buildTitlePrompt(history: TitleMessage[]): string {
  const lines: string[] = [];
  let budget = PROMPT_INPUT_CHARS;
  for (const item of history) {
    const content = flatten(item.content);
    if (!content) continue;
    const slice = content.slice(0, Math.max(0, Math.min(budget, 600)));
    if (!slice) break;
    budget -= slice.length;
    lines.push(`${item.role === 'user' ? '用户' : '助手'}：${slice}`);
    if (budget <= 0) break;
  }
  return [
    `给下面这段对话起一个标题：不超过 ${TITLE_MAX_CHARS} 个字，说清主要话题，不要标点结尾，不要引号，不要解释，直接输出标题。`,
    '',
    ...lines,
  ].join('\n');
}

/** 拼 URL：baseUrl 末尾斜杠不重复 */
function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/** anthropic 协议的 messages 端点：baseUrl 已带 /v1 时不重复 */
function anthropicMessagesUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return /\/v\d+$/.test(trimmed) ? `${trimmed}/messages` : `${trimmed}/v1/messages`;
}

export interface TitleRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** 从响应 JSON 里取标题文本（形状随线协议不同） */
  pick: (json: any) => string;
}

const pickChatCompletions = (json: any): string => {
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('');
  return '';
};

const pickResponses = (json: any): string => {
  if (typeof json?.output_text === 'string') return json.output_text;
  const output = Array.isArray(json?.output) ? json.output : [];
  const parts: string[] = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) if (typeof block?.text === 'string') parts.push(block.text);
  }
  return parts.join('');
};

const pickAnthropic = (json: any): string => {
  const content = Array.isArray(json?.content) ? json.content : [];
  return content.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('');
};

/**
 * 按当前 Agent 配置拼出命名请求；没配凭据返回 null。
 * 纯函数（不读配置、不发请求），便于单测钉住三种线协议的 URL 与请求体。
 */
export function titleRequest(config: AgentConfig, prompt: string): TitleRequest | null {
  const apiKey = (config.apiKey || '').trim();
  if (!apiKey) return null;
  const route = customRoute(config);
  if (!route) {
    const base = (process.env.DEEPSEEK_BASE_URL || '').trim() || OFFICIAL_BASE_URL;
    return {
      url: joinUrl(base, '/chat/completions'),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: {
        model: (config.model || '').trim() || OFFICIAL_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: TITLE_MAX_TOKENS,
        temperature: 0.2,
        stream: false,
      },
      pick: pickChatCompletions,
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
        max_tokens: TITLE_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      },
      pick: pickAnthropic,
    };
  }
  if (route.api === 'openai-responses') {
    return {
      url: joinUrl(route.baseUrl, '/responses'),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: { model: route.model, input: prompt, max_output_tokens: TITLE_MAX_TOKENS },
      pick: pickResponses,
    };
  }
  return {
    url: joinUrl(route.baseUrl, '/chat/completions'),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: {
      model: route.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: TITLE_MAX_TOKENS,
      temperature: 0.2,
      stream: false,
    },
    pick: pickChatCompletions,
  };
}

export interface TitleDeps {
  config?: AgentConfig;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * 用模型给会话起名：拿不到凭据、请求失败、响应不可解析都返回 null（调用方保留临时标题）。
 * 不抛错——命名是锦上添花，不该让一轮对话以失败收场。
 */
export async function generateSessionTitle(
  history: TitleMessage[],
  deps: TitleDeps = {}
): Promise<string | null> {
  const usable = history.filter((item) => flatten(item.content));
  if (!usable.length) return null;
  const request = titleRequest(deps.config ?? getAgentConfig(), buildTitlePrompt(usable));
  if (!request) return null;
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15000),
    });
    if (!response.ok) return null;
    const json: any = await response.json();
    const title = normalizeTitle(request.pick(json));
    return title || null;
  } catch {
    return null;
  }
}
