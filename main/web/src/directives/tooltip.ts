/**
 * v-tooltip 指令：为元素附加全局自建提示（替代系统原生 title）。
 *
 * 用法：
 *   <button v-tooltip="'保存'">…</button>                     只有正文
 *   <span v-tooltip.auto="file.name">…</span>                 仅在文本被截断时显示
 *   <button v-tooltip.bottom="'说明'">…</button>              指定首选方向（top/bottom/left/right）
 *   <button v-tooltip.cursor="'节点'">…</button>              光标跟随（图谱 / 画布等大块区域）
 *   <button v-tooltip.near="{ title, body }">…</button>       就近优先（首选方向优先，允许轻微遮挡）
 *   <button v-tooltip.strict.spotlight="{…}">…</button>       严格零遮挡 + 聚光
 *   <button v-tooltip="{ title: '保存', body: '写回磁盘', kbd: 'Ctrl+S' }">…</button>
 *
 * 修饰符可组合：v-tooltip.auto.bottom
 * 对象值支持 title / body / kbd / meta / placement / strategy / strict / spotlight / pointer / anchorRect / delay。
 *
 * 第三方库自己生成的 DOM（Vditor 工具栏等）拿不到指令，用 bindDelegatedTooltips() 按选择器委托绑定。
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

/**
 * 委托式绑定：容器内所有匹配选择器的元素自动获得自建提示，之后动态插入的也一并覆盖。
 *
 * 给第三方库直接生成 DOM 的界面用（Vditor 工具栏 / 面板按钮），那里挂不上 Vue 指令；
 * 事件挂在容器上，靠 mouseover/mouseout 的冒泡找出真正命中的元素，因此不必观察 DOM 变化。
 *
 * @param root     容器元素
 * @param selector 命中选择器（应带 aria-label 或 data-tip 之类可取文案的属性）
 * @param resolve  取提示内容；返回空串/null 表示这个元素不显示提示（默认读 aria-label）
 * @param resolveOptions 取提示选项（方向、策略等）
 * @returns 解绑函数
 */
export function bindDelegatedTooltips(
  root: HTMLElement,
  selector: string,
  resolve: (el: HTMLElement) => TooltipValue | null = (el) => el.getAttribute('aria-label') || '',
  resolveOptions: (el: HTMLElement) => TooltipOptions = () => ({}),
): () => void {
  let current: HTMLElement | null = null;

  /** 事件目标向上找到容器内的命中元素（svg 里的 path 也算在按钮上） */
  const hit = (node: EventTarget | null): HTMLElement | null => {
    if (!(node instanceof Element)) return null;
    const el = node.closest<HTMLElement>(selector);
    return el && root.contains(el) ? el : null;
  };

  const onOver = (event: Event) => {
    const el = hit(event.target);
    if (!el || el === current) return;
    current = el;
    // 触屏（无 hover）：tap 触发的 mouseover 不弹提示
    if (window.matchMedia('(hover: none)').matches) return;
    const value = resolve(el);
    if (!value) return;
    showTooltip(el, value, resolveOptions(el));
  };

  const onOut = (event: MouseEvent) => {
    const el = hit(event.target);
    if (!el || el !== current) return;
    // 元素内部移动（button → svg → path）不算离开
    if (hit(event.relatedTarget) === el) return;
    current = null;
    hideTooltip(el);
  };

  // 键盘可达：focus 立即显示（不等待延迟），blur 收起
  const onFocusIn = (event: Event) => {
    const el = hit(event.target);
    if (!el) return;
    current = el;
    const value = resolve(el);
    if (value) showTooltip(el, value, resolveOptions(el), true);
  };

  const onFocusOut = (event: FocusEvent) => {
    const el = hit(event.target);
    if (!el || el !== current) return;
    current = null;
    hideTooltip(el);
  };

  root.addEventListener('mouseover', onOver);
  root.addEventListener('mouseout', onOut);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('focusout', onFocusOut);

  return () => {
    root.removeEventListener('mouseover', onOver);
    root.removeEventListener('mouseout', onOut);
    root.removeEventListener('focusin', onFocusIn);
    root.removeEventListener('focusout', onFocusOut);
    if (current) hideTooltip(current);
    current = null;
  };
}
