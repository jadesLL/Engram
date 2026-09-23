package com.engram.app

import android.util.JsonReader
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Android 成员端一次性同步器。无 SSE、无后台调度：前台事件触发一轮收敛，完成后线程空闲。
 * 本地写入先落 SQLite outbox，网络失败或进程退出均可在下次前台继续。
 */
class SyncEngine(private val db: LocalDatabase, private val secrets: SecretStore) {
    private val executor = Executors.newSingleThreadExecutor()
    private val running = AtomicBoolean(false)
    private val requestWhileRunning = AtomicBoolean(false)
    private val fullRequestWhileRunning = AtomicBoolean(false)
    @Volatile private var foreground = false
    @Volatile private var cancelled = false
    @Volatile var connected = false; private set
    @Volatile var lastError: String? = null; private set
    @Volatile var lastSyncAt: String? = db.setting("sync_last_at"); private set

    fun onForeground() { foreground = true; cancelled = false; request(false) }
    @Volatile private var currentConnection: HttpURLConnection? = null

    fun onBackground() {
        foreground = false
        cancelled = true
        connected = false
        currentConnection?.disconnect()
    }

    fun request(full: Boolean) {
        if (!foreground || db.setting("sync_role") != "member" || db.setting("sync_enabled") != "1") return
        if (!running.compareAndSet(false, true)) {
            requestWhileRunning.set(true)
            if (full) fullRequestWhileRunning.set(true)
            return
        }
        executor.execute {
            var completed = false
            try {
                db.log("info", "start", if (full) "手动全量对账" else "事件触发同步")
                if ((db.setting("sync_cursor")?.toLongOrNull() ?: 0L) <= 0L) {
                    // 首次绑定直接按轻量清单逐项对账，避免从游标 0 一次解析数百条内嵌正文的历史 op。
                    // 对账完成后推进到快照水位，再由 converge 补拉其后发生的少量变化。
                    reconcile(preferHub = true, advanceCursor = true)
                } else if (full) {
                    reconcile()
                }
                converge()
                connected = true
                lastError = null
                lastSyncAt = Instant.now().toString().also { db.setSetting("sync_last_at", it) }
                db.log("info", "sync-done", "同步已收敛")
                completed = true
            } catch (e: Cancelled) {
                db.log("info", "sync-paused", "应用已进入后台，待下次继续")
            } catch (e: Exception) {
                connected = false
                lastError = e.message ?: e.javaClass.simpleName
                db.log("warn", "sync-failed", lastError ?: "同步失败")
            } finally {
                running.set(false)
                val rerun = requestWhileRunning.getAndSet(false)
                val rerunFull = fullRequestWhileRunning.getAndSet(false)
                // 失败后保留持久化 outbox，等待下次前台/本机修改/手动同步。
                // 不能因队列仍非空就立即递归重试：离线时这会形成无限请求与日志风暴。
                if (completed && foreground && !cancelled && (rerun || db.outboxCount() > 0)) {
                    request(rerunFull)
                }
            }
        }
    }

    fun isRunning() = running.get()

    private fun checkActive() { if (cancelled || !foreground) throw Cancelled() }

    private fun converge() {
        repeat(4) {
            checkActive()
            pushOutbox()
            val changed = pullChanges()
            if (db.outboxCount() == 0 && !changed) return
        }
    }

    private fun pushOutbox() {
        for (item in db.outbox()) {
            checkActive()
            val kind = item.getString("kind")
            val target = item.getString("target")
            when (kind) {
                "page" -> {
                    val raw = db.rawPage(target)
                    if (raw == null) { db.ackOutbox(item.getLong("id")); continue }
                    val payload = JSONObject()
                        .put("node_id", nodeId()).put("kind", "page").put("target", target)
                        .put("base_revision", db.pageRevision(target)).put("content", raw)
                        .put("mtime", db.file(target).lastModified())
                    db.evidence(target)?.let { payload.put("evidence", it) }
                    val ack = postJson("/api/sync/push", payload)
                    val revision = ack.optInt("revision")
                    val authoritative = ack.optString("content", raw)
                    db.writeSyncedPage(target, authoritative, revision)
                }
                "file" -> {
                    val file = db.file(target)
                    if (!file.exists()) { db.ackOutbox(item.getLong("id")); continue }
                    postFile(target, file)
                }
                "delete" -> postJson("/api/sync/push", JSONObject().put("node_id", nodeId()).put("kind", "delete").put("target", target))
                "move" -> postJson("/api/sync/push", JSONObject().put("node_id", nodeId()).put("kind", "move").put("target", target).put("old_path", item.optString("old_path")))
            }
            db.ackOutbox(item.getLong("id"))
        }
    }

