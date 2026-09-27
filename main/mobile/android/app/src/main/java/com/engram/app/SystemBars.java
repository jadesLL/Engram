package com.engram.app;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

/**
 * 系统栏（状态栏 / 导航栏 / 大屏任务栏）适配。
 *
 * 背景：旧实现靠 values-v35 的 {@code windowOptOutEdgeToEdgeEnforcement} 退出 edge-to-edge，
 * 于是 Android 15 用主题默认色（AppCompat DayNight 的 colorPrimaryDark，即黑色）铺满
 * 状态栏和导航栏——浅色界面上下各挂一条黑带，用户报的「任务栏一直是黑色，融入不进去」。
 *
 * 现在改成真 edge-to-edge：
 *  1. 系统栏透明，页面背景一直延伸到屏幕边缘（状态栏区域显示的就是应用自己的底色）；
 *  2. 状态栏/导航栏图标明暗跟随**应用主题**（网页通过 {@link InsetsBridge#setDark} 报告），
 *     而不是跟随系统深色开关——应用内切成浅色、系统是深色时也不会出现白字白底；
 *  3. WebView 里的 {@code env(safe-area-inset-*)} 在 Android WebView 上不可靠（实测为 0），
 *     所以把系统栏尺寸通过 JS 接口 + {@code window.__engramSystemBars()} 交给网页，
 *     网页用 CSS 变量给可点击内容留白（见 web/src/lib/systemInsets.ts）。
 */
public class SystemBars {

    private static final String PREFS = "engram-system-bars";
    private static final String KEY_DARK = "dark";

    private final Activity activity;
    private final WebView webView;
    private final SharedPreferences preferences;
    /** 屏幕密度：WindowInsets 是物理像素，交网页前要换算成 CSS 像素（dp） */
    private final float density;

    private volatile int top;
    private volatile int bottom;
    private volatile int left;
    private volatile int right;
    private volatile int imeBottom;
    private volatile boolean dark;

    public SystemBars(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        this.preferences = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        this.density = activity.getResources().getDisplayMetrics().density;
        // 冷启动先用上次网页报告的主题兜底，避免「浅色页面 + 白色状态栏图标」的瞬间反色
        this.dark = preferences.getBoolean(KEY_DARK, isSystemDark());
    }

    public boolean isDark() {
        return dark;
    }

    private boolean isSystemDark() {
        int mode = activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return mode == Configuration.UI_MODE_NIGHT_YES;
    }

    /** 透明系统栏 + 内容铺到屏幕边缘。必须在设置 WebView 之后、加载页面前调用。 */
    public void install() {
        Window window = activity.getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.setStatusBarColor(Color.TRANSPARENT);
        // API 26 以下不支持导航栏浅色图标：透明会变成「深底 + 黑图标」，退化成深色蒙层
        window.setNavigationBarColor(SystemBarPolicy.needsNavigationBarScrim(Build.VERSION.SDK_INT)
                ? 0x99000000
                : Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // 关掉系统给导航栏/状态栏铺的半透明蒙层：否则浅色底上仍是一条灰带
            window.setNavigationBarContrastEnforced(false);
            window.setStatusBarContrastEnforced(false);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && Build.VERSION.SDK_INT < 35) {
            // 刘海/挖孔屏也让它铺满（API 35 起 edge-to-edge 默认就是 ALWAYS，无需再设）
            WindowManager.LayoutParams attributes = window.getAttributes();
            attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(attributes);
        }
        applyIconAppearance();

        View decor = window.getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(decor, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            /*
             * 底部只报系统栏：软键盘高度单独用 imeBottom 传给网页（网页据此加 html.kb-open）。
             * 不能把 ime 并进 bottom —— activity 是 adjustResize + 网页 viewport 带
             * interactive-widget=resizes-content，键盘弹起时布局视口本来就缩了，
             * 再把 800px 当成安全区会把底部导航整条推到屏幕中间。
             */
            update(bars.left, bars.top, bars.right, bars.bottom, ime.bottom);
            // 不消费：网页自己按 CSS 变量留白，系统栏区域继续显示页面背景
            return insets;
        });
        webView.addJavascriptInterface(new InsetsBridge(), "EngramSystemBars");
    }

    private void applyIconAppearance() {
        Window window = activity.getWindow();
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        // 浅色底配深色图标：dark=false 时状态栏/导航栏图标转深色（跟随网页报告的应用主题）
        boolean lightIcons = SystemBarPolicy.useLightIcons(dark);
        controller.setAppearanceLightStatusBars(lightIcons);
        controller.setAppearanceLightNavigationBars(lightIcons);
    }

    /** 入参是 WindowInsets 的物理像素，存下来的是给网页用的 CSS 像素。 */
    private void update(int leftPx, int topPx, int rightPx, int bottomPx, int imePx) {
        int left = SystemBarPolicy.toCssPx(leftPx, density);
        int top = SystemBarPolicy.toCssPx(topPx, density);
        int right = SystemBarPolicy.toCssPx(rightPx, density);
        int bottom = SystemBarPolicy.toCssPx(bottomPx, density);
        int imeBottom = SystemBarPolicy.toCssPx(imePx, density);
        boolean changed = left != this.left || top != this.top || right != this.right
                || bottom != this.bottom || imeBottom != this.imeBottom;        this.left = left;
        this.top = top;
        this.right = right;
        this.bottom = bottom;
        this.imeBottom = imeBottom;
        if (changed) push();
    }

    /** 把当前系统栏尺寸推给网页（页面就绪后、旋转/折叠/键盘/任务栏变化时都会调到）。 */
    public void push() {
        final String json = insetsJson();
        webView.post(() -> {
            try {
                webView.evaluateJavascript("window.__engramSystemBars&&window.__engramSystemBars(" + json + ")", null);
            } catch (Throwable ignored) {
                // 页面还没起来时 evaluateJavascript 可能抛错：下次 insets 变化会再推一次
            }
        });
    }

    private String insetsJson() {
        return SystemBarPolicy.insetsJson(top, right, bottom, left, imeBottom, dark);
    }

    /** 网页报告当前主题：系统栏图标颜色跟着页面走，并记住供下次冷启动使用。 */
    private void reportDark(boolean value) {
        if (this.dark == value) return;
        this.dark = value;
        preferences.edit().putBoolean(KEY_DARK, value).apply();
        activity.runOnUiThread(() -> {
            applyIconAppearance();
            push();
        });
    }

    /** 暴露给网页的桥：同步读一次尺寸，之后按主题变化回调。 */
    public class InsetsBridge {

        @JavascriptInterface
        public String insets() {
            return insetsJson();
        }

        @JavascriptInterface
        public void setDark(boolean value) {
            reportDark(value);
        }
    }
}
