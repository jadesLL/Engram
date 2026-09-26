package com.engram.app

import android.util.JsonReader
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.net.InetAddress
import java.net.URLEncoder
import java.net.UnknownHostException
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Android 成员端一次性同步器。无 SSE、无后台调度：前台事件触发一轮收敛，完成后线程空闲。
 * 本地写入先落 SQLite outbox，网络失败或进程退出均可在下次前台继续。
 * 连中枢走 OkHttp + 双栈策略（见 DualStack.kt）：域名同时有 A/AAAA 时先 IPv6，连不上改 IPv4，
 * IPv4 用稳后定期回探一次 IPv6——协议族只在建连时选定，传输途中不换。
 */
class SyncEngine(private val db: LocalDatabase, private val secrets: SecretStore) {
    private val executor = Executors.newSingleThreadExecutor()
    private val fetchExecutor = Executors.newFixedThreadPool(MAX_PARALLEL_FETCHES)
    private val activeCalls = ConcurrentHashMap.newKeySet<Call>()
    /**
     * 三个客户端共用一套超时，只有 DNS 解析不同：
     *  - clientV6/clientV4 各自只解析出选定协议族的地址 → 两套独立连接池，切族不打断在途传输；
     *  - httpClient 用于「策略关闭 / 解析不出地址」的场景，保持历史行为（系统默认排序）。
     */
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(0, TimeUnit.SECONDS)
        .build()
    private val clientV6 = httpClient.newBuilder().dns(FamilyDns(6)).build()
    private val clientV4 = httpClient.newBuilder().dns(FamilyDns(4)).build()
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

    fun onForeground() { foreground = true; cancelled = false; request(false) }

