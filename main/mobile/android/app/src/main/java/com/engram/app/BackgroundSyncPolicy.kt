package com.engram.app

/**
 * 「退到后台后继续把这一轮同步跑完」的宽限策略（纯逻辑，JVM 单测覆盖；调度在 [SyncEngine]）。
 *
 * 安卓端没有同步 SSE / WorkManager / 常驻前台服务：同步只由前台事件触发，进入后台原本会
 * 立刻取消在途请求。现实中常见的卡点是「刚改完或刚点全量对账就切到别的 App」——这一轮被
 * 掐断后只能等下次回前台。这里给一个有上限的宽限窗口，补上这几分钟：
 *
 * - 只在有工作时开启：正在同步、有本机待推队列、或还有一轮排队请求；
 * - 窗口从进入后台起算，最多 [GRACE_MS]（5 分钟），不凭空发起无关的新一轮；
 * - 窗口内一轮收敛且待推队列清空就提前结束，不空等；
 * - 到期 / 失败立即收尾，待推队列留在 SQLite，回前台按原逻辑继续。
 *
 * 不使用前台服务，因此不改变「没有常驻前台服务 / 通知」的形态；系统若冻结后台进程，
 * 宽限可能提前失效（回前台会立即补一轮），属于该方案的已知边界。
 */
internal object BackgroundSyncPolicy {
    /** 进入后台后最多继续同步的时长（需求口径 3~5 分钟，取上限 5 分钟） */
    const val GRACE_MS = 5 * 60_000L

    /** 是否值得开后台宽限：只放行「已经发生」的工作，不凭空拉新一轮 */
    fun shouldStartGrace(
        foreground: Boolean,
        memberEnabled: Boolean,
        running: Boolean,
        pendingOutbox: Int,
        rerunQueued: Boolean,
    ): Boolean = !foreground && memberEnabled && (running || pendingOutbox > 0 || rerunQueued)

    fun deadlineFrom(backgroundAtMs: Long): Long = backgroundAtMs + GRACE_MS

    fun inGrace(nowMs: Long, deadlineMs: Long): Boolean = deadlineMs > 0L && nowMs < deadlineMs

    fun remainingMs(nowMs: Long, deadlineMs: Long): Long = (deadlineMs - nowMs).coerceAtLeast(0L)
}
