/**
 * 系统栏安全区（Android 本地端专用，桌面/Docker 网页端取 0）。
 *
 * 背景：WebView 里 `env(safe-area-inset-*)` 不可靠（实测恒为 0），而 Android 15 起
 * targetSdk 35 强制 edge-to-edge，网页背景会铺到状态栏/导航栏/大屏任务栏后面。
 * 原生侧 `mobile/android/.../SystemBars.java` 把真实尺寸通过 JS 接口交给这里：
 *
 *   window.EngramSystemBars.insets()     同步读一次当前值（页面加载时原生已装好）
 *   window.__engramSystemBars({...})     原生在旋转/折叠/键盘/任务栏变化时回调
 *   window.EngramSystemBars.setDark(bool) 网页把应用主题报给原生，决定系统栏图标明暗
 *
 * 这里把值写进 CSS 变量 `--inset-top/right/bottom/left`（单位 CSS px，原生已按屏幕密度
 * 从物理像素换算过），样式层统一用 `--safe-top/right/bottom/left`
 * （= max(env(...), var(--inset-*))）留白。
 */
import { ref } from 'vue';

export interface SystemInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
  /** 软键盘顶起的高度（原生 ime inset），> 0 时给 <html> 加 kb-open */
  imeBottom: number;
  /** 网页上一次报告的主题：原生据此决定系统栏图标明暗 */
  dark?: boolean;
}

export const ZERO_INSETS: SystemInsets = { top: 0, right: 0, bottom: 0, left: 0, imeBottom: 0 };

/** 最近一次生效的安全区（组件里需要按数值算布局时用，例如阅读器可视高度）。 */
export const systemInsets = ref<SystemInsets>({ ...ZERO_INSETS });

interface NativeBridge {
  insets?: () => string;
  setDark?: (dark: boolean) => void;
}

function nativeBridge(): NativeBridge | null {
  const value = (window as unknown as { EngramSystemBars?: NativeBridge }).EngramSystemBars;
  return value && typeof value === 'object' ? value : null;
}

function normalize(input: Partial<SystemInsets> | null | undefined): SystemInsets {
  const px = (value: unknown) => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0);
  return {
    top: px(input?.top),
    right: px(input?.right),
    bottom: px(input?.bottom),
    left: px(input?.left),
    imeBottom: px(input?.imeBottom),
  };
}

/** 同步读原生当前值；没有原生桥（桌面/网页/Docker）时返回全 0。 */
export function readNativeInsets(): SystemInsets {
  try {
    const raw = nativeBridge()?.insets?.();
    if (typeof raw !== 'string' || raw.length === 0) return { ...ZERO_INSETS };
    return normalize(JSON.parse(raw) as Partial<SystemInsets>);
  } catch {
    return { ...ZERO_INSETS };
  }
}

/** 把安全区写进 CSS 变量（样式层只认 --inset-*，见 styles/main.css 的 --safe-*）。 */
export function applySystemInsets(input: Partial<SystemInsets> | null | undefined): SystemInsets {
  const next = normalize(input);
  const root = document.documentElement;
  root.style.setProperty('--inset-top', `${next.top}px`);
  root.style.setProperty('--inset-right', `${next.right}px`);
  root.style.setProperty('--inset-bottom', `${next.bottom}px`);
  root.style.setProperty('--inset-left', `${next.left}px`);
  // 软键盘弹起：底部固定元素（底部导航/状态胶囊/抽屉底栏）据此降级，别压住光标行
  root.classList.toggle('kb-open', next.imeBottom > 0);
  systemInsets.value = next;
  return next;
}

/** 把应用主题（浅色/深色）报给原生：系统栏图标明暗跟着页面走，并记下来供下次冷启动。 */
export function reportThemeToNative(dark: boolean): void {
  try {
    nativeBridge()?.setDark?.(dark);
  } catch {
    /* 没有原生桥：忽略 */
  }
}

let installed = false;

/** 应用启动时调用一次（main.ts）。桌面/网页端保持现状，不产生额外行为。 */
export function installSystemInsets(): void {
  if (installed) return;
  installed = true;
  (window as unknown as { __engramSystemBars?: (value: unknown) => void }).__engramSystemBars = (value) => {
    applySystemInsets(value as Partial<SystemInsets>);
  };
  applySystemInsets(readNativeInsets());
  // 兜底：宿主没推变化时（老 WebView / 厂商 ROM），旋转或分屏后自己再读一次原生值
  const refresh = () => applySystemInsets(readNativeInsets());
  window.addEventListener('resize', refresh, { passive: true });
  window.addEventListener('orientationchange', refresh, { passive: true });
}
