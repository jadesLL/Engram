/**
 * 安卓「返回键 / 侧滑返回」的统一入口。
 *
 * 原生侧（`mobile/android/.../MainActivity.java`）在系统 back（含屏幕边缘侧滑手势）时
 * 先调用 `window.__engramHandleBack()`：
 *   - 返回 true：网页自己吃掉了这一层（关抽屉、关弹层、退出阅读态、回上一层……）
 *   - 返回 false：交回原生（WebView 历史后退，历史到头才退到后台）
 *
 * 约定：后注册的先处理（与浮层叠放顺序一致）。浮层组件在打开时注册、关闭时注销，
 * 于是「组件挂载 == 这一层存在」，不需要额外的开关状态。
 * 桌面端与 Docker 网页端不会触发这个钩子，注册的处理器闲置，不影响原有行为。
 */
export type BackHandler = () => boolean;

const handlers: BackHandler[] = [];

/** 注册一层返回处理；返回值是注销函数（组件卸载时调用）。 */
export function registerBackHandler(handler: BackHandler): () => void {
  handlers.push(handler);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const index = handlers.indexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  };
}

/** 从栈顶往下问，第一个认领的生效。 */
export function handleBack(): boolean {
  for (let index = handlers.length - 1; index >= 0; index -= 1) {
    try {
      if (handlers[index]()) return true;
    } catch {
      // 单个处理器的异常不该拦住下面的层：继续试更底层
    }
  }
  return false;
}

let installed = false;

/** 应用启动时调用一次（main.ts）。 */
export function installBackHandler(): void {
  if (installed) return;
  installed = true;
  (window as unknown as { __engramHandleBack?: () => boolean }).__engramHandleBack = handleBack;
}

/** 只用到 router.back()，避免把 vue-router 的类型依赖带进这个纯工具模块 */
interface BackCapableRouter {
  back: () => void;
}

/**
 * 「上一页」这一层：安卓 WebView 的 `canGoBack()` 不认 SPA 的 pushState
 * （vue-router 每次跳转只改 same-document 历史，实测原生拿到 false），
 * 于是旧版一按返回就把应用退到后台，用户的感觉正是「侧滑不是返回」。
 * 所以路由回退必须由网页自己走 `router.back()`：
 *   - history.state.back 有值时 = 应用内还有上一页 → 网页消费掉这一层
 *   - 没有上一页（停在应用根路径）= 交回原生（退到后台），符合安卓习惯
 * 注册得最早 → 优先级最低，浮层/抽屉/阅读面板先各自消费。
 */
export function installRouterBack(router: BackCapableRouter): () => void {
  return registerBackHandler(() => {
    const state = window.history.state as { back?: string | null } | null;
    if (!state || !state.back) return false;
    router.back();
    return true;
  });
}
