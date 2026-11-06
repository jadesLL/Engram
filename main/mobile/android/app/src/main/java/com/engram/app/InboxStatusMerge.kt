package com.engram.app

/**
 * 收集箱状态的合并优先级（纯逻辑，JVM 单测直接钉边界；不碰 Android API）。
 *
 * 背景（2026-11 用户报障「已整理（已入库/已转换）在其他端变成待整理」）：
 * 手机端原来只有「中枢在线」时才用中枢状态覆盖本机列表，而本机条目状态被硬编码成
 * pending，且合并被 `sync.connected` 一票否决——冷启动首轮同步完成前、任一轮失败后、
 * 离线时都会倒回「待整理」。
 *
 * 这里的规则：
 *  1. 中枢成功响应（最新）> 本地缓存（updatedAt 新者）> 本地磁盘推导；
 *  2. 任何情况下「磁盘上转换产物 / 入库副本确实存在」都不得显示 pending——
 *     这是用户看得见的事实，比任何远端状态都可信；
 *  3. 中枢没返回的路径保留缓存/本地结果（中枢可能只是暂时没这份原件）。
 *
 * 纯逻辑的原因：合并规则要能被 JVM 单测覆盖，不依赖 SQLite / 网络 / JSON。
 */
data class InboxItemStatus(
    val path: String,
    /** pending / converting / converted / adopted / failed */
    val status: String,
    val derivedPath: String? = null,
    val adoptedPath: String? = null,
    val error: String = "",
    /** 该状态来自哪次观测（毫秒）：0 = 本地磁盘推导（没有"时刻"语义，永远让缓存/中枢先） */
    val updatedAt: Long = 0L,
    /** 本地磁盘确证：转换产物（derivedPath）或入库副本（adoptedPath）存在 */
    val artifactOnDisk: Boolean = false,
) {
    val isPending: Boolean get() = status == PENDING

    companion object {
        const val PENDING = "pending"
        const val CONVERTING = "converting"
        const val CONVERTED = "converted"
        const val ADOPTED = "adopted"
        const val FAILED = "failed"

        /** 状态优先级：越靠前越"靠后的事实"（用于兜底修正常见回退：pending 覆盖 adopted） */
        fun isTerminalArtifact(status: String): Boolean = status == ADOPTED || status == CONVERTED
    }
}

internal object InboxStatusMerge {
    /**
     * 合并本地推导、缓存与中枢响应。
     *
     * @param local 本轮由磁盘推导出的状态（updatedAt 恒为 0）
     * @param cached 上次中枢成功响应落盘的状态（updatedAt = 那次响应的时刻）
     * @param hub 本次中枢成功响应的状态；null 表示本轮没拿到（离线/中枢异常）——此时不得回退
     */
    fun merge(
        local: List<InboxItemStatus>,
        cached: List<InboxItemStatus>,
        hub: List<InboxItemStatus>?,
    ): Map<String, InboxItemStatus> {
        val localByPath = local.associateBy { it.path }
        val cacheByPath = cached.associateBy { it.path }
        val hubByPath = hub?.associateBy { it.path }
        val out = LinkedHashMap<String, InboxItemStatus>(localByPath.size)
        for ((path, localItem) in localByPath) {
            val cachedItem = cacheByPath[path]
            // 本地推导没有时间戳：只要缓存存在且来自中枢成功响应，就认为缓存比"磁盘推导"新。
            // 但缓存本身不能盖掉"产物确实存在"的证据（见 ensureArtifactVisible）。
            val freshCache = cachedItem?.takeIf { it.updatedAt > localItem.updatedAt }
            val base = freshCache ?: localItem
            val merged = when {
                hubByPath == null -> base
                else -> hubByPath[path]?.let { hubItem -> preferHub(hubItem, localItem, base) } ?: base
            }
            out[path] = ensureArtifactVisible(merged, localItem, base)
        }
        return out
    }

    /**
     * 中枢状态优先：中枢本轮成功响应是最新事实（可能包含本地推不出的 converting / failed）。
     * 但中枢说 pending 而本地磁盘确有产物时不能照抄（历史 bug 的核心，见 ensureArtifactVisible）。
     */
    private fun preferHub(hub: InboxItemStatus, local: InboxItemStatus, base: InboxItemStatus): InboxItemStatus {
        if (hub.status != InboxItemStatus.PENDING) {
            // 中枢已入库/已转换但没带路径（旧中枢字段缺失）时，用本地已知路径补全展示
            val derivedPath = hub.derivedPath ?: local.derivedPath ?: base.derivedPath
            val adoptedPath = hub.adoptedPath
                ?: (if (hub.status == InboxItemStatus.ADOPTED) local.adoptedPath ?: base.adoptedPath else null)
            return hub.copy(derivedPath = derivedPath, adoptedPath = adoptedPath)
        }
        // 中枢说待整理：保留中枢的 job/error 口径，但路径与"产物存在"的结论下面兜底
        return hub.copy(
            derivedPath = hub.derivedPath ?: local.derivedPath ?: base.derivedPath,
            adoptedPath = hub.adoptedPath ?: local.adoptedPath ?: base.adoptedPath,
            error = hub.error.ifBlank { base.error },
        )
    }

    /**
     * 产物兜底：磁盘上已经存在入库副本 / 转换产物时，任何 pending 结论都必须被修正成
     * 已入库 / 已转换。这是"已整理不能变回未整理"的最后一道防线。
     */
    private fun ensureArtifactVisible(
        merged: InboxItemStatus,
        local: InboxItemStatus,
        base: InboxItemStatus,
    ): InboxItemStatus {
        if (!merged.isPending) return merged
        val adopted = merged.adoptedPath ?: local.adoptedPath ?: base.adoptedPath
        if (adopted != null || local.artifactOnDisk && local.adoptedPath != null) {
            return merged.copy(
                status = InboxItemStatus.ADOPTED,
                adoptedPath = adopted,
                derivedPath = merged.derivedPath ?: local.derivedPath ?: base.derivedPath,
            )
        }
        val derived = merged.derivedPath ?: local.derivedPath ?: base.derivedPath
        if (derived != null || local.artifactOnDisk && local.derivedPath != null) {
            return merged.copy(status = InboxItemStatus.CONVERTED, derivedPath = derived)
        }
        return merged
    }
}
