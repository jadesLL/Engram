package com.engram.app

import android.util.JsonReader
import android.util.JsonToken
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
    /** 本轮同步真正落地/送出的改动条数（推 + 拉），只用于结尾那条汇总 */
    private var roundChanges = 0

    /**
     * ── 连接通道择优：局域网 → IPv6 → IPv4（都不通即「已断开」）────────────────────
     *
     * 与 desktop / Docker 端 server/src/sync/client.ts 同一套口径：中枢在 /api/sync/announce 里
     * 通告自己的内网地址，成员端把「内网地址 + 中枢主地址」排成候选逐个探测，第一个通的作为当前
     * 通道。家里/公司同网段自动走内网直连（低延迟、不占公网），出门自动回到主地址再按双栈选族；
     * **探不到局域网时行为与历史版本完全一致**。通道现状经 /api/sync/status 的 link 字段给界面，
     * 侧栏状态胶囊与设置页「局域网优先」都读它。
     */
    private val linkProbeMinIntervalMs = 20_000L
    /** 健康期间的定期复探：从公司回到家、或局域网恢复后要能自动升回局域网 */
    private val linkReprobeIntervalMs = 10 * 60_000L
    /** 局域网候选是 IP 字面量，不可路由地址通常毫秒级失败，1.5 秒硬超时足够 */
    private val linkProbeLanTimeoutMs = 1500L
    private val linkLanUrlsSetting = "sync_lan_urls"
    private val linkPreferLanSetting = "sync_prefer_lan"
    private val deviceLabelSetting = "sync_device_label"

    /** 当前实际在用的基地址；null = 还没择优过，按配置的中枢地址走 */
    @Volatile private var activeBase: String? = null
    @Volatile private var linkCandidates: List<SyncLink.Candidate> = emptyList()
    @Volatile private var linkChannel: String = SyncLink.CHANNEL_OFFLINE
    @Volatile private var linkLatencyMs: Long? = null
    @Volatile private var linkSince: String? = null
    @Volatile private var linkProbedAt: String? = null
    private var lastProbeRoundAt = 0L
    private var forceProbe = false
    /** 上一轮探测绑定的中枢地址：改绑定后不能拿旧中枢的内网地址去连新中枢 */
    private var probeBoundHub: String? = null
    private var announcedLanCache: List<String>? = null
    /** 本端不认识的同步类型（每种只记一条，避免刷屏） */
    private val unknownKinds = mutableSetOf<String>()
    /** 中枢还没有连接通告端点时只提醒一条，别每轮刷屏 */
    private var announceMissingLogged = false

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
            roundChanges = 0
            try {
                db.log("info", "start", if (full) "手动全量对账" else "事件触发同步")
                syncProgress = "正在连接中枢"
                // 先择优一条路（局域网优先），再开始同步：否则首轮会先绕一次公网才发现内网可直连
                maybeProbeLink()
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
                    // 本端内容与中枢回执不同 = 中枢做过合并：本端已被写回，日志里必须有一句解释
                    if (authoritative != raw) recordPushMerged(target, ack, raw, authoritative, revision)
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
                            page = fetchExecutor.submit<PagePayload?> {
                                // 中枢已经没有这份（oplog 里的旧 op 滞后于改名/删除）：null，绝不拖死整轮
                                tolerateMissing {
                                    val content = getJson("/api/sync/page-content?path=${encode(target)}").optString("content")
                                    val evidence = getJson("/api/sync/evidence?path=${encode(target)}").optJSONObject("snapshot")
                                    PagePayload(content, evidence)
                                }
                            },
                        )
                        kind == "file" -> ChangeWork(op = op, file = fetchExecutor.submit<File?> { tolerateMissing { stageFile(target) } })
                        else -> ChangeWork(op = op)
                    }
                }
                try {
                    for (item in work) {
                        checkActive()
                        val page = item.page?.let(::await)
                        val file = item.file?.let(::await)
                        // 取不回来（中枢 404）说明这份已经被改名/删除：跳过它、推进水位，
                        // 否则这条永远取不回的 op 会让每一轮同步都在这里失败（实测卡死过）
                        if ((item.page != null && page == null) || (item.file != null && file == null)) {
                            skipMissingOp(item.op)
                            any = true
                            continue
                        }
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
        val kind = op.optString("kind")
        when (kind) {
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
            // 会话 / 看板：手机端不存本地副本，读写都经窄代理走已绑定的中枢（见 AgentBridge），
            // 所以这里是「已知但不镜像」——跳过内容，水位照常推进，别让水位卡在这两类 op 上。
            "session", "board" -> Unit
            else -> {
                // 协议比本端新：既不能瞎套页面逻辑，也不能吞得无声无息。
                // 水位仍然推进（否则后续 op 永远卡在它后面），但同步详情里留下一条 warn 可查。
                if (unknownKinds.add(kind)) {
                    db.log("warn", "sync-unknown-kind", SyncOpText.describeUnknownKind(kind), JSONObject().put("kind", kind))
                }
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
        /**
         * 本机已经改名/改分类/删除、但还没推给中枢的路径。
         *
         * 对账是「按中枢清单逐项核对本机有没有」：本机把文件推到新路径后，中枢的旧路径在本机
         * 已经不存在，会被当成「本机缺这份」拉回来——手机上于是新旧两份并存（实测：改分类后
         * 手动全量对账把旧路径复活）。待推送的旧路径要跳过，等这一轮 converge() 把改动推上去。
         */
        val pendingMoves = mutableSetOf<String>()
        val pendingDeletes = mutableSetOf<String>()
        runCatching {
            for (item in db.outbox()) {
                when (item.getString("kind")) {
                    "move" -> item.optString("old_path").takeIf { it.isNotBlank() }?.let(pendingMoves::add)
                    "delete" -> pendingDeletes += item.getString("target")
                }
            }
        }
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
                            // 本机已经把这份改名/改分类（或删掉了）但还没推上去：中枢的旧路径不拉回来，
                            // 否则手机上会同时出现新旧两份，等这一轮 converge() 推完改动自然收敛
                            if (path in pendingMoves || path in pendingDeletes) {
                                recordPendingLocal(kind, path)
                                continue
                            }
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
                                    val future = fetchExecutor.submit<String?> {
                                        tolerateMissing { getJson("/api/sync/page-content?path=${encode(fetchPath)}").optString("content") }
                                    }
                                    pending += SnapshotWork(
                                        apply = {
                                            val content = await(future)
                                            if (content == null) {
                                                // 中枢在清单生成后把它改名/删掉了：跳过，别把整轮对账拖死
                                                completePull()
                                                recordMissingAtHub("page", fetchPath)
                                            } else {
                                                // 旧正文先读出来：这条同步记录要写清「新增还是修改、动了多少行」
                                                val before = db.rawPage(fetchPath)
                                                db.writeSyncedPage(fetchPath, content, revision)
                                                completePull()
                                                recordApplied("pull-page", SyncOpText.summarizePage(fetchPath, before, content), tally)
                                            }
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
                                    val future = fetchExecutor.submit<File?> { tolerateMissing { stageFile(fetchPath) } }
                                    pending += SnapshotWork(
                                        apply = {
                                            val stagedFile = await(future)
                                            if (stagedFile == null) {
                                                completePull()
                                                recordMissingAtHub("file", fetchPath)
                                            } else {
                                                val afterBytes = stagedFile.length()
                                                try { db.installSyncedFile(fetchPath, stagedFile) }
                                                finally { stagedFile.delete() }
                                                completePull()
                                                recordApplied("pull-file", SyncOpText.summarizeFile(fetchPath, beforeBytes, afterBytes), tally)
                                            }
                                        },
                                        discard = { discardStagedFile(future) },
                                    )
                                }
                            }
                            if (distilled && !db.evidenceDistilled(path)) {
                                val evidencePath = path
                                schedulePull()
                                val future = fetchExecutor.submit<JSONObject?> {
                                    tolerateMissing { getJson("/api/sync/evidence?path=${encode(evidencePath)}").optJSONObject("snapshot") }
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
                    // 中枢随清单下发「本机在中枢配置里的成员名」：学回来，设置页与对话抽屉才有名字可显示
                    "device" -> {
                        if (reader.peek() == JsonToken.BEGIN_OBJECT) {
                            var name = ""
                            reader.beginObject()
                            while (reader.hasNext()) when (reader.nextName()) {
                                "name" -> name = reader.nextString()
                                else -> reader.skipValue()
                            }
                            reader.endObject()
                            learnDeviceLabel(name)
                        } else {
                            reader.skipValue()
                        }
                    }
                    // 中枢随清单下发「同步群组共用的更新源」（服务器/桌面端「更新源配置」那一份）：
                    // 手机没手填地址时直接用它检查更新，免得多端各填一遍
                    "updateSource" -> {
                        if (reader.peek() == JsonToken.BEGIN_OBJECT) {
                            var url = ""
                            var repo = ""
                            reader.beginObject()
                            while (reader.hasNext()) when (reader.nextName()) {
                                "url" -> url = reader.nextString()
                                "repo" -> repo = reader.nextString()
                                else -> reader.skipValue()
                            }
                            reader.endObject()
                            learnUpdateSource(url, repo)
                        } else {
                            reader.skipValue()
                        }
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

    /** 本机已改名/改分类/删除但还没推上去：中枢的旧路径不拉回（否则手机上新旧两份并存） */
    private fun recordPendingLocal(kind: String, path: String) {
        val subject = if (kind == "page") "页面「${SyncOpText.pageTitle(path)}」" else "文件「$path」"
        db.log(
            "info",
            "pull-pending-local",
            "$subject 本机已改名/移动或删除、尚未推送，中枢里的旧路径不再拉回本机",
            toJson(mapOf("kind" to kind, "path" to path)),
        )
    }

    /**
     * 中枢对本端推送做了合并/规范化（本端内容已被写回）：这是「我的改动怎么变了」的唯一解释，
     * 与 desktop / Docker 端 client.ts 的 push-merged 同措辞、同 data 键名。
     */
    private fun recordPushMerged(path: String, ack: JSONObject, localRaw: String, mergedRaw: String, revision: Int) {
        if (!SyncOpText.isNoteworthyPush(path)) return
        val op = ack.optJSONObject("op")
        val title = op?.optString("title")
        val added = op?.optInt("added") ?: 0
        val removed = op?.optInt("removed") ?: 0
        val localBytes = localRaw.toByteArray(Charsets.UTF_8).size.toLong()
        val mergedBytes = mergedRaw.toByteArray(Charsets.UTF_8).size.toLong()
        roundChanges += 1
        val data = JSONObject()
            .put("kind", SyncOpText.KIND_PAGE).put("verb", "merged").put("path", path)
            .put("revision", revision).put("added", added).put("removed", removed)
            .put("localBytes", localBytes).put("mergedBytes", mergedBytes)
        title?.takeIf { it.isNotBlank() }?.let { data.put("title", it) }
        db.log("info", "push-merged", SyncOpText.describePushMerged(path, title, added, removed, localBytes, mergedBytes), data)
    }

    /**
     * 结构化字段 → JSONObject：集合要显式转 JSONArray。
     *
     * Android 的 `JSONObject.put` 不包装集合——直接塞 List，序列化时会被当成普通对象调 `toString()`，
     * 于是 `data.changes` 落库成了字符串 `"[+ 某一行]"`，前端按数组读就一行都渲染不出来（实测踩到）。
     */
    private fun toJson(fields: Map<String, Any>): JSONObject {
        val out = JSONObject()
        for ((key, value) in fields) {
            out.put(key, if (value is Collection<*>) JSONArray(value) else value)
        }
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
    private data class ChangeWork(val op: JSONObject, val page: Future<PagePayload?>? = null, val file: Future<File?>? = null)

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

    private fun discardStagedFile(future: Future<File?>) {
        if (!future.isDone) {
            future.cancel(true)
            return
        }
        if (future.isCancelled) return
        runCatching { await(future)?.delete() }
    }

    /**
     * 中枢已经没有这份内容（404：清单/oplog 里的旧条目滞后于改名或删除）时返回 null。
     *
     * 不能让它升级成整轮失败：水位推不过去，下一轮还会撞同一条，同步就永久卡死了（实测卡过）。
     * 其余错误（网络、鉴权、5xx）照旧抛出，交给上层的退避重试。
     */
    private fun <T> tolerateMissing(block: () -> T): T? = try {
        block()
    } catch (error: Exception) {
        if (error.message?.contains("404") == true) null else throw error
    }

    /** 取不回来的 op：推进水位并留一条记录，别静默跳过 */
    private fun skipMissingOp(op: JSONObject) {
        val kind = op.optString("kind")
        val target = op.optString("target")
        recordMissingAtHub(kind, target)
        val seq = op.optLong("seq")
        if (seq > 0) db.setSetting("sync_cursor", seq.toString())
    }

    /** 中枢已经没有这份内容（多半是被改名或删除）：记一条，说清为什么这一项没落地 */
    private fun recordMissingAtHub(kind: String, path: String) {
        if (!SyncOpText.isNoteworthyPush(path)) return
        val subject = if (kind == "page") "页面「${SyncOpText.pageTitle(path)}」" else "文件「$path」"
        db.log(
            "info",
            "pull-missing",
            "中枢已经没有这份内容（可能已被改名或删除），本次跳过：$subject",
            toJson(mapOf("kind" to kind, "path" to path)),
        )
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
            // 择优命中的那条排最前（局域网直连优先）；探不到时自然回到配置的中枢地址，行为与历史一致
            activeBase?.takeIf { it.isNotBlank() }?.let(::add)
            add(primary)
            for (i in 0 until fallbacks.length()) fallbacks.optString(i).trimEnd('/').takeIf { it.startsWith("http") }?.let(::add)
        }.distinct()
    }

    // ── 连接通道择优（局域网 → IPv6 → IPv4 → 断开）────────────────────────────────

    /** 「优先局域网」开关：只有显式存过 '0' 才算关，老库默认开（与 server 同口径） */
    fun preferLan(): Boolean = db.setting(linkPreferLanSetting) != "0"

    /** 设置页改开关：记一条日志并立刻按新策略重选一次，用户不必等下一轮同步 */
    fun setPreferLan(value: Boolean) {
        val before = preferLan()
        db.setSetting(linkPreferLanSetting, if (value) "1" else "0")
        if (before == value) return
        db.log(
            "info",
            "link-config",
            if (value) "已启用「优先局域网」：同一局域网内优先走内网直连，探不到时按 IPv6 → IPv4 自动降级"
            else "已关闭「优先局域网」：只按配置的中枢地址连接",
            JSONObject().put("preferLan", value),
        )
        forceProbe = true
        request(false)
    }

    /** 本机在同步群组里的显示名：中枢配置里的成员名（对账时学回），没学到时退回手机型号 */
    fun deviceLabel(): String {
        val learned = db.setting(deviceLabelSetting)?.trim().orEmpty()
        if (learned.isNotEmpty()) return learned
        val model = android.os.Build.MODEL?.trim().orEmpty()
        return if (model.isEmpty()) "手机" else "手机 $model"
    }

    /** 学回中枢配置里的成员名；名字变了记一条日志让用户看得见（与 server deviceLabel.ts 同口径） */
    private fun learnDeviceLabel(name: String) {
        val trimmed = name.trim().take(40)
        if (trimmed.isEmpty()) return
        val before = db.setting(deviceLabelSetting)?.trim().orEmpty()
        if (before == trimmed) return
        db.setSetting(deviceLabelSetting, trimmed)
        db.log(
            "info",
            "device-label",
            "本机名称已按中枢配置对齐为「$trimmed」",
            JSONObject().put("label", trimmed).put("previous", before),
        )
    }

    /** 显示名是哪来的：设置页据此说明「按中枢配置」还是「暂时显示手机名」 */
    fun deviceLabelSource(): String =
        if (db.setting(deviceLabelSetting)?.trim().isNullOrEmpty()) "hostname" else "member-config"

    /**
     * 学回中枢的更新源（多端同步共用一份，见 server/routes/sync.ts 的 updateSource 字段）：
     * 只写「中枢下发」那两个键，本机手填的地址不被覆盖——检查更新时本机手填优先。
     */
    private fun learnUpdateSource(url: String, repo: String) {
        val trimmedUrl = url.trim().trimEnd('/')
        val trimmedRepo = repo.trim().trim('/')
        if (trimmedUrl.isEmpty() || trimmedRepo.isEmpty()) return
        val before = "${db.setting(AppUpdateConfig.KEY_HUB_URL).orEmpty()}/${db.setting(AppUpdateConfig.KEY_HUB_REPO).orEmpty()}"
        if (before == "$trimmedUrl/$trimmedRepo") return
        db.setSetting(AppUpdateConfig.KEY_HUB_URL, trimmedUrl)
        db.setSetting(AppUpdateConfig.KEY_HUB_REPO, trimmedRepo)
        db.log(
            "info",
            "update-source",
            "更新源已按中枢配置对齐为「$trimmedRepo」",
            JSONObject().put("repo", trimmedRepo).put("url", trimmedUrl),
        )
    }

    /** 通道现状（`/api/sync/status` 的 link 字段）；未启用同步时为 null，界面据此整块隐藏 */
    fun linkStatus(): JSONObject? {
        if (db.setting("sync_role") != "member" || db.setting("sync_enabled") != "1") return null
        val base = activeBase.orEmpty()
        val candidates = JSONArray()
        for (item in linkCandidates) {
            candidates.put(
                JSONObject()
                    .put("kind", item.kind).put("label", item.label).put("url", item.url).put("ok", item.ok)
                    .put("latencyMs", item.latencyMs ?: JSONObject.NULL)
                    .put("error", item.error ?: JSONObject.NULL),
            )
        }
        return JSONObject()
            .put("channel", linkChannel)
            .put("url", if (linkChannel == SyncLink.CHANNEL_OFFLINE) "" else base)
            .put("host", SyncLink.hostPortOf(base))
            .put("latencyMs", linkLatencyMs ?: JSONObject.NULL)
            .put("since", linkSince ?: JSONObject.NULL)
            .put("probedAt", linkProbedAt ?: JSONObject.NULL)
            .put("preferLan", preferLan())
            .put("candidates", candidates)
    }

    private fun announcedLanUrls(): List<String> {
        announcedLanCache?.let { return it }
        val parsed = runCatching {
            val raw = JSONArray(db.setting(linkLanUrlsSetting) ?: "[]")
            (0 until raw.length()).map { raw.getString(it) }
        }.getOrDefault(emptyList())
        announcedLanCache = parsed
        return parsed
    }

    /** 记住中枢通告的内网地址：本轮与下次启动都先用它试局域网 */
    private fun rememberAnnouncedLan(urls: List<String>) {
        announcedLanCache = urls
        runCatching { db.setSetting(linkLanUrlsSetting, JSONArray(urls).toString()) }
    }

    /** 改绑定/解绑后清掉上一个中枢学到的东西（不能拿旧中枢的内网地址去连新中枢） */
    private fun resetLinkBinding() {
        activeBase = null
        linkCandidates = emptyList()
        linkChannel = SyncLink.CHANNEL_OFFLINE
        linkLatencyMs = null
        linkSince = null
        linkProbedAt = null
        lastProbeRoundAt = 0L
        probeBoundHub = null
        announcedLanCache = emptyList()
        runCatching { db.setSetting(linkLanUrlsSetting, "[]") }
    }

    /**
     * 一轮同步开头调一次：首次、到期（10 分钟）或显式要求（改档位）才真探。
     * 节流不是可选项——离线时每轮同步都先探一遍会把「同步中」白白拖长几秒。
     */
    private fun maybeProbeLink() {
        if (db.setting("sync_role") != "member" || db.setting("sync_enabled") != "1") return
        val hubBase = (db.setting("sync_hub_url") ?: "").trimEnd('/')
        // 绑定换了一个中枢：上一个中枢学到的内网地址与通道判定一律作废，且**必须立刻重探**——
        // 否则节流会让我们拿着旧中枢的候选继续显示「已断开」（实测：刚绑定完仍探旧地址）。
        if (hubBase != probeBoundHub) {
            resetLinkBinding()
            forceProbe = true
        }
        val now = System.currentTimeMillis()
        val firstRound = lastProbeRoundAt == 0L
        val due = firstRound || now - lastProbeRoundAt >= linkReprobeIntervalMs
        if (!forceProbe && !due) return
        if (!firstRound && forceProbe && now - lastProbeRoundAt < linkProbeMinIntervalMs) return
        forceProbe = false
        try {
            runProbeRound()
        } catch (error: Cancelled) {
            throw error
        } catch (error: Exception) {
            db.log("warn", "link-probe-failed", "连接通道探测失败：${error.message ?: error.javaClass.simpleName}")
        }
    }

    private fun runProbeRound() {
        val hubBase = (db.setting("sync_hub_url") ?: "").trimEnd('/')
        if (hubBase.isBlank()) return
        if (probeBoundHub != null && probeBoundHub != hubBase) resetLinkBinding()
        probeBoundHub = hubBase
        val prefer = preferLan()
        val results = mutableListOf<SyncLink.Candidate>()
        var learned: List<String>? = null
        // 最多两轮：第一轮从中枢取回内网地址清单，第二轮把它们探掉（清单会随网段变化，每次启动重学一遍）
        for (pass in 0..1) {
            for (target in SyncLink.planProbes(hubBase, announcedLanUrls(), prefer)) {
                checkActive()
                if (results.any { it.url == target.url }) continue
                val probe = probeAnnounce(target.url, probeTimeoutMs(target.kind))
                results += SyncLink.Candidate(target.kind, target.label, target.url, probe.ok, probe.latencyMs, probe.error)
                if (target.kind == SyncLink.KIND_HUB && probe.ok && probe.lan.isNotEmpty()) learned = probe.lan
                // 局域网已经通了就不必再探剩下的：这一轮的目的就是找到最快那条路
                if (target.kind == SyncLink.KIND_LAN && probe.ok && prefer) break
            }
            val pending = learned
            if (pending != null) {
                val changed = pending != announcedLanUrls()
                rememberAnnouncedLan(pending)
                learned = null
                // 刚学到（或清单变了）的地址要立刻探一轮，否则这一轮仍然只走了公网
                if (changed) continue
            }
            break
        }
        linkCandidates = results
        linkProbedAt = Instant.now().toString()
        lastProbeRoundAt = System.currentTimeMillis()

        val winner = SyncLink.pickWinner(results, prefer)
        if (winner == null) {
            // 全部候选失败：可能是真断网，也可能是中枢版本还没有这个通告端点（404）。
            // 后者不能显示「已断开」——同步其实正常，只是猜不出走的哪条路，退回按中枢地址归类。
            val hubProbe = results.firstOrNull { it.kind == SyncLink.KIND_HUB }
            if (hubProbe != null && !hubProbe.ok && hubProbe.error?.contains("404") == true) {
                activeBase = hubBase
                linkChannel = detectHubChannel(hubBase)
                linkLatencyMs = null
                linkSince = null
                if (!announceMissingLogged) {
                    announceMissingLogged = true
                    db.log("info", "link-announce-unavailable", "中枢尚未提供连接通告端点，连接通道按中枢地址判定：${SyncLink.channelLabel(linkChannel)}")
                }
                return
            }
            linkChannel = SyncLink.CHANNEL_OFFLINE
            linkLatencyMs = null
            return
        }

        val nextBase = winner.url
        val nextChannel = if (winner.kind == SyncLink.KIND_LAN) SyncLink.CHANNEL_LAN else detectHubChannel(nextBase)
        val previousBase = activeBase
        val changed = nextBase != previousBase || nextChannel != linkChannel
        activeBase = nextBase
        linkLatencyMs = winner.latencyMs
        linkChannel = nextChannel
        if (changed) {
            linkSince = Instant.now().toString()
            db.log(
                "info",
                "link-changed",
                "连接通道：${SyncLink.channelLabel(nextChannel)}（${SyncLink.hostPortOf(nextBase)}，延迟 ${winner.latencyMs ?: "?"} 毫秒）",
                JSONObject()
                    .put("channel", nextChannel).put("base", nextBase)
                    .put("latencyMs", winner.latencyMs ?: JSONObject.NULL)
                    .put("previous", previousBase ?: hubBase),
            )
        }
    }

    private data class AnnounceProbe(val ok: Boolean, val latencyMs: Long?, val error: String?, val lan: List<String>)

    /**
     * 一次候选探测：打中枢的连接通告端点（带令牌）。既证明这个地址可达，又顺手取回中枢的内网地址清单。
     * 逐候选设超时（不写进双栈记账）——探测超时被记成真实请求的失败会把界面的协议族判定带偏。
     */
    private fun probeAnnounce(base: String, timeoutMs: Long): AnnounceProbe {
        val url = "$base/api/sync/announce".toHttpUrlOrNull()
            ?: return AnnounceProbe(false, null, "地址无效", emptyList())
        val call = httpClient.newCall(
            Request.Builder().url(url)
                .header("Authorization", "Bearer ${token()}")
                .header("Accept", "application/json")
                .build(),
        )
        call.timeout().timeout(timeoutMs, TimeUnit.MILLISECONDS)
        activeCalls.add(call)
        val startedAt = System.currentTimeMillis()
        return try {
            call.execute().use { response ->
                if (!response.isSuccessful) return AnnounceProbe(false, null, "中枢返回 ${response.code}", emptyList())
                val data = runCatching { JSONObject(response.body?.string().orEmpty()) }.getOrNull()
                    ?: return AnnounceProbe(false, null, "中枢应答异常", emptyList())
                if (!data.optBoolean("ok")) return AnnounceProbe(false, null, "中枢应答异常", emptyList())
                val lan = mutableListOf<String>()
                data.optJSONArray("lan")?.let { arr -> for (i in 0 until arr.length()) lan += arr.optString(i) }
                AnnounceProbe(
                    true,
                    System.currentTimeMillis() - startedAt,
                    null,
                    SyncLink.normalizeAnnouncedLan(lan, db.setting("sync_hub_url")),
                )
            }
        } catch (error: Exception) {
            if (cancelled || !foreground) throw Cancelled()
            AnnounceProbe(false, null, describeLinkError(error, timeoutMs), emptyList())
        } finally {
            activeCalls.remove(call)
        }
    }

    private fun probeTimeoutMs(kind: String): Long =
        if (kind == SyncLink.KIND_LAN) linkProbeLanTimeoutMs
        else maxOf(linkProbeLanTimeoutMs, dualStackConfig().connectTimeoutMs + 1000L)

    /** 走中枢主地址（域名）时到底是 IPv6 还是 IPv4：优先信双栈记账，其次看域名解析出的协议族 */
    private fun detectHubChannel(base: String): String {
        SyncLink.classifyBase(base)?.let { return it }
        val host = SyncLink.hostnameOf(base)
        val entry = DualStack.status().firstOrNull { it.host == host }
        if (entry != null) return if (entry.family == 4) SyncLink.CHANNEL_IPV4 else SyncLink.CHANNEL_IPV6
        return try {
            val addresses = InetAddress.getAllByName(host)
            when {
                addresses.any { FamilyDns.isFamily(it, 6) } -> SyncLink.CHANNEL_IPV6
                addresses.any { FamilyDns.isFamily(it, 4) } -> SyncLink.CHANNEL_IPV4
                else -> SyncLink.CHANNEL_IPV4
            }
        } catch (_: UnknownHostException) {
            SyncLink.CHANNEL_IPV4
        }
    }

    /** 探测失败原因：超时/连不上给一句人话，其余截断保留（完整信息在同步详情里） */
    private fun describeLinkError(error: Exception, timeoutMs: Long): String {
        val text = error.message.orEmpty()
        return when {
            error is java.io.InterruptedIOException || text.contains("timeout", true) || text.contains("Canceled", true) ->
                "探测超时（$timeoutMs 毫秒）"
            error is java.net.ConnectException || error is java.net.SocketException || error is UnknownHostException ||
                text.contains("failed", true) || text.contains("refused", true) || text.contains("unreachable", true) -> "连不上"
            else -> text.take(60).ifBlank { "连不上" }
        }
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

    /** 上传一个文件；返回中枢应答（含 revision），推送记录要写「送到了中枢哪一版」 */
    private fun postFile(path: String, file: File): JSONObject {
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
        return withConnection("POST", "/api/sync/file", null, body) { response ->
            val bytes = response.body?.byteStream()?.use { readLimited(it, MAX_JSON_BYTES) } ?: ByteArray(0)
            runCatching { JSONObject(String(bytes, StandardCharsets.UTF_8)) }.getOrDefault(JSONObject())
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
