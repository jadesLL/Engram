/**
 * 浮层「点外面关闭」统一实现。
 *
 * 为什么不用遮罩上的 @click.self：
 *  - 悬浮卡片（Agent 对话 / 图片资产 / 同步详情）没有遮罩，正文照常可点，
 *    需要一个 document 级的「外面」判定；
 *  - 多张浮层可能同时打开（对话卡片 + 同步详情），一次点击只应关掉视觉上最上面那张，
 *    否则会把下面几张一起带掉。
 *
 * 用 pointerdown（捕获阶段）而不是 click：
 *  - 比 click 早一拍，点在浮层外时先收浮层，不再触发底下的行/按钮；
 *  - 触屏、鼠标、笔都走同一套事件（click 依赖合成事件，个别层级会被 preventDefault 吞掉）。
 *
 * 与模态层的关系：页面里一旦有模态遮罩/对话框（AppModal、编辑器 AI 对话框、原生 <dialog>、
 * 手机底部弹层……）在场，说明用户正在跟更上层打交道，悬浮卡片**不抢**这次点外关闭——
 * 否则点一下模态遮罩会把「模态 + 卡片」两层一起关掉。上层自己收口后，下一次点击才轮到卡片。
 *
 * 标记 `data-overlay-keep` 的元素（Teleport 到 body 的下拉菜单、右键菜单、通知栈等）视为
 * 浮层的一部分：点它们不触发卡片的点外关闭。
 */

import { onBeforeUnmount, watch } from 'vue';

interface OverlayLayer {
  id: symbol;
  /** 视觉层级：数字大的在上面（与 z-index 同向）；同优先级后打开的在上面 */
  priority: number;
}

/** 按优先级降序排列，多层浮层里只有最上面那层响应 */
const layers: OverlayLayer[] = [];

/**
 * 模态层选择器：存在任意一个就说明有比悬浮卡片更上层的交互面。
 * 新增遮罩/对话框时记得补进来，否则点它的遮罩会把下面的悬浮卡片一起关掉。
 */
const MODAL_LAYER_SELECTOR = [
  '.app-modal-mask',
  '.ai-mask',
  '.settings-search-mask',
  '.settings-mask',
  '.outline-mask',
  '.fmt-mask',
  '.insert-mask',
  '.ai-menu-mask',
  '.vi-mask',
  '.context-menu-mask',
  '.new-mask',
  '.more-mask',
  '.rel-mask',
  '.mi-dim',
  '.mask',
  '.detail-backdrop',
  '.asset-preview',
  '.update-overlay',
  '.qr-scanner',
  'dialog[open]',
].join(',');

/**
 * 属于浮层自己的弹出件：Teleport 到 body 的下拉菜单、右键菜单、通知条。
 * 只做「点到的元素或其祖先」判断——这类组件有的常驻 DOM（通知栈），不能按「存在即算」。
 */
const KEEP_SELECTOR = '[data-overlay-keep]';

function register(id: symbol, priority: number): void {
  unregister(id);
  let index = 0;
  while (index < layers.length && layers[index].priority >= priority) index += 1;
  layers.splice(index, 0, { id, priority });
}

function unregister(id: symbol): void {
  const index = layers.findIndex((layer) => layer.id === id);
  if (index >= 0) layers.splice(index, 1);
}

export interface DismissOnOutsideOptions {
  /** 浮层是否打开（响应式 getter） */
  open: () => boolean;
  /** 浮层根元素；指针落在它内部不算「外面」 */
  root: () => HTMLElement | null | undefined;
  /** 关闭回调 */
  close: () => void;
  /** 与 z-index 同向的层级：数字大的先收到「点外关闭」，默认 0 */
  priority?: () => number;
  /** 额外视为「里面」的节点（Teleport 出去、但语义上属于本层的子面板） */
  inside?: () => Array<HTMLElement | null | undefined>;
}

export function useDismissOnOutside(options: DismissOnOutsideOptions): void {
  const id = Symbol('overlay-layer');

  function sync(open: boolean, priority: number): void {
    if (!open) {
      unregister(id);
      return;
    }
    register(id, priority);
  }

  function onPointerDown(event: PointerEvent): void {
    // 只认主键（触屏 / 笔的 pointerdown 也是 0）；右键留给上下文菜单
    if (event.button !== 0) return;
    if (!layers.length || layers[0].id !== id) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    // 上层还有模态/菜单：这次点击归它们收口
    if (target instanceof Element && target.closest(KEEP_SELECTOR)) return;
    if (document.querySelector(MODAL_LAYER_SELECTOR)) return;
    if (options.root()?.contains(target)) return;
    for (const el of options.inside?.() ?? []) {
      if (el?.contains(target)) return;
    }
    options.close();
  }

  watch(
    () => [options.open(), options.priority?.() ?? 0] as const,
    ([open, priority]) => sync(open, priority),
    { immediate: true },
  );

  document.addEventListener('pointerdown', onPointerDown, true);
  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    unregister(id);
  });
}
