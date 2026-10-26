import type { ServerResponse } from 'node:http';

/**
 * 进程内 SSE 广播：服务端页面增删改/移动时主动推送给所有已连接的前端。
 * 单用户本地知识库规模下，内存 Set 足够；写失败的死连接自动剔除。
 */

export interface Subscriber {
  send(event: string, data: unknown): void;
  raw: ServerResponse;
}

const subs = new Set<Subscriber>();

/**
 * 会改动知识库内容的事件：只有这些事件推进「内容版本号」。
 *
 * 用途见 /api/events/state：SSE 在反向代理缓冲、电脑休眠/唤醒、多端同步等场景下
 * 可能丢事件或晚到，前端靠这个版本号做一次很轻的兜底对账（版本变了才重读列表）。
 * 会话/看板/设置这类事件不动知识库目录，不进版本号，避免无谓刷新。
 */
const CHANGE_EVENTS = new Set(['page-changed', 'page-deleted', 'page-moved', 'file-changed']);

/** 内容版本号：每次内容变更事件 +1（进程内单调递增，重启归零，前端首拍只取基线） */
let contentRevision = 0;

/** 当前内容版本号（供 GET /api/events/state 与测试读取） */
export function stateRevision(): number {
  return contentRevision;
}

/** 注册一个 SSE 订阅者；返回反注册函数 */
export function subscribe(s: Subscriber): () => void {
  subs.add(s);
  return () => subs.delete(s);
}

/** 向所有订阅者推送事件；写失败的死连接自动剔除。
 *  内容事件会带上 rev（内容版本号），前端收到即记下，兜底轮询据此省略重复刷新。 */
export function emit(event: string, data: unknown): void {
  let payload = data;
  if (CHANGE_EVENTS.has(event)) {
    contentRevision += 1;
    payload = data && typeof data === 'object' && !Array.isArray(data)
      ? { ...data as Record<string, unknown>, rev: contentRevision }
      : { rev: contentRevision };
  }
  for (const s of subs) {
    try {
      s.send(event, payload);
    } catch {
      subs.delete(s);
    }
  }
}

/** 心跳：向所有连接写 SSE 注释行，保活并探活（断线由 EventSource 自动重连） */
export function heartbeat(): void {
  for (const s of subs) {
    try {
      s.raw.write(': ping\n\n');
    } catch {
      subs.delete(s);
    }
  }
}
