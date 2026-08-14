import { reactive } from 'vue';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
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

function push(kind: ToastKind, text: string, duration: number) {
  const id = ++seq;
  toastState.items.push({ id, kind, text });
  // 同屏最多保留 4 条，最老的先退场
  while (toastState.items.length > 4) dismissToast(toastState.items[0].id);
  timers.set(id, setTimeout(() => dismissToast(id), duration));
}

export const notify = {
  success: (text: string) => push('success', text, 3200),
  error: (text: string) => push('error', text, 5200),
  info: (text: string) => push('info', text, 3600),
};
