package com.engram.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

/**
 * 后台同步的权限判定与系统界面跳转（Android API 封装；策略在 {@link BackgroundSyncPermissions}）。
 *
 * 两枚权限都只服务「退到后台后继续同步 10 分钟」：
 *  - POST_NOTIFICATIONS（Android 13+，运行时权限）：{@link SyncGraceService} 的前台服务通知；
 *  - REQUEST_IGNORE_BATTERY_OPTIMIZATIONS：Doze / 厂商省电会冻结后台进程，要用户点「允许后台运行」。
 *
 * 「问过没有」单独记在 SharedPreferences：{@link ActivityCompat#shouldShowRequestPermissionRationale}
 * 对「从没问过」和「已永久拒绝」都返回 false，不记这一笔就分不清该弹对话框还是跳设置页。
 */
final class SyncPermissions {

    private static final String PREFS = "engram-sync-permissions";
    private static final String KEY_NOTIFICATIONS_ASKED = "notifications_asked";

    private SyncPermissions() {
    }

    /** Android 13 以下的 POST_NOTIFICATIONS 不是运行时权限（声明即授予），这里视为已授予 */
    static boolean notificationsGranted(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    /** 本应用是否已在电池优化白名单里（API 23 起才有这个开关，更低版本视为不受限） */
    static boolean batteryUnrestricted(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        try {
            PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            return power != null && power.isIgnoringBatteryOptimizations(context.getPackageName());
        } catch (Exception ignored) {
            // 厂商 ROM 上偶发 SecurityException：按未豁免处理，界面仍会给出申请入口
            return false;
        }
    }

    /** 通知权限是否已经「问过且被永久拒绝」：此时系统不会再弹对话框，只能跳设置页 */
    static boolean notificationDialogBlocked(Activity activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false;
        if (notificationsGranted(activity)) return false;
        if (!notificationsAsked(activity)) return false;
        return !ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.POST_NOTIFICATIONS);
    }

    static boolean notificationsAsked(Context context) {
        return preferences(context).getBoolean(KEY_NOTIFICATIONS_ASKED, false);
    }

    static void markNotificationsAsked(Context context) {
        preferences(context).edit().putBoolean(KEY_NOTIFICATIONS_ASKED, true).apply();
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * 弹系统「允许后台运行 / 忽略电池优化」对话框。
     * 个别 ROM 没有这个界面（或权限被收走）时退回电池优化列表，用户仍能自己找到本应用。
     */
    static void requestBatteryExemption(Activity activity) {
        try {
            Intent intent = new Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + activity.getPackageName())
            );
            activity.startActivity(intent);
        } catch (Exception ignored) {
            openBatterySettings(activity);
        }
    }

    static void openBatterySettings(Activity activity) {
        try {
            activity.startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        } catch (Exception ignored) {
            openAppSettings(activity);
        }
    }

    /** 跳本应用的通知设置页：用户已永久拒绝通知时，这是唯一还能提醒的入口 */
    static void openAppNotificationSettings(Activity activity) {
        try {
            Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName());
            activity.startActivity(intent);
        } catch (Exception ignored) {
            openAppSettings(activity);
        }
    }

    static void openAppSettings(Activity activity) {
        try {
            activity.startActivity(new Intent(
                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + activity.getPackageName())
            ));
        } catch (Exception ignored) {
            // 系统设置打不开：界面文案仍写明要开哪两枚权限
        }
    }
}
