package com.engram.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 周期自愈对账的判定（纯逻辑，不碰 Android API）：与桌面成员 15 分钟 HEAL_INTERVAL_MS
 * 同口径；手机没有后台调度，这条规则决定「这一轮前台同步要不要顺带跑一次全量对账」。
 */
class SyncHealPolicyTest {
    @Test
    fun firstRoundAfterBindingHealsImmediately() {
        // 从未成功对账过（lastHealAtMs = 0）：下一次前台同步立即补一轮
        assertTrue(SyncHealPolicy.due(nowMs = 1_000_000L, lastHealAtMs = 0L, cursor = 42L))
    }

    @Test
    fun notDueBeforeIntervalElapses() {
        val last = 1_000_000L
        assertFalse(SyncHealPolicy.due(last + SyncHealPolicy.HEAL_INTERVAL_MS - 1, last, 42L))
    }

    @Test
    fun dueOnceIntervalElapses() {
        val last = 1_000_000L
        assertTrue(SyncHealPolicy.due(last + SyncHealPolicy.HEAL_INTERVAL_MS, last, 42L))
    }

    @Test
    fun noCursorLetsFirstBindPathHandleIt() {
        // 游标 0 由「首次绑定全量对账」处理，周期自愈不重复触发
        assertFalse(SyncHealPolicy.due(9_999_999L, 0L, 0L))
    }

    @Test
    fun intervalMatchesDesktopHealCadence() {
        // 桌面/Docker 成员端 server/src/sync/client.ts 的 HEAL_INTERVAL_MS = 15 * 60_000
        assertEquals(15 * 60_000L, SyncHealPolicy.HEAL_INTERVAL_MS)
    }

    @Test
    fun clockSkewNeverTriggersAHeal() {
        // 用户把系统时间往回调：差值变负，不能判成到期
        assertFalse(SyncHealPolicy.due(nowMs = 500L, lastHealAtMs = 1_000_000L, cursor = 42L))
    }
}
