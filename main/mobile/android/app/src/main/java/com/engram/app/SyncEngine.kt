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
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Android 成员端一次性同步器。无 SSE、无后台调度：前台事件触发一轮收敛，完成后线程空闲。
 * 本地写入先落 SQLite outbox，网络失败或进程退出均可在下次前台继续。
 */
class SyncEngine(private val db: LocalDatabase, private val secrets: SecretStore) {
    private val executor = Executors.newSingleThreadExecutor()
    private val fetchExecutor = Executors.newFixedThreadPool(MAX_PARALLEL_FETCHES)
    private val activeConnections = ConcurrentHashMap.newKeySet<HttpURLConnection>()
    private val running = AtomicBoolean(false)
    private val requestWhileRunning = AtomicBoolean(false)
    private val fullRequestWhileRunning = AtomicBoolean(false)
    @Volatile private var foreground = false
    @Volatile private var cancelled = false
    @Volatile var connected = false; private set
    @Volatile var lastError: String? = null; private set
    @Volatile var lastSyncAt: String? = db.setting("sync_last_at"); private set
    @Volatile var pendingPulls: Int = 0; private set
    @Volatile var syncProgress: String = ""; private set
    /** 本轮同步真正落地/送出的改动条数（推 + 拉），只用于结尾那条汇总 */
    private var roundChanges = 0

    fun onForeground() { foreground = true; cancelled = false; request(false) }

