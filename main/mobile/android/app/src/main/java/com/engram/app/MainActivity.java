package com.engram.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.graphics.Color;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;

import java.io.InputStream;
import java.io.OutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;

public class MainActivity extends BridgeActivity {

    /** 长按桌面图标快捷方式的 action：保留旧名称以兼容升级，实际打开本地库同步设置。 */
    private static final String ACTION_SELECT_SERVER = "com.engram.app.SELECT_SERVER";
    private static final int REQUEST_CREATE_DOCUMENT = 18182;
    private static final int REQUEST_NOTIFICATIONS = 18183;

    private boolean forceSelectServer = false;
    private volatile boolean activityForeground = false;
    private volatile boolean startupSurfaceReady = false;
    private View startupOverlay;
    private int localNavigationGeneration = 0;
    private String pendingDownloadUrl;
    private String pendingDownloadCookie;
    /** 系统栏（状态栏/导航栏/大屏任务栏）：透明 + 尺寸交给网页，见 SystemBars。 */
    private SystemBars systemBars;
    /** 系统解锁（指纹/人脸/锁屏密码）：登录页用，见 BiometricUnlock。 */
    private BiometricUnlock biometricUnlock;
    /** 应用内在线更新的宿主（安装器/权限页/通知都离不开 Activity），见 AppUpdater。 */
    private UpdateHost updateHost;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        SplashScreen splashScreen = SplashScreen.installSplashScreen(this);
        splashScreen.setKeepOnScreenCondition(() -> !startupSurfaceReady);
        super.onCreate(savedInstanceState);
        WebView shellWebView = bridge != null ? bridge.getWebView() : null;
        if (shellWebView != null) {
            systemBars = new SystemBars(this, shellWebView);
            systemBars.install();
            // 与系统栏同一个时机装桥：页面加载后登录页就要能问「有没有指纹解锁」
            biometricUnlock = new BiometricUnlock(this, shellWebView);
            biometricUnlock.install();
        }
        showStartupOverlay();
        startupSurfaceReady = true;
        String previousCrash = CrashReporter.consume(getApplicationContext());
        CrashReporter.install(getApplicationContext());
        // 应用内在线更新的宿主：本地服务（AppUpdater）在后台线程里跑下载，需要 Activity 才能
        // 调起系统安装器 / 跳「安装未知应用」授权页 / 发通知。实例还没建好也先挂上（静态持有）。
        updateHost = new UpdateHost();
        AppUpdater.setHost(updateHost);

        // Ktor/kotlinx-io 在 Android 上跨线程写 socket 时若不启用二级段池，会持续产生大量
        // 短命 Segment，部分设备可在几秒内耗尽应用堆。必须在首次加载 Ktor 类之前设置。
        if (System.getProperty("kotlinx.io.pool.size.bytes") == null) {
            System.setProperty("kotlinx.io.pool.size.bytes", "4194304");
        }

