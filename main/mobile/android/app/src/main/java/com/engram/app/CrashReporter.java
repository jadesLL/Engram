package com.engram.app;

import android.content.Context;
import android.os.Build;

import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.time.Instant;

/** 调试版本地崩溃记录：不联网，只写入 App 私有目录并在下一次启动展示一次。 */
final class CrashReporter {
    private static final String FILE_NAME = "last-crash.txt";
    private static boolean installed;

    private CrashReporter() {}

    static synchronized void install(Context context) {
        if (installed) return;
        installed = true;
        Context app = context.getApplicationContext();
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                StringWriter trace = new StringWriter();
                error.printStackTrace(new PrintWriter(trace));
                Runtime runtime = Runtime.getRuntime();
                String report = "time=" + Instant.now() + "\n"
                        + "device=" + Build.MANUFACTURER + " " + Build.MODEL + "\n"
                        + "android=" + Build.VERSION.RELEASE + " api=" + Build.VERSION.SDK_INT + "\n"
                        + "thread=" + thread.getName() + "\n"
                        + "heapFree=" + runtime.freeMemory() + " heapTotal=" + runtime.totalMemory() + " heapMax=" + runtime.maxMemory() + "\n\n"
                        + trace;
                try (FileOutputStream output = new FileOutputStream(new File(app.getFilesDir(), FILE_NAME), false)) {
                    output.write(report.getBytes(StandardCharsets.UTF_8));
                    output.flush();
                }
            } catch (Throwable ignored) {
                // OOM 等极端情况下记录失败也必须继续交给系统默认处理器。
            }
            if (previous != null) previous.uncaughtException(thread, error);
        });
    }

    static String consume(Context context) {
        File file = new File(context.getFilesDir(), FILE_NAME);
        if (!file.isFile()) return null;
        try {
            byte[] bytes = new byte[(int) Math.min(file.length(), 12_000)];
            int count;
            try (java.io.FileInputStream input = new java.io.FileInputStream(file)) {
                count = input.read(bytes);
            }
            file.delete();
            return count > 0 ? new String(bytes, 0, count, StandardCharsets.UTF_8) : null;
        } catch (Exception ignored) {
            return null;
        }
    }
}
