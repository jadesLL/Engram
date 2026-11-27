package com.engram.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/**
 * 推送永久失败判定（与桌面/Docker 端 client.ts 的 isPermanentPushError 同口径）。
 */
class SyncPushErrorPolicyTest {
    @Test
    fun permanent4xxAndOversizeErrorsAreDropped() {
        assertTrue(SyncPushErrorPolicy.isPermanent(IllegalStateException("中枢返回 400：路径无效")))
        assertTrue(SyncPushErrorPolicy.isPermanent(IllegalStateException("中枢返回 404：not found")))
        assertTrue(SyncPushErrorPolicy.isPermanent(IllegalStateException("中枢返回 413：too large")))
        assertTrue(SyncPushErrorPolicy.isPermanent(IllegalStateException("中枢返回 422：bad payload")))
        assertTrue(SyncPushErrorPolicy.isPermanent(IllegalArgumentException("同步文件超过 200 MB 上限")))
    }

    @Test
    fun authAndRateLimit4xxRemainRetryable() {
        assertFalse(SyncPushErrorPolicy.isPermanent(IllegalStateException("中枢返回 401：unauthorized")))
        assertFalse(SyncPushErrorPolicy.isPermanent(IllegalStateException("中枢返回 403：forbidden")))
        assertFalse(SyncPushErrorPolicy.isPermanent(IllegalStateException("中枢返回 408：timeout")))
        assertFalse(SyncPushErrorPolicy.isPermanent(IllegalStateException("中枢返回 429：too many requests")))
    }

    @Test
    fun serverErrorsAndNetworkFailuresRemainRetryable() {
        assertFalse(SyncPushErrorPolicy.isPermanent(IllegalStateException("中枢返回 500：internal")))
        assertFalse(SyncPushErrorPolicy.isPermanent(IllegalStateException("中枢返回 502：bad gateway")))
        assertFalse(SyncPushErrorPolicy.isPermanent(IOException("Connection reset")))
    }
}
