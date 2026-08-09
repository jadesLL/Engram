/**
 * 全局 SSE 订阅：服务端页面变更实时推送。
 * EventSource 同源自动带 cookie 鉴权，断线原生自动重连。
 */

export interface PageEvent {
  type: string; // page-changed | page-deleted | page-moved | file-changed
  path?: string;
  id?: string;
  oldPath?: string;
  newPath?: string;
}

let es: EventSource | null = null;

/** 关闭事件流（幂等） */
export function closePageStream() {
  if (es) {
    es.close();
    es = null;
  }
}

/**
 * 打开事件流；onEvent 收到具名事件（event 名即 type）。
 * 返回关闭函数。重复调用会先关旧连接再开新连接。
 */
export function openPageStream(onEvent: (ev: PageEvent) => void): () => void {
  closePageStream();
  es = new EventSource('/api/events');
  const handle = (type: string) => (e: MessageEvent) => {
    try {
      onEvent({ type, ...JSON.parse(e.data) });
    } catch {
      /* ignore malformed */
    }
  };
  for (const type of ['page-changed', 'page-deleted', 'page-moved', 'file-changed']) {
    es.addEventListener(type, handle(type));
  }
  return closePageStream;
}
