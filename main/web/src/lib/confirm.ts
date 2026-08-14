import { reactive } from 'vue';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  /** 破坏性操作：确认按钮使用实心危险色，且默认焦点落在取消上 */
  danger?: boolean;
}

interface ConfirmState extends ConfirmOptions {
  open: boolean;
  resolve: ((ok: boolean) => void) | null;
}

export const confirmState = reactive<ConfirmState>({
  open: false,
  title: '',
  resolve: null,
});

/** Promise 化确认框，替代原生 confirm()；同一时间只展示一个，新调用会取消前一个 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (confirmState.open) settleConfirm(false);
  return new Promise((resolve) => {
    Object.assign(confirmState, {
      message: undefined,
      confirmText: undefined,
      cancelText: undefined,
      danger: false,
      ...options,
      open: true,
      resolve,
    });
  });
}

export function settleConfirm(ok: boolean) {
  if (!confirmState.open) return;
  confirmState.open = false;
  confirmState.resolve?.(ok);
  confirmState.resolve = null;
}
