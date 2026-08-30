package com.example.exampleproject;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {

    /** 长按桌面图标快捷方式的 action：打开服务器选择页 */
    private static final String ACTION_SELECT_SERVER = "com.example.exampleproject.SELECT_SERVER";

    private boolean forceSelectServer = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        forceSelectServer = ACTION_SELECT_SERVER.equals(getIntent().getAction());

        // 冷启动路径：在首个页面开始加载时覆盖为目标选择页（晚于桥接初始加载，必然生效）
        if (forceSelectServer) {
            bridge.addWebViewListener(new WebViewListener() {
                @Override
                public void onPageStarted(WebView webView) {
                    if (forceSelectServer) {
                        forceSelectServer = false;
                        webView.loadUrl(launcherUrl(true));
                    }
                }
            });
        }

        // 注册晚于 App 插件的回调（后加入者优先生效）：
        // 可后退则网页后退，否则退到后台（不销毁 Activity，保留登录态）
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = bridge != null ? bridge.getWebView() : null;
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                } else {
                    moveTaskToBack(true);
                }
            }
        });

        setupDownloads();
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // 应用已在前台时点快捷方式：直接覆盖为选择页
        if (ACTION_SELECT_SERVER.equals(intent.getAction()) && bridge != null && bridge.getWebView() != null) {
            forceSelectServer = false;
            bridge.getWebView().loadUrl(launcherUrl(true));
        }
    }

    /**
     * 下载文件名：服务端用 RFC 5987（filename*=UTF-8''…）传递 UTF-8 文件名，
     * URLUtil.guessFileName 不解析该格式（会得到 raw.bin 之类），需自行解析。
     */
    private String guessFileName(String url, String contentDisposition, String mimetype) {
        if (contentDisposition != null && !contentDisposition.isEmpty()) {
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("filename\\*\\s*=\\s*(?:UTF-8|utf-8)''([^;]+)")
                    .matcher(contentDisposition);
            if (m.find()) {
                try {
                    String decoded = java.net.URLDecoder.decode(m.group(1).trim(), "UTF-8");
                    if (!decoded.isEmpty()) return decoded;
                } catch (Exception ignored) {
                    // 解码失败则回退普通 filename / URLUtil
                }
            }
            m = java.util.regex.Pattern
                    .compile("filename\\s*=\\s*\"?([^\";]+)\"?")
                    .matcher(contentDisposition);
            if (m.find()) {
                String v = m.group(1).trim();
                if (!v.isEmpty()) return v;
            }
        }
        return URLUtil.guessFileName(url, contentDisposition, mimetype);
    }

    private String launcherUrl(boolean withFlag) {
        String scheme = bridge != null ? bridge.getScheme() : "https";
        String host = bridge != null ? bridge.getHost() : "localhost";
        return scheme + "://" + host + "/index.html" + (withFlag ? "?select=1" : "");
    }

    /**
     * 附件下载：走系统 DownloadManager（带 Cookie 鉴权，保存到公共 Download 目录并显示通知）。
     * 服务端受保护下载地址依赖登录 Cookie，必须显式携带。
     */
    private void setupDownloads() {
        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView == null) return;
        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            try {
                String fileName = guessFileName(url, contentDisposition, mimetype);
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                String cookie = CookieManager.getInstance().getCookie(url);
                if (cookie != null) request.addRequestHeader("Cookie", cookie);
                if (userAgent != null) request.addRequestHeader("User-Agent", userAgent);
                if (mimetype != null) request.setMimeType(mimetype);
                request.setTitle(fileName);
                request.setDescription("Engram 附件下载");
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm != null) {
                    dm.enqueue(request);
                }
            } catch (Exception ignored) {
                // 系统下载管理不可用时静默放弃；不影响页面内浏览
            }
        });
    }
}