        forceSelectServer = ACTION_SELECT_SERVER.equals(getIntent().getAction());
        // 注册晚于 App 插件的回调（后加入者优先生效）：物理返回键与屏幕侧滑手势都走这里。
        // 顺序：先让网页处理「它自己叠出来的那一层」（抽屉/弹层/阅读态/子视图），
        // 网页不要才交给 WebView 历史，历史也到头才退到后台（不销毁 Activity，保留登录态）。
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = bridge != null ? bridge.getWebView() : null;
                if (webView == null) {
                    moveTaskToBack(true);
                    return;
                }
                webView.evaluateJavascript(
                        "(function(){try{return window.__engramHandleBack?window.__engramHandleBack()===true:false}catch(e){return false}})()",
                        handled -> {
                            switch (BackPolicy.decide("true".equals(handled), webView.canGoBack())) {
                                case WEB:
                                    break;
                                case HISTORY:
                                    webView.goBack();
                                    break;
                                default:
                                    moveTaskToBack(true);
                                    break;
                            }
                        });
            }
        });

        setupDownloads();
        handleIncomingShare(getIntent());

        // 先绘出启动说明；服务启动与文件索引随后在工作线程完成。
        WebView webView = bridge != null ? bridge.getWebView() : null;
        final int startupGeneration = localNavigationGeneration;
        if (webView != null) {
            webView.loadDataWithBaseURL(null, startupHtml("正在启动本地知识库…", false), "text/html", "UTF-8", null);
            if (previousCrash != null) {
                webView.postDelayed(() -> new AlertDialog.Builder(this)
                        .setTitle("检测到上次闪退")
                        .setMessage(previousCrash)
                        .setPositiveButton("知道了", null)
                        .show(), 800);
            }
        }
        // 文件库启动会扫描 Markdown 与附件；大库可能耗时数秒，不能阻塞 Activity 首帧。
        new Thread(() -> {
            try {
                EngramLocalServer localServer = EngramLocalServer.getInstance(getApplicationContext());
                localServer.start();
                localServer.migrateLegacyRemoteUrl();
                runOnUiThread(() -> {
                    if (webView != null && startupGeneration == localNavigationGeneration && !isFinishing()) {
                        loadLocalWhenReady(webView, forceSelectServer);
                    }
                });
            } catch (Throwable error) {
                runOnUiThread(() -> {
                    if (webView != null && !isFinishing()) showStartupError(webView, error.getMessage());
                });
            }
        }, "engram-local-start").start();
    }

    @Override
    public void onStart() {
        super.onStart();
        activityForeground = true;
        try {
            EngramLocalServer localServer = EngramLocalServer.peek();
            if (localServer != null && startupOverlay == null) localServer.onForeground();
        } catch (Throwable error) {
            WebView webView = bridge != null ? bridge.getWebView() : null;
            if (webView != null) showStartupError(webView, error.getMessage());
        }
    }

    @Override
    public void onStop() {
        activityForeground = false;
        try {
            EngramLocalServer localServer = EngramLocalServer.peek();
            if (localServer != null) localServer.onBackground();
        } catch (Throwable ignored) {
            // 本地服务未完成初始化时没有需要取消的同步请求。
        }
        super.onStop();
    }

    @Override
    public void onDestroy() {
        // 摘掉宿主：更新引擎静态持有 Activity 会造成泄漏；应用不在前台时安装/权限页会明确报错
        if (AppUpdater.getHost() == updateHost) AppUpdater.setHost(null);
        updateHost = null;
        super.onDestroy();
    }

    /**
     * 在线更新的宿主实现：把需要 Activity 的三件事接起来——系统安装器、授权页、下载完成通知。
     * 这些动作都由本地服务（后台线程）发起，所以统一切回主线程再做。
     */
    private final class UpdateHost implements AppUpdater.Host {

        @Override
        public boolean launchInstaller(File apk) {
            runOnUiThread(() -> {
                try {
                    Uri uri = FileProvider.getUriForFile(
                            MainActivity.this,
                            getPackageName() + ".fileprovider",
                            apk
                    );
                    Intent intent = new Intent(Intent.ACTION_VIEW)
                            .setDataAndType(uri, "application/vnd.android.package-archive")
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(intent);
                } catch (Exception error) {
                    Toast.makeText(
                            MainActivity.this,
                            "无法调起系统安装器：" + error.getMessage(),
                            Toast.LENGTH_LONG
                    ).show();
                }
            });
            return true;
        }

        @Override
        public void openInstallPermissionSettings() {
            runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                            .setData(Uri.parse("package:" + getPackageName()))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(intent);
                } catch (Exception error) {
                    Toast.makeText(
                            MainActivity.this,
                            "无法打开系统设置：" + error.getMessage(),
                            Toast.LENGTH_LONG
                    ).show();
                }
            });
        }

        @Override
        public void notifyReady(String version, File apk) {
            // 前台有绿色更新图标与设置页提示，不重复发系统通知；退到后台才用通知兜住
            if (activityForeground) return;
            UpdateNotifier.notifyReady(MainActivity.this, version, apk);
        }

        @Override
        public boolean requestNotificationPermission() {
            if (Build.VERSION.SDK_INT < 33) return true;
            if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED) {
                return true;
            }
            runOnUiThread(() -> ActivityCompat.requestPermissions(
                    MainActivity.this,
                    new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    REQUEST_NOTIFICATIONS
            ));
            return false;
        }
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
        handleIncomingShare(intent);
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
                            if (generation == localNavigationGeneration && !isFinishing()) {
                                webView.loadUrl(target);
                                waitForPageSurface(webView, generation, 0);
                            }
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

    /** Vue 首次渲染完成后才收起原生加载层，避免 WebView 的纯白首帧。 */
    private void waitForPageSurface(WebView webView, int generation, int attempt) {
        webView.postDelayed(() -> {
            if (generation != localNavigationGeneration || isFinishing()) return;
            if (attempt >= 100) {
                showStartupError(webView, "页面未能显示，请点此重试");
                return;
            }
            webView.evaluateJavascript("(function(){var root=document.getElementById('app');return location.hostname==='127.0.0.1' && !!root && root.childElementCount>0})()", result -> {
                if (generation != localNavigationGeneration || isFinishing()) return;
                if ("true".equals(result)) {
                    hideStartupOverlay();
                    // 页面已就绪：清掉「正在启动」占位页那一格历史，否则根页面按返回会退回空白页；
                    // 并把系统栏尺寸推给网页（WebView 里 env(safe-area-inset-*) 不可靠）。
                    webView.clearHistory();
                    if (systemBars != null) systemBars.push();
                    // 先显示本地页面，再启动可能需要大量网络和内存的首次同步。
                    webView.postDelayed(() -> {
                        if (activityForeground && generation == localNavigationGeneration) {
                            try {
                                EngramLocalServer localServer = EngramLocalServer.peek();
                                if (localServer != null) localServer.onForeground();
                            } catch (Throwable error) {
                                android.util.Log.e("EngramStartup", "foreground sync could not start", error);
                            }
                        }
                    }, 250);
                }
                else waitForPageSurface(webView, generation, attempt + 1);
            });
        }, 200);
    }

    private void showStartupError(WebView webView, String detail) {
        ++localNavigationGeneration;
        hideStartupOverlay();
        String safeDetail = detail == null ? "未知错误" : detail.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
        webView.loadDataWithBaseURL(
                EngramLocalServer.BASE_URL,
                startupHtml("本地知识库启动失败<br><small>" + safeDetail + "</small><br><a href=\"/\">点此重试</a>", true),
                "text/html",
                "UTF-8",
                null
        );
    }

    private void showStartupOverlay() {
        FrameLayout root = findViewById(android.R.id.content);
        if (root == null) return;
        // 启动说明的底色跟随应用主题：深色模式下不再闪一块白屏（主题由 SystemBars 记住上次选择）
        boolean dark = systemBars != null && systemBars.isDark();
        FrameLayout overlay = new FrameLayout(this);
        overlay.setBackgroundColor(dark ? Color.rgb(30, 29, 28) : Color.rgb(247, 246, 244));
        overlay.setClickable(true);
        TextView label = new TextView(this);
        label.setText("Engram Local\n正在启动本地知识库…");
        label.setTextColor(dark ? Color.rgb(201, 201, 201) : Color.rgb(71, 85, 105));
        label.setTextSize(17);
        label.setGravity(Gravity.CENTER);
        label.setLineSpacing(8, 1);
        overlay.addView(label, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        root.addView(overlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        startupOverlay = overlay;
    }

    private void hideStartupOverlay() {
        if (startupOverlay != null) {
            View overlay = startupOverlay;
            startupOverlay = null;
            if (overlay.getParent() instanceof FrameLayout) ((FrameLayout) overlay.getParent()).removeView(overlay);
        }
    }

    private String startupHtml(String message, boolean isError) {
        boolean dark = systemBars != null && systemBars.isDark();
        String color = isError ? "#f0a56b" : (dark ? "#c9c9c9" : "#475569");
        String background = dark ? "#1e1d1c" : "#f7f6f4";
        return "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\"></head>"
                + "<body style=\"margin:0;background:" + background + ";color:" + color + ";font:16px system-ui;display:grid;place-items:center;height:100vh\">"
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
        // 系统凭据验证（API 23-27 的锁屏验证）由 BiometricUnlock 自己收口，别落到下载逻辑里
        if (biometricUnlock != null && biometricUnlock.onActivityResult(requestCode, resultCode, data)) return;
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

    /**
     * 系统分享入口：文字与文件先写进 Android 私有库的「原始资料/文档」，写入成功后走
     * 普通同步 outbox。这里只接收用户主动分享给 Engram 的 URI，不申请全盘存储权限。
     */
    private void handleIncomingShare(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        // singleTask 的 onNewIntent 可能再次交付同一 Intent；清掉 action 防止配置变更时重复导入。
        intent.setAction(null);
        new Thread(() -> {
            int imported = 0;
            try {
                EngramLocalServer server = EngramLocalServer.getInstance(getApplicationContext());
                String text = intent.getStringExtra(Intent.EXTRA_TEXT);
                String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
                if (text != null && !text.trim().isEmpty()) {
                    server.importSharedText(subject, text);
                    imported++;
                }

                ArrayList<Uri> uris = new ArrayList<>();
                if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
                    ArrayList<Uri> multiple = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                    if (multiple != null) uris.addAll(multiple);
                } else {
                    Uri single = (Uri) intent.getParcelableExtra(Intent.EXTRA_STREAM);
                    if (single != null) uris.add(single);
                }
                for (Uri uri : uris) {
                    String name = sharedDisplayName(uri);
                    File staged = File.createTempFile("engram-share-", ".tmp", getCacheDir());
                    try {
                        try (InputStream input = getContentResolver().openInputStream(uri);
                             OutputStream output = new FileOutputStream(staged)) {
                            if (input == null) throw new IllegalStateException("无法读取分享文件");
                            byte[] buffer = new byte[64 * 1024];
                            long total = 0;
                            int count;
                            while ((count = input.read(buffer)) >= 0) {
                                total += count;
                                if (total > 200L * 1024L * 1024L) throw new IllegalArgumentException("分享文件超过 200 MB 上限");
                                output.write(buffer, 0, count);
                            }
                        }
                        server.importSharedFile(name, staged);
                        imported++;
                    } finally {
                        staged.delete();
                    }
                }
                final int count = imported;
                runOnUiThread(() -> Toast.makeText(
                        this,
                        count > 0 ? "已收入本地收集箱" + (count > 1 ? "（" + count + " 项）" : "") : "没有可导入的分享内容",
                        Toast.LENGTH_LONG
                ).show());
            } catch (Exception error) {
                runOnUiThread(() -> Toast.makeText(this, "接收分享失败：" + error.getMessage(), Toast.LENGTH_LONG).show());
            }
        }, "engram-share-import").start();
    }

    private String sharedDisplayName(Uri uri) {
        try (android.database.Cursor cursor = getContentResolver().query(
                uri,
                new String[]{OpenableColumns.DISPLAY_NAME},
                null,
                null,
                null
        )) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) {
                    String value = cursor.getString(index);
                    if (value != null && !value.trim().isEmpty()) return value;
                }
            }
        } catch (Exception ignored) {
            // 某些分享方不支持 query，退回 URI 尾段。
        }
        String tail = uri.getLastPathSegment();
        return tail == null || tail.trim().isEmpty() ? "手机分享文件" : tail;
    }
}
