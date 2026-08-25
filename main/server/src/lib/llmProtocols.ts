/** LLM 协议适配层：核心调用层（llm.ts）保持 OpenAI 形状的请求/响应模型，
 *  anthropic 协议在 HTTP 边界完成双向转换——
 *  请求：OpenAI 风格 body → Anthropic Messages body（messages/system/tools/max_tokens）
 *  响应：Anthropic payload → OpenAI 风格 payload（choices/usage），
 *  使 chat/chatWithTools/chatStream 的抽取、截断判定、用量记账逻辑零改动复用。
 *  embedding 保持 OpenAI 兼容协议，不经过本层。 */

export type ProtocolKind = 'openai' | 'anthropic';

// ---------- OpenAI 形状（与 llm.ts 的请求构造一致） ----------

interface OpenAiStyleBody {
  model: string;
  messages: unknown[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: unknown;
  thinking?: unknown;
  stream_options?: unknown;
  [key: string]: unknown;
}

export interface StreamParsedLine {
  text?: string;
  /** 思考增量（OpenAI: delta.reasoning_content；Anthropic: thinking_delta） */
  reasoning?: string;
  /** 结束原因（length/stop/tool_calls），随最后几个 chunk 到达 */
  finishReason?: string;
  usage?: unknown;
  done?: boolean;
}

export interface ProtocolAdapter {
  kind: ProtocolKind;
  /** 请求 URL：openai 为 baseUrl+path；anthropic 按 baseUrl 自动拼 /v1|/messages */
  url(baseUrl: string, path: string): string;
  headers(apiKey: string): Record<string, string>;
  /** OpenAI 形状 body → 协议原生 body */
  buildBody(body: OpenAiStyleBody): Record<string, unknown>;
  /** 协议原生响应 → OpenAI 风格 payload（非流式） */
  parseResponse(payload: unknown): unknown;
  /** 流式 data: 行解析器（有状态，每次请求新建） */
  createStreamParser(): { feed(data: string): StreamParsedLine };
}

// ---------- Anthropic Messages 协议 ----------

const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;

function joinText(parts: string[]): string {
  return parts.filter(Boolean).join('\n');
}

function imagePartToAnthropic(url: string): Record<string, unknown> | null {
  const dataMatch = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (dataMatch) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: dataMatch[1], data: dataMatch[2] },
    };
  }
  if (/^https?:\/\//i.test(url)) {
    return { type: 'image', source: { type: 'url', url } };
  }
  return null;
}

/** OpenAI content（字符串或 parts 数组）→ Anthropic content blocks */
function convertUserContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return typeof content === 'number' ? String(content) : '';
  const blocks: Record<string, unknown>[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) blocks.push({ type: 'text', text: part });
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const item = part as Record<string, any>;
    if (item.type === 'text' && typeof item.text === 'string') {
      if (item.text) blocks.push({ type: 'text', text: item.text });
    } else if (item.type === 'image_url' && typeof item.image_url?.url === 'string') {
      const block = imagePartToAnthropic(item.image_url.url);
      if (block) blocks.push(block);
    }
  }
  return blocks;
}

/** OpenAI messages → Anthropic {system, messages}。
 *  - system 消息上提为顶层 system 字符串
 *  - assistant.tool_calls → tool_use blocks（arguments JSON 反解析为 input 对象）
 *  - tool 角色 → user 角色的 tool_result block（Anthropic 标准工具回传形态） */
export function convertMessagesForAnthropic(
  messages: unknown[],
): { system?: string; messages: Record<string, unknown>[] } {
  const systemParts: string[] = [];
  const out: Record<string, unknown>[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const message = raw as Record<string, any>;
    if (message.role === 'system') {
      const text = typeof message.content === 'string'
        ? message.content
        : joinText((Array.isArray(message.content) ? message.content : [])
            .map((part: any) => typeof part === 'string' ? part : String(part?.text || '')));
      if (text) systemParts.push(text);
      continue;
    }
    if (message.role === 'tool') {
      out.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: String(message.tool_call_id || ''),
          content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
        }],
      });
      continue;
    }
    if (message.role === 'assistant') {
      const blocks: Record<string, unknown>[] = [];
      const text = typeof message.content === 'string' ? message.content : '';
      if (text) blocks.push({ type: 'text', text });
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (!call || typeof call !== 'object') continue;
          const fn = (call as any).function || {};
          let input: unknown = {};
          try { input = JSON.parse(fn.arguments || '{}'); } catch { input = {}; }
          blocks.push({ type: 'tool_use', id: String(call.id || ''), name: String(fn.name || ''), input });
        }
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
      continue;
    }
    // user（含文档识别的 image_url/text parts）
    out.push({ role: 'user', content: convertUserContent(message.content) });
  }
  return {
    ...(systemParts.length ? { system: joinText(systemParts) } : {}),
    messages: out,
  };
}

/** Anthropic 响应 → OpenAI 风格 payload，供既有 chat/chatWithTools 抽取逻辑复用。
 *  - text blocks 拼为 content；thinking blocks 归入 reasoning_content（截断判定依赖）
 *  - tool_use blocks → tool_calls（input 对象序列化为 arguments 字符串）
 *  - stop_reason 映射 finish_reason：max_tokens→length（截断重试依赖）、tool_use→tool_calls
 *  - usage 同时输出 Anthropic 原生字段（input_tokens/cache_read_input_tokens 等，
 *    llmUsage.normalizeLlmUsage 已识别）与 OpenAI 别名 */
