package com.engram.app;

/**
 * 系统栏策略的纯逻辑：不引用任何 android.* 框架类，因此可以在 JVM 单测里锁住行为
 * （android.* 在本地单测里是 not mocked）。IO 与窗口操作留在 {@link SystemBars}。
 */
public final class SystemBarPolicy {

    private SystemBarPolicy() {
    }

    /** 浅色底配深色图标：dark=false → 系统栏图标用深色（light=true）。 */
    public static boolean useLightIcons(boolean dark) {
        return !dark;
    }

    /**
     * API 26 以下系统不认识「导航栏浅色图标」：透明导航栏会变成深底上的黑图标（看不见），
     * 这些版本退化成深色蒙层 + 系统默认图标。
     */
    public static boolean needsNavigationBarScrim(int sdkInt) {
        return sdkInt < 26;
    }

    /**
     * 物理像素 → CSS 像素（dp）。Android 的 WindowInsets 给的是物理像素，而网页的
     * `--inset-*` 是 CSS 像素（WebView 里 1 CSS px = 1 dp，前提是 viewport 用
     * `width=device-width, initial-scale=1`）：不换算就把 137px 的导航栏写成 137 CSS px，
     * 底部整整多留出两倍多的空白（实测密度 2.4375 的折叠屏上底部让位会虚增 197px）。
     */
    public static int toCssPx(int px, float density) {
        if (density <= 0f) return Math.max(0, px);
        return Math.max(0, Math.round(px / density));
    }

    /**
     * 交给网页的 insets JSON（单位：CSS px）。字段名与 `web/src/lib/systemInsets.ts` 的
     * SystemInsets 一一对应，网页侧用 CSS 变量给可点击内容留白
     * （WebView 里 env(safe-area-inset-*) 不可靠）。
     * 负值没有意义（insets 不该为负），统一收敛到 0。
     */
    public static String insetsJson(int top, int right, int bottom, int left, int imeBottom, boolean dark) {
        return "{\"top\":" + Math.max(0, top)
                + ",\"right\":" + Math.max(0, right)
                + ",\"bottom\":" + Math.max(0, bottom)
                + ",\"left\":" + Math.max(0, left)
                + ",\"imeBottom\":" + Math.max(0, imeBottom)
                + ",\"dark\":" + dark + "}";
    }
}
