package com.engram.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 后台同步权限策略回归（纯逻辑，不碰 Android API）。
 *
 * 用户要求「软件需要什么权限都要主动申请 / 每次使用如果没权限都要申请」：
 * 缺通知先弹通知对话框，缺电池优化再弹电池优化对话框，永久拒绝时改跳设置页；
 * 每次回到前台（每次使用）都重新走一遍判断。
 */
class BackgroundSyncPermissionsTest {
    @Test
    fun fullyGrantedNeedsNothing() {
        assertNull(BackgroundSyncPermissions.nextAction(34, notificationsGranted = true, batteryUnrestricted = true, notificationDialogBlocked = false))
        assertTrue(BackgroundSyncPermissions.missing(34, true, true).isEmpty())
    }

    @Test
    fun notificationDialogIsFirst() {
        // Android 13+ 没通知权限：先弹通知对话框（对话框还没被永久拒绝）
        assertEquals(
            BackgroundSyncPermissions.ACTION_REQUEST_NOTIFICATIONS,
            BackgroundSyncPermissions.nextAction(33, notificationsGranted = false, batteryUnrestricted = false, notificationDialogBlocked = false),
        )
        // 通知拿到之后轮到电池优化
        assertEquals(
            BackgroundSyncPermissions.ACTION_REQUEST_BATTERY,
            BackgroundSyncPermissions.nextAction(33, notificationsGranted = true, batteryUnrestricted = false, notificationDialogBlocked = false),
        )
    }

    @Test
    fun permanentlyDeniedNotificationOpensSettings() {
        assertEquals(
            BackgroundSyncPermissions.ACTION_NOTIFICATION_SETTINGS,
            BackgroundSyncPermissions.nextAction(34, notificationsGranted = false, batteryUnrestricted = true, notificationDialogBlocked = true),
        )
    }

    @Test
    fun android12AndBelowHasNoNotificationRuntimePermission() {
        // API 32 及以下：POST_NOTIFICATIONS 声明即授予，只关心电池优化
        assertNull(BackgroundSyncPermissions.nextAction(32, notificationsGranted = false, batteryUnrestricted = true, notificationDialogBlocked = false))
        assertEquals(
            BackgroundSyncPermissions.ACTION_REQUEST_BATTERY,
            BackgroundSyncPermissions.nextAction(32, notificationsGranted = false, batteryUnrestricted = false, notificationDialogBlocked = false),
        )
        assertEquals(listOf(BackgroundSyncPermissions.BATTERY), BackgroundSyncPermissions.missing(32, notificationsGranted = false, batteryUnrestricted = false))
    }

    @Test
    fun missingKeepsStableOrder() {
        assertEquals(
            listOf(BackgroundSyncPermissions.NOTIFICATIONS, BackgroundSyncPermissions.BATTERY),
            BackgroundSyncPermissions.missing(35, notificationsGranted = false, batteryUnrestricted = false),
        )
        assertEquals(listOf(BackgroundSyncPermissions.NOTIFICATIONS), BackgroundSyncPermissions.missing(35, false, true))
    }

    @Test
    fun autoRequestOnlyWhenBoundAndNotAskedYet() {
        // 已绑定中枢 + 同步开着 + 本次前台还没问过：申请
        assertTrue(BackgroundSyncPermissions.shouldAutoRequest("member", enabled = true, alreadyAsked = false))
        // 同一段前台已经问过：不重复弹
        assertFalse(BackgroundSyncPermissions.shouldAutoRequest("member", enabled = true, alreadyAsked = true))
        // 没绑定 / 同步停用：不打扰
        assertFalse(BackgroundSyncPermissions.shouldAutoRequest("none", enabled = true, alreadyAsked = false))
        assertFalse(BackgroundSyncPermissions.shouldAutoRequest("member", enabled = false, alreadyAsked = false))
    }

    @Test
    fun labelsAreUserReadable() {
        assertEquals("通知", BackgroundSyncPermissions.label(BackgroundSyncPermissions.NOTIFICATIONS))
        assertEquals("电池优化", BackgroundSyncPermissions.label(BackgroundSyncPermissions.BATTERY))
    }
}
