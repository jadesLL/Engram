package com.engram.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 收集箱上传阈值的回归测试。
 *
 * 2026-11 手机端导入 HEIC 照片失败：Ktor 的 formFieldLimit 是**每个 part**（含文件）的硬阈值，
 * 当时按 1 MB 传，2–5 MB 的照片整份被拒。这里钉住「文件口径必须远大于照片/视频体积」。
 */
class MultipartLimitsTest {
    @Test
    fun `收集箱转发的单 part 阈值远高于常见照片与视频`() {
        // 旧值 1 MiB 就是这么翻车的：HEIC 照片普遍 2–5 MB
        assertTrue(
            "单 part 阈值必须大于手机照片（4 MB）",
            MultipartLimits.HUB_UPLOAD_BYTES > 4L * 1024 * 1024
        )
        assertTrue(
            "单 part 阈值必须容得下短视频（200 MB）",
            MultipartLimits.HUB_UPLOAD_BYTES > 200L * 1024 * 1024
        )
        // 中枢收集箱不设单文件上限，手机端只做「明显异常」的兜底
        assertTrue("阈值至少 1 GB", MultipartLimits.HUB_UPLOAD_BYTES >= 1024L * 1024 * 1024)
    }

    @Test
    fun `表单字段仍保持 1 MB 的小上限`() {
        assertEquals(1024L * 1024, MultipartLimits.HUB_FIELD_BYTES)
        assertTrue(MultipartLimits.HUB_FIELD_BYTES < MultipartLimits.HUB_UPLOAD_BYTES)
    }
}
