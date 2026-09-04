import { reactive } from 'vue';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  /** 破坏性操作：确认按钮使用实心危险色，且默认焦点落在取消上 */
  danger?: boolean;
  /** 输入框模式：提供后确认框带单行输入框，占位符提示文本（Electron 桌面壳不支持原生 prompt()） */
  placeholder?: string;
  /** 输入框预填值 */
  value?: string;
}

interface ConfirmState extends ConfirmOptions {
  open: boolean;
  resolve: ((value: boolean | string | null) => void) | null;
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
      placeholder: undefined,
      value: undefined,
      ...options,
      open: true,
      resolve,
    });
  });
}

/** Promise 化输入框，替代原生 prompt()（Electron 桌面壳不支持 prompt()，浏览器才可用）；
 *  确定返回输入值（可能为空串，由调用方决定默认值回退），取消返回 null。
 *  danger 仅影响确认按钮配色；输入框模式下焦点始终落在输入框 */
export function promptDialog(options: ConfirmOptions): Promise<string | null> {
  if (confirmState.open) settleConfirm(false);
  return new Promise((resolve) => {
    Object.assign(confirmState, {
      message: undefined,
      confirmText: undefined,
      cancelText: undefined,
      danger: false,
      placeholder: undefined,
      value: undefined,
      ...options,
      open: true,
      resolve,
    });
  });
}

export function settleConfirm(ok: boolean, value?: string) {
  if (!confirmState.open) return;
  confirmState.open = false;
  const resolve = confirmState.resolve;
  confirmState.resolve = null;
  // 输入框模式（promptDialog）把输入值带回给调用方；普通确认框只回传布尔
  resolve?.(value !== undefined ? value : ok);
}
