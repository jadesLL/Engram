package com.engram.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import java.io.OutputStream;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 单页导出的原生出口（D 类桥，见 docs/PLATFORM-PARALLEL-DEV.md §3.2）。
 *
 * 网页侧：`web/src/lib/pageExportCapture.ts`
 *  - `EngramPageExport.saveImage(dataUrl, name)`：长图（PNG）走系统 SAF「另存为」，
 *    和备份 / 下载一样不申请存储权限；选完位置后在后台线程落盘并 toast。
 *  - `EngramPageExport.printPage(name)`：PDF 走系统打印框架（打印面板里可选「另存为 PDF」），
 *    直接打印当前 WebView；打印媒体下网页只渲染 #engram-export-root（见 pageExport.css）。
 *
 * 为什么不用 PdfDocument 自己画：那只能把长图贴进 PDF（文字不可选、体积大）；
 * WebView 的打印适配器走 Chromium 打印管线，会应用 @media print 与 @page，输出的是真文字。
 */
public final class PageExportBridge {
    /** SAF 保存长图的 requestCode；与下载（18182）分开，结果不会串到下载逻辑里。 */
    static final int REQUEST_EXPORT_IMAGE = 18186;
    /** 长图上限：网页侧已按 2 万像素内降采样，这里只兜住异常数据（避免一次 IPC 拖垮进程）。 */
    private static final int MAX_IMAGE_BYTES = 48 * 1024 * 1024;

    private final Activity activity;
    private final WebView webView;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicReference<PendingImage> pending = new AtomicReference<>();

    private static final class PendingImage {
        final byte[] bytes;
        final String name;

        PendingImage(byte[] bytes, String name) {
            this.bytes = bytes;
            this.name = name;
        }
    }

    public PageExportBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    /** 安装 JS 桥：名字与网页侧 `window.EngramPageExport` 一一对应，漏装会静默退回浏览器下载。 */
    public void install() {
        webView.addJavascriptInterface(new Bridge(), "EngramPageExport");
    }

    /** Activity 销毁时清掉待保存的图片字节，避免静态桥持有大块内存。 */
    public void onDestroy() {
        pending.set(null);
    }

    /** 承接 SAF 结果；返回 true 表示这次结果属于导出图片，Activity 不再往下分发。 */
    public boolean onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_EXPORT_IMAGE) return false;
        final PendingImage image = pending.getAndSet(null);
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null || image == null) {
            return true;
        }
        final Uri target = data.getData();
        new Thread(() -> {
            try (OutputStream output = activity.getContentResolver().openOutputStream(target, "w")) {
                if (output == null) throw new IllegalStateException("无法打开目标文件");
                output.write(image.bytes);
                main.post(() -> toast("长图已保存"));
            } catch (Exception error) {
                main.post(() -> toast("保存长图失败：" + error.getMessage()));
            }
        }, "engram-export-image").start();
        return true;
    }

    private void toast(String message) {
        Toast.makeText(activity, message, Toast.LENGTH_SHORT).show();
    }

    /** 文件名只留可读部分：不允许路径分隔符，扩展名由原生侧补。 */
    private static String safeName(String raw, String fallback, String extension) {
        String name = raw == null ? "" : raw.trim()
                .replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", " ")
                .replaceAll("\\s+", " ")
                .trim();
        if (name.isEmpty()) name = fallback;
        if (name.length() > 80) name = name.substring(0, 80);
        if (!name.toLowerCase(Locale.ROOT).endsWith("." + extension)) name += "." + extension;
        return name;
    }

    /** JS 接口方法运行在 WebView 的 JS 线程：弹系统面板 / 打印必须 post 回 UI 线程。 */
    public final class Bridge {
        @JavascriptInterface
        public boolean saveImage(String dataUrl, String name) {
            final String prefix = "data:image/png;base64,";
            if (dataUrl == null || !dataUrl.startsWith(prefix)) return false;
            final byte[] bytes;
            try {
                bytes = Base64.decode(dataUrl.substring(prefix.length()), Base64.DEFAULT);
            } catch (IllegalArgumentException error) {
                return false;
            }
            if (bytes.length == 0 || bytes.length > MAX_IMAGE_BYTES) return false;
            final String fileName = safeName(name, "Engram 长图", "png");
            if (pending.getAndSet(new PendingImage(bytes, fileName)) != null) return false;
            main.post(() -> {
                try {
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                            .addCategory(Intent.CATEGORY_OPENABLE)
                            .setType("image/png")
                            .putExtra(Intent.EXTRA_TITLE, fileName);
                    activity.startActivityForResult(intent, REQUEST_EXPORT_IMAGE);
                } catch (Exception error) {
                    pending.set(null);
                    toast("无法打开保存面板：" + error.getMessage());
                }
            });
            return true;
        }

        @JavascriptInterface
        public boolean printPage(String name) {
            if (webView == null) return false;
            final String jobName = safeName(name, "Engram 导出", "pdf");
            main.post(() -> {
                try {
                    PrintManager manager = (PrintManager) activity.getSystemService(Activity.PRINT_SERVICE);
                    if (manager == null) {
                        toast("当前系统不支持打印");
                        return;
                    }
                    PrintAttributes attributes = new PrintAttributes.Builder()
                            .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                            .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
                            .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                            .build();
                    manager.print(jobName, webView.createPrintDocumentAdapter(jobName), attributes);
                } catch (Exception error) {
                    toast("打开打印面板失败：" + error.getMessage());
                }
            });
            return true;
        }
    }
}
