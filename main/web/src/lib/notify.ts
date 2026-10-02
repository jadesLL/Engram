import { reactive } from 'vue';

export type ToastKind = 'success' | 'error' | 'info';

/**
 * 通知里的一个动作。
 * `primary` 决定视觉层级：主动作给按钮（下一步很明确），次动作给文字链接（稍后 / 知道了）。
 */
export interface ToastAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

export interface ToastItem {
  id: number;
  kind: ToastKind;
  /** 一行正文；有 title 时它退到第二行 */
  text: string;
  /** 加粗的标题行（完成通知用它说清「这条灵感提炼完了」） */
  title?: string;
  actions?: ToastAction[];
  /**
   * 不自动消失：只能点动作或点关闭。
   * 为什么需要：提炼是后台异步的，完成那一刻用户未必在看屏幕——自动倒计时会把「去查看」的机会
   * 一起吞掉（用户回来只看到侧栏多了个文件，不知道刚才发生了什么）。
   */
  sticky?: boolean;
  /** 整张卡片可点（等同第一个动作），用于「完成通知」这种一眼就该点进去的场景 */
  clickable?: boolean;
}

export const toastState = reactive({ items: [] as ToastItem[] });

let seq = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export function dismissToast(id: number) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  const index = toastState.items.findIndex((item) => item.id === id);
  if (index >= 0) toastState.items.splice(index, 1);
}

/** 同屏上限：超了先退非 sticky 的最老一条，sticky 留到最后（否则完成通知会被流水式提示挤掉） */
function trimStack() {
  while (toastState.items.length > 4) {
    const victim = toastState.items.find((item) => !item.sticky) ?? toastState.items[0];
    dismissToast(victim.id);
  }
}

/**
 * 推一条通知，返回 id（调用方可用它提前收走，例如点「再试一次」后关掉失败那条）。
 * 不传 duration 时按 kind 用默认时长；sticky 一律不倒计时。
 */
export function pushToast(item: Omit<ToastItem, 'id'> & { duration?: number }): number {
  const { duration, ...rest } = item;
  const id = ++seq;
  toastState.items.push({ id, ...rest });
  trimStack();
  if (!rest.sticky) {
    const fallback = rest.kind === 'error' ? 5200 : rest.kind === 'info' ? 3600 : 3200;
    timers.set(id, setTimeout(() => dismissToast(id), duration ?? fallback));
  }
  return id;
}

export const notify = {
  success: (text: string) => pushToast({ kind: 'success', text }),
  error: (text: string) => pushToast({ kind: 'error', text }),
  info: (text: string) => pushToast({ kind: 'info', text }),
};
