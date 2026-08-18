/**
 * 全局 Tooltip 状态：单例气泡，任何元素 hover 即激活。
 * 与 Toast 类似走 Teleport 全局单例，避免每个组件独立挂载。
 */

import { reactive } from 'vue';

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipState {
  visible: boolean;
  text: string;
  /** 锚点元素 viewport 坐标 */
  x: number;
  y: number;
  width: number;
  height: number;
  placement: TooltipPlacement;
}

export const tooltipState = reactive<TooltipState>({
  visible: false,
  text: '',
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  placement: 'top',
});

let showTimer: ReturnType<typeof setTimeout> | null = null;
let currentAnchor: HTMLElement | null = null;

const SHOW_DELAY = 350;

function clearTimer() {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
}

export function showTooltip(
  anchor: HTMLElement,
  text: string,
  placement: TooltipPlacement = 'top',
  immediate = false,
) {
  if (!text) return;
  clearTimer();
  currentAnchor = anchor;
  const doShow = () => {
    if (currentAnchor !== anchor || !anchor.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    tooltipState.text = text;
    tooltipState.x = rect.left;
    tooltipState.y = rect.top;
    tooltipState.width = rect.width;
    tooltipState.height = rect.height;
    tooltipState.placement = placement;
    tooltipState.visible = true;
  };
  if (immediate) doShow();
  else showTimer = setTimeout(doShow, SHOW_DELAY);
}

export function hideTooltip(anchor?: HTMLElement) {
  if (anchor && currentAnchor !== anchor) return;
  clearTimer();
  currentAnchor = null;
  tooltipState.visible = false;
}

/** 元素是否被截断（用于智能折叠，仅截断时显示 tooltip） */
export function isTruncated(el: HTMLElement): boolean {
  // 水平或垂直任一方向溢出即视为截断
  return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
}
