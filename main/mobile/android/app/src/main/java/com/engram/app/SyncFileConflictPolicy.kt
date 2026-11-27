package com.engram.app

/**
 * 成员端全量对账时的文件冲突裁决策略（纯逻辑，JVM 单测覆盖）。
 *
 * 与桌面/Docker 端 `server/src/sync/client.ts` 同口径：
 *  - 本地没有或首次绑定（preferHub）：拉取中枢；
 *  - 本机 outbox 有尚未推送的改动：保留本机并推给中枢；
 *  - 否则比较磁盘修改时间：中枢带了 `mtime` 且 `local <= hub` → 拉取中枢（较新或同刻以中枢为准）；
 *    只有本机明确更新、或旧中枢未下发 `mtime`（0）时才推送本机版本。
 */
internal object SyncFileConflictPolicy {
    enum class Action { PULL_HUB, PUSH_LOCAL }

    fun resolve(
        localExists: Boolean,
        preferHub: Boolean,
        localPending: Boolean,
        localMtimeMs: Long,
        hubMtimeMs: Long,
    ): Action {
        if (!localExists || preferHub) return Action.PULL_HUB
        if (localPending) return Action.PUSH_LOCAL
        if (hubMtimeMs > 0L && localMtimeMs <= hubMtimeMs) return Action.PULL_HUB
        return Action.PUSH_LOCAL
    }
}
