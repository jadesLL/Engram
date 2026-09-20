import type { ChatMessage, ChatRun, ChatSubagent, ChatToolCall } from '../stores/chat';

/**
 * 聊天抽屉的对话流：把消息（正文 / 思考）、工具卡（执行记录）与子代理卡合成一条按时间排的时间线。
 *
 * 助手正文在服务端按步分段落库（每步一条 assistant/message），思考段是同表另一类
 * （metadata.kind = 'reasoning'），所以这里要做的就是把工具卡插回它发生的那两步之间——
 * 纯函数，无 Vue 依赖，便于单测。
 *
 * 子代理（dsh 的 subagent / subagent_fork / workflow / ralph 子会话）单独成卡：
 * 派它的那次工具调用（subagent.parentCallId）不再单独显示，否则同一件事会出现两行；
 * 子代理又派子代理时按谱系嵌进父卡（一层展示，再深就并排）。
 */

export type ChatStreamItem = {
  /** 稳定 key：消息 id 或工具卡 id */
  key: string;
  /** 排序用的落库时间（ISO 字符串，可直接字典序比较） */
  at: string;
  /** 同一毫秒时的次序：消息/思考段在前，工具卡与子代理卡在后 */
  rank: number;
  role: 'user' | 'assistant';
} & (
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'reasoning'; message: ChatMessage }
  | { kind: 'tool'; call: ChatToolCall }
  | { kind: 'subagent'; subagent: ChatSubagent; children: ChatSubagent[] }
);

/** 思考段：正文之外的「过程」消息（服务端按 metadata.kind 标记） */
export function isReasoningMessage(message: ChatMessage): boolean {
  return (message.metadata as any)?.kind === 'reasoning';
}

/**
 * 排队中的用户消息：上一轮还在跑时发的那条，服务端先落库并打 metadata.queued，
 * 轮到它时转正并摘掉标记。界面据此标「排队中」。
 */
export function isQueuedMessage(message: ChatMessage): boolean {
  return (message.metadata as any)?.queued === true;
}