    /** 返回本轮是否应用了远端 op。 */
    private fun pullChanges(): Boolean {
        var any = false
        var gap = false
        while (true) {
            checkActive()
            val cursor = db.setting("sync_cursor")?.toLongOrNull() ?: 0L
            val response = try {
                getJson("/api/sync/changes?since=$cursor&limit=$CHANGE_BATCH&compact=1")
            } catch (_: JsonResponseTooLarge) {
                // 旧中枢会忽略 limit/compact，历史正文可能远超手机堆。改走逐项全量对账，
                // 完成后推进快照水位；本地已同步后的修改仍按既有冲突规则保留。
                db.log("warn", "changes-too-large", "增量批次过大，已切换全量对账")
                reconcile(advanceCursor = true)
                return true
            }
            gap = gap || response.optBoolean("resync")
            val ops = response.optJSONArray("ops") ?: JSONArray()
            val compact = response.optBoolean("compact")
            for (i in 0 until ops.length()) { applyOp(ops.getJSONObject(i), compact); any = true }
            if (ops.length() < CHANGE_BATCH) break
        }
        if (gap) reconcile()
        return any
    }

    private fun applyOp(op: JSONObject, compact: Boolean = false) {
        val seq = op.optLong("seq")
        val cursor = db.setting("sync_cursor")?.toLongOrNull() ?: 0L
        if (seq <= cursor) return
        val target = op.optString("target")
        when (op.optString("kind")) {
            "page" -> {
                val content = if (compact) {
                    getJson("/api/sync/page-content?path=${encode(target)}").optString("content")
                } else op.optString("content")
                db.writeSyncedPage(target, content, op.optInt("revision"))
                val evidence = if (compact) {
                    getJson("/api/sync/evidence?path=${encode(target)}").optJSONObject("snapshot")
                } else op.optJSONObject("evidence")
                evidence?.let { db.saveEvidence(target, it) }
            }
            "file" -> pullFile(target)
            "delete" -> db.deleteSyncedPath(target)
            "move" -> db.moveSyncedPath(op.optString("old_path"), target, op.optInt("revision"))
        }
        db.setSetting("sync_cursor", seq.toString())
    }

