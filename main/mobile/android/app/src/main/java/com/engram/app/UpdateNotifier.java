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
 * 「新版本已下载」的系统通知（Android 端在线更新）。
 *
 * 下载在应用进程里后台跑，用户此时可能在别的应用里，所以下载完成要有一条通知兜住；
 * 应用在前台时不发（界面上的绿色更新图标已经提示了，避免重复打扰，判断在 MainActivity 的 Host 里）。
 * 点通知只打开 Engram——安装那一步必须由用户在应用内点「立即安装」再走系统安装器确认，
 * 不在通知里直接调起安装界面（防止误触静默升级）。
 */
final class UpdateNotifier {

    private static final String CHANNEL_ID = "engram-app-update";
    private static final int NOTIFICATION_ID = 18183;

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
        } catch (Exception ignored) {
            // 通知发不出去不影响更新：应用内仍然有绿色更新图标与设置页入口
        }
    }

    /** 取消下载完成提醒（用户装完或跳过了这次更新） */
    static void clear(Context context) {
        try {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) manager.cancel(NOTIFICATION_ID);
        } catch (Exception ignored) {
            // 同上：取消失败无需上报
        }
    }
}
