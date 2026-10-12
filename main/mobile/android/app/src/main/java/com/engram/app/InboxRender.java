package com.engram.app;

import android.app.Activity;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 收集箱「渲染后抓取」（安卓端）。
 *
 * 背景：服务端抓网页不执行脚本，正文由 JavaScript 渲染的页面（多数分享页与单页应用）只能
 * 拿到空壳，服务端会以 needs-render 明确拒绝（见 server/src/lib/inboxWebFetch.ts）。手机端
 * 自带 WebView，可以把页面渲染出来再取 HTML——结果与「浏览器另存为网页」等价，存进收集箱。
 *
 * 与网页的契约（{@code web/src/lib/inboxRender.ts}）：
 *  - {@code window.EngramInboxRender.render(requestId, url)} → 开始渲染；
 *  - 结果经 {@code window.__engramInboxRenderResult(requestId, payload)} 回给网页，
 *    payload 为 {@code {"ok":true,"html":…,"title":…,"url":…}} 或 {@code {"ok":false,"error":…}}。
 *
 * 实现要点：用一棵**离屏 WebView**（1×1、alpha 0、挂在当前 Activity 的根视图上——不挂载的
 * WebView 不跑渲染与定时器）加载页面，轮询 body 可见文字长度，连续两次达到阈值后取
 * outerHTML；整段有 45 秒上限，结束（成功/失败/超时）都把离屏视图拆掉，不留后台页面。
 */
public class InboxRender {

    private static final String TAG = "EngramInboxRender";
    private static final String BRIDGE_NAME = "EngramInboxRender";
    /** 正文至少要带来这么多可见文字，才算渲染出来了（壳页的导航/页脚一加载就在，实测 238 字符） */
    private static final int CONTENT_GROWTH = 200;
    /** 基线（壳页自带文字）至少要这么多字符才值得信任；页面还没挂出来时先别把 0 当基线 */
    private static final int MIN_BASELINE_TEXT = 50;
    /** 等基线的宽限：页面迟迟不吐一个字（异常页面）也照常往下走 */
    private static final long BASELINE_GRACE_MS = 3_000;
    /** 等正文的上限；到这还没长出来就先取快照，由服务端按「渲染后仍没有正文」如实报错 */
    private static final long CONTENT_WAIT_MS = 12_000;
    private static final long POLL_MS = 400;
    private static final long TIMEOUT_MS = 45_000;

    private static final String TEXT_LENGTH_JS =
            "document.body ? document.body.innerText.replace(/\\s+/g, \"\").length : 0";
    private static final String SNAPSHOT_JS =
            "(function(){try{return JSON.stringify({html:document.documentElement?document.documentElement.outerHTML:\"\","
                    + "title:document.title||\"\",url:location.href})}catch(e){return \"\"}})()";

    private final Activity activity;
    private final WebView shellWebView;
    private final Handler handler = new Handler(Looper.getMainLooper());

    /** 同一时刻只渲一个页面：网页端一次只抓一条链接，离屏视图也就只该有一个 */
    private WebView offscreen;

    public InboxRender(Activity activity, WebView shellWebView) {
        this.activity = activity;
        this.shellWebView = shellWebView;
    }

    /** 装 JS 桥；必须在加载页面之前调用（与系统栏、系统解锁同一个时机）。 */
    public void install() {
        shellWebView.addJavascriptInterface(new Bridge(), BRIDGE_NAME);
    }

    private final class Bridge {
        @JavascriptInterface
        public void render(String requestId, String url) {
            handler.post(() -> start(requestId == null ? "" : requestId, url == null ? "" : url));
        }
    }

    private void start(String requestId, String url) {
        if (requestId.isEmpty()) return;
        Uri parsed = Uri.parse(url);
        String scheme = parsed.getScheme() == null ? "" : parsed.getScheme().toLowerCase();
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            reply(requestId, errorPayload("只支持 http/https 网页地址"));
            return;
        }
        if (offscreen != null) {
            reply(requestId, errorPayload("上一个页面还在渲染，请稍后再试"));
            return;
        }
        // 有活干才带 WebView 初始化；离屏视图用完即拆，长期只保留壳里那一个
        final WebView view = new WebView(activity);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUserAgentString(shellWebView.getSettings().getUserAgentString());
        view.setBackgroundColor(0);
        view.setAlpha(0f);
        view.setWebViewClient(new WebViewClient());
        ViewGroup root = activity.findViewById(android.R.id.content);
        root.addView(view, new ViewGroup.LayoutParams(1, 1));
        offscreen = view;

