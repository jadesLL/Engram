/**
 * 全局 SSE 订阅：服务端页面变更与 Agent 提问提醒实时推送。
 * EventSource 同源自动带 cookie 鉴权，断线原生自动重连。
 * 断线/重连通过回调通知外部（用于全局提示）。
 *
 * 同一条 EventSource 由整个窗口共享：Home（正文/侧栏）、聊天抽屉（会话列表）、
 * 任务看板各自订阅自己的处理器，谁挂载/卸载都不会关掉别人的连接。
 * 之前的实现是「最后一次 openPageStream 独占」——打开内置 Agent 抽屉会把 Home 的
 * 连接关掉，抽屉只认 session-changed，于是 page-changed 被吞掉、编辑器不刷新
 * （2026-11-19 用户报障：Agent 用位置引用写进正文后编辑器看不到）。
 */

// 相对导入带真实扩展名：web 包的 *_test 用 node 类型擦除直接跑（同 ideaDistillFeed.ts 的说明）
import { notify } from './notify.ts';

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

export type PageEventHandler = (ev: PageEvent) => void;

interface Subscriber {
  onEvent: PageEventHandler;
  onReconnect?: () => void;
}

let es: EventSource | null = null;
let disconnectToastShown = false;
/** 当前这条连接是否已经 open 过：只有断线后的重新 open 才通知订阅者补对账 */
let openedBefore = false;
const subscribers = new Set<Subscriber>();

function dispatch(type: string, raw: string) {
  let ev: PageEvent;
  try {
    ev = { type, ...JSON.parse(raw) };
  } catch {
    return; /* ignore malformed */
  }
  // 快照遍历：处理器里注销自己（例如关闭抽屉）不影响同一事件的其余订阅者
  for (const sub of [...subscribers]) {
    try {
      sub.onEvent(ev);
    } catch {
      /* 单个订阅者抛错不影响其他订阅者 */
    }
  }
}

function connect() {
  if (es) return;
  openedBefore = false;
  es = new EventSource('/api/events');
  const handle = (type: string) => (e: MessageEvent) => dispatch(type, e.data);
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
    // 断线期间的事件不会补发：重连后让订阅方立刻对一次账（首次连接不需要，组件自己会读）
    if (openedBefore) {
      for (const sub of [...subscribers]) {
        try {
          sub.onReconnect?.();
        } catch {
          /* 回调失败不影响事件流 */
        }
      }
    }
    openedBefore = true;
  };
}

function disconnect() {
  if (es) {
    es.close();
    es = null;
  }
  openedBefore = false;
  disconnectToastShown = false;
}

/** 关闭整条事件流并清空全部订阅者（页面整体离开/测试用） */
export function closePageStream() {
  subscribers.clear();
  disconnect();
}

/**
 * 订阅全局事件流；同一个窗口里可以多方同时订阅，共享同一条 EventSource。
 * onEvent 收到具名事件（event 名即 type）。
 * onReconnect 在「断开后重新连上」时调用：断线期间的事件已经丢了，调用方应做一次兜底对账
 * （见 lib/freshness）。首次连接不触发。
 * 返回的注销函数只移除本次订阅；最后一个订阅者离开时才关闭连接。
 */
export function openPageStream(onEvent: PageEventHandler, onReconnect?: () => void): () => void {
  const sub: Subscriber = { onEvent, onReconnect };
  subscribers.add(sub);
  connect();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    subscribers.delete(sub);
    if (!subscribers.size) disconnect();
  };
}
