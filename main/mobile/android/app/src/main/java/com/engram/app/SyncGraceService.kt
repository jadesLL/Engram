package com.engram.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * 后台同步宽限窗口的前台服务（dataSync 类型 + 部分唤醒锁）。
 *
 * 为什么需要它：安卓在应用退到后台后很快会把进程标成 cached，并由 CachedAppOptimizer 冻结
 * （SIGSTOP）——计时器与网络线程一起停，只靠「App 自己数 10 分钟」到不了 10 分钟。前台服务让进程
 * 保持 foreground-service 优先级不被冻结；部分唤醒锁保证熄屏时 CPU 不停，10 分钟的同步才真的跑得完。
 *
 * 生命周期由 [SyncEngine] 的宽限窗口驱动（见 [BackgroundSyncPolicy]）：进入后台且还有工作 → 拉起；
 * 一轮收敛 / 8 分钟到期 / 回到前台 → [stop]。窗口不常驻，绝不留后台进程。
 *
 * 系统限制：Android 12+ 不允许从后台启动前台服务。所以宿主在 onUserLeaveHint（进程还在前台时）
 * 就先拉起，onStop 时再兜一次；两次都被拒（低内存 / 厂商策略）时 [start] 返回 false，调用方记一条
 * warn，宽限计时照旧但可能被冻结提前打断——回前台会立即补一轮，数据不丢。
 */
class SyncGraceService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        // 提示语用 [BackgroundSyncPolicy.GRACE_MINUTES]：窗口改了文案自动跟着改
        startForegroundCompat()
        acquireWakeLock()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        releaseWakeLock()
        super.onDestroy()
    }

    private fun startForegroundCompat() {
        try {
            createChannel()
            val notification = buildNotification()
            // API 29 起有带类型的重载；API 34 起必须带 dataSync 类型（Manifest 已声明 foregroundServiceType）
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (error: Throwable) {
            // 没有通知权限 / 前台服务被限制：同步照旧跑，只是没有常驻通知
            Log.w(TAG, "后台同步前台服务没能挂上通知", error)
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(CHANNEL_ID, "后台同步", NotificationManager.IMPORTANCE_LOW)
        channel.description = "退到后台后继续完成同步（最多 " + BackgroundSyncPolicy.GRACE_MINUTES + " 分钟）"
        channel.setShowBadge(false)
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
        val open = Intent(this, MainActivity::class.java)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pending = PendingIntent.getActivity(this, NOTIFICATION_ID, open, flags)
        val text = "退到后台后继续同步，最多 " + BackgroundSyncPolicy.GRACE_MINUTES + " 分钟；完成或到点自动停止"
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Engram 正在同步")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setContentIntent(pending)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        try {
            val power = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
            val lock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "engram:sync-grace")
            lock.setReferenceCounted(false)
            // 超时兜底：比宽限窗口多一分钟，服务被异常杀不掉时锁也会自己释放
            lock.acquire(BackgroundSyncPolicy.GRACE_MS + 60_000L)
            wakeLock = lock
        } catch (error: Throwable) {
            Log.w(TAG, "后台同步唤醒锁没拿到", error)
        }
    }

    private fun releaseWakeLock() {
        try {
            val lock = wakeLock ?: return
            if (lock.isHeld) lock.release()
        } catch (error: Throwable) {
            Log.w(TAG, "后台同步唤醒锁释放失败", error)
        } finally {
            wakeLock = null
        }
    }

    companion object {
        private const val TAG = "EngramSyncGrace"
        /** 通知渠道 / 通知 id：与更新通知（18183 / 18184）错开 */
        private const val CHANNEL_ID = "engram-background-sync"
        private const val NOTIFICATION_ID = 18186
        private const val ACTION_START = "com.engram.app.action.SYNC_GRACE_START"
        private const val ACTION_STOP = "com.engram.app.action.SYNC_GRACE_STOP"

        /**
         * 拉起后台同步前台服务。
         *
         * @return true = 已交给系统；false = 被系统拒绝（Android 12+ 后台启动限制 / 厂商策略），
         *         调用方记一条可读 warn，宽限计时照旧。
         */
        @JvmStatic
        fun start(context: Context): Boolean {
            val intent = Intent(context, SyncGraceService::class.java).setAction(ACTION_START)
            return try {
                ContextCompat.startForegroundService(context, intent)
                true
            } catch (error: Throwable) {
                Log.w(TAG, "系统不允许启动后台同步前台服务", error)
                false
            }
        }

        /** 停止（宽限结束 / 回到前台 / 同步已停用）：没有在跑时是无操作 */
        @JvmStatic
        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, SyncGraceService::class.java))
            } catch (error: Throwable) {
                Log.w(TAG, "停止后台同步前台服务失败", error)
            }
        }
    }
}
