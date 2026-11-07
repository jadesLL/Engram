package com.engram.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import java.io.File;

/**
 * 安卓端在线更新的系统通知：①「新版本已下载」②「自动更新失败、本版本已暂停自动下载」。
 *
 * 下载在应用进程里后台跑，用户此时可能在别的应用里，所以下载完成要有一条通知兜住；
 * 应用在前台时不发（界面上的绿色更新图标已经提示了，避免重复打扰，判断在 MainActivity 的 Host 里）。
 * 失败通知则前台也发：自动更新已暂停是用户必须知道的状态变化，不发他会一直以为还在自动更新。
 * 点通知只打开 Engram——安装那一步必须由用户在应用内点「立即安装」再走系统安装器确认，
 * 不在通知里直接调起安装界面（防止误触静默升级）。
 */
final class UpdateNotifier {

    private static final String CHANNEL_ID = "engram-app-update";
    private static final int NOTIFICATION_ID = 18183;
    /** 自动更新失败（本版本已暂停自动下载）单独一个渠道：用户可单独关掉这类提醒 */
    private static final String FAILED_CHANNEL_ID = "engram-app-update-failed";
    private static final int FAILED_NOTIFICATION_ID = 18184;

    private UpdateNotifier() {
    }

    static void notifyReady(Context context, String version, File apk) {
        if (apk == null || !apk.exists()) return;
        try {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel channel = new NotificationChannel(
                        CHANNEL_ID,
                        "应用更新",
                        NotificationManager.IMPORTANCE_DEFAULT
                );
                channel.setDescription("新版本安装包下载完成后提醒");
                manager.createNotificationChannel(channel);
            }
            Intent open = new Intent(context, MainActivity.class)
                    .setAction(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_LAUNCHER)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pending = PendingIntent.getActivity(context, NOTIFICATION_ID, open, flags);
            String title = (version == null || version.isEmpty())
                    ? "新版本已下载"
                    : "Engram v" + version + " 已下载";
            NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.stat_sys_download_done)
                    .setContentTitle(title)
                    .setContentText("点此打开 Engram 完成安装（会弹出系统安装确认）")
                    .setAutoCancel(true)
                    .setContentIntent(pending);
            manager.notify(NOTIFICATION_ID, builder.build());
            // 包已就绪说明这个版本下载成功、暂停记录也清了：把上次的失败提醒一并撤掉
            try {
                manager.cancel(FAILED_NOTIFICATION_ID);
            } catch (Exception ignored) {
                // 取消失败不影响下载完成提醒
            }
        } catch (Exception ignored) {
            // 通知发不出去不影响更新：应用内仍然有绿色更新图标与设置页入口
        }
    }

    /**
     * 「自动更新失败、本版本已暂停自动下载」提醒。
     *
     * 自动下载失败后不会再有下一次重试（本版本暂停），用户不打开应用就永远不知道，
     * 所以这条与「下载完成」不同：前台也发，通知中心留档；没通知权限时静默跳过。
     */
    static void notifyAutoUpdateFailure(Context context, String version, String reason) {
        try {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel channel = new NotificationChannel(
                        FAILED_CHANNEL_ID,
                        "更新失败提醒",
                        NotificationManager.IMPORTANCE_DEFAULT
                );
                channel.setDescription("自动更新失败、本版本暂停自动下载时提醒");
                manager.createNotificationChannel(channel);
            }
            Intent open = new Intent(context, MainActivity.class)
                    .setAction(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_LAUNCHER)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pending = PendingIntent.getActivity(context, FAILED_NOTIFICATION_ID, open, flags);
            String title = (version == null || version.isEmpty())
                    ? "Engram 自动更新失败"
                    : "Engram v" + version + " 自动更新失败";
            String reasonText = (reason == null || reason.isEmpty()) ? "" : "（" + reason + "）";
            String text = "已暂停该版本的自动更新" + reasonText + "，可在 设置 → 版本与更新 手动重试";
            NotificationCompat.Builder builder = new NotificationCompat.Builder(context, FAILED_CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.stat_notify_sync)
                    .setContentTitle(title)
                    .setContentText(text)
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                    .setAutoCancel(true)
                    .setContentIntent(pending);
            manager.notify(FAILED_NOTIFICATION_ID, builder.build());
        } catch (Exception ignored) {
            // 通知发不出去不影响暂停记录：设置页仍有「已暂停」的可读说明
        }
    }

    /** 取消更新相关提醒（用户装完 / 跳过这次更新 / 自动恢复后） */
    static void clear(Context context) {
        try {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;
            manager.cancel(NOTIFICATION_ID);
            manager.cancel(FAILED_NOTIFICATION_ID);
        } catch (Exception ignored) {
            // 同上：取消失败无需上报
        }
    }
}
