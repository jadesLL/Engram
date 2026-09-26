package com.engram.app

import org.json.JSONArray
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * Android 本地服务到 Docker 中枢内置 Agent 的窄代理。
 *
 * 手机只持有成员 token，不保存 owner 密码和模型 Key；真正的 dsh 进程、会话库和长任务都
 * 留在 24 小时在线的中枢。WebView 退后台导致 SSE 断开不会取消远端 run，回前台后聊天
 * store 会通过 active + snapshot 接回现场。
 */
class AgentBridge(private val db: LocalDatabase, private val secrets: SecretStore) {
    data class Response(val status: Int, val contentType: String, val body: ByteArray)
    data class Stream(val connection: HttpURLConnection, val status: Int, val contentType: String)

    fun configured(): Boolean =
        db.setting("sync_role") == "member" &&
            db.setting("sync_enabled") == "1" &&
            !db.setting("sync_hub_url").isNullOrBlank() &&
            !secrets.get("sync_hub_token").isNullOrBlank()

    fun request(method: String, path: String, body: String? = null): Response {
        require(configured()) { "请先在多端同步中绑定 Docker 中枢" }
        var failure: Exception? = null
        val urls = baseUrls()
        for ((index, base) in urls.withIndex()) {
            val connection = open(base, method, path, "application/json")
            try {
                if (body != null) {
                    val bytes = body.toByteArray(StandardCharsets.UTF_8)
                    require(bytes.size <= MAX_REQUEST_BYTES) { "Agent 请求过大" }
                    connection.doOutput = true
                    connection.setFixedLengthStreamingMode(bytes.size)
                    connection.outputStream.use { it.write(bytes) }
                }
                val status = connection.responseCode
                val source = if (status in 200..299) connection.inputStream else connection.errorStream
                if (status in RETRYABLE_STATUSES && index < urls.lastIndex) {
                    source?.use { readLimited(it, 64 * 1024L) }
                    failure = IOException("中枢 $base 返回 HTTP $status")
                    continue
                }
                val bytes = source?.use { readLimited(it, MAX_RESPONSE_BYTES) } ?: ByteArray(0)
                return Response(status, connection.contentType ?: "application/json; charset=utf-8", bytes)
            } catch (error: Exception) {
                failure = error
            } finally {
                connection.disconnect()
            }
        }
        throw failure ?: IllegalStateException("无法连接 Docker 中枢 Agent")
    }

    /** 调用方在把 inputStream 转发完成后必须 disconnect。 */
    fun stream(path: String, accept: String = "text/event-stream"): Stream {
        require(configured()) { "请先在多端同步中绑定 Docker 中枢" }
        var failure: Exception? = null
        val urls = baseUrls()
        for ((index, base) in urls.withIndex()) {
            val connection = open(base, "GET", path, accept)
            try {
                connection.readTimeout = 0
                val status = connection.responseCode
                if (status in RETRYABLE_STATUSES && index < urls.lastIndex) {
                    connection.errorStream?.close()
                    failure = IOException("中枢 $base 返回 HTTP $status")
                    connection.disconnect()
                    continue
                }
                return Stream(connection, status, connection.contentType ?: "text/event-stream; charset=utf-8")
            } catch (error: Exception) {
                failure = error
                connection.disconnect()
            }
        }
        throw failure ?: IllegalStateException("无法连接 Docker 中枢 Agent")
    }

    /**
     * multipart 上传转发（收集箱上传）：调用方写完 body 后自行 disconnect。
     * 只走第一个地址——上传带 body，自动重试会重复传输，失败交给用户重试。
     */
    fun openMultipart(path: String, boundary: String): HttpURLConnection {
        require(configured()) { "请先在多端同步中绑定 Docker 中枢" }
        val base = baseUrls().firstOrNull() ?: error("未配置中枢地址")
        val connection = open(base, "POST", path, "application/json")
        connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
        return connection
    }

    private fun open(base: String, method: String, path: String, accept: String): HttpURLConnection {
        val connection = URL(base + path).openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = 6_000
        connection.readTimeout = 60_000
        connection.useCaches = false
        connection.setRequestProperty("Authorization", "Bearer ${token()}")
        connection.setRequestProperty("Accept", accept)
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        connection.setRequestProperty("X-Engram-Client", "android-local")
        return connection
    }

    private fun baseUrls(): List<String> {
        val primary = db.setting("sync_hub_url").orEmpty().trimEnd('/')
        val fallbacks = runCatching { JSONArray(db.setting("sync_direct_urls") ?: "[]") }.getOrDefault(JSONArray())
        return buildList {
            if (primary.startsWith("http://") || primary.startsWith("https://")) add(primary)
            for (index in 0 until fallbacks.length()) {
                fallbacks.optString(index).trimEnd('/').takeIf {
                    it.startsWith("http://") || it.startsWith("https://")
                }?.let(::add)
            }
        }.distinct()
    }

    private fun token(): String = secrets.get("sync_hub_token") ?: error("未配置绑定令牌")

    private fun readLimited(input: java.io.InputStream, limit: Long): ByteArray {
        val output = ByteArrayOutputStream(minOf(limit, 64 * 1024L).toInt())
        val buffer = ByteArray(32 * 1024)
        var total = 0L
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            require(total <= limit) { "Agent 响应过大" }
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }

    companion object {
        private const val MAX_REQUEST_BYTES = 2 * 1024 * 1024
        private const val MAX_RESPONSE_BYTES = 16L * 1024L * 1024L
        private val RETRYABLE_STATUSES = setOf(502, 503, 504)
    }
}
