import { reactive } from 'vue';

/**
 * 整页缩放（Ctrl + 滚轮）。
 *
 * 为什么缩放走桌面壳而不是 CSS zoom：整页缩放必须同时改变 CSS 视口宽度，
 * 页面的 640/768/1024 断点、window.innerWidth、媒体查询才会跟着一致地切换；
 * 只对某个容器写 CSS `zoom` 时媒体查询仍按物理窗口宽度判断，宽屏会被挤成
 * 「桌面三栏塞进窄容器」——所以真正的缩放由主进程 `webContents.setZoomFactor`
 * 执行（见 desktop/main.js），本模块只负责手势、档位、提示与记忆读回。
 *
 * 无桌面桥（Docker 浏览器 / Android WebView）时完全不接管 Ctrl+滚轮：
 * 浏览器原生缩放本来就是正确的整页缩放，再 preventDefault 只会把原生行为弄坏。
 */

/** 缩放档位：每格滚轮走一档；下限 50%，上限 200% */
export const UI_ZOOM_STEPS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export const UI_ZOOM_MIN = UI_ZOOM_STEPS[0];
export const UI_ZOOM_MAX = UI_ZOOM_STEPS[UI_ZOOM_STEPS.length - 1];

/** 缩放结束后右上角提示保留多久（用户口径：1.5 秒后自动消失） */
export const UI_ZOOM_HINT_MS = 1500;

/**
 * 累计多少 deltaY 走一档。
 * 鼠标滚轮一格通常是 100（deltaMode=0 像素）/ 3 行（deltaMode=1）；
 * 触控板双指捏合会连续发小 delta，必须累计到阈值才走档，否则会连跳十几档。
 */
export const UI_ZOOM_WHEEL_STEP = 100;

export interface UiZoomBridge {
  getUiZoom?: () => Promise<number>;
  setUiZoom?: (factor: number) => Promise<number>;
}

export const uiZoomState = reactive({
  /** 有桌面桥才接管 Ctrl + 滚轮；无桥时交给浏览器原生缩放 */
  supported: false,
  /** 右上角提示是否可见（缩放停止 1.5 秒后自动消失） */
  visible: false,
  /** 当前缩放系数（1 = 100%） */
  factor: 1,
});

function zoomBridge(): Required<UiZoomBridge> | null {
  const desktop = (window as any).wikiDesktop as UiZoomBridge | undefined;
  if (!desktop) return null;
  if (typeof desktop.getUiZoom !== 'function' || typeof desktop.setUiZoom !== 'function') return null;
  return desktop as Required<UiZoomBridge>;
}

export function clampUiZoom(factor: number): number {
  if (!Number.isFinite(factor)) return 1;
  // 主进程按两位小数保存；这里同样归一，避免 IPC 往返出现 1.2500000001
  const rounded = Math.round(factor * 100) / 100;
  return Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, rounded));
}

export function zoomPercent(factor: number): number {
  return Math.round(clampUiZoom(factor) * 100);
}

/** 从当前档位往方向走一格：+1 放大，-1 缩小；已在端点则停在端点 */
export function stepUiZoom(current: number, direction: 1 | -1): number {
  const value = clampUiZoom(current);
  if (direction > 0) {
    return UI_ZOOM_STEPS.find((step) => step > value + 1e-6) ?? UI_ZOOM_MAX;
  }
  for (let i = UI_ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
    const step = UI_ZOOM_STEPS[i];
    if (step < value - 1e-6) return step;
  }
  return UI_ZOOM_MIN;
}

let hideTimer: ReturnType<typeof setTimeout> | null = null;
let wheelAccumulator = 0;
let wheelIdleTimer: ReturnType<typeof setTimeout> | null = null;
let applySeq = 0;

/**
 * 桌面标题栏反缩放：Windows 原生窗口按钮不随页面缩放，融合标题栏与内容留白
 * 要按 1/z 抵消（见 main.css 的 html.desktop-frame.ui-zoomed），否则 150% 时
 * 标题栏变 54 物理像素、按钮还是 36，错位一眼可见。100% 时移除，不留痕迹。
 */
function syncZoomCssVars(factor: number) {
  const root = document.documentElement;
  if (Math.abs(factor - 1) < 0.001) {
    root.classList.remove('ui-zoomed');
    root.style.removeProperty('--ui-zoom-inverse');
    return;
  }
  root.classList.add('ui-zoomed');
  root.style.setProperty('--ui-zoom-inverse', String(Math.round((1 / factor) * 10000) / 10000));
}

