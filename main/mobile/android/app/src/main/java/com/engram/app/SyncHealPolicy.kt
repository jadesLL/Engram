package com.engram.app

/**
 * 安卓端「周期自愈对账」的判定（纯逻辑，JVM 单测覆盖）。
 *
 * 桌面 / Docker 成员端每 15 分钟跑一次全量对账（server/src/sync/client.ts 的 HEAL_INTERVAL_MS），
 * 补的是增量 op 表达不了的那部分：改名 / 移动 / 删除后本机残留的旧路径、旧 op 回放时 404
 * 被跳过的内容。安卓端没有后台调度，把这条自愈挂在「前台事件触发的一轮同步」上：距上次成功
 * 全量对账超过 [HEAL_INTERVAL_MS] 就在本轮同步里顺带跑一次，不额外起定时器、不常驻后台。
 *
 * 首次绑定（游标 0）与手动全量对账不受这里节流，各自单独触发。
 */
internal object SyncHealPolicy {
    /** 与桌面端 HEAL_INTERVAL_MS 同口径：15 分钟 */
    const val HEAL_INTERVAL_MS = 15 * 60_000L

    /**
     * 这一轮是否该顺带跑一次全量对账。
     *
     * @param nowMs 当前时刻
     * @param lastHealAtMs 上次成功全量对账的时刻（0 = 从未跑过 → 立即补一轮）
     * @param cursor 当前增量游标（0 = 还没首绑，走首次绑定对账，不在这里判）
     */
    fun due(nowMs: Long, lastHealAtMs: Long, cursor: Long): Boolean {
        if (cursor <= 0L) return false
        if (lastHealAtMs <= 0L) return true
        // 时钟回拨（now < last）时差值为负，不会触发，避免把用户系统时间调整当成到期
        return nowMs - lastHealAtMs >= HEAL_INTERVAL_MS
    }
}
