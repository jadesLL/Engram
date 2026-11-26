import { nextTick, watch, type Ref } from 'vue';

/**
 * 抽屉/弹窗焦点接管：打开时记住当前焦点元素并把焦点移入面板，关闭时还原焦点，
 * 避免键盘或辅助技术用户在浮层关闭后迷失焦点。
 */
export function useDialogFocus(
  open: () => boolean,
  containerEl: Ref<HTMLElement | undefined | null>,
): void {
  let previousFocus: HTMLElement | null = null;

  watch(open, async (isOpen) => {
    if (isOpen) {
      previousFocus = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      await nextTick();
      const el = containerEl.value;
      if (!el) return;
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: true });
      return;
    }
    if (previousFocus && previousFocus.isConnected) {
      previousFocus.focus({ preventScroll: true });
    }
    previousFocus = null;
  });
}
