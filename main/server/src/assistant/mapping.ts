/**
 * dsh 会话事件 → 归一化动作的纯映射层（无 IO、无依赖，便于单测）。
 *
 * 字段形状取自 dsh 自身的 SessionEventMap / session.event 通知载荷（与真实会话日志逐字核对过）：
 *   assistant/message { message: { content: [{type:'text'|'reasoning', text}] }, interrupted? }
 *   tool/call         { callId, name, arguments(未解析的 JSON 字符串) }
 *   tool/result       { message: { source: {kind:'tool', callId},
 *                                   content: [{type:'tool-result', toolCallId, isError?,
 *                                              content: [{type:'text', text}]}] }, error? }
 *   step/start | turn/end ...
 * 事件表由 dsh 插件可扩展，未知类型一律忽略（不猜测语义）。
 */

/** 归一化后的运行事件：runner 据此写库并推 SSE */
export type AgentEvent =
  | { kind: 'status'; text: string }
  | { kind: 'text'; text: string; interrupted?: boolean }
  | { kind: 'tool-call'; callId: string; name: string; args: string }
  | { kind: 'tool-result'; callId: string; ok: boolean; text: string }
  | { kind: 'turn-end'; reason: string };

/** 从 ContentBlock[] / string 里拼出文本（容错：未知块型忽略） */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('');
}

/**
 * 工具结果正文。
 *
 * dsh 把结果文本包在 `tool-result` 块里，文本在**第二层**：
 *   message.content = [{ type: 'tool-result', toolCallId, content: [{type:'text', text}], isError }]
 * 早期实现直接在 message.content 上找 text 块，于是每次调用都只落库 `{"ok":true,"text":""}`——
 * 界面里执行记录卡片展开后是空的。这里按真实形状取第二层，同时兼容文本直接铺在
 * message.content 上的形状（旧会话/简化形状不丢）。
 */
function toolResultText(message: any): string {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'tool-result') parts.push(textOfContent(b.content));
    else if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('');
}

/** 工具调用 id：优先 tool-result 块的 toolCallId，其次 message.source.callId（真实载荷两处都有） */
function toolResultCallId(message: any): string {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const callId = (block as Record<string, unknown>).toolCallId;
    if (typeof callId === 'string' && callId) return callId;
  }
  if (typeof message?.toolCallId === 'string' && message.toolCallId) return message.toolCallId;
  const source = message?.source;
  if (source && typeof source === 'object' && typeof source.callId === 'string' && source.callId) {
    return source.callId;
  }
  return '';
}

/** 成败判定：tool-result 块的 isError 优先，其次 message.isError / 事件级 error */
function toolResultFailed(data: any, message: any): boolean {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  for (const block of blocks) {
    if (block && typeof block === 'object' && (block as Record<string, unknown>).isError === true) return true;
  }
  return message?.isError === true || Boolean(data?.error);
}

/** 一条 session.event → 归一化事件（未知/无关类型返回空数组） */
export function mapSessionEvent(type: string, data: any): AgentEvent[] {
  switch (type) {
    case 'step/start':
      return [{ kind: 'status', text: `第 ${data?.step ?? '?'} 步` }];
    case 'assistant/message': {
      const text = textOfContent(data?.message?.content);
      if (!text) return [];
      return [{ kind: 'text', text, ...(data?.interrupted === true ? { interrupted: true } : {}) }];
    }
    case 'tool/call':
      return typeof data?.name === 'string'
        ? [{
            kind: 'tool-call',
            callId: String(data.callId ?? ''),
            name: data.name,
            args: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}),
          }]
        : [];
    case 'tool/result': {
      const message = data?.message ?? {};
      return [{
        kind: 'tool-result',
        callId: toolResultCallId(message),
        ok: !toolResultFailed(data, message),
        text: toolResultText(message),
      }];
    }
    case 'turn/end':
      return [{ kind: 'turn-end', reason: describeTurnReason(data?.reason) }];
    default:
      return [];
  }
}

/** turn/end.reason 是结构化对象（kind 等），转成一行可读文本 */
export function describeTurnReason(reason: unknown): string {
  if (typeof reason === 'string') return reason;
  if (!reason || typeof reason !== 'object') return '';
  const r = reason as Record<string, unknown>;
  for (const key of ['kind', 'type', 'code', 'message']) {
    if (typeof r[key] === 'string' && r[key]) return r[key] as string;
  }
  try {
    return JSON.stringify(reason).slice(0, 200);
  } catch {
    return '';
  }
}

/**
 * SDK 通知 → 归一化事件。
 * 只透传根会话：子 Agent（subagent）的事件按设计不进主对话流。
 */
export function mapNotification(method: string, params: any, rootSessionId: string): AgentEvent[] {
  if (method === 'session.status') {
    return params?.status === 'running' ? [{ kind: 'status', text: '处理中' }] : [];
  }
  if (method !== 'session.event') return [];
  if (params?.sessionId && rootSessionId && params.sessionId !== rootSessionId) return [];
  const event = params?.event;
  if (!event || typeof event.type !== 'string') return [];
  return mapSessionEvent(event.type, event.data);
}
