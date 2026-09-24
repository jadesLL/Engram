/**
 * dsh 会话事件 → 归一化动作的纯映射层（无 IO、无依赖，便于单测）。
 *
 * 字段形状取自 dsh 自身的 SessionEventMap / session.event 通知载荷（与真实会话日志逐字核对过）：
 *   assistant/message { message: { content: [{type:'text'|'reasoning', text}] }, stream?, interrupted? }
 *   tool/call         { callId, name, arguments(未解析的 JSON 字符串) }
 *   tool/result       { message: { source: {kind:'tool', callId},
 *                                   content: [{type:'tool-result', toolCallId, isError?,
 *                                              content: [{type:'text', text}]}] }, error? }
 *   step/start | turn/end ...
 * 事件表由 dsh 插件可扩展，未知类型一律忽略（不猜测语义）。
 *
 * 子代理：dsh 的子会话也是本会话树的一部分，SDK 的 onNotification 把整棵树的通知都送过来，
 * 所以除了根会话事件还有两类信号——
 *   subagent.started  { parentSessionId, childSessionId }（谱系边）
 *   subagent.finished { parentSessionId, childSessionId, status:'ok'|'error', stopReason, lastAssistantMessage? }
 * 子会话自己的事件里，第一条是 subagent/descriptor（version 3：mode/provider/label），
 * 其后才是常规的 turn/step/tool/assistant 事件，sessionId 是子会话 id。
 *
 * 流式：SDK 的 session.event 是「按步提交」——一步（一次模型请求）结束时才落一条
 * assistant/message，正文与思考一起到达。但这条持久事件里带着模型原始增量流
 * （`stream: AssistantStreamRecord[]`，reasoning-chunks 记录含 time0 + 逐块 dt 与 texts），
 * 所以思考过程可以按真实节奏回放出来（见 planReasoningReplay），观感与逐字流式一致。
 */

import { parseUsage, type UsageStep } from './usage.js';

/** 一段思考增量：text 是原文片段，at 是它在会话时间轴上的毫秒时间戳 */
export interface ReasoningPart {
  text: string;
  at: number;
}

/** 归一化后的运行事件：runner 据此写库并推 SSE */
export type AgentEvent =
  | { kind: 'status'; text: string }
  | { kind: 'text'; text: string; interrupted?: boolean }
  | { kind: 'reasoning'; text: string; parts: ReasoningPart[]; interrupted?: boolean }
  | { kind: 'tool-call'; callId: string; name: string; args: string }
  | { kind: 'tool-result'; callId: string; ok: boolean; text: string }
  | { kind: 'turn-end'; reason: string }
  // ---- 模型用量（每一步一次，随该步的 assistant/message 一起到达）----
  /** 主对话这一步的用量：runner 累计到本轮命中率上 */
  | { kind: 'usage'; usage: UsageStep }
  /** 子代理这一步的用量：单独累计，不混进主对话的命中率 */
  | { kind: 'subagent-usage'; childSessionId: string; usage: UsageStep }
  // ---- 子代理（dsh subagent / subagent_fork / workflow / ralph 起的子会话）----
  /** 子代理开工：dsh 通知 subagent.started（父会话 → 子会话的谱系边） */
  | { kind: 'subagent-start'; childSessionId: string; parentSessionId: string }
  /** 子会话自己的第一条事件 subagent/descriptor：标签、模式、provider 都在这 */
  | { kind: 'subagent-descriptor'; childSessionId: string; label: string; mode: string; provider: string }
  /** 子代理过程里的一步（子会话的工具调用/结果） */
  | { kind: 'subagent-activity'; childSessionId: string; callId: string; name: string; summary: string; status: 'running' | 'completed' | 'failed'; text: string }
  /** 子代理的正文（只作最新产出预览，不进主对话流） */
  | { kind: 'subagent-text'; childSessionId: string; text: string }
  /** 子代理收工：dsh 通知 subagent.finished（含最后一条助手消息与停止原因） */
  | { kind: 'subagent-end'; childSessionId: string; ok: boolean; stopReason: string; text: string };

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

/** 取字符串字段（空/非字符串一律给空串，调用方不必再判） */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 工具参数的一行摘要：第一个非空字符串字段（对象键序），没有就退回压平后的原文。
 * 与前端 lib/chatTimeline 的 toolCallSummary 同一口径——子代理过程在服务端落库，
 * 前端只负责显示，所以摘要必须在写入时就定下来。
 */
