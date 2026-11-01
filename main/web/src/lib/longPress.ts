/**
 * 触屏长按（安卓交互统一入口，2026-11 知识库目录整改）。
 *
 * 桌面端用右键菜单 / hover 图标；触屏没有这些，行内多选改成「长按 500ms 进入选择态」，
 * 与收集箱卡片、聊天会话的长按手势同一套时长。判定只在这里做一次，PageRow / FileRow 共用：
 *  - 只认触摸/触控笔指针（pointerType === 'mouse' 直接放过，桌面右键菜单完全不受影响）；
 *  - 移动超过 tolerance 视为滚动，立即取消（否则滑列表会误触多选）；
 *  - 长按触发后返回 consumeClick()=true，调用方在 click 里吞掉那一次「松手点击」，
 *    否则刚进选择态就被下一次 click 取消。
 */

export interface LongPressPoint {
  clientX: number;
  clientY: number;
}

export interface LongPressStart extends LongPressPoint {
  pointerType?: string;
  button?: number;
}

export interface LongPressController {
  start(event: LongPressStart): void;
  move(event: LongPressPoint): void;
  end(): void;
  /** 长按已触发时消费掉紧随其后的 click，返回 true 表示这次点击要忽略 */
  consumeClick(): boolean;
}

export interface LongPressOptions {
  /** 触发时长（毫秒），默认与收集箱 / 会话长按一致 */
  delayMs?: number;
  /** 手指位移超过这个距离就放弃（视为滚动） */
  tolerance?: number;
  onLongPress: () => void;
}

export function createLongPress(options: LongPressOptions): LongPressController {
  const delayMs = options.delayMs ?? 500;
  const tolerance = options.tolerance ?? 10;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startX = 0;
  let startY = 0;
  let fired = false;
  let pressed = false;

  function clear() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pressed = false;
  }

  return {
    start(event) {
      if (event.pointerType === 'mouse' || (event.button ?? 0) !== 0) return;
      clear();
      fired = false;
      pressed = true;
      startX = event.clientX;
      startY = event.clientY;
      timer = setTimeout(() => {
        timer = null;
        if (!pressed) return;
        fired = true;
        options.onLongPress();
      }, delayMs);
    },
    move(event) {
      if (!timer) return;
      if (Math.abs(event.clientX - startX) > tolerance || Math.abs(event.clientY - startY) > tolerance) clear();
    },
    end() {
      clear();
    },
    consumeClick() {
      if (!fired) return false;
      fired = false;
      return true;
    },
  };
}