/** 思考段时长（毫秒）：服务端在段收口时补写；缺失返回 0 */
export function reasoningDurationMs(message: ChatMessage): number {
  const value = Number((message.metadata as any)?.ms);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 思考段是否还在长：它是本轮最后一条（streamingKey 命中）且服务端还没给它收口。
 * 服务端在这段播完时补写 metadata.ms 并推一份快照，所以「有 ms」就等于「这段已经跑完」——
 * 界面据此在思考跑完的那一刻自动收起，不必等整轮结束。
 */
export function isReasoningLive(message: ChatMessage, streamingKey: string): boolean {
  return streamingKey === message.id && reasoningDurationMs(message) === 0;
}

function byAt(a: ChatStreamItem, b: ChatStreamItem): number {
  return a.at.localeCompare(b.at) || a.rank - b.rank;
}

export function buildChatTimeline(
  messages: ChatMessage[],
  calls: ChatToolCall[],
  runs: ChatRun[],
  subagents: ChatSubagent[] = []
): ChatStreamItem[] {
  const groups = new Map<string, ChatStreamItem[]>();
  const loose: ChatStreamItem[] = [];
  const add = (runId: string | undefined, item: ChatStreamItem) => {
    if (!runId) {
      loose.push(item);
      return;
    }
    const list = groups.get(runId);
    if (list) list.push(item);
    else groups.set(runId, [item]);
  };

  for (const message of messages) {
    add(message.runId, {
      key: message.id,
      at: message.createdAt,
      rank: 0,
      role: message.role,
      kind: isReasoningMessage(message) ? 'reasoning' : 'message',
      message,
    });
  }

  // 子代理卡：先按谱系分组，父会话是另一个子代理的子会话时算嵌套
  const childSessions = new Set(subagents.map((item) => item.childSessionId));
  const childrenOf = new Map<string, ChatSubagent[]>();
  const roots: ChatSubagent[] = [];
  for (const subagent of subagents) {
    if (subagent.parentSessionId && childSessions.has(subagent.parentSessionId)) {
      const list = childrenOf.get(subagent.parentSessionId);
      if (list) list.push(subagent);
      else childrenOf.set(subagent.parentSessionId, [subagent]);
    } else {
      roots.push(subagent);
    }
  }
  // 被子代理卡接管的那几张工具卡（委派动作本身）：不再单独成行
  const claimedCalls = new Set(
    subagents.map((item) => item.parentCallId).filter((id): id is string => Boolean(id))
  );

  for (const call of calls) {
    if (claimedCalls.has(call.id)) continue;
    add(call.runId, {
      key: call.id,
      at: call.createdAt,
      rank: 1,
      role: 'assistant',
      kind: 'tool',
      call,
    });
  }
  for (const subagent of roots) {
    add(subagent.runId, {
      key: subagent.id,
      at: subagent.createdAt,
      rank: 2,
      role: 'assistant',
      kind: 'subagent',
      subagent,
      children: childrenOf.get(subagent.childSessionId) || [],
    });
  }

  // 一轮一组，组内按时间排；组间也按时间排（同一会话同时只有一轮在跑，通常不会交错）。
  // 没挂到轮上的（v1.1 的历史消息、刚乐观插入还没等到快照的那条）各自成组，按自身时间落位。
  // 同一步里思考段先于正文落库，时间戳可能同毫秒——sort 稳定，靠输入顺序（落库顺序）保住先后。
  const ordered: Array<{ at: string; items: ChatStreamItem[] }> = [];
  for (const [runId, items] of groups) {
    const startedAt = runs.find((run) => run.id === runId)?.createdAt || items[0].at;
    ordered.push({ at: startedAt, items: items.sort(byAt) });
  }
  for (const item of loose) ordered.push({ at: item.at, items: [item] });
  return ordered.sort((a, b) => a.at.localeCompare(b.at)).flatMap((group) => group.items);
}

/**
 * 一轮里只在第一条正文上署名，避免按步分段后每段都重复一次「内置 Agent」。
 * 思考段不署名、也不算「已署名」——它有自己的标题行，夹在正文之间不该把署名吞掉。
 */
export function showStreamName(items: ChatStreamItem[], index: number): boolean {
  const current = items[index];
  for (let i = index - 1; i >= 0; i -= 1) {
    const prev = items[i];
    if (prev.kind === 'reasoning') continue;
    if (prev.role !== current.role) return true; // 换人了（上一轮/上一条用户消息）
    if (prev.kind === 'message') return false; // 本轮已经署过名
  }
  return true;
}

/** 取条目挂的那一轮 id（散项没有） */
function runIdOf(item: ChatStreamItem): string {
  if (item.kind === 'tool') return item.call.runId;
  if (item.kind === 'subagent') return item.subagent.runId || '';
  return item.message.runId || '';
}

/**
 * 是否是一轮的第一条（单列转录用它画轮间细分隔）。
 * 首项、换了轮、以及没挂到轮上的散项（v1.1 历史消息、乐观插入的那条）都算新段。
 */
export function startsNewRun(items: ChatStreamItem[], index: number): boolean {
  const current = items[index];
  if (!current) return false;
  if (index === 0) return true;
  const runId = runIdOf(current);
  const prevRunId = runIdOf(items[index - 1]);
  if (!runId || !prevRunId) return true;
  return runId !== prevRunId;
}

/**
 * 工具卡收起态的一行参数摘要：取 args 里第一个非空字符串字段（对象键序）；
 * 没有字符串字段就写成「键: 值」；坏 JSON / 非对象用原串；空白压成一行，超长截断。
 */
export function toolCallSummary(args: string, limit = 80): string {
  const raw = (args || '').trim();
  if (!raw || raw === '{}') return '';
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
