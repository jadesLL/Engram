package com.engram.app

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 全量对账时的文件冲突裁决（与桌面/Docker 端 client.ts 同口径）。
 */
class SyncFileConflictPolicyTest {
    @Test
    fun missingLocalFilePullsFromHub() {
        assertEquals(
            SyncFileConflictPolicy.Action.PULL_HUB,
            SyncFileConflictPolicy.resolve(
                localExists = false,
                preferHub = false,
                localPending = false,
                localMtimeMs = 0L,
                hubMtimeMs = 1000L,
            ),
        )
    }

    @Test
    fun firstBindPreferHubAlwaysPulls() {
        assertEquals(
            SyncFileConflictPolicy.Action.PULL_HUB,
            SyncFileConflictPolicy.resolve(
                localExists = true,
                preferHub = true,
                localPending = true,
                localMtimeMs = 9999L,
                hubMtimeMs = 1000L,
            ),
        )
    }

    @Test
    fun pendingLocalEditPushesEvenIfHubLooksNewer() {
        assertEquals(
            SyncFileConflictPolicy.Action.PUSH_LOCAL,
            SyncFileConflictPolicy.resolve(
                localExists = true,
                preferHub = false,
                localPending = true,
                localMtimeMs = 1000L,
                hubMtimeMs = 5000L,
            ),
        )
    }

    @Test
    fun newerOrEqualHubMtimePullsInsteadOfOverwritingHub() {
        assertEquals(
            SyncFileConflictPolicy.Action.PULL_HUB,
            SyncFileConflictPolicy.resolve(
                localExists = true,
                preferHub = false,
                localPending = false,
                localMtimeMs = 2000L,
                hubMtimeMs = 3000L,
            ),
        )
        assertEquals(
            SyncFileConflictPolicy.Action.PULL_HUB,
            SyncFileConflictPolicy.resolve(
                localExists = true,
                preferHub = false,
                localPending = false,
                localMtimeMs = 3000L,
                hubMtimeMs = 3000L,
            ),
        )
    }

    @Test
    fun newerLocalFilePushesToHub() {
        assertEquals(
            SyncFileConflictPolicy.Action.PUSH_LOCAL,
            SyncFileConflictPolicy.resolve(
                localExists = true,
                preferHub = false,
                localPending = false,
                localMtimeMs = 5000L,
                hubMtimeMs = 3000L,
            ),
        )
    }

    @Test
    fun legacyHubWithoutMtimeFallsBackToLocalPush() {
        assertEquals(
            SyncFileConflictPolicy.Action.PUSH_LOCAL,
            SyncFileConflictPolicy.resolve(
                localExists = true,
                preferHub = false,
                localPending = false,
                localMtimeMs = 1000L,
                hubMtimeMs = 0L,
            ),
        )
    }
}