    fun onBackground() {
        foreground = false
        cancelled = true
        connected = false
        activeCalls.forEach { it.cancel() }
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
                db.log("info", "sync-done", "同步已收敛")
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
                db.writeSyncedPage(target, content, op.optInt("revision"))
                val evidence = if (compact) {
                    page?.evidence ?: getJson("/api/sync/evidence?path=${encode(target)}").optJSONObject("snapshot")
                } else op.optJSONObject("evidence")
                evidence?.let { db.saveEvidence(target, it) }
            }
            "file" -> {
                if (stagedFile == null) pullFile(target)
                else try { db.installSyncedFile(target, stagedFile) } finally { stagedFile.delete() }
            }
            "delete" -> db.deleteSyncedPath(target)
            "move" -> db.moveSyncedPath(op.optString("old_path"), target, op.optInt("revision"))
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
            withConnection("GET", "/api/sync/snapshot") { response ->
                val stream = response.body?.byteStream() ?: throw IllegalStateException("中枢未返回清单内容")
                val declared = response.body?.contentLength() ?: -1L
                require(declared < 0 || declared <= MAX_SNAPSHOT_BYTES) { "中枢清单超过 256 MB 上限" }
                stream.use { input ->
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
                                if (localFile.exists() && db.pageRevision(path) > 0) db.enqueue("page", path)
                                else {
                                    val fetchPath = path
                                    schedulePull()
                                    val future = fetchExecutor.submit<String> {
                                        getJson("/api/sync/page-content?path=${encode(fetchPath)}").optString("content")
                                    }
                                    pending += SnapshotWork(
                                        apply = {
                                            db.writeSyncedPage(fetchPath, await(future), revision)
                                            completePull()
                                        },
                                        discard = { cancelFetch(future) },
                                    )
                                }
                            } else {
                                if (localFile.exists() && !preferHub) db.enqueue("file", path)
                                else {
                                    val fetchPath = path
                                    schedulePull()
                                    val future = fetchExecutor.submit<File> { stageFile(fetchPath) }
                                    pending += SnapshotWork(
                                        apply = {
                                            val stagedFile = await(future)
                                            try { db.installSyncedFile(fetchPath, stagedFile) }
                                            finally { stagedFile.delete() }
                                            completePull()
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
        db.log("info", "reconcile-done", "中枢 $remoteCount 项，本地 $localCount 项")
        syncProgress = if (remoteCount == 0) "正在补齐本机改动" else "已核对 $remoteCount 项"
    }

    private fun pullFile(path: String) {
        val staged = stageFile(path)
        try { db.installSyncedFile(path, staged) } finally { staged.delete() }
    }

    private fun stageFile(path: String): File {
        val staged = File(db.root, "sync-${UUID.randomUUID()}.tmp")
        val maxBytes = if (isInboxFile(path)) Long.MAX_VALUE else MAX_FILE_BYTES
        try {
            withConnection("GET", "/api/sync/file?path=${encode(path)}") { response ->
                val stream = response.body?.byteStream() ?: throw IllegalStateException("中枢未返回文件内容")
                val declared = response.body?.contentLength() ?: -1L
                require(declared < 0 || declared <= maxBytes) { "同步文件超过 200 MB 上限" }
                stream.use { input ->
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
        val requestBody = body?.toRequestBody(contentType.toMediaType())
        return withConnection(method, path, contentType, requestBody) { response ->
            val stream = response.body?.byteStream() ?: throw IllegalStateException("中枢未返回内容")
            val declared = response.body?.contentLength() ?: -1L
            if (declared > MAX_JSON_BYTES) throw JsonResponseTooLarge(declared)
            stream.use { readLimited(it, MAX_JSON_BYTES) }
        }
    }

    /** 当前生效的双栈配置（设置页可改；默认 IPv6 优先 + 标准阈值） */
    private fun dualStackConfig(): DualStackConfig = DualStackConfig.fromSettings { key -> db.setting(key) }

    /**
     * 发一次请求并按双栈策略轮换协议族（IPv6 优先 → 失败用 IPv4；IPv4 用稳后定期回探）。
     *
     * 关键约束：一次请求（含大文件上传／下载）只在**建连那一刻**选定协议族，成功后全程同一条
     * 连接；只有「连都没连上」（isConnectFailure）才换族重试，传输途中出错一律不换。
     */
    private fun <T> withConnection(
        method: String,
        path: String,
        contentType: String? = null,
        body: RequestBody? = null,
        block: (Response) -> T,
    ): T {
        var failure: Exception? = null
        for (base in baseUrls()) {
            checkActive()
            val url = (base + path).toHttpUrlOrNull()
            if (url == null) {
                failure = IllegalArgumentException("中枢地址无效: $base")
                continue
            }
            val config = dualStackConfig()
            // 解析不出地址或策略关闭时不介入：交给系统默认连接器，行为与历史版本一致
            val availability = if (config.enabled) addressAvailability(url.host) else null
            if (availability == null) {
                try {
                    val result = attempt(method, url, contentType, body, httpClient, block)
                    connected = true
                    return result
                } catch (error: Exception) {
                    if (cancelled || !foreground) throw Cancelled()
                    failure = error
                    continue
                }
            }
            val state = DualStack.state(url.host)
            // 单栈域名先把状态校准到实际那一族（界面显示的「当前用哪一族」必须是真的）
            DualStack.alignSingleStack(state, availability.first, availability.second)
            val plan = DualStack.plan(state, availability.first, availability.second, body == null)
            for ((index, planned) in plan.withIndex()) {
                checkActive()
                val startedAt = System.currentTimeMillis()
                val client = if (planned.family == 6) clientV6 else clientV4
                try {
                    val result = attempt(method, url, contentType, body, client, block)
                    logDualStackEvent(
                        DualStack.record(config, state, planned.family, true, System.currentTimeMillis() - startedAt)
                    )
                    connected = true
                    return result
                } catch (error: Exception) {
                    if (cancelled || !foreground) throw Cancelled()
                    logDualStackEvent(
                        DualStack.record(config, state, planned.family, false, System.currentTimeMillis() - startedAt)
                    )
                    failure = error
                    if (!isConnectFailure(error) || index == plan.lastIndex) break
                }
            }
        }
        throw failure ?: IllegalStateException("无法连接同步中枢")
    }

    /** 单次尝试：一发请求一条连接；错误信息（含中枢返回的非 2xx 正文）与历史版本保持一致 */
    private fun <T> attempt(
        method: String,
        url: okhttp3.HttpUrl,
        contentType: String?,
        body: RequestBody?,
        client: OkHttpClient,
        block: (Response) -> T,
    ): T {
        val builder = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer ${token()}")
            .header("Accept", "application/json, application/octet-stream")
        contentType?.let { builder.header("Content-Type", it) }
        builder.method(method, body)
        val call = client.newCall(builder.build())
        activeCalls.add(call)
        try {
            call.execute().use { response ->
                if (!response.isSuccessful) {
                    val error = response.body?.string()?.take(200).orEmpty()
                    throw IllegalStateException("中枢返回 ${response.code}：$error")
                }
                return block(response)
            }
        } finally {
            activeCalls.remove(call)
        }
    }

    /** 域名解析出的协议族清单；解析失败返回 null（让请求自己报 DNS 错，不当作双栈问题记账） */
    private fun addressAvailability(host: String): Pair<Boolean, Boolean>? = try {
        val addresses = InetAddress.getAllByName(host)
        Pair(
            addresses.any { FamilyDns.isFamily(it, 6) },
            addresses.any { FamilyDns.isFamily(it, 4) },
        )
    } catch (_: UnknownHostException) {
        null
    }

    private fun logDualStackEvent(event: DualStackEvent?) {
        if (event == null) return
        db.log(event.level, event.event, event.detail)
    }

    private fun postFile(path: String, file: File) {
        if (!isInboxFile(path)) {
            require(file.length() <= MAX_FILE_BYTES) { "同步文件超过 200 MB 上限" }
        }
        // multipart 从文件流式读，不整块进内存；文件名与字段名与中枢接口一致
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("path", path)
            .addFormDataPart(
                "file",
                path.substringAfterLast('/'),
                file.asRequestBody("application/octet-stream".toMediaType()),
            )
            .build()
        withConnection("POST", "/api/sync/file", null, body) { response ->
            response.body?.byteStream()?.use { readLimited(it, MAX_JSON_BYTES) }
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
