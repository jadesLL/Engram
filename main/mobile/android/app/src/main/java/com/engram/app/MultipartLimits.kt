package com.engram.app

/**
 * 手机端 multipart 的 per-part 阈值。
 *
 * 坑：Ktor 3 的 `receiveMultipart(formFieldLimit)` 卡的是**每一个 part**（文件 part 也算），
 * 不是只看表单字段。2026-11 手机端导入收集箱踩过一次：转发按 1 MB 传，超过 1 MB 的照片
 * （HEIC 普遍 2–5 MB）在 forEachPart 里抛
 * `Limit of 1048576 bytes exceeded while searching for "----WebKitFormBoundary…"`，
 * 整份文件存不进去，收集箱里只剩报错。
 */
internal object MultipartLimits {
    /**
     * 收集箱转发中枢时的单 part 上限。
     *
     * 中枢收集箱本身不设单文件上限（`fileSize: Infinity`），手机端也不该比它更严：照片、视频、
     * PDF 都可能几 GB，这里取 4 GB 当作「近似不限」（Ktor 要求给一个具体数值）。
     */
    const val HUB_UPLOAD_BYTES = 4L * 1024 * 1024 * 1024

    /** 表单字段（`dir` / `sourceUrl`）自身的小上限：sourceUrl 在 web 侧已截到 4096 字符 */
    const val HUB_FIELD_BYTES = 1024L * 1024
}
