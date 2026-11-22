package com.engram.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 补积压时的裁剪规则：同一路径只应用最后一条、hash 一致就跳过。
 * 算错的表现是「少拉了一条新内容」或「明明已是最新还在反复下载」。
 */
class SyncReplayPolicyTest {
    private fun op(kind: String, target: String, hash: String = "") = SyncReplayPolicy.Op(kind, target, hash)

    @Test fun keepsOnlyTheLastPageOpPerTarget() {
        val ops = listOf(
            op("page", "AIWorks/log/log.md"),
            op("page", "AIWorks/index/index.md"),
            op("page", "AIWorks/log/log.md"),
            op("page", "AIWorks/log/log.md"),
        )
        assertEquals(setOf(0, 2), SyncReplayPolicy.superseded(ops))
    }

    @Test fun filesAndPagesAreTrackedIndependently() {
        val ops = listOf(
            op("file", "assets/a.png"),
            op("page", "assets/a.png"),
        )
        assertTrue(SyncReplayPolicy.superseded(ops).isEmpty())
    }

    @Test fun neverDropsMoveOrDeleteOps() {
        val ops = listOf(
            op("delete", "Wiki/旧.md"),
            op("move", "Wiki/新.md"),
            op("delete", "Wiki/旧.md"),
        )
        assertTrue(SyncReplayPolicy.superseded(ops).isEmpty())
    }

    @Test fun skipsUnchangedContentByHash() {
        assertTrue(SyncReplayPolicy.unchanged(op("file", "收集箱/a.html", "abc"), "abc"))
        assertTrue(SyncReplayPolicy.unchanged(op("page", "Wiki/甲.md", "abc"), "abc"))
    }

    @Test fun missingHashOrDifferentHashStillFetches() {
        assertFalse(SyncReplayPolicy.unchanged(op("page", "Wiki/甲.md"), ""))
        assertFalse(SyncReplayPolicy.unchanged(op("page", "Wiki/甲.md", "abc"), "def"))
        assertFalse(SyncReplayPolicy.unchanged(op("file", "收集箱/a.html", ""), ""))
    }

    @Test fun nonContentKindsAreNeverSkippedByHash() {
        assertFalse(SyncReplayPolicy.unchanged(op("board", "default", "abc"), "abc"))
        assertFalse(SyncReplayPolicy.unchanged(op("preference", "home_layout", "abc"), "abc"))
    }
}
