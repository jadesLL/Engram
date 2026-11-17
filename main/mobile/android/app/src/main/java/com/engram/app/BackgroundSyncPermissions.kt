package com.engram.app

/**
 * 后台同步要哪些系统权限、缺哪个、下一步该弹哪个界面（纯逻辑，JVM 单测覆盖；系统调用在 [SyncPermissions]）。
 *
 * 安卓端要「退到后台还能继续同步 10 分钟」，靠的是 [SyncGraceService] 前台服务 + 唤醒锁，这两样
 * 都需要用户授权才能完整生效：
 *  - 前台服务通知：Android 13+ 要 POST_NOTIFICATIONS（运行时权限，只能靠系统对话框拿）；
 *  - 电池优化豁免：Doze 与厂商省电策略会冻结后台进程，要 REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
 *    才能弹系统「允许后台运行」对话框。
 *
 * 口径（2026-11 用户要求「软件需要什么权限都要主动申请 / 每次使用如果没权限都要申请」）：
 *  - 每次回到前台（每次使用）都检查一遍，缺哪个就申请哪个，不再永久闭嘴；
 *  - 系统同一时刻只允许一个权限对话框：先通知（运行时对话框），结果回来再要电池优化；
 *  - 用户已永久拒绝（再次申请系统不再弹框）时改跳应用通知设置页，避免「点了没反应」。
 */
object BackgroundSyncPermissions {
    const val NOTIFICATIONS = "notifications"
    const val BATTERY = "battery"

    /** 需要用户去系统界面点一下的动作 */
    const val ACTION_REQUEST_NOTIFICATIONS = "request-notifications"
    const val ACTION_REQUEST_BATTERY = "request-battery"
    const val ACTION_NOTIFICATION_SETTINGS = "notification-settings"

    /**
     * 下一步该触发哪个系统界面；null = 都不缺（或这台设备不需要），不必打扰用户。
     *
     * @param sdkInt 系统版本（通知权限从 API 33 起才是运行时权限）
     * @param notificationDialogBlocked 已经申请过、且系统不会再弹通知对话框（永久拒绝）
     */
    @JvmStatic
    fun nextAction(
        sdkInt: Int,
        notificationsGranted: Boolean,
        batteryUnrestricted: Boolean,
        notificationDialogBlocked: Boolean,
    ): String? {
        if (sdkInt >= 33 && !notificationsGranted) {
            return if (notificationDialogBlocked) ACTION_NOTIFICATION_SETTINGS else ACTION_REQUEST_NOTIFICATIONS
        }
        if (!batteryUnrestricted) return ACTION_REQUEST_BATTERY
        return null
    }

    /** 当前还缺的权限键（顺序固定：通知 → 电池优化），给状态接口与界面文案用 */
    @JvmStatic
    fun missing(sdkInt: Int, notificationsGranted: Boolean, batteryUnrestricted: Boolean): List<String> {
        val out = ArrayList<String>(2)
        if (sdkInt >= 33 && !notificationsGranted) out.add(NOTIFICATIONS)
        if (!batteryUnrestricted) out.add(BATTERY)
        return out
    }

    /** 是否该在回到前台时自动申请：已绑定中枢 + 同步开着 + 本次前台还没问过 */
    @JvmStatic
    fun shouldAutoRequest(role: String?, enabled: Boolean, alreadyAsked: Boolean): Boolean {
        if (alreadyAsked) return false
        if (role != "member" || !enabled) return false
        return true
    }

    @JvmStatic
    fun label(key: String): String = when (key) {
        NOTIFICATIONS -> "通知"
        BATTERY -> "电池优化"
        else -> key
    }
}
