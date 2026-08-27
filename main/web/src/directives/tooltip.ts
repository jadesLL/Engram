/**
 * v-tooltip 指令：为元素附加全局 Tooltip。
 *
 * 用法：
 *   <button v-tooltip="'保存'">…</button>               永远显示
 *   <span v-tooltip.auto="file.name">…</span>           仅在文本被截断时显示
 *   <span v-tooltip.bottom="'说明'">…</span>            指定方向（top/bottom/left/right）
 *
 * 修饰符可组合：v-tooltip.auto.bottom
 */

import type { Directive, DirectiveBinding } from 'vue';
import { hideTooltip, isTruncated, showTooltip, type TooltipPlacement } from '../lib/tooltip';

interface TooltipEl extends HTMLElement {
  __tooltipHandlers__?: {
    enter: () => void;
    leave: () => void;
    value: string;
    auto: boolean;
    placement: TooltipPlacement;
  };
}

function resolvePlacement(binding: DirectiveBinding): TooltipPlacement {
  if (binding.modifiers.bottom) return 'bottom';
  if (binding.modifiers.left) return 'left';
  if (binding.modifiers.right) return 'right';
  return 'top';
}

function attach(el: TooltipEl, binding: DirectiveBinding) {
  const value = typeof binding.value === 'string' ? binding.value : '';
  const auto = Boolean(binding.modifiers.auto);
  const placement = resolvePlacement(binding);

  // 先清理旧绑定
  if (el.__tooltipHandlers__) {
    el.removeEventListener('mouseenter', el.__tooltipHandlers__.enter);
    el.removeEventListener('mouseleave', el.__tooltipHandlers__.leave);
    el.removeEventListener('focus', el.__tooltipHandlers__.enter);
    el.removeEventListener('blur', el.__tooltipHandlers__.leave);
  }

  if (!value) {
    delete el.__tooltipHandlers__;
    return;
  }

  // 触屏（无 hover）：tap 触发的 mouseenter 不弹提示；实时判断以覆盖运行中 hover 能力变化（折叠屏形态切换/DevTools 模拟）
  const isTouchOnly = () => window.matchMedia('(hover: none)').matches;

  const enter = () => {
    if (isTouchOnly()) return;
    if (auto && !isTruncated(el)) return;
    showTooltip(el, value, placement);
  };
  const leave = () => hideTooltip(el);

  // 统一绑定 mouse 事件：触屏下 enter 内部短路，无需在绑定期区分
  el.addEventListener('mouseenter', enter);
  el.addEventListener('mouseleave', leave);
  el.addEventListener('focus', enter);
  el.addEventListener('blur', leave);

  el.__tooltipHandlers__ = { enter, leave, value, auto, placement };
}

function detach(el: TooltipEl) {
  const handlers = el.__tooltipHandlers__;
  if (!handlers) return;
  el.removeEventListener('mouseenter', handlers.enter);
  el.removeEventListener('mouseleave', handlers.leave);
  el.removeEventListener('focus', handlers.enter);
  el.removeEventListener('blur', handlers.leave);
  hideTooltip(el);
  delete el.__tooltipHandlers__;
}export const vTooltip: Directive<TooltipEl, string> = {
  mounted: attach,
  updated: attach,
  unmounted: detach,
};
