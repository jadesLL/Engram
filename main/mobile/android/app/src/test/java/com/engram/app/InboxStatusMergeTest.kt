package com.engram.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 收集箱状态合并的边界（纯逻辑，JVM 单测直接钉边界）。
 *
 * 用户报障「已整理（已入库/已转换）在其他端变成待整理」：合并规则一旦让 pending 覆盖
 * 已入库，或者离线时丢掉上次已知状态，手机上就会看到"整理过的东西又回来了"。
 */
class InboxStatusMergeTest {
    private fun status(
        path: String,
        status: String,
        derived: String? = null,
        adopted: String? = null,
        updatedAt: Long = 0L,
        artifact: Boolean = derived != null || adopted != null,
    ) = InboxItemStatus(path, status, derived, adopted, updatedAt = updatedAt, artifactOnDisk = artifact)

    private val original = "收集箱/合同.pdf"
    private val derived = "收集箱/转换结果/合同-解析.md"
    private val adopted = "原始资料/文档/合同-解析.md"

    @Test
    fun adoptedIsNeverDowngradedByHubPending() {
        // 本机磁盘上入库副本明明在（adopted），中枢却说 pending（异常/延迟/旧版）——必须保留已入库
        val local = listOf(status(original, InboxItemStatus.ADOPTED, derived, adopted))
        val hub = listOf(status(original, InboxItemStatus.PENDING, updatedAt = 2_000L))
        val merged = InboxStatusMerge.merge(local, emptyList(), hub)[original]!!
        assertEquals(InboxItemStatus.ADOPTED, merged.status)
        assertEquals(adopted, merged.adoptedPath)
    }

    @Test
    fun offlineUsesLastKnownCacheInsteadOfPending() {
        // 中枢请求失败（hub = null）：用上次成功响应落盘的缓存，不能倒回待整理
        val local = listOf(status(original, InboxItemStatus.PENDING))
        val cached = listOf(status(original, InboxItemStatus.ADOPTED, derived, adopted, updatedAt = 1_000L))
        val merged = InboxStatusMerge.merge(local, cached, hub = null)[original]!!
        assertEquals(InboxItemStatus.ADOPTED, merged.status)
        assertEquals(adopted, merged.adoptedPath)
    }

    @Test
    fun freshHubWinsOverOlderCache() {
        // 中枢成功响应（updatedAt 更新）优先于缓存：中枢已转换，缓存还停在更早的已入库时以中枢为准
        val local = listOf(status(original, InboxItemStatus.PENDING))
        val cached = listOf(status(original, InboxItemStatus.ADOPTED, derived, adopted, updatedAt = 1_000L))
        val hub = listOf(status(original, InboxItemStatus.CONVERTED, derived, updatedAt = 2_000L))
        val merged = InboxStatusMerge.merge(local, cached, hub)[original]!!
        assertEquals(InboxItemStatus.CONVERTED, merged.status)
        assertEquals(derived, merged.derivedPath)
    }

    @Test
    fun artifactOnDiskFixesPendingEvenWithoutHubOrCache() {
        // 本地推导发现产物存在（artifactOnDisk），即使本轮状态兜底成 pending，也要修正成已转换
        val local = listOf(status(original, InboxItemStatus.PENDING, derived, artifact = true))
        val merged = InboxStatusMerge.merge(local, emptyList(), hub = null)[original]!!
        assertEquals(InboxItemStatus.CONVERTED, merged.status)
        assertEquals(derived, merged.derivedPath)
    }

    @Test
    fun hubPathMissingKeepsCacheResult() {
        // 中枢这次没回这个路径（例如原件刚被移出收集箱）：保留缓存/本地结果，不从 pending 开始
        val local = listOf(status(original, InboxItemStatus.PENDING))
        val cached = listOf(status(original, InboxItemStatus.CONVERTED, derived, updatedAt = 1_000L))
        val hub = emptyList<InboxItemStatus>()
        val merged = InboxStatusMerge.merge(local, cached, hub)[original]!!
        assertEquals(InboxItemStatus.CONVERTED, merged.status)
    }

    @Test
    fun hubConvertingAndFailedAreHonoured() {
        // 中枢才知道的状态（转换中 / 失败）要能显示出来，不被本地 pending 覆盖
        val local = listOf(status(original, InboxItemStatus.PENDING))
        val converting = listOf(status(original, InboxItemStatus.CONVERTING, updatedAt = 2_000L))
        assertEquals(
            InboxItemStatus.CONVERTING,
            InboxStatusMerge.merge(local, emptyList(), converting)[original]!!.status,
        )
        val failed = listOf(status(original, InboxItemStatus.FAILED, updatedAt = 2_000L).copy(error = "转换失败"))
        val failedResult = InboxStatusMerge.merge(local, emptyList(), failed)[original]!!
        assertEquals(InboxItemStatus.FAILED, failedResult.status)
        assertEquals("转换失败", failedResult.error)
    }

    @Test
    fun pathsAreIndependent() {
        val other = "收集箱/另一个.pdf"
        val local = listOf(
            status(original, InboxItemStatus.ADOPTED, derived, adopted),
            status(other, InboxItemStatus.PENDING),
        )
        val merged = InboxStatusMerge.merge(local, emptyList(), hub = null)
        assertEquals(InboxItemStatus.ADOPTED, merged[original]!!.status)
        assertEquals(InboxItemStatus.PENDING, merged[other]!!.status)
        assertNull(merged[other]!!.adoptedPath)
    }
}