    private fun reconcile(preferHub: Boolean = false, advanceCursor: Boolean = false) {
        checkActive()
        db.log("info", "reconcile-start")
        // 大库的 snapshot 可达数十 MiB。先流式落临时文件，再逐项解析，避免 JSONObject
        // 将整份清单及字符串副本同时留在 Android 的 256 MiB 堆里。
        val staged = File(db.root, "snapshot-${UUID.randomUUID()}.json")
        val remotePaths = mutableSetOf<String>()
        val stalePaths = mutableSetOf<String>()
        var inferredCursor = 0L
        var snapshotCursor = 0L
        var remoteCount = 0
        try {
            withConnection("GET", "/api/sync/snapshot") { connection ->
                requireSuccessfulResponse(connection)
                val declared = connection.contentLengthLong
                require(declared < 0 || declared <= MAX_SNAPSHOT_BYTES) { "中枢清单超过 256 MB 上限" }
                connection.inputStream.use { input ->
                    staged.outputStream().buffered().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        var total = 0L
                        while (true) {
                            checkActive()
                            val count = input.read(buffer)
                            if (count < 0) break
                            total += count
                            require(total <= MAX_SNAPSHOT_BYTES) { "中枢清单超过 256 MB 上限" }
                            output.write(buffer, 0, count)
                        }
                    }
                }
            }
            JsonReader(staged.inputStream().bufferedReader(StandardCharsets.UTF_8)).use { reader ->
                reader.beginObject()
                while (reader.hasNext()) when (reader.nextName()) {
                    "entries" -> {
                        reader.beginArray()
                        while (reader.hasNext()) {
                            checkActive()
                            var kind = ""
                            var path = ""
                            var hash = ""
                            var revision = 0
                            var distilled = false
                            reader.beginObject()
                            while (reader.hasNext()) when (reader.nextName()) {
                                "kind" -> kind = reader.nextString()
                                "path" -> path = reader.nextString()
                                "hash" -> hash = reader.nextString()
                                "revision" -> revision = reader.nextInt()
                                "distilled" -> distilled = reader.nextBoolean()
                                else -> reader.skipValue()
                            }
                            reader.endObject()
                            require(path.isNotBlank() && (kind == "page" || kind == "file")) { "中枢清单条目无效" }
                            remoteCount++
                            inferredCursor = maxOf(inferredCursor, revision.toLong())
                            remotePaths += path
                            if (preferHub) db.dropOutboxForTarget(path)
                            val localFile = db.file(path)
                            val localHash = if (localFile.exists()) sha256(localFile) else ""
                            if (localHash == hash) {
                                if (kind == "page" && db.pageRevision(path) != revision) {
                                    db.rawPage(path)?.let { db.writeSyncedPage(path, it, revision) }
                                }
                            } else if (kind == "page") {
                                if (localFile.exists() && db.pageRevision(path) > 0) db.enqueue("page", path)
                                else {
                                    val detail = getJson("/api/sync/page-content?path=${encode(path)}")
                                    db.writeSyncedPage(path, detail.optString("content"), revision)
                                }
                            } else {
                                if (localFile.exists() && !preferHub) db.enqueue("file", path) else pullFile(path)
                            }
                            if (distilled && !db.evidenceDistilled(path)) {
                                val evidence = getJson("/api/sync/evidence?path=${encode(path)}").optJSONObject("snapshot")
                                if (evidence != null) db.saveEvidence(path, evidence)
                            }
                        }
                        reader.endArray()
                    }
                    "cursor" -> snapshotCursor = reader.nextLong()
                    "stale" -> {
                        reader.beginArray()
                        while (reader.hasNext()) stalePaths += reader.nextString()
                        reader.endArray()
                    }
                    else -> reader.skipValue()
                }
                reader.endObject()
            }
        } finally {
            staged.delete()
        }
        var localCount = 0
        val brainPrefix = db.brain.canonicalPath + File.separator
        db.brain.walkTopDown().filter { it.isFile && !it.canonicalPath.startsWith(brainPrefix + ".trash" + File.separator) }.forEach { file ->
            checkActive()
            localCount++
            val path = file.canonicalPath.removePrefix(brainPrefix).replace('\\', '/')
            if (path !in remotePaths && path !in stalePaths) {
                val kind = if (file.extension.equals("md", true) || file.extension.equals("markdown", true)) "page" else "file"
                db.enqueue(kind, path)
            }
        }
        if (advanceCursor) {
            snapshotCursor = maxOf(inferredCursor, snapshotCursor)
            val current = db.setting("sync_cursor")?.toLongOrNull() ?: 0L
            if (snapshotCursor > current) db.setSetting("sync_cursor", snapshotCursor.toString())
        }
        db.log("info", "reconcile-done", "中枢 $remoteCount 项，本地 $localCount 项")
    }

    private fun pullFile(path: String) {
        val staged = File(db.root, "sync-${UUID.randomUUID()}.tmp")
        try {
            withConnection("GET", "/api/sync/file?path=${encode(path)}") { connection ->
                val declared = connection.contentLengthLong
                require(declared < 0 || declared <= MAX_FILE_BYTES) { "同步文件超过 200 MB 上限" }
                connection.inputStream.use { input ->
                    staged.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        var total = 0L
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            total += count
                            require(total <= MAX_FILE_BYTES) { "同步文件超过 200 MB 上限" }
                            output.write(buffer, 0, count)
                        }
                    }
                }
            }
            db.installSyncedFile(path, staged)
        } finally { staged.delete() }
    }

    private fun nodeId(): String {
        val existing = db.setting("sync_node_id")
        if (!existing.isNullOrBlank()) return existing
        return UUID.randomUUID().toString().also { db.setSetting("sync_node_id", it) }
    }

    private fun baseUrls(): List<String> {
        val primary = (db.setting("sync_hub_url") ?: error("未配置中枢地址")).trimEnd('/')
        val fallbacks = runCatching { JSONArray(db.setting("sync_direct_urls") ?: "[]") }.getOrDefault(JSONArray())
        return buildList {
            add(primary)
            for (i in 0 until fallbacks.length()) fallbacks.optString(i).trimEnd('/').takeIf { it.startsWith("http") }?.let(::add)
        }.distinct()
    }
    private fun token(): String = secrets.get("sync_hub_token") ?: error("未配置绑定令牌")
    private fun encode(value: String) = URLEncoder.encode(value, "UTF-8")

    private fun getJson(path: String) = JSONObject(String(request("GET", path, null, "application/json"), StandardCharsets.UTF_8))
    private fun postJson(path: String, body: JSONObject) = JSONObject(String(request("POST", path, body.toString().toByteArray(), "application/json"), StandardCharsets.UTF_8))

    private fun request(method: String, path: String, body: ByteArray?, contentType: String): ByteArray {
        checkActive()
        return withConnection(method, path, contentType) { connection ->
            if (body != null) {
                connection.doOutput = true
                connection.outputStream.use { it.write(body) }
            }
            requireSuccessfulResponse(connection)
            val declared = connection.contentLengthLong
            if (declared > MAX_JSON_BYTES) throw JsonResponseTooLarge(declared)
            connection.inputStream.use { readLimited(it, MAX_JSON_BYTES) }
        }
    }

    private fun requireSuccessfulResponse(connection: HttpURLConnection) {
        val status = connection.responseCode
        if (status !in 200..299) {
            val error = connection.errorStream?.use { String(readLimited(it, 64 * 1024L), StandardCharsets.UTF_8).take(200) }.orEmpty()
            throw IllegalStateException("中枢返回 $status：$error")
        }
    }

    private fun <T> withConnection(method: String, path: String, contentType: String? = null, block: (HttpURLConnection) -> T): T {
        var failure: Exception? = null
        for (base in baseUrls()) {
            checkActive()
            val connection = URL(base + path).openConnection() as HttpURLConnection
            currentConnection = connection
            try {
                connection.requestMethod = method
                connection.connectTimeout = 6_000
                connection.readTimeout = 30_000
                connection.setRequestProperty("Authorization", "Bearer ${token()}")
                connection.setRequestProperty("Accept", "application/json, application/octet-stream")
                contentType?.let { connection.setRequestProperty("Content-Type", it) }
                val result = block(connection)
                val status = connection.responseCode
                if (status !in 200..299) {
                    val error = connection.errorStream?.use { String(readLimited(it, 64 * 1024L)).take(200) }.orEmpty()
                    throw IllegalStateException("中枢返回 $status：$error")
                }
                connected = true
                return result
            } catch (error: Exception) {
                if (cancelled || !foreground) throw Cancelled()
                failure = error
            } finally {
                currentConnection = null
                connection.disconnect()
            }
        }
        throw failure ?: IllegalStateException("无法连接同步中枢")
    }

    private fun postFile(path: String, file: File) {
        require(file.length() <= MAX_FILE_BYTES) { "同步文件超过 200 MB 上限" }
        val boundary = "Engram-${UUID.randomUUID()}"
        withConnection("POST", "/api/sync/file", "multipart/form-data; boundary=$boundary") { connection ->
            connection.doOutput = true
            connection.setChunkedStreamingMode(64 * 1024)
            connection.outputStream.buffered(64 * 1024).use { output ->
                fun line(value: String) { output.write(value.toByteArray()); output.write("\r\n".toByteArray()) }
                line("--$boundary"); line("Content-Disposition: form-data; name=\"path\""); line(""); line(path)
                line("--$boundary"); line("Content-Disposition: form-data; name=\"file\"; filename=\"${path.substringAfterLast('/')}\"")
                line("Content-Type: application/octet-stream"); line("")
                FileInputStream(file).use { it.copyTo(output, 64 * 1024) }
                line(""); line("--$boundary--")
            }
            requireSuccessfulResponse(connection)
            connection.inputStream.use { readLimited(it, MAX_JSON_BYTES) }
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
    private fun readLimited(input: java.io.InputStream, limit: Long): ByteArray {
        val output = java.io.ByteArrayOutputStream(minOf(limit, 64 * 1024L).toInt())
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            if (total > limit) throw JsonResponseTooLarge(total)
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }
    private class JsonResponseTooLarge(size: Long) : IllegalStateException("同步 JSON 响应过大（至少 ${size / 1024 / 1024} MiB）")
    private class Cancelled : RuntimeException()

    companion object {
        private const val MAX_FILE_BYTES = 200L * 1024 * 1024
        private const val MAX_JSON_BYTES = 8L * 1024 * 1024
        private const val MAX_SNAPSHOT_BYTES = 256L * 1024 * 1024
        private const val CHANGE_BATCH = 20
    }
}
