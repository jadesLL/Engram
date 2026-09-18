import type { ChatMessage, ChatRun, ChatToolCall } from '../stores/chat';

/**
 * 聊天抽屉的对话流：把消息与工具卡（执行记录）合成一条按时间排的时间线。
 *
 * 助手正文在服务端按步分段落库（每步一条 assistant/message），所以这里要做的就是把
 * 工具卡插回它发生的那两步之间——纯函数，无 Vue 依赖，便于单测。
 */

export type ChatStreamItem = {
  /** 稳定 key：消息 id 或工具卡 id */
  key: string;
  /** 排序用的落库时间（ISO 字符串，可直接字典序比较） */
  at: string;
  /** 同一毫秒时的次序：正文段在前，工具卡在后 */
  rank: number;
  role: 'user' | 'assistant';
} & (
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'tool'; call: ChatToolCall }
);

function byAt(a: ChatStreamItem, b: ChatStreamItem): number {
  return a.at.localeCompare(b.at) || a.rank - b.rank;
}

export function buildChatTimeline(
  messages: ChatMessage[],
  calls: ChatToolCall[],
  runs: ChatRun[]
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
      kind: 'message',
      message,
    });
  }
  for (const call of calls) {
    add(call.runId, {
      key: call.id,
      at: call.createdAt,
      rank: 1,
      role: 'assistant',
      kind: 'tool',
      call,
    });
  }

  // 一轮一组，组内按时间排；组间也按时间排（同一会话同时只有一轮在跑，通常不会交错）。
  // 没挂到轮上的（v1.1 的历史消息、刚乐观插入还没等到快照的那条）各自成组，按自身时间落位。
  const ordered: Array<{ at: string; items: ChatStreamItem[] }> = [];
  for (const [runId, items] of groups) {
    const startedAt = runs.find((run) => run.id === runId)?.createdAt || items[0].at;
    ordered.push({ at: startedAt, items: items.sort(byAt) });
  }
  for (const item of loose) ordered.push({ at: item.at, items: [item] });
  return ordered.sort((a, b) => a.at.localeCompare(b.at)).flatMap((group) => group.items);
}

/** 一轮里只在第一条正文上署名，避免按步分段后每段都重复一次「内置 Agent」 */
export function showStreamName(items: ChatStreamItem[], index: number): boolean {
  const current = items[index];
  for (let i = index - 1; i >= 0; i -= 1) {
    const prev = items[i];
    if (prev.role !== current.role) return true; // 换人了（上一轮/上一条用户消息）
    if (prev.kind === 'message') return false; // 本轮已经署过名
  }
  return true;
}
