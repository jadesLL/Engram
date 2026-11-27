package com.engram.app

/**
 * 推送永久失败判定（纯逻辑，JVM 单测覆盖）。
 *
 * 与桌面/Docker 端 `server/src/sync/client.ts` 的 `isPermanentPushError` 同口径：
 *  - 本地超限拦截（>200MB）或中枢明确 4xx 拒绝（排除 401/403/408/429）→ 丢弃毒条目继续推送；
 *  - 401/403（可能重新配对恢复）、408/429（超时/限流）、5xx 与网络异常 → 保留队列退避重试。
 */
internal object SyncPushErrorPolicy {
    private val STATUS_PATTERN = Regex("""中枢返回\s*(\d{3})""")
    private val RETRYABLE_4XX = setOf(401, 403, 408, 429)

    fun isPermanent(error: Throwable): Boolean {
        val message = error.message.orEmpty()
        if (message.contains("同步文件超过 200 MB 上限")) return true
        val status = STATUS_PATTERN.find(message)?.groupValues?.getOrNull(1)?.toIntOrNull() ?: return false
        return status in 400..499 && status !in RETRYABLE_4XX
    }
}
