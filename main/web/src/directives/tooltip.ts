/**
 * v-tooltip 指令：为元素附加全局自建提示（替代系统原生 title）。
 *
 * 用法：
 *   <button v-tooltip="'保存'">…</button>                     只有正文
 *   <span v-tooltip.auto="file.name">…</span>                 仅在文本被截断时显示
 *   <button v-tooltip.bottom="'说明'">…</button>              指定首选方向（top/bottom/left/right）
 *   <button v-tooltip.cursor="'节点'">…</button>              光标跟随（图谱 / 画布等大块区域）
 *   <button v-tooltip.near="{ title, body }">…</button>       就近优先（允许轻微遮挡，不外移）
 *   <button v-tooltip.strict.spotlight="{…}">…</button>       严格零遮挡 + 聚光
 *   <button v-tooltip="{ title: '保存', body: '写回磁盘', kbd: 'Ctrl+S' }">…</button>
 *
 * 修饰符可组合：v-tooltip.auto.bottom
 * 对象值支持 title / body / kbd / meta / placement / strategy / strict / spotlight / pointer / anchorRect / delay。
 */

import type { Directive, DirectiveBinding } from 'vue';
import {
  hideTooltip,
  isTruncated,
  showTooltip,
  tooltipAnchor,
  updateTooltipPointer,
  type TooltipOptions,
  type TooltipPlacement,
  type TooltipStrategy,
  type TooltipValue,
} from '../lib/tooltip';

interface TooltipEl extends HTMLElement {
  __tooltipHandlers__?: {
    enter: () => void;
    leave: () => void;
    focusIn: () => void;
    move: (event: MouseEvent) => void;
    value: TooltipValue;
    auto: boolean;
    options: TooltipOptions;
    /** 绑定指纹：只有值/修饰符真的变了才重建监听 */
    key: string;
  };
}

function resolvePlacement(binding: DirectiveBinding): TooltipPlacement | undefined {
  if (binding.modifiers.bottom) return 'bottom';
  if (binding.modifiers.left) return 'left';
  if (binding.modifiers.right) return 'right';
  if (binding.modifiers.top) return 'top';
  return undefined;
}

/** 把修饰符翻译成提示选项（对象值里的同名字段优先） */
function resolveOptions(binding: DirectiveBinding): TooltipOptions {
  const value: TooltipValue = typeof binding.value === 'string' ? binding.value : (binding.value ?? '');
  const base: TooltipOptions = typeof value === 'string' ? { body: value } : { ...value };
  const placement = resolvePlacement(binding);
  const strategy: TooltipStrategy | undefined = binding.modifiers.cursor ? 'cursor' : undefined;
  return {
    ...base,
    ...(placement ? { placement } : {}),
    ...(strategy ? { strategy } : {}),
    ...(binding.modifiers.strict ? { strict: true } : {}),
    ...(binding.modifiers.near ? { strict: false } : {}),
    ...(binding.modifiers.spotlight ? { spotlight: true } : {}),
  };
}

function detach(el: TooltipEl) {
  const handlers = el.__tooltipHandlers__;
  if (!handlers) return;
  el.removeEventListener('mouseenter', handlers.enter);
  el.removeEventListener('mouseleave', handlers.leave);
  el.removeEventListener('mousemove', handlers.move);
  el.removeEventListener('focus', handlers.focusIn);
  el.removeEventListener('blur', handlers.leave);
  hideTooltip(el);
  delete el.__tooltipHandlers__;
}

function attach(el: TooltipEl, binding: DirectiveBinding) {
  const options = resolveOptions(binding);
  const auto = Boolean(binding.modifiers.auto);
  const key = JSON.stringify({ value: binding.value ?? '', auto, mods: Object.keys(binding.modifiers).sort() });

  // 组件重渲染也会走 updated：绑定没变就原样留着，否则会把正在显示（或还在延迟里）的提示打掉
  const prev = el.__tooltipHandlers__;
  if (prev && prev.key === key) return;
  const wasShowing = tooltipAnchor() === el;
  detach(el);

  if (!options.body && !options.title) return;

  // 触屏（无 hover）：tap 触发的 mouseenter 不弹提示；实时判断以覆盖运行中 hover 能力变化（折叠屏形态切换/DevTools 模拟）
  const isTouchOnly = () => window.matchMedia('(hover: none)').matches;
  const skip = () => isTouchOnly() || (auto && !isTruncated(el));

  const enter = () => {
    if (skip()) return;
    showTooltip(el, options);
  };
  const leave = () => hideTooltip(el);
  const move = (event: MouseEvent) => updateTooltipPointer(event.clientX, event.clientY);
  // 键盘可达：focus 立即显示（不等待延迟），blur 收起
  const focusIn = () => {
    if (skip()) return;
    showTooltip(el, options, {}, true);
  };

  // 统一绑定 mouse 事件：触屏下 enter 内部短路，无需在绑定期区分
  el.addEventListener('mouseenter', enter);
  el.addEventListener('mouseleave', leave);
  el.addEventListener('mousemove', move);
  el.addEventListener('focus', focusIn);
  el.addEventListener('blur', leave);

  el.__tooltipHandlers__ = { enter, leave, focusIn, move, value: binding.value, auto, options, key };

  // 值变了但鼠标还在原地（如「显示/隐藏」切换）：直接按新内容重新显示，不留下「要挪开再回来」的空档
  if (wasShowing && el.matches(':hover')) showTooltip(el, options, {}, true);
}

export const vTooltip: Directive<TooltipEl, TooltipValue> = {
  mounted: attach,
  updated: attach,
  unmounted: detach,
};