    fun onBackground() {
        foreground = false
        cancelled = true
        connected = false
        activeConnections.forEach { it.disconnect() }
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
            roundChanges = 0
            try {
                db.log("info", "start", if (full) "手动全量对账" else "事件触发同步")
                syncProgress = "正在连接中枢"
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
                syncProgress = "同步完成"
                // 结尾这条要说清「这轮到底动了什么」：没改动也明说，别让用户对着空白记录猜
                db.log("info", "sync-done", if (roundChanges > 0) "同步已收敛（本轮落地 $roundChanges 项改动）" else "同步已收敛（本轮无改动）")
                completed = true
            } catch (e: Cancelled) {
                syncProgress = "已暂停，待下次继续"
                db.log("info", "sync-paused", "应用已进入后台，待下次继续")
            } catch (e: Exception) {
                connected = false
                lastError = e.message ?: e.javaClass.simpleName
                syncProgress = "同步中断"
                db.log("warn", "sync-failed", lastError ?: "同步失败")
            } finally {
                pendingPulls = 0
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
            syncProgress = "正在补齐改动"
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
                    recordPush("push-page", SyncOpText.KIND_PAGE, target, null, authoritative.toByteArray(Charsets.UTF_8).size.toLong(), revision)
                }
                "file" -> {
                    val file = db.file(target)
                    if (!file.exists()) { db.ackOutbox(item.getLong("id")); continue }
                    val ack = postFile(target, file)
                    recordPush("push-file", SyncOpText.KIND_FILE, target, null, file.length(), ack.optInt("revision"))
                }
                "delete" -> {
                    val ack = postJson("/api/sync/push", JSONObject().put("node_id", nodeId()).put("kind", "delete").put("target", target))
                    recordPush("push-delete", SyncOpText.KIND_DELETE, target, null, 0L, ack.optInt("revision"))
                }
                "move" -> {
                    val oldPath = item.optString("old_path")
                    val ack = postJson("/api/sync/push", JSONObject().put("node_id", nodeId()).put("kind", "move").put("target", target).put("old_path", oldPath))
                    recordPush("push-move", SyncOpText.KIND_MOVE, target, oldPath, 0L, ack.optInt("revision"))
                }
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
            val batch = (0 until ops.length()).map { ops.getJSONObject(it) }
            for (chunk in batch.chunked(MAX_PARALLEL_FETCHES)) {
                val work = chunk.map { op ->
                    val kind = op.optString("kind")
                    val target = op.optString("target")
                    when {
                        kind == "page" && compact -> ChangeWork(
                            op = op,
                            page = fetchExecutor.submit<PagePayload> {
                                val content = getJson("/api/sync/page-content?path=${encode(target)}").optString("content")
                                val evidence = getJson("/api/sync/evidence?path=${encode(target)}").optJSONObject("snapshot")
                                PagePayload(content, evidence)
                            },
                        )
                        kind == "file" -> ChangeWork(op = op, file = fetchExecutor.submit<File> { stageFile(target) })
                        else -> ChangeWork(op = op)
                    }
                }
                try {
                    for (item in work) {
                        checkActive()
                        val page = item.page?.let(::await)
                        val file = item.file?.let(::await)
                        applyOp(item.op, compact, page, file)
                        any = true
                    }
                } finally {
                    work.forEach { item ->
                        item.page?.let(::cancelFetch)
                        item.file?.let(::discardStagedFile)
                    }
                }
            }
            if (ops.length() < CHANGE_BATCH) break
        }
        if (gap) reconcile()
        return any
    }

    private fun applyOp(op: JSONObject, compact: Boolean = false, page: PagePayload? = null, stagedFile: File? = null) {
        val seq = op.optLong("seq")
        val cursor = db.setting("sync_cursor")?.toLongOrNull() ?: 0L
        if (seq <= cursor) return
        val target = op.optString("target")
        when (op.optString("kind")) {
            "page" -> {
                val content = if (compact) {
                    page?.content ?: getJson("/api/sync/page-content?path=${encode(target)}").optString("content")
                } else op.optString("content")
                // 先取旧正文，才写得清「改了多少行」——同步记录里这句就是用户要的「具体改了什么」
                val before = db.rawPage(target)
                db.writeSyncedPage(target, content, op.optInt("revision"))
                val evidence = if (compact) {
                    page?.evidence ?: getJson("/api/sync/evidence?path=${encode(target)}").optJSONObject("snapshot")
                } else op.optJSONObject("evidence")
                evidence?.let { db.saveEvidence(target, it) }
                recordApplied("pull-page", SyncOpText.summarizePage(target, before, content))
            }
            "file" -> {
                val beforeBytes = db.file(target).let { if (it.exists()) it.length() else 0L }
                val staged = stagedFile ?: stageFile(target)
                val afterBytes = staged.length()
                try { db.installSyncedFile(target, staged) } finally { staged.delete() }
                recordApplied("pull-file", SyncOpText.summarizeFile(target, beforeBytes, afterBytes))
            }
            "delete" -> {
                val existing = db.file(target)
                val beforeBytes = if (existing.exists()) existing.length() else 0L
                db.deleteSyncedPath(target)
                recordApplied("pull-delete", SyncOpText.summarizeDelete(target, beforeBytes, target.endsWith(".md", true)))
            }
            "move" -> {
                val oldPath = op.optString("old_path")
                db.moveSyncedPath(oldPath, target, op.optInt("revision"))
                recordApplied("pull-move", SyncOpText.summarizeMove(oldPath, target))
            }
        }
        db.setSetting("sync_cursor", seq.toString())
    }

    private fun reconcile(preferHub: Boolean = false, advanceCursor: Boolean = false) {
        checkActive()
        syncProgress = "正在读取中枢目录"
        db.log("info", "reconcile-start")
        // 大库的 snapshot 可达数十 MiB。先流式落临时文件，再逐项解析，避免 JSONObject
        // 将整份清单及字符串副本同时留在 Android 的 256 MiB 堆里。
        val staged = File(db.root, "snapshot-${UUID.randomUUID()}.json")
        val remotePaths = mutableSetOf<String>()
        val stalePaths = mutableSetOf<String>()
        var inferredCursor = 0L
        var snapshotCursor = 0L
        var remoteCount = 0
        val tally = ChangeTally()
        val pending = mutableListOf<SnapshotWork>()
        fun flushPending() {
            if (pending.isEmpty()) return
            val batch = pending.toList()
            pending.clear()
            try {
                batch.forEach { work -> checkActive(); work.apply() }
            } finally {
                batch.forEach { work -> work.discard() }
            }
        }
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
                            if (remoteCount % 25 == 0) syncProgress = "正在核对中枢目录（$remoteCount 项）"
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
                                if (localFile.exists() && db.pageRevision(path) > 0) {
                                    db.enqueue("page", path)
                                    recordLocalNewer("page", path)
                                } else {
                                    val fetchPath = path
                                    schedulePull()
                                    val future = fetchExecutor.submit<String> {
                                        getJson("/api/sync/page-content?path=${encode(fetchPath)}").optString("content")
                                    }
                                    pending += SnapshotWork(
                                        apply = {
                                            val content = await(future)
                                            // 旧正文先读出来：这条同步记录要写清「新增还是修改、动了多少行」
                                            val before = db.rawPage(fetchPath)
                                            db.writeSyncedPage(fetchPath, content, revision)
                                            completePull()
                                            recordApplied("pull-page", SyncOpText.summarizePage(fetchPath, before, content), tally)
                                        },
                                        discard = { cancelFetch(future) },
                                    )
                                }
                            } else {
                                if (localFile.exists() && !preferHub) {
                                    db.enqueue("file", path)
                                    recordLocalNewer("file", path)
                                } else {
                                    val fetchPath = path
                                    val beforeBytes = if (localFile.exists()) localFile.length() else 0L
                                    schedulePull()
                                    val future = fetchExecutor.submit<File> { stageFile(fetchPath) }
                                    pending += SnapshotWork(
                                        apply = {
                                            val stagedFile = await(future)
                                            val afterBytes = stagedFile.length()
                                            try { db.installSyncedFile(fetchPath, stagedFile) }
                                            finally { stagedFile.delete() }
                                            completePull()
                                            recordApplied("pull-file", SyncOpText.summarizeFile(fetchPath, beforeBytes, afterBytes), tally)
                                        },
                                        discard = { discardStagedFile(future) },
                                    )
                                }
                            }
                            if (distilled && !db.evidenceDistilled(path)) {
                                val evidencePath = path
                                schedulePull()
                                val future = fetchExecutor.submit<JSONObject?> {
                                    getJson("/api/sync/evidence?path=${encode(evidencePath)}").optJSONObject("snapshot")
                                }
                                pending += SnapshotWork(
                                    apply = {
                                        await(future)?.let { db.saveEvidence(evidencePath, it) }
                                        completePull()
                                    },
                                    discard = { cancelFetch(future) },
                                )
                            }
                            if (pending.size >= SNAPSHOT_FETCH_BATCH) flushPending()
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
            flushPending()
        } finally {
            pending.forEach { it.discard() }
            pending.clear()
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
        db.log("info", "reconcile-done", "中枢 $remoteCount 项，本地 $localCount 项${tally.describe()}")
        syncProgress = if (remoteCount == 0) "正在补齐本机改动" else "已核对 $remoteCount 项"
    }

    /**
     * 记一条「具体改了什么」（拉取方向）：列表展示 describe() 的中文，展开看 data 的结构化字段，
     * 与 desktop 端 eventLog 的 data 键名同口径。落到本地内容才 +1 内容版本，前端据此渐进刷新文件树。
     */
    private fun recordApplied(event: String, item: SyncOpText.SyncOpSummary, tally: ChangeTally? = null) {
        if (!SyncOpText.isNoteworthy(item)) return
        tally?.note(item)
        roundChanges += 1
        db.log("info", event, SyncOpText.describe(item), toJson(SyncOpText.data(item)))
        db.bumpContentRevision()
    }

    /** 记一条推送（本机 → 中枢）：方向写清楚，别和拉取混成一句「同步了 N 项」 */
    private fun recordPush(event: String, kind: String, path: String, oldPath: String?, bytes: Long, revision: Int) {
        // AIWorks/ 下的系统页由应用自身写入（首次启动就会种下 index/log/scheme），不进用户记录
        if (!SyncOpText.isNoteworthyPush(path, oldPath)) return
        roundChanges += 1
        db.log("info", event, SyncOpText.describePush(kind, path, oldPath, bytes, revision), toJson(SyncOpText.pushData(kind, path, oldPath, bytes, revision)))
    }

    /** 本机版本较新、没被中枢覆盖：说明白为什么这项没落地，而不是静默跳过 */
    private fun recordLocalNewer(kind: String, path: String) {
        val subject = if (kind == "page") "页面「${SyncOpText.pageTitle(path)}」" else "文件「$path」"
        db.log("info", "pull-local-newer", "本机改动较新，保留本机版本并排队推送：$subject", toJson(mapOf("kind" to kind, "path" to path)))
    }

    private fun toJson(fields: Map<String, Any>): JSONObject {
        val out = JSONObject()
        for ((key, value) in fields) out.put(key, value)
        return out
    }

    /** 对账过程中的改动计数（只服务结尾那条汇总） */
    private class ChangeTally {
        private var addedPages = 0
        private var updatedPages = 0
        private var addedFiles = 0
        private var updatedFiles = 0
        private var removed = 0
        private var moved = 0

        fun note(item: SyncOpText.SyncOpSummary) {
            when (item.kind) {
                SyncOpText.KIND_PAGE -> if (item.verb == SyncOpText.VERB_ADD) addedPages++ else updatedPages++
                SyncOpText.KIND_FILE -> if (item.verb == SyncOpText.VERB_ADD) addedFiles++ else updatedFiles++
                SyncOpText.KIND_DELETE -> removed++
                SyncOpText.KIND_MOVE -> moved++
            }
        }

        fun describe(): String {
            val parts = mutableListOf<String>()
            if (addedPages > 0) parts += "新增页面 $addedPages"
            if (updatedPages > 0) parts += "修改页面 $updatedPages"
            if (addedFiles > 0) parts += "新增文件 $addedFiles"
            if (updatedFiles > 0) parts += "更新文件 $updatedFiles"
            if (removed > 0) parts += "删除 $removed"
            if (moved > 0) parts += "改名 $moved"
            if (parts.isEmpty()) return ""
            return "；本次落地：" + parts.joinToString("、")
        }
    }

    private fun stageFile(path: String): File {
        val staged = File(db.root, "sync-${UUID.randomUUID()}.tmp")
        val maxBytes = if (isInboxFile(path)) Long.MAX_VALUE else MAX_FILE_BYTES
        try {
            withConnection("GET", "/api/sync/file?path=${encode(path)}") { connection ->
                val declared = connection.contentLengthLong
                require(declared < 0 || declared <= maxBytes) { "同步文件超过 200 MB 上限" }
                connection.inputStream.use { input ->
                    staged.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        var total = 0L
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            total += count
                            require(total <= maxBytes) { "同步文件超过 200 MB 上限" }
                            output.write(buffer, 0, count)
                        }
                    }
                }
            }
            return staged
        } catch (error: Exception) {
            staged.delete()
            throw error
        }
    }

    private data class SnapshotWork(val apply: () -> Unit, val discard: () -> Unit)
    private data class PagePayload(val content: String, val evidence: JSONObject?)
    private data class ChangeWork(val op: JSONObject, val page: Future<PagePayload>? = null, val file: Future<File>? = null)

    private fun schedulePull() {
        pendingPulls++
        syncProgress = "正在下载内容（队列 $pendingPulls 项）"
    }

    private fun completePull() {
        pendingPulls = (pendingPulls - 1).coerceAtLeast(0)
        syncProgress = if (pendingPulls > 0) "正在下载内容（还剩 $pendingPulls 项）" else "已下载目录内容"
    }

    private fun <T> await(future: Future<T>): T = try {
        future.get()
    } catch (error: ExecutionException) {
        throw error.cause ?: error
    }

    private fun cancelFetch(future: Future<*>) {
        if (!future.isDone) future.cancel(true)
    }

    private fun discardStagedFile(future: Future<File>) {
        if (!future.isDone) {
            future.cancel(true)
            return
        }
        if (future.isCancelled) return
        runCatching { await(future).delete() }
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
    private fun isInboxFile(path: String) = path.startsWith("收集箱/")

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
            activeConnections.add(connection)
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
                activeConnections.remove(connection)
                connection.disconnect()
            }
        }
        throw failure ?: IllegalStateException("无法连接同步中枢")
    }

    /** 上传一个文件；返回中枢应答（含 revision），推送记录要写「送到了中枢哪一版」 */
    private fun postFile(path: String, file: File): JSONObject {
        if (!isInboxFile(path)) {
            require(file.length() <= MAX_FILE_BYTES) { "同步文件超过 200 MB 上限" }
        }
        val boundary = "Engram-${UUID.randomUUID()}"
        return withConnection("POST", "/api/sync/file", "multipart/form-data; boundary=$boundary") { connection ->
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
            val body = connection.inputStream.use { readLimited(it, MAX_JSON_BYTES) }
            runCatching { JSONObject(String(body, StandardCharsets.UTF_8)) }.getOrDefault(JSONObject())
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
        private const val MAX_PARALLEL_FETCHES = 4
        private const val SNAPSHOT_FETCH_BATCH = MAX_PARALLEL_FETCHES
    }
}
