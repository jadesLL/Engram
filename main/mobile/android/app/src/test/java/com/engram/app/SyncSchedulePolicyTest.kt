package com.engram.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 前台周期同步与缺口补轮的判定（纯逻辑，JVM 单测覆盖各分支）。
 *
 * 背景：安卓端没有后台调度，App 停在前台不动时原来永远不拉中枢改动。心跳必须
 * 严格限定在「前台 + 成员 + 启用 + 空闲」，否则会在锁屏/未绑定/正在同步时空转。
 */
class SyncSchedulePolicyTest {
    private val now = 10_000_000L

    @Test
    fun dueWhenForegroundIdleAndIntervalElapsed() {
        assertTrue(SyncSchedulePolicy.due(now, now - 90_000L, true, "member", true, false))
        assertTrue(SyncSchedulePolicy.due(now, now - 200_000L, true, "member", true, false))
    }

    @Test
    fun notDueWhenIntervalNotElapsed() {
        assertFalse(SyncSchedulePolicy.due(now, now - 89_999L, true, "member", true, false))
    }

    @Test
    fun neverRunsInBackground() {
        assertFalse(SyncSchedulePolicy.due(now, 0L, foreground = false, role = "member", enabled = true, running = false))
    }

    @Test
    fun neverRunsForNonMemberOrDisabled() {
        assertFalse(SyncSchedulePolicy.due(now, 0L, true, role = "none", enabled = true, running = false))
        assertFalse(SyncSchedulePolicy.due(now, 0L, true, role = "hub", enabled = true, running = false))
        assertFalse(SyncSchedulePolicy.due(now, 0L, true, role = "member", enabled = false, running = false))
    }

    @Test
    fun neverOverlapsRunningRound() {
        assertFalse(SyncSchedulePolicy.due(now, 0L, true, "member", true, running = true))
    }

    @Test
    fun firstRoundFiresImmediately() {
        // 从未同步过（lastSyncAt=0）：回前台/心跳立刻补一轮
        assertTrue(SyncSchedulePolicy.due(now, 0L, true, "member", true, false))
    }

    @Test
    fun clockSkewDoesNotFire() {
        // 用户把系统时间往回调：差值变负，不能判成到期（否则会连续空转）
        assertFalse(SyncSchedulePolicy.due(now, now + 60_000L, true, "member", true, false))
    }

    @Test
    fun intervalIsNinetySeconds() {
        assertEquals(90_000L, SyncSchedulePolicy.HEARTBEAT_INTERVAL_MS)
        assertEquals(30_000L, SyncSchedulePolicy.GAP_RETRY_DELAY_MS)
    }

    @Test
    fun gapRetryOnlyInForegroundAndThrottled() {
        assertTrue(SyncSchedulePolicy.gapRetryDue(now, 0L, foreground = true))
        assertFalse(SyncSchedulePolicy.gapRetryDue(now, 0L, foreground = false))
        // 5 分钟内已经排过：不重复排，避免坏网/持续 404 时每轮都排
        assertFalse(SyncSchedulePolicy.gapRetryDue(now, now - 60_000L, foreground = true))
        assertTrue(SyncSchedulePolicy.gapRetryDue(now, now - SyncSchedulePolicy.GAP_RETRY_MIN_INTERVAL_MS, foreground = true))
        // 时钟回拨同样不触发
        assertFalse(SyncSchedulePolicy.gapRetryDue(now, now + 1_000L, foreground = true))
    }
}
