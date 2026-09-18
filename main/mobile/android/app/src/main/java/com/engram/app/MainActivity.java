package com.engram.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends BridgeActivity {

    /** 长按桌面图标快捷方式的 action：保留旧名称以兼容升级，实际打开本地库同步设置。 */
    private static final String ACTION_SELECT_SERVER = "com.engram.app.SELECT_SERVER";
    private static final int REQUEST_CREATE_DOCUMENT = 18182;

    private boolean forceSelectServer = false;
    private int localNavigationGeneration = 0;
    private String pendingDownloadUrl;
    private String pendingDownloadCookie;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String previousCrash = CrashReporter.consume(getApplicationContext());
        CrashReporter.install(getApplicationContext());

        // Ktor/kotlinx-io 在 Android 上跨线程写 socket 时若不启用二级段池，会持续产生大量
        // 短命 Segment，部分设备可在几秒内耗尽应用堆。必须在首次加载 Ktor 类之前设置。
        if (System.getProperty("kotlinx.io.pool.size.bytes") == null) {
            System.setProperty("kotlinx.io.pool.size.bytes", "4194304");
        }

        forceSelectServer = ACTION_SELECT_SERVER.equals(getIntent().getAction());
        Throwable startupError = null;
        try {
            EngramLocalServer localServer = EngramLocalServer.getInstance(getApplicationContext());
            localServer.start();
            localServer.migrateLegacyRemoteUrl();
        } catch (Throwable error) {
            startupError = error;
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

        // 不与 Capacitor 首次导航竞争：只有 /health 确认可访问后才切换到本机 HTTP 服务。
        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView != null) {
            if (startupError == null) loadLocalWhenReady(webView, forceSelectServer);
            else showStartupError(webView, startupError.getMessage());
            if (previousCrash != null) {
                webView.postDelayed(() -> new AlertDialog.Builder(this)
                        .setTitle("检测到上次闪退")
                        .setMessage(previousCrash)
                        .setPositiveButton("知道了", null)
                        .show(), 800);
            }
        }
    }

    @Override
    public void onStart() {
        super.onStart();
        try {
            EngramLocalServer.getInstance(getApplicationContext()).onForeground();
        } catch (Throwable error) {
            WebView webView = bridge != null ? bridge.getWebView() : null;
            if (webView != null) showStartupError(webView, error.getMessage());
        }
    }

    @Override
    public void onStop() {
        try {
            EngramLocalServer.getInstance(getApplicationContext()).onBackground();
        } catch (Throwable ignored) {
            // 本地服务未完成初始化时没有需要取消的同步请求。
        }
        super.onStop();
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // 应用已在前台时点快捷方式：直接打开同步设置页
        if (ACTION_SELECT_SERVER.equals(intent.getAction()) && bridge != null && bridge.getWebView() != null) {
            forceSelectServer = false;
            loadLocalWhenReady(bridge.getWebView(), true);
        }
    }

    private void loadLocalWhenReady(WebView webView, boolean syncSettings) {
        final int generation = ++localNavigationGeneration;
        final String target = localUrl(syncSettings);
        webView.loadDataWithBaseURL(null, startupHtml("正在启动本地知识库…", false), "text/html", "UTF-8", null);
        new Thread(() -> {
            String lastError = "本地服务未响应";
            for (int attempt = 0; attempt < 100; attempt++) {
                HttpURLConnection connection = null;
                try {
                    connection = (HttpURLConnection) new URL(EngramLocalServer.BASE_URL + "/health").openConnection();
                    connection.setConnectTimeout(300);
                    connection.setReadTimeout(300);
                    connection.setUseCaches(false);
                    if (connection.getResponseCode() == 200) {
                        runOnUiThread(() -> {
                            if (generation == localNavigationGeneration && !isFinishing()) webView.loadUrl(target);
                        });
                        return;
                    }
                    lastError = "健康检查返回 HTTP " + connection.getResponseCode();
                } catch (Exception error) {
                    lastError = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
                } finally {
                    if (connection != null) connection.disconnect();
                }
                try {
                    Thread.sleep(100);
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
            final String detail = lastError;
            runOnUiThread(() -> {
                if (generation == localNavigationGeneration && !isFinishing()) showStartupError(webView, detail);
            });
        }, "engram-local-health").start();
    }

    private void showStartupError(WebView webView, String detail) {
        ++localNavigationGeneration;
        String safeDetail = detail == null ? "未知错误" : detail.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
        webView.loadDataWithBaseURL(
                EngramLocalServer.BASE_URL,
                startupHtml("本地知识库启动失败<br><small>" + safeDetail + "</small><br><a href=\"/\">点此重试</a>", true),
                "text/html",
                "UTF-8",
                null
        );
    }

    private String startupHtml(String message, boolean isError) {
        String color = isError ? "#c2410c" : "#475569";
        return "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>"
                + "<body style=\"margin:0;background:#f8fafc;color:" + color + ";font:16px system-ui;display:grid;place-items:center;height:100vh\">"
                + "<div style=\"max-width:320px;text-align:center;line-height:1.7\"><b>Engram Local</b><br>" + message + "</div></body></html>";
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

    private String localUrl(boolean syncSettings) {
        return EngramLocalServer.BASE_URL + (syncSettings ? "/settings?section=sync" : "/");
    }

    /** 导出与备份使用系统 SAF“另存为”，不申请外部存储权限，API 23 起行为一致。 */
    private void setupDownloads() {
        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView == null) return;
        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            try {
                String fileName = guessFileName(url, contentDisposition, mimetype);
                pendingDownloadUrl = url;
                pendingDownloadCookie = CookieManager.getInstance().getCookie(url);
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType(mimetype == null || mimetype.isEmpty() ? "application/octet-stream" : mimetype)
                        .putExtra(Intent.EXTRA_TITLE, fileName);
                startActivityForResult(intent, REQUEST_CREATE_DOCUMENT);
            } catch (Exception ignored) {
                pendingDownloadUrl = null;
                pendingDownloadCookie = null;
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_CREATE_DOCUMENT) return;
        final String url = pendingDownloadUrl;
        final String cookie = pendingDownloadCookie;
        pendingDownloadUrl = null;
        pendingDownloadCookie = null;
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null || url == null) return;
        final Uri destination = data.getData();
        new Thread(() -> saveDownload(url, cookie, destination), "engram-export").start();
    }

    private void saveDownload(String source, String cookie, Uri destination) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(source).openConnection();
            connection.setConnectTimeout(5_000);
            connection.setReadTimeout(60_000);
            if (cookie != null) connection.setRequestProperty("Cookie", cookie);
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new IllegalStateException("HTTP " + status);
            try (InputStream input = connection.getInputStream();
                 OutputStream output = getContentResolver().openOutputStream(destination, "w")) {
                if (output == null) throw new IllegalStateException("无法打开目标文件");
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
            }
            runOnUiThread(() -> Toast.makeText(this, "文件已保存", Toast.LENGTH_SHORT).show());
        } catch (Exception error) {
            runOnUiThread(() -> Toast.makeText(this, "保存失败：" + error.getMessage(), Toast.LENGTH_LONG).show());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