        final long deadline = android.os.SystemClock.uptimeMillis() + TIMEOUT_MS;
        final long contentDeadline = android.os.SystemClock.uptimeMillis() + CONTENT_WAIT_MS;
        final long baselineDeadline = android.os.SystemClock.uptimeMillis() + BASELINE_GRACE_MS;
        view.loadUrl(url);
        awaitContent(requestId, view, url, -1, 1, contentDeadline, baselineDeadline, deadline);
    }

    /**
     * 轮询可见文字长度：基线 = 页面挂出来之后自带的可见文字（导航/页脚），正文要把它顶起来一截才算
     * 渲染完（不能只看「有没有文字」——壳页的导航/页脚会骗过判据）；基线自身也要等页面吐字
     *（loadUrl 刚返回时 body 可能还没就绪，0 不能当基线）。
     * 第一轮没等到正文就重载一次（有些站点要等会话建立后第二次访问才给正文，重载用同一份
     * CookieManager，正是浏览器的做法）；再没有就取快照，由服务端如实报「渲染后仍没有正文」。
     */
    private void awaitContent(String requestId, WebView view, String originalUrl, double baseline, int round,
                              long contentDeadline, long baselineDeadline, long deadline) {
        if (view != offscreen) return; // 已被收尾（超时或 Activity 退出）
        long now = android.os.SystemClock.uptimeMillis();
        if (now > deadline) {
            finish(requestId, view, errorPayload("页面渲染超时（45 秒内没有等到正文）"));
            return;
        }
        if (now >= contentDeadline) {
            if (round < 2) {
                view.loadUrl(originalUrl);
                awaitContent(requestId, view, originalUrl, -1, round + 1,
                        android.os.SystemClock.uptimeMillis() + CONTENT_WAIT_MS,
                        android.os.SystemClock.uptimeMillis() + BASELINE_GRACE_MS, deadline);
                return;
            }
            snapshot(requestId, view, originalUrl);
            return;
        }
        view.evaluateJavascript(TEXT_LENGTH_JS, value -> {
            if (view != offscreen) return;
            double length = 0;
            try {
                length = Double.parseDouble(value == null ? "0" : value.replace("\"", ""));
            } catch (NumberFormatException ignored) {
                // 页面正在跳转时拿不到数字，按「还没好」处理
            }
            // 只赋值一次：lambda 捕获的局部变量必须是（实际上的）最终变量
            final double nextBaseline;
            if (baseline >= 0) {
                if (length - baseline >= CONTENT_GROWTH) {
                    snapshot(requestId, view, originalUrl);
                    return;
                }
                nextBaseline = baseline;
            } else if (length >= MIN_BASELINE_TEXT || android.os.SystemClock.uptimeMillis() >= baselineDeadline) {
                nextBaseline = length;
            } else {
                nextBaseline = baseline;
            }
            handler.postDelayed(
                    () -> awaitContent(requestId, view, originalUrl, nextBaseline, round, contentDeadline, baselineDeadline, deadline),
                    POLL_MS);
        });
    }

    private void snapshot(String requestId, WebView view, String originalUrl) {
        view.evaluateJavascript(SNAPSHOT_JS, value -> {
            if (view != offscreen) return;
            try {
                // evaluateJavascript 会把返回的字符串再包一层 JSON：先解一层拿到对象文本
                String objectText = new JSONArray("[" + value + "]").getString(0);
                JSONObject page = new JSONObject(objectText);
                String html = page.optString("html", "");
                if (html.isEmpty()) {
                    finish(requestId, view, errorPayload("页面渲染完成但没有拿到 HTML"));
                    return;
                }
                JSONObject payload = new JSONObject();
                payload.put("ok", true);
                payload.put("html", html);
                payload.put("title", page.optString("title", ""));
                payload.put("url", page.optString("url", originalUrl));
                finish(requestId, view, payload);
            } catch (Exception error) {
                finish(requestId, view, errorPayload("渲染结果无法解析：" + error.getMessage()));
            }
        });
    }

    /** 统一收尾：拆掉离屏视图，再经壳 WebView 把结果回给网页（拆视图失败不影响结果回执） */
    private void finish(String requestId, WebView view, JSONObject payload) {
        if (offscreen == view) offscreen = null;
        try {
            ViewGroup parent = (ViewGroup) view.getParent();
            if (parent != null) parent.removeView(view);
        } catch (Exception error) {
            Log.w(TAG, "移除离屏视图失败：" + error.getMessage());
        }
        try {
            view.destroy();
        } catch (Exception error) {
            Log.w(TAG, "销毁离屏视图失败：" + error.getMessage());
        }
        reply(requestId, payload);
    }

    private JSONObject errorPayload(String message) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("ok", false);
            payload.put("error", message == null ? "渲染失败" : message);
        } catch (Exception ignored) {
            // JSONObject.put 对这两个字符串不会失败
        }
        return payload;
    }

    private void reply(String requestId, JSONObject payload) {
        if (activity.isFinishing() || activity.isDestroyed()) return;
        String script = "window.__engramInboxRenderResult&&window.__engramInboxRenderResult("
                + JSONObject.quote(requestId) + "," + JSONObject.quote(payload.toString()) + ")";
        try {
            shellWebView.evaluateJavascript(script, null);
        } catch (Exception error) {
            // 页面已经跳走时 evaluateJavascript 会抛错，忽略即可
            Log.w(TAG, "渲染结果回执失败：" + error.getMessage());
        }
    }
}
