/**
 * 运行事件总线：SSE 订阅者按 runId 收增量。
 * 进程内内存实现——运行本身由 runner 持久化到库，断了连接重连时用 snapshot 补齐。
 */

type Subscriber = (event: string, data: unknown) => void;

const subscribers = new Map<string, Set<Subscriber>>();

export function subscribeRun(runId: string, fn: Subscriber): () => void {
  let set = subscribers.get(runId);
  if (!set) {
    set = new Set();
    subscribers.set(runId, set);
  }
  set.add(fn);
  return () => {
    const current = subscribers.get(runId);
    if (!current) return;
    current.delete(fn);
    if (!current.size) subscribers.delete(runId);
  };
}

export function publishRun(runId: string, event: string, data: unknown): void {
  const set = subscribers.get(runId);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(event, data);
    } catch {
      /* 单个订阅者出错不影响其他订阅者 */
    }
  }
}

/** 运行进入终态后调用：清掉订阅集合，释放内存 */
export function clearRun(runId: string): void {
  subscribers.delete(runId);
}
