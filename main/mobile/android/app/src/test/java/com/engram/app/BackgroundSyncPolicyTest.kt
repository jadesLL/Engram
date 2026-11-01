package com.engram.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「退到后台后继续同步最多 5 分钟」的宽限策略回归（纯逻辑，不碰 Android API）：
 * 只放行已经发生的工作；窗口从进入后台起算，到期边界之后一律不再允许。
 */
class BackgroundSyncPolicyTest {
    @Test
    fun foregroundNeverStartsGrace() {
        // 前台本来就会同步，不需要宽限
        assertFalse(BackgroundSyncPolicy.shouldStartGrace(true, true, true, 3, true))
    }

    @Test
    fun runningOrQueuedWorkStartsGrace() {
        assertTrue(BackgroundSyncPolicy.shouldStartGrace(false, true, running = true, pendingOutbox = 0, rerunQueued = false))
        assertTrue(BackgroundSyncPolicy.shouldStartGrace(false, true, running = false, pendingOutbox = 1, rerunQueued = false))
        assertTrue(BackgroundSyncPolicy.shouldStartGrace(false, true, running = false, pendingOutbox = 0, rerunQueued = true))
    }

    @Test
    fun idleOrDisabledSyncSkipsGrace() {
        // 没有在跑、没有待推、没有排队：进后台没有必要开窗口
        assertFalse(BackgroundSyncPolicy.shouldStartGrace(false, true, running = false, pendingOutbox = 0, rerunQueued = false))
        // 未绑定中枢 / 同步关闭：别为不可能发生的同步空转
        assertFalse(BackgroundSyncPolicy.shouldStartGrace(false, false, running = true, pendingOutbox = 5, rerunQueued = true))
    }

    @Test
    fun graceLastsFiveMinutesFromBackgrounding() {
        val backgroundAt = 1_000_000L
        val deadline = BackgroundSyncPolicy.deadlineFrom(backgroundAt)
        assertEquals(backgroundAt + 5 * 60_000L, deadline)
        assertEquals(5 * 60_000L, BackgroundSyncPolicy.remainingMs(backgroundAt, deadline))
        assertTrue(BackgroundSyncPolicy.inGrace(backgroundAt + 1, deadline))
        assertTrue(BackgroundSyncPolicy.inGrace(deadline - 1, deadline))
    }

    @Test
    fun graceExpiresAtDeadline() {
        val deadline = BackgroundSyncPolicy.deadlineFrom(2_000_000L)
        assertFalse(BackgroundSyncPolicy.inGrace(deadline, deadline))
        assertFalse(BackgroundSyncPolicy.inGrace(deadline + 1, deadline))
        // 0 = 从未开过宽限（前台 / 已收尾）
        assertFalse(BackgroundSyncPolicy.inGrace(deadline - 1, 0L))
        assertEquals(0L, BackgroundSyncPolicy.remainingMs(deadline + 5_000L, deadline))
    }
}
