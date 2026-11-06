package com.engram.app

/**
 * 安卓成员端「前台周期同步」的判定（纯逻辑，JVM 单测覆盖；调度在 [SyncEngine]）。
 *
 * 背景（2026-11 用户报障「有的客户端不同步」）：安卓端没有任何常驻后台调度，同步只由
 * 前台事件触发（回前台 / 本机写入 / 手动 / 换网 / 失败重试）。App 停在前台不动时，
 * 中枢侧的改动——包括只能在同步轮收尾对齐的「已提炼」标记——永远不会被拉下来。
 * 这里给一个前台心跳节拍：满足条件时让 [SyncEngine.request] 跑一轮轻量增量同步。
 *
 * 约束：
 *  - 只在 前台 + 成员角色 + 已启用 + 没有在跑 时触发；
 *  - 距上次成功同步 [HEARTBEAT_INTERVAL_MS]（90 秒）才触发，避免与 15 分钟 heal 抢节奏；
 *  - 时钟回拨（now < lastSync）不触发。
 */
internal object SyncSchedulePolicy {
    /** 前台心跳间隔：90 秒（普通增量轮，很小；heal 仍是 15 分钟一次，见 [SyncHealPolicy]） */
    const val HEARTBEAT_INTERVAL_MS = 90_000L
    /** 心跳检查节拍：30 秒看一次是否到期（不是每 30 秒同步一次） */
    const val HEARTBEAT_CHECK_MS = 30_000L
    /** 一轮有拉取缺口时，30 秒后补一轮 */
    const val GAP_RETRY_DELAY_MS = 30_000L
    /** 缺口自愈的最小间隔：避免坏网时每轮都排一次（刷屏/空转） */
    const val GAP_RETRY_MIN_INTERVAL_MS = 5 * 60_000L

    fun due(
        nowMs: Long,
        lastSyncAtMs: Long,
        foreground: Boolean,
        role: String?,
        enabled: Boolean,
        running: Boolean,
        intervalMs: Long = HEARTBEAT_INTERVAL_MS,
    ): Boolean {
        if (!foreground) return false
        if (role != "member" || !enabled) return false
        if (running) return false
        if (lastSyncAtMs <= 0L) return true
        val elapsed = nowMs - lastSyncAtMs
        // 时钟回拨（用户调系统时间）时差值为负，不触发
        if (elapsed < 0L) return false
        return elapsed >= intervalMs
    }

    /** 本轮有缺口（拉取失败/旧路径 404/对账没落地）时，是否排一次补轮 */
    fun gapRetryDue(
        nowMs: Long,
        lastGapRetryAtMs: Long,
        foreground: Boolean,
        minIntervalMs: Long = GAP_RETRY_MIN_INTERVAL_MS,
    ): Boolean {
        if (!foreground) return false
        if (lastGapRetryAtMs <= 0L) return true
        val elapsed = nowMs - lastGapRetryAtMs
        if (elapsed < 0L) return false
        return elapsed >= minIntervalMs
    }
}
