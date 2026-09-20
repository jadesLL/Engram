/**
 * 全局 SSE 订阅：服务端页面变更与名称核验请示实时推送。
 * EventSource 同源自动带 cookie 鉴权，断线原生自动重连。
 * 断线/重连通过回调通知外部（用于全局提示）。
 */

import { notify } from './notify';

export interface PageEvent {
  type: string; // page-changed | page-deleted | page-moved | file-changed | entity-name
  path?: string;
  id?: string;
  oldPath?: string;
  newPath?: string;
  /** entity-name 事件：核验阶段（query_consent 等用户答复 / lookup 等 Agent 回填 / rename_consent 等用户确认改名 / closed） */
  stage?: string;
}

let es: EventSource | null = null;
let disconnectToastShown = false;

/** 关闭事件流（幂等） */
export function closePageStream() {
  if (es) {
    es.close();
    es = null;
  }
  disconnectToastShown = false;
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
  for (const type of ['page-changed', 'page-deleted', 'page-moved', 'file-changed', 'entity-name']) {
    es.addEventListener(type, handle(type));
  }
  es.onerror = () => {
    if (!disconnectToastShown && es && es.readyState === EventSource.CONNECTING) {
      disconnectToastShown = true;
      notify.info('实时同步连接断开，正在自动重连…');
    }
  };
  es.onopen = () => {
    if (disconnectToastShown) {
      disconnectToastShown = false;
      notify.success('实时同步已恢复');
    }
  };
  return closePageStream;
}