export function parseAnthropicResponse(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const body = payload as Record<string, any>;
  const blocks: any[] = Array.isArray(body.content) ? body.content : [];
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      thinkingParts.push(block.thinking);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: String(block.id || ''),
        type: 'function',
        function: {
          name: String(block.name || ''),
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }
  const content = textParts.join('\n');
  const reasoning = thinkingParts.join('\n');
  const finishReason =
    body.stop_reason === 'max_tokens' ? 'length'
    : body.stop_reason === 'tool_use' ? 'tool_calls'
    : 'stop';
  const usage = body.usage && typeof body.usage === 'object' ? body.usage : {};
  const inputTokens = Number(usage.input_tokens || 0);
  const outputTokens = Number(usage.output_tokens || 0);
  return {
    id: body.id,
    model: body.model,
    choices: [{
      message: {
        role: 'assistant',
        ...(content ? { content } : { content: content || null }),
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason,
    }],
    usage: {
      ...usage,
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

/** Anthropic SSE 事件解析：text_delta 出文本、thinking_delta 出思考、
 *  message_start/message_delta 出用量与 stop_reason、message_stop 收尾 */
function createAnthropicStreamParser() {
  let inputTokens = 0;
  let finishReason = '';
  return {
    feed(data: string): StreamParsedLine {
      let event: any;
      try { event = JSON.parse(data); } catch { return {}; }
      if (!event || typeof event !== 'object') return {};
      if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
          return { text: delta.text };
        }
        if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
          return { reasoning: delta.thinking };
        }
        return {};
      }
      if (event.type === 'message_start') {
        inputTokens = Number(event.message?.usage?.input_tokens || 0);
        return {};
      }
      if (event.type === 'message_delta') {
        const usage = event.usage && typeof event.usage === 'object' ? event.usage : {};
        const outputTokens = Number(usage.output_tokens || 0);
        if (typeof event.delta?.stop_reason === 'string') {
          finishReason =
            event.delta.stop_reason === 'max_tokens' ? 'length'
            : event.delta.stop_reason === 'tool_use' ? 'tool_calls'
            : 'stop';
        }
        return {
          finishReason: finishReason || undefined,
          usage: {
            ...usage,
            input_tokens: inputTokens,
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          },
        };
      }
      if (event.type === 'message_stop') return { done: true, finishReason: finishReason || undefined };
      return {};
    },
  };
}

/** Anthropic 请求 URL：baseUrl 以 /v1 结尾时视为已带版本段（拼 /messages），
 *  否则补 /v1/messages。目录内置 anthropic 线路均不带 /v1。 */
export function anthropicUrl(baseUrl: string, _path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
}

function buildAnthropicBody(body: OpenAiStyleBody): Record<string, unknown> {
  const { system, messages } = convertMessagesForAnthropic(body.messages || []);
  const out: Record<string, unknown> = {
    model: body.model,
    max_tokens: body.max_tokens || ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages,
  };
  if (system) out.system = system;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (body.stream === true) out.stream = true;
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools
      .map((tool) => {
        const fn = (tool as any)?.function;
        if (!fn?.name) return null;
        return { name: fn.name, description: fn.description || '', input_schema: fn.parameters || { type: 'object' } };
      })
      .filter(Boolean);
    if (body.tool_choice === 'auto') out.tool_choice = { type: 'auto' };
  }
  // OpenAI 专属参数在 Anthropic 协议下直接丢弃：
  // thinking（Anthropic 思考默认关闭，禁用语义天然成立）、response_format、stream_options
  return out;
}

export const anthropicAdapter: ProtocolAdapter = {
  kind: 'anthropic',
  url: anthropicUrl,
  headers(apiKey) {
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
  },
  buildBody: buildAnthropicBody,
  parseResponse: parseAnthropicResponse,
  createStreamParser: createAnthropicStreamParser,
};

// ---------- OpenAI 兼容协议（原行为直通） ----------

function openAiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function createOpenAiStreamParser() {
  let usageCaptured = false;
  return {
    feed(data: string): StreamParsedLine {
      if (data === '[DONE]') return { done: true };
      let json: any;
      try { json = JSON.parse(data); } catch { return {}; }
      const choice = json?.choices?.[0];
      const delta = choice?.delta?.content;
      // GLM 等思考模型把推理过程放 delta.reasoning_content，与 content 并行到达
      const reasoning = choice?.delta?.reasoning_content;
      const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined;
      const usage = !usageCaptured && json?.usage ? json.usage : undefined;
      if (usage) usageCaptured = true;
      return {
        ...(typeof delta === 'string' && delta ? { text: delta } : {}),
        ...(typeof reasoning === 'string' && reasoning ? { reasoning } : {}),
        ...(finishReason ? { finishReason } : {}),
        ...(usage ? { usage } : {}),
      };
    },
  };
}

export const openAiAdapter: ProtocolAdapter = {
  kind: 'openai',
  url: openAiUrl,
  headers(apiKey) {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
  },
  buildBody(body) {
    // 直通（body 已是 OpenAI 形状），仅剥离 undefined 字段
    return body as Record<string, unknown>;
  },
  parseResponse(payload) {
    return payload;
  },
  createStreamParser: createOpenAiStreamParser,
};

export function protocolAdapter(kind: ProtocolKind | undefined): ProtocolAdapter {
  return kind === 'anthropic' ? anthropicAdapter : openAiAdapter;
}