export function briefArgs(args: unknown, limit = 120): string {
  const raw = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  let picked = '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>);
      const firstString = entries.find(([, value]) => typeof value === 'string' && value.trim() !== '');
      if (firstString) picked = firstString[1] as string;
      else if (entries.length) {
        const [key, value] = entries[0];
        picked = `${key}: ${typeof value === 'string' ? value : JSON.stringify(value) ?? ''}`;
      }
    } else {
      picked = typeof parsed === 'string' ? parsed : raw;
    }
  } catch {
    picked = raw;
  }
  const text = picked.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 从持久事件的原始增量流里取思考片段时间线。
 *
 * 记录形状（dsh-llm 的 AssistantStreamRecord）：{ type:'reasoning-chunks', time0, dt[], texts[] }，
 * 第 i 块的时间 = time0 + Σ dt[0..i]。拼回来的文本必须与块文本逐字一致才采用——dsh 版本
 * 换了压缩口径时宁可整段显示，也不放出对不上的回放。
 */
function reasoningParts(stream: unknown, expected: string): ReasoningPart[] {
  if (!expected || !Array.isArray(stream)) return [];
  const parts: ReasoningPart[] = [];
  for (const record of stream) {
    if (!record || typeof record !== 'object') continue;
    const r = record as Record<string, unknown>;
    if (r.type !== 'reasoning-chunks') continue;
    const time0 = Number(r.time0);
    if (!Number.isFinite(time0)) continue;
    const dt = Array.isArray(r.dt) ? r.dt : [];
    const texts = Array.isArray(r.texts) ? r.texts : [];
    let at = time0;
    for (let i = 0; i < texts.length; i++) {
      at += Number(dt[i]) || 0;
      const text = typeof texts[i] === 'string' ? texts[i] : '';
      if (text) parts.push({ text, at });
    }
  }
  if (!parts.length) return [];
  if (parts.map((part) => part.text).join('') !== expected) return [];
  return parts;
}