function showHint(factor: number) {
  uiZoomState.factor = clampUiZoom(factor);
  syncZoomCssVars(uiZoomState.factor);
  uiZoomState.visible = true;
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    uiZoomState.visible = false;
  }, UI_ZOOM_HINT_MS);
}

/** 应用缩放：主进程负责持久化 + webContents 缩放，返回值是最终生效的系数 */
function applyUiZoom(factor: number) {
  const bridge = zoomBridge();
  const next = clampUiZoom(factor);
  // 先乐观更新，滚轮连发时下一档从新值继续走，不依赖 IPC 往返时序
  showHint(next);
  if (!bridge) return;
  const seq = ++applySeq;
  bridge
    .setUiZoom(next)
    .then((applied) => {
      // 只认最后一次请求的返回值；前面的响应晚到不能把百分比改回去
      if (seq === applySeq && Number.isFinite(applied)) {
        uiZoomState.factor = clampUiZoom(applied);
        syncZoomCssVars(uiZoomState.factor);
      }
    })
    .catch(() => {
      /* 主进程异常时保留乐观值：提示已经显示，用户可再滚一格或点重置重试 */
    });
}

/** 重置到 100%（右上角提示里的「重置」按钮 / Ctrl+0） */
export function resetUiZoom() {
  applyUiZoom(1);
}

/**
 * 安装全局手势。返回卸载函数（App 卸载时清监听与定时器）。
 * 只监听 window 捕获阶段：图片查看器 / 图谱自己处理的是不带 Ctrl 的滚轮，
 * 带 Ctrl 的整页缩放优先，stopPropagation 防止两边同时缩放。
 */
export function installUiZoom(): () => void {
  const bridge = zoomBridge();
  if (!bridge) return () => {};
  uiZoomState.supported = true;
  // 记忆值由主进程在窗口创建时应用；这里读回来只是为了第一次滚轮从正确档位继续
  bridge
    .getUiZoom()
    .then((saved) => {
      if (Number.isFinite(saved)) {
        uiZoomState.factor = clampUiZoom(saved);
        syncZoomCssVars(uiZoomState.factor);
      }
    })
    .catch(() => {});

  const onWheel = (event: WheelEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (!event.deltaY) return;
    event.preventDefault();
    event.stopPropagation();
    // deltaMode：0=像素、1=行、2=页；统一换算成像素再累计
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1;
    const delta = event.deltaY * unit;
    if (Math.sign(delta) !== Math.sign(wheelAccumulator)) wheelAccumulator = 0;
    wheelAccumulator += delta;

    // 一次事件最多走 3 档，异常大的 delta（部分驱动/远程桌面）不会从 100% 直接跳到 200%
    let guard = 0;
    while (Math.abs(wheelAccumulator) >= UI_ZOOM_WHEEL_STEP && guard < 3) {
      // 滚轮向上（deltaY < 0）= 放大，和浏览器 Ctrl+滚轮 / 看图组件的方向一致
      const sign = wheelAccumulator < 0 ? -1 : 1;
      wheelAccumulator -= sign * UI_ZOOM_WHEEL_STEP;
      applyUiZoom(stepUiZoom(uiZoomState.factor, sign < 0 ? 1 : -1));
      guard += 1;
    }

    // 停手 250ms 清掉余量：下一次手势从干净状态开始，不会因为「上次差 10」突然跳档
    if (wheelIdleTimer) clearTimeout(wheelIdleTimer);
    wheelIdleTimer = setTimeout(() => {
      wheelIdleTimer = null;
      wheelAccumulator = 0;
    }, 250);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key !== '0') return;
    event.preventDefault();
    event.stopPropagation();
    resetUiZoom();
  };

  window.addEventListener('wheel', onWheel, { passive: false, capture: true });
  window.addEventListener('keydown', onKeyDown, true);

  return () => {
    window.removeEventListener('wheel', onWheel, true);
    window.removeEventListener('keydown', onKeyDown, true);
    if (hideTimer) clearTimeout(hideTimer);
    if (wheelIdleTimer) clearTimeout(wheelIdleTimer);
    hideTimer = null;
    wheelIdleTimer = null;
    wheelAccumulator = 0;
    uiZoomState.visible = false;
  };
}
