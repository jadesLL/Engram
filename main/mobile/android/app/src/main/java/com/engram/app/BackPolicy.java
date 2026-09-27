package com.engram.app;

/**
 * 返回键 / 侧滑返回的判定（纯逻辑，便于 JVM 单测锁回归）。
 *
 * 起因：旧实现只看 {@code WebView.canGoBack()}，而 SPA 的抽屉、沉浸阅读、弹层都不占历史，
 * 首页还残留「正在启动本地知识库…」占位页那一格历史 → 侧滑要么退回空白死页，要么直接
 * 把应用退到后台，用户的感觉就是「侧滑不是返回」。
 */
public final class BackPolicy {

    private BackPolicy() {
    }

    public enum Action {
        /** 网页自己的返回栈消费了这一层（关抽屉/关面板/退出阅读态） */
        WEB,
        /** 交给 WebView 历史后退 */
        HISTORY,
        /** 历史到头：退到后台（不销毁 Activity，保留登录态） */
        BACKGROUND
    }

    /**
     * @param webConsumed 网页 {@code window.__engramHandleBack()} 是否返回了 true
     * @param canGoBack   WebView 是否还有上一页
     */
    public static Action decide(boolean webConsumed, boolean canGoBack) {
        if (webConsumed) return Action.WEB;
        return canGoBack ? Action.HISTORY : Action.BACKGROUND;
    }
}
