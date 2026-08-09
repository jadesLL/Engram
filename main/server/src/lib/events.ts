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

/** 注册一个 SSE 订阅者；返回反注册函数 */
export function subscribe(s: Subscriber): () => void {
  subs.add(s);
  return () => subs.delete(s);
}

/** 向所有订阅者推送事件；写失败的死连接自动剔除 */
export function emit(event: string, data: unknown): void {
  for (const s of subs) {
    try {
      s.send(event, data);
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
