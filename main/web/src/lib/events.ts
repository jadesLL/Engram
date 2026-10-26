/**
 * 全局 SSE 订阅：服务端页面变更与 Agent 提问提醒实时推送。
 * EventSource 同源自动带 cookie 鉴权，断线原生自动重连。
 * 断线/重连通过回调通知外部（用于全局提示）。
 */

import { notify } from './notify';

export interface PageEvent {
  type: string; // page-changed | page-deleted | page-moved | file-changed | agent-question | session-changed | board-changed
  path?: string;
  id?: string;
  oldPath?: string;
  newPath?: string;
  /** agent-question：Agent 在对话里提了问，抽屉关着时提醒一句（弹窗本体在 ChatDrawer 里） */
  sessionId?: string;
  runId?: string;
  count?: number;
  text?: string;
  /** 内容版本号（服务端随内容事件附带）：兜底轮询据此判断「这条事件已经处理过」，不重复刷新 */
  rev?: number;
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
 * onReconnect 在「断开后重新连上」时调用：断线期间的事件已经丢了，调用方应做一次兜底对账
 * （见 lib/freshness）。首次连接不触发。
 * 返回关闭函数。重复调用会先关旧连接再开新连接。
 */
export function openPageStream(onEvent: (ev: PageEvent) => void, onReconnect?: () => void): () => void {
  closePageStream();
  es = new EventSource('/api/events');
  let openedBefore = false;
  const handle = (type: string) => (e: MessageEvent) => {
    try {
      onEvent({ type, ...JSON.parse(e.data) });
    } catch {
      /* ignore malformed */
    }
  };
  // session-changed / board-changed：多端同步把别端的会话或任务看板同步过来时推送
  for (const type of [
    'page-changed',
    'page-deleted',
    'page-moved',
    'file-changed',
    'agent-question',
    'session-changed',
    'board-changed',
    'settings-changed',
  ]) {
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
    // 断线期间的事件不会补发：重连后让调用方立刻对一次账（首次连接不需要，组件自己会读）
    if (openedBefore) {
      try { onReconnect?.(); } catch { /* 回调失败不影响事件流 */ }
    }
    openedBefore = true;
  };
  return closePageStream;
}