/** 一条 session.event → 归一化事件（未知/无关类型返回空数组） */
export function mapSessionEvent(type: string, data: any): AgentEvent[] {
  switch (type) {
    case 'step/start':
      return [{ kind: 'status', text: `第 ${data?.step ?? '?'} 步` }];
    case 'assistant/message': {
      // 一步的正文与思考在同一个 content 数组里按块序混排（通常是 思考…思考、正文…正文）。
      // 按块序切成若干段：连续的思考并成一段、连续的正文并成一段，段的先后即真实发生顺序。
      const blocks = Array.isArray(data?.message?.content) ? data.message.content : [];
      const interrupted = data?.interrupted === true;
      const events: AgentEvent[] = [];
      let reasoning: string[] = [];
      let text: string[] = [];
      const flushReasoning = () => {
        if (!reasoning.length) return;
        const joined = reasoning.join('');
        reasoning = [];
        if (!joined.trim()) return;
        events.push({
          kind: 'reasoning',
          text: joined,
          parts: reasoningParts(data?.stream, joined),
          ...(interrupted ? { interrupted: true } : {}),
        });
      };
      const flushText = () => {
        if (!text.length) return;
        const joined = text.join('');
        text = [];
        if (!joined) return;
        events.push({ kind: 'text', text: joined, ...(interrupted ? { interrupted: true } : {}) });
      };
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (typeof b.text !== 'string') continue;
        if (b.type === 'reasoning') {
          flushText();
          reasoning.push(b.text);
        } else if (b.type === 'text') {
          flushReasoning();
          text.push(b.text);
        }
      }
      flushReasoning();
      flushText();
      // 这一步的模型用量（dsh 的 TokenUsage）随消息一起来：交给 runner 累计成本轮命中率
      const usage = parseUsage(data?.usage);
      if (usage) events.push({ kind: 'usage', usage });
      return events;
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

/** 回放一步：每段正文前要等多久（毫秒） */
export interface ReplayStep {
  text: string;
  delayMs: number;
}

export interface ReplayOptions {
  /** 单段思考的回放总时长上限（真实思考再久也压缩到这个量级） */
  capMs?: number;
  /** 合并阈值：攒够这么多字才发一段（减少落库与 SSE 帧数） */
  minChars?: number;
  /** 合并阈值：攒够这么多毫秒才发一段 */
  minMs?: number;
  /** 单段思考最多发几帧（极端长思考的兜底） */
  maxSteps?: number;
}

/**
 * 把思考片段时间线折算成回放计划。
 *
 * 没有可用片段（模型没流式思考 / 形状对不上）时退化成「整段一次发出」，绝不编造节奏。
 * 有片段时按真实间隔回放；真实总时长超过 capMs 就整体等比压缩，保证一步最多拖住
 * capMs（默认 2s）——正文要等这段回放完才显示，所以上限必须硬。
 */
export function planReasoningReplay(
  parts: ReasoningPart[],
  text: string,
  options: ReplayOptions = {}
): ReplayStep[] {
  const whole: ReplayStep[] = [{ text, delayMs: 0 }];
  if (!text) return [];
  if (!parts.length || parts.map((part) => part.text).join('') !== text) return whole;

  const capMs = options.capMs ?? 2000;
  const minChars = options.minChars ?? 6;
  const minMs = options.minMs ?? 60;
  const maxSteps = options.maxSteps ?? 60;

  const start = parts[0].at;
  const end = parts[parts.length - 1].at;
  const span = Math.max(0, end - start);
  const scale = span > capMs && span > 0 ? capMs / span : 1;

  const steps: ReplayStep[] = [];
  let buffer = '';
  let delay = 0;
  let previous = start;
  for (const part of parts) {
    buffer += part.text;
    delay += Math.max(0, part.at - previous) * scale;
    previous = part.at;
    if (buffer.length >= minChars || delay >= minMs) {
      steps.push({ text: buffer, delayMs: Math.round(delay) });
      buffer = '';
      delay = 0;
    }
  }
  if (buffer) steps.push({ text: buffer, delayMs: Math.round(delay) });
  // 压缩后帧数仍可能很多：把超出上限的尾部帧并进最后一帧（间隔已经很小，观感无差）
  if (steps.length > maxSteps) {
    const head = steps.slice(0, maxSteps - 1);
    const tail = steps.slice(maxSteps - 1);
    head.push({ text: tail.map((step) => step.text).join(''), delayMs: tail[0].delayMs });
    return head;
  }
  return steps;
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
 * 子会话（子代理）事件 → 归一化事件。
 *
 * 子代理自己的正文与思考**不进**主对话流（那会把一条对话搅成两股声音），
 * 但要看得出「它在干什么、干出了什么」：过程收成过程条目，正文只作最新产出预览，
 * 收工时再由 subagent.finished 的 lastAssistantMessage 定稿。
 */
export function mapChildSessionEvent(childSessionId: string, type: string, data: any): AgentEvent[] {
  switch (type) {
    // 子会话的第一条事件：标签（模型给的 3-5 词任务名）、模式、provider
    case 'subagent/descriptor':
      return [{
        kind: 'subagent-descriptor',
        childSessionId,
        label: str(data?.label),
        mode: str(data?.mode),
        provider: str(data?.provider),
      }];
    case 'tool/call':
      return typeof data?.name === 'string'
        ? [{
            kind: 'subagent-activity',
            childSessionId,
            callId: str(data.callId),
            name: data.name,
            summary: briefArgs(data.arguments, 90),
            status: 'running',
            text: '',
          }]
        : [];
    case 'tool/result': {
      const message = data?.message ?? {};
      return [{
        kind: 'subagent-activity',
        childSessionId,
        callId: toolResultCallId(message),
        name: '',
        summary: '',
        status: toolResultFailed(data, message) ? 'failed' : 'completed',
        text: toolResultText(message),
      }];
    }
    case 'assistant/message': {
      const text = textOfContent(data?.message?.content).trim();
      const usage = parseUsage(data?.usage);
      return [
        ...(text ? [{ kind: 'subagent-text' as const, childSessionId, text }] : []),
        // 子代理自己的用量：单独累计，主对话的命中率不含它
        ...(usage ? [{ kind: 'subagent-usage' as const, childSessionId, usage }] : []),
      ];
    }
    default:
      return [];
  }
}

/**
 * SDK 通知 → 归一化事件。
 *
 * 根会话照旧进主对话流；子会话（子代理）转成过程/产出事件，由 runner 挂到子代理卡上；
 * 子代理的开收工由 subagent.started / subagent.finished 两条谱系通知界定
 * （dsh 的 sdk profile 只会推这两种，故不必猜）。
 */
export function mapNotification(method: string, params: any, rootSessionId: string): AgentEvent[] {
  if (method === 'subagent.started') {
    const childSessionId = str(params?.childSessionId);
    if (!childSessionId) return [];
    return [{ kind: 'subagent-start', childSessionId, parentSessionId: str(params?.parentSessionId) }];
  }
  if (method === 'subagent.finished') {
    const childSessionId = str(params?.childSessionId) || str(params?.agentId);
    if (!childSessionId) return [];
    return [{
      kind: 'subagent-end',
      childSessionId,
      ok: params?.status !== 'error',
      stopReason: str(params?.stopReason),
      text: textOfContent(params?.lastAssistantMessage),
    }];
  }
  if (method === 'session.status') {
    // 子代理的运行状态不是主对话的状态：早期实现照单全收，子代理一开工主对话就显示「处理中」
    if (params?.sessionId && rootSessionId && params.sessionId !== rootSessionId) return [];
    return params?.status === 'running' ? [{ kind: 'status', text: '处理中' }] : [];
  }
  if (method !== 'session.event') return [];
  const sessionId = str(params?.sessionId);
  const event = params?.event;
  if (!event || typeof event.type !== 'string') return [];
  if (sessionId && rootSessionId && sessionId !== rootSessionId) {
    return mapChildSessionEvent(sessionId, event.type, event.data);
  }
  return mapSessionEvent(event.type, event.data);
}
