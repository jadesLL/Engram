package com.engram.app

import android.content.Context
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.PartData
import io.ktor.http.content.forEachPart
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.cio.CIOApplicationEngine
import io.ktor.server.engine.EmbeddedServer
import io.ktor.server.engine.EngineConnectorBuilder
import io.ktor.server.engine.embeddedServer
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.plugins.statuspages.exception
import io.ktor.server.request.header
import io.ktor.server.request.receiveMultipart
import io.ktor.server.request.receiveText
import io.ktor.server.response.header
import io.ktor.server.response.respondOutputStream
import io.ktor.server.response.respondText
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import io.ktor.server.routing.routing
import io.ktor.utils.io.jvm.javaio.toInputStream
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URLDecoder
import java.security.SecureRandom
import java.time.Instant
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

/**
 * APK 内嵌的本地优先服务。只监听 loopback，WebView 与桌面版共用 REST 契约。
 * Android 永远是同步成员，不签发成员、不运行 dsh/MCP；内置 Agent 会话窄代理到绑定的 Docker 中枢。
 */
class EngramLocalServer private constructor(private val context: Context) {
    private val db = LocalDatabase(context)
    private val secrets = SecretStore(context)
    private val sync = SyncEngine(db, secrets)
    private val agent = AgentBridge(db, secrets)
    private val sessionToken: String = secrets.get("local_session_token") ?: randomToken().also {
        secrets.put("local_session_token", it)
    }
    private var engine: EmbeddedServer<CIOApplicationEngine, CIOApplicationEngine.Configuration>? = null

    @Synchronized
    fun start() {
        if (engine != null) return
        engine = embeddedServer(CIO, configure = {
            connectors.add(EngineConnectorBuilder().apply {
                host = "127.0.0.1"
                port = PORT
            })
            // 只有单个 WebView 客户端；避免默认按 CPU 核数创建多组调度线程与缓冲区。
            connectionGroupSize = 1
            workerGroupSize = 1
            callGroupSize = 2
            connectionIdleTimeoutSeconds = 5
        }) {
            install(StatusPages) {
                exception<IllegalArgumentException> { call, error ->
                    call.json(JSONObject().put("error", error.message ?: "请求无效"), HttpStatusCode.BadRequest)
                }
                exception<Throwable> { call, error ->
                    call.json(JSONObject().put("error", error.message ?: "本地服务错误"), HttpStatusCode.InternalServerError)
                }
            }
            routing { routes() }
        }.start(wait = false)
    }

    fun onForeground() = sync.onForeground()
    fun onBackground() = sync.onBackground()
    fun requestSync(full: Boolean) = sync.request(full)
    fun importSharedText(title: String?, text: String): String = db.importSharedText(title, text)
    fun importSharedFile(name: String, staged: File): String = db.installSharedFile(name, staged)

    /** 旧远程壳升级：只把旧地址预填为候选中枢，不启用同步、不覆盖本地库。 */
    fun migrateLegacyRemoteUrl() {
        if (!db.setting("sync_hub_url").isNullOrBlank()) return
        val legacy = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
        val primary = legacy.getString("serverUrl", "").orEmpty().trim()
        val direct = legacy.getString("serverUrlDirect", "").orEmpty().trim()
        if (primary.startsWith("http://") || primary.startsWith("https://")) db.setSetting("sync_hub_url", primary.trimEnd('/'))
        if (direct.startsWith("http://") || direct.startsWith("https://")) db.setSetting("sync_direct_urls", JSONArray().put(direct.trimEnd('/')).toString())
    }

    private fun io.ktor.server.routing.Route.routes() {
        get("/health") { call.json(JSONObject().put("ok", true).put("runtime", "android-local")) }
        get("/api/runtime/capabilities") {
            val remoteAgent = agent.configured()
            call.json(JSONObject()
                .put("runtime", "android-local").put("localFirst", true)
                .put("agentMode", if (remoteAgent) "hub" else "unavailable")
                .put("nativeActions", JSONArray().put("share-text").put("share-file").put("file-picker"))
                .put("syncRoles", JSONArray().put("none").put("member"))
                .put("features", JSONObject()
                    .put("agent", remoteAgent).put("agentAdmin", false).put("mcp", false).put("jobs", false)
                    .put("onlyOffice", false).put("serverUpdate", false).put("ddns", false)
                    .put("backup", true).put("fileExtraction", true)))
        }

        get("/api/auth/status") {
            call.json(JSONObject().put("initialized", db.authInitialized()).put("authed", call.isAuthed()))
        }
        post("/api/auth/setup") {
            if (db.authInitialized()) return@post call.error("已初始化", HttpStatusCode.BadRequest)
            db.setPassword(call.body().optString("password"))
            call.setSession(); call.json(JSONObject().put("ok", true))
        }
        post("/api/auth/login") {
            if (!db.checkPassword(call.body().optString("password"))) return@post call.error("密码错误", HttpStatusCode.Unauthorized)
            call.setSession(); call.json(JSONObject().put("ok", true))
        }
        post("/api/auth/logout") {
            call.response.header(HttpHeaders.SetCookie, "$SESSION_COOKIE=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
            call.json(JSONObject().put("ok", true))
        }
        post("/api/auth/password") {
            if (!call.authorize()) return@post
            val body = call.body()
            if (!db.checkPassword(body.optString("oldPassword"))) return@post call.error("原密码错误", HttpStatusCode.BadRequest)
            db.setPassword(body.optString("newPassword")); call.json(JSONObject().put("ok", true))
        }

        get("/api/pages/tree") { if (call.authorize()) call.json(JSONObject().put("tree", db.tree())) }
        get("/api/pages/list") {
            if (!call.authorize()) return@get
            var pages = db.pages()
            call.request.queryParameters["type"]?.let { type -> pages = pages.filter { it.optString("type") == type } }
            call.request.queryParameters["tag"]?.let { tag -> pages = pages.filter { it.optJSONArray("tags")?.contains(tag) == true } }
            call.json(JSONObject().put("guideVersion", 0).put("pages", pages))
        }
        get("/api/pages/tags") { if (call.authorize()) call.json(JSONObject().put("tags", db.tags())) }
        get("/api/pages/suggest") {
            if (call.authorize()) call.json(JSONObject().put("suggestions", db.suggest(call.request.queryParameters["q"].orEmpty())))
        }
        get("/api/pages/by-title/{title}") {
            if (!call.authorize()) return@get
            val page = db.pageByTitle(decoded(call.parameters["title"].orEmpty())) ?: return@get call.error("not found", HttpStatusCode.NotFound)
            call.json(JSONObject().put("id", page.getString("id")))
        }
        post("/api/pages") {
            if (!call.authorize()) return@post
            val body = call.body()
            call.json(JSONObject().put("meta", db.createPage(body.optStringOrNull("dir"), body.optStringOrNull("title"), body.optStringOrNull("type"))))
        }
        get("/api/pages/{id}/evidence") {
            if (!call.authorize()) return@get
            call.json(db.pageEvidence(call.parameters["id"].orEmpty()))
        }
        get("/api/pages/{id}/related") {
            if (!call.authorize()) return@get
            call.json(db.related(call.parameters["id"].orEmpty()))
        }
        get("/api/pages/{id}") {
            if (!call.authorize()) return@get
            val page = db.page(call.parameters["id"].orEmpty()) ?: return@get call.error("页面不存在", HttpStatusCode.NotFound)
            val content = page.optString("content"); page.remove("content")
            call.json(JSONObject().put("meta", page).put("content", content))
        }
        put("/api/pages/{id}") {
            if (!call.authorize()) return@put
            call.json(JSONObject().put("meta", db.updatePage(call.parameters["id"].orEmpty(), call.body())))
        }
        post("/api/pages/{id}/archive") { if (call.authorize()) { db.archive(call.parameters["id"].orEmpty()); call.ok() } }
        post("/api/pages/{id}/unarchive") { if (call.authorize()) { db.unarchive(call.parameters["id"].orEmpty()); call.ok() } }
        post("/api/pages/{id}/move") {
            if (!call.authorize()) return@post
            val body = call.body(); call.json(JSONObject().put("ok", true).put("meta", db.movePage(call.parameters["id"].orEmpty(), body.optStringOrNull("dir"), body.optStringOrNull("newTitle"))))
        }
        post("/api/pages/{id}/rename") {
            if (!call.authorize()) return@post
            db.renamePage(call.parameters["id"].orEmpty(), call.body().optString("newTitle")); call.ok()
        }
        delete("/api/pages/{id}") { if (call.authorize()) { db.deletePage(call.parameters["id"].orEmpty()); call.ok() } }
        post("/api/mkdir") { if (call.authorize()) call.ok() }

        get("/api/files/list") {
            if (!call.authorize()) return@get
            val section = call.request.queryParameters["section"]
            call.json(JSONObject().put("files", db.files(call.request.queryParameters["dir"], section)))
        }
        // 原始资料二级分类定义（与 server/src/lib/rawSections.ts 同口径）
        get("/api/files/sections") {
            if (!call.authorize()) return@get
            call.json(JSONObject()
                .put("sections", JSONArray().apply {
                    put(JSONObject().put("key", "doc").put("dir", "原始资料/文档").put("label", "文档")
                        .put("hint", "成文的完整文件：会议纪要、调研报告、复盘、年报、教程、攻略…"))
                    put(JSONObject().put("key", "chat").put("dir", "原始资料/对话").put("label", "对话")
                        .put("hint", "与 Agent 的对话沉积（save_chat 写入，可按项目分目录）"))
                    put(JSONObject().put("key", "idea").put("dir", "原始资料/灵感碎片").put("label", "灵感碎片")
                        .put("hint", "随手记：零散条目、想法、待办"))
                })
                .put("defaultDir", "原始资料/文档"))
        }
        post("/api/files/create") {
            if (!call.authorize()) return@post
            call.json(db.createRawFile(call.body().optString("name", "未命名.md"), call.body().optString("section").ifBlank { null }))
        }
        post("/api/files/upload") {
            if (!call.authorize()) return@post
            val incoming = mutableListOf<Pair<String, File>>()
            // 默认落「文档」二级目录（与 server routes/files.ts 同口径）
            var dir = "原始资料/文档"
            try {
                call.receiveMultipart(formFieldLimit = MAX_FILE_BYTES).forEachPart { part ->
                    when (part) {
                        is PartData.FormItem -> if (part.name == "dir") dir = part.value.trim('/').ifBlank { "原始资料/文档" }
                        is PartData.FileItem -> {
                            val name = sanitizeFileName(part.originalFileName ?: "file")
                            val staged = File(db.root, "upload-${UUID.randomUUID()}.tmp")
                            try {
                                part.provider().toInputStream().use { input -> staged.outputStream().use { copyLimited(input, it) } }
                                incoming += name to staged
                            } catch (error: Exception) {
                                staged.delete()
                                throw error
                            }
                        }
                        else -> Unit
                    }
                    part.dispose()
                }
            } catch (error: Exception) {
                incoming.forEach { it.second.delete() }
                throw error
            }
            // 与 server config.ts UPLOAD_DIRS 同口径（原始资料三个二级目录 + 一级目录 + assets 供编辑器贴图），改一处要同步另一处
            require(
                dir == "原始资料" || dir == "原始资料/文档" || dir == "原始资料/对话" || dir == "原始资料/灵感碎片" || dir == "assets"
            ) { "文件只能上传到「原始资料」的 文档 / 对话 / 灵感碎片 目录" }
            val saved = JSONArray(); val duplicates = JSONArray()
            incoming.forEach { (name, staged) ->
                try { saved.put(db.installImportedFile("$dir/$name", staged)) }
                catch (error: IllegalArgumentException) { duplicates.put(name) }
                finally { staged.delete() }
            }
            if (saved.length() == 0 && duplicates.length() > 0) return@post call.error("已存在同名文件，未重复导入", HttpStatusCode.Conflict)
            call.json(JSONObject().put("saved", saved).put("duplicates", duplicates))
        }
        // 编辑器贴图 / 侧栏拖图：图片是 md 父项的私有资产，落 brain/assets/<父项id>/（与 server routes/assets.ts 同规则）。
        // 父项 = 表单 parent 字段或 X-Engram-Parent 头，必须是已有页面；insert=append 时顺手写进正文。
        post("/api/assets/upload") {
            if (!call.authorize()) return@post
            var parent = call.request.header("X-Engram-Parent").orEmpty()
            var insert = ""
            val incoming = mutableListOf<Pair<String, ByteArray>>()
            call.receiveMultipart(formFieldLimit = MAX_ASSET_BYTES).forEachPart { part ->
                when (part) {
                    is PartData.FormItem -> when (part.name.orEmpty()) {
                        "parent" -> parent = part.value.trim()
                        "insert" -> insert = part.value.trim()
                    }
                    is PartData.FileItem -> {
                        val name = sanitizeFileName(part.originalFileName ?: "image")
                        val bytes = part.provider().toInputStream().use { input ->
                            val data = input.readBytes()
                            require(data.size <= MAX_ASSET_BYTES) { "单张图片超过 12 MB 上限" }
                            data
                        }
                        incoming += name to bytes
                    }
                    else -> Unit
                }
                part.dispose()
            }
            if (incoming.isEmpty()) return@post call.error("没有收到图片", HttpStatusCode.BadRequest)
            val pageId = parent.trim()
            if (!PARENT_ID_REGEX.matches(pageId) || pageId == "_unassigned" || db.page(pageId) == null) {
                return@post call.error("父项无效：图片只能插进已有页面", HttpStatusCode.BadRequest)
            }
            val saved = JSONArray(); val errors = JSONArray(); var appended = false
            for ((name, bytes) in incoming) {
                val extension = name.substringAfterLast('.', "").lowercase()
                if (extension !in ASSET_EXTENSIONS) { errors.put(name); continue }
                val asset = db.savePageAsset(pageId, name, bytes)
                saved.put(asset)
                if (insert == "append") {
                    val assetName = asset.getString("name")
                    val alt = assetName.substringAfter('-').substringBeforeLast('.', assetName)
                    if (db.appendPageMedia(pageId, assetName, alt.ifBlank { "图片" })) appended = true
                }
            }
            call.json(JSONObject().put("saved", saved).put("errors", errors).put("appended", appended))
        }

        // 「查看引用图片」抽屉：列某个父项的本地图片资产 / 删除单张 / 外链图本地化（Android 不外链抓图）
        get("/api/assets/orphans/list") {
            if (!call.authorize()) return@get
            call.json(db.orphanAssets())
        }
        get("/api/assets/{parentId}") {
            if (!call.authorize()) return@get
            val parentId = call.parameters["parentId"].orEmpty()
            if (!PARENT_ID_REGEX.matches(parentId)) return@get call.error("父项无效", HttpStatusCode.BadRequest)
            val title = if (parentId == "_unassigned") "未归属图片"
            else db.page(parentId)?.optString("title")?.takeIf { it.isNotBlank() }
                ?: return@get call.error("父项不存在", HttpStatusCode.NotFound)
            call.json(JSONObject()
                .put("parent", JSONObject().put("id", parentId).put("title", title))
                .put("assets", db.listPageAssets(parentId))
                .put("remoteImages", JSONArray()))
        }
        delete("/api/assets") {
            if (!call.authorize()) return@delete
            val body = call.body()
            val parentId = body.optString("parentId"); val name = body.optString("name")
            if (!PARENT_ID_REGEX.matches(parentId) || name.isBlank()) return@delete call.error("参数无效", HttpStatusCode.BadRequest)
            runCatching { db.deletePageAsset(parentId, name) }.onFailure { return@delete call.error("路径无效", HttpStatusCode.BadRequest) }
            call.ok()
        }
        post("/api/assets/localize") {
            if (!call.authorize()) return@post
            // Android 不外链抓图（没有服务端的抓取链路），正文里的外链图保持原样
            call.json(JSONObject().put("localized", 0).put("failed", JSONArray()))
        }

        get("/api/files/preview") {            if (!call.authorize()) return@get
            val path = call.request.queryParameters["path"] ?: return@get call.error("缺少 path", HttpStatusCode.BadRequest)
            val file = db.file(path); if (!file.isFile) return@get call.error("文件不存在", HttpStatusCode.NotFound)
            val ext = file.extension.lowercase()
            val response = when (ext) {
                "docx", "xlsx", "pptx" -> JSONObject().put("kind", "office").put("ext", ext).put("url", "/api/files/raw?path=${encoded(path)}")
                "pdf" -> JSONObject().put("kind", "pdf").put("ext", ext).put("url", "/api/files/content?path=${encoded(path)}").put("extraction", db.extraction(path) ?: JSONObject.NULL)
                "png", "jpg", "jpeg", "gif", "webp", "svg" -> JSONObject().put("kind", "image").put("url", "/api/files/content?path=${encoded(path)}").put("extraction", db.extraction(path) ?: JSONObject.NULL)
                "md", "markdown" -> JSONObject().put("kind", "markdown").put("text", db.rawPage(path).orEmpty().substringAfter("\n---\n", db.rawPage(path).orEmpty()).trim())
                "txt", "json", "log", "yaml", "yml", "csv" -> JSONObject().put("kind", "text").put("text", file.readText().take(200_000))
                else -> JSONObject().put("kind", "unsupported").put("ext", ext)
            }
            call.json(response)
        }
        get("/api/files/content") { if (call.authorize()) call.sendFile(inline = true) }
        get("/api/files/raw") { if (call.authorize()) call.sendFile(inline = false) }
        get("/api/files/open") { if (call.authorize()) call.sendFile(inline = false) }
        // 侧栏/预览页的「下载」别名（与 content/raw 同一实现，只是下载语义更明确）
        get("/api/files/download") { if (call.authorize()) call.sendFile(inline = false) }
        get("/api/files/extraction") {
            if (!call.authorize()) return@get
            val path = call.request.queryParameters["path"] ?: return@get call.error("缺少 path", HttpStatusCode.BadRequest)
            val extraction = db.extraction(path) ?: return@get call.error("尚无文字提取记录", HttpStatusCode.NotFound)
            call.json(JSONObject().put("extraction", extraction))
        }
        post("/api/files/extract") {
            if (!call.authorize()) return@post
            val body = call.body(); val pages = body.optJSONArray("embedded_pages")
                ?: return@post call.error("Android 端不执行 OCR；请使用本地内嵌文字提取", HttpStatusCode.NotImplemented)
            call.json(JSONObject().put("ok", true).put("extraction", db.saveExtraction(body.optString("path"), pages)))
        }
        post("/api/files/export") {
            if (!call.authorize()) return@post
            val body = call.body(); val paths = body.optJSONArray("paths") ?: JSONArray()
            val temp = File(db.root, "export-${UUID.randomUUID()}.zip")
            ZipOutputStream(temp.outputStream().buffered()).use { zip ->
                for (i in 0 until paths.length()) addZipFile(zip, db.file(paths.optString(i)), paths.optString(i))
            }
            call.download(temp, "${sanitizeFileName(body.optString("name", "导出"))}-${Instant.now().toString().take(10)}.zip")
        }
        delete("/api/files") {
            if (!call.authorize()) return@delete
            db.deleteFile(call.body().optString("path")); call.ok()
        }

        // 页面图片资产直链：/media/<父项id>/<文件名> → brain/assets/<父项id>/<文件名>。
        // 正文里存的是根相对路径，图片在阅读视图与编辑器预览里由浏览器直接解析（与 server routes/media.ts 同规则）。
        get("/media/{parentId}/{name}") {
            if (!call.authorize()) return@get
            val parentId = call.parameters["parentId"].orEmpty()
            val name = call.parameters["name"].orEmpty()
            val extension = name.substringAfterLast('.', "").lowercase()
            if (!PARENT_ID_REGEX.matches(parentId) || extension !in ASSET_EXTENSIONS) {
                return@get call.error("图片不存在", HttpStatusCode.NotFound)
            }
            val assets = File(db.brain, "assets").canonicalFile
            val file = File(assets, "$parentId/$name").canonicalFile
            if (!file.path.startsWith(assets.path + File.separator) || !file.isFile) {
                return@get call.error("图片不存在", HttpStatusCode.NotFound)
            }
            // 文件名是内容寻址的（<sha1-8>-<原名>），可以安全长缓存
            call.response.header(HttpHeaders.CacheControl, "private, max-age=31536000, immutable")
            call.response.header("X-Content-Type-Options", "nosniff")
            if (extension == "svg") call.response.header("Content-Security-Policy", "sandbox")
            call.response.header(HttpHeaders.ContentLength, file.length().toString())
            call.respondOutputStream(mime(extension)) { file.inputStream().use { it.copyTo(this, 64 * 1024) } }
        }

        get("/api/search") {
            if (!call.authorize()) return@get
            call.json(JSONObject().put("hits", db.search(call.request.queryParameters["q"].orEmpty())))
        }
        get("/api/graph") {
            if (!call.authorize()) return@get
            call.json(db.graph(call.request.queryParameters["scope"], call.request.queryParameters["id"]))
        }
        get("/api/jobs") { if (call.authorize()) call.json(JSONObject().put("active", JSONArray()).put("recent", JSONArray()).put("queue", JSONObject().put("running", false))) }

        // Docker 内置 Agent：Android 只代理交互面，模型配置、dsh 进程和长任务仍留在中枢。
        get("/api/assistant/status") { call.proxyAgent("GET", "/api/assistant/status") }
        get("/api/assistant/sessions") { call.proxyAgent("GET", "/api/assistant/sessions") }
        post("/api/assistant/sessions") { call.proxyAgent("POST", "/api/assistant/sessions", call.receiveText()) }
        get("/api/assistant/sessions/{id}") {
            call.proxyAgent("GET", "/api/assistant/sessions/${encoded(call.parameters["id"].orEmpty())}")
        }
        patch("/api/assistant/sessions/{id}") {
            call.proxyAgent("PATCH", "/api/assistant/sessions/${encoded(call.parameters["id"].orEmpty())}", call.receiveText())
        }
        delete("/api/assistant/sessions/{id}") {
            call.proxyAgent("DELETE", "/api/assistant/sessions/${encoded(call.parameters["id"].orEmpty())}")
        }
        post("/api/assistant/sessions/{id}/runs") {
            call.proxyAgent("POST", "/api/assistant/sessions/${encoded(call.parameters["id"].orEmpty())}/runs", call.receiveText())
        }
        get("/api/assistant/runs/active") { call.proxyAgent("GET", "/api/assistant/runs/active") }
        get("/api/assistant/runs/{id}/events") {
            call.proxyAgentEvents("/api/assistant/runs/${encoded(call.parameters["id"].orEmpty())}/events")
        }
        get("/api/assistant/runs/{id}") {
            call.proxyAgent("GET", "/api/assistant/runs/${encoded(call.parameters["id"].orEmpty())}")
        }
        post("/api/assistant/runs/{id}/cancel") {
            call.proxyAgent("POST", "/api/assistant/runs/${encoded(call.parameters["id"].orEmpty())}/cancel", "{}")
        }
        post("/api/assistant/runs/{id}/retry") {
            call.proxyAgent("POST", "/api/assistant/runs/${encoded(call.parameters["id"].orEmpty())}/retry", "{}")
        }
        post("/api/assistant/runs/{id}/ingest") {
            call.proxyAgent("POST", "/api/assistant/runs/${encoded(call.parameters["id"].orEmpty())}/ingest", "{}")
        }
        post("/api/assistant/questions/{id}/answer") {
            call.proxyAgent("POST", "/api/assistant/questions/${encoded(call.parameters["id"].orEmpty())}/answer", call.receiveText())
        }
        // 任务看板：状态与重新生成都落中枢（本机不跑 dsh），与上面几条一样窄代理
        get("/api/tasks/board") { call.proxyAgent("GET", "/api/tasks/board") }
        post("/api/tasks/board/refresh") { call.proxyAgent("POST", "/api/tasks/board/refresh", "{}") }

        // 收集箱：语义转换要中枢的内置 Agent，本机不跑模型也不跑任务队列，整条交互面按同一模式窄代理。
        // 收集箱原件走同步落在两端同一目录，所以中枢看到的文件与手机上是同一份。
        get("/api/inbox/items") { call.proxyHub("GET", "/api/inbox/items") }
        post("/api/inbox/upload") { call.proxyHubUpload() }
        post("/api/inbox/fetch-url") { call.proxyHub("POST", "/api/inbox/fetch-url", call.receiveText()) }
        get("/api/inbox/download") { call.proxyHubDownload() }
        delete("/api/inbox/items") { call.proxyHub("DELETE", "/api/inbox/items", call.receiveText()) }
        get("/api/inbox/derived-path") {
            call.proxyHub("GET", "/api/inbox/derived-path?path=${encoded(call.request.queryParameters["path"].orEmpty())}")
        }
        get("/api/inbox/derived") {
            call.proxyHub("GET", "/api/inbox/derived?path=${encoded(call.request.queryParameters["path"].orEmpty())}")
        }
        post("/api/inbox/adopt") { call.proxyHub("POST", "/api/inbox/adopt", call.receiveText()) }
        post("/api/inbox/convert") { call.proxyHub("POST", "/api/inbox/convert", call.receiveText()) }

        // 记一条灵感：标题由中枢的模型拟、落盘前再按知识库既有写法勘误一遍，本机没有模型，同样窄代理
        post("/api/ideas") { call.proxyHub("POST", "/api/ideas", call.receiveText()) }

        get("/api/trash") { if (call.authorize()) call.json(db.trash()) }
        post("/api/trash/restore") { if (call.authorize()) call.json(db.restoreTrash(call.body().ids())) }
        delete("/api/trash") { if (call.authorize()) call.json(db.deleteTrash(call.body().ids())) }
        delete("/api/trash/all") { if (call.authorize()) call.json(db.emptyTrash()) }

        get("/api/settings") { if (call.authorize()) call.json(JSONObject().put("settings", db.publicSettings())) }
        put("/api/settings") {
            if (!call.authorize()) return@put
            val body = call.body()
            // 白名单与 server PUBLIC_SETTINGS 对齐；DDNS / 一键接入 token 在 Android 上没有意义，显式忽略
            for (key in listOf("search_synonyms", "show_ai_workspace")) if (body.has(key)) db.setSetting(key, body.optString(key))
            call.ok()
        }
        get("/api/settings/backup") {
            if (!call.authorize()) return@get
            val temp = createBackup(); call.download(temp, "engram-backup-${Instant.now().toString().take(10)}.zip")
        }
        post("/api/settings/restore") {
            if (!call.authorize()) return@post
            var password = ""; var archive: File? = null
            call.receiveMultipart(formFieldLimit = MAX_BACKUP_BYTES).forEachPart { part ->
                when (part) {
                    is PartData.FormItem -> if (part.name == "password") password = part.value
                    is PartData.FileItem -> {
                        val target = File(db.root, "restore-${UUID.randomUUID()}.zip")
                        try {
                            part.provider().toInputStream().use { input -> target.outputStream().use { copyLimited(input, it, MAX_BACKUP_BYTES) } }
                            archive = target
                        } catch (error: Exception) {
                            target.delete()
                            throw error
                        }
                    }
                    else -> Unit
                }
                part.dispose()
            }
            if (!db.checkPassword(password)) { archive?.delete(); return@post call.error("密码错误", HttpStatusCode.Unauthorized) }
            val result = restoreBackup(archive ?: return@post call.error("未选择备份文件", HttpStatusCode.BadRequest))
            call.json(JSONObject().put("ok", true).put("needsRestart", false).put("files", result))
        }
        post("/api/settings/wipe") {
            if (!call.authorize()) return@post
            if (!db.checkPassword(call.body().optString("password"))) return@post call.error("密码错误", HttpStatusCode.Unauthorized)
            val count = db.knowledgeFileCount(); db.wipe()
            call.json(JSONObject().put("ok", true).put("fileCount", count).put("reportCount", 0).put("cancelledJobs", 0))
        }
        // 清空 AI 整理日志（保留知识正文）：与 server 同语义，Android 无关系表故 relationCount 恒 0
        post("/api/settings/wipe-ai-logs") {
            if (!call.authorize()) return@post
            if (!db.checkPassword(call.body().optString("password"))) return@post call.error("密码错误", HttpStatusCode.Unauthorized)
            call.json(JSONObject().put("ok", true).put("fileCount", db.wipeAiLogs()).put("relationCount", 0).put("cancelledJobs", 0))
        }

        get("/api/sync/status") {
            if (!call.authorize()) return@get
            call.json(syncStatus())
        }
        // 同步详情抽屉：分页 / 筛选 / 清空都落在本机 sync_log 上。
        // 中枢的 /api/sync/log 只对 owner 开放，成员端（手机只有成员令牌）拿不到，所以本地实现。
        get("/api/sync/log") {
            if (!call.authorize()) return@get
            val params = call.request.queryParameters
            val limit = (params["limit"]?.toIntOrNull() ?: 200).coerceIn(1, 2000)
            val page = db.syncLogs(
                limit = limit,
                before = params["before"]?.toLongOrNull(),
                level = params["level"]?.takeIf { it == "info" || it == "warn" || it == "error" },
                q = params["q"]?.takeIf { it.isNotBlank() },
            )
            page.put("status", syncStatus())
            call.json(page)
        }
        delete("/api/sync/log") {
            if (!call.authorize()) return@delete
            call.json(JSONObject().put("ok", true).put("cleared", db.clearSyncLog()))
        }
        post("/api/sync/config") {
            if (!call.authorize()) return@post
            val body = call.body(); val role = body.optString("role", "member")
            require(role == "none" || role == "member") { "Android 只能作为同步成员" }
            if (role == "member") {
                val url = body.optString("hub_url", db.setting("sync_hub_url").orEmpty()).trimEnd('/')
                val token = body.optString("hub_token")
                require(url.startsWith("http://") || url.startsWith("https://")) { "中枢地址无效" }
                if (token.isNotBlank()) secrets.put("sync_hub_token", token)
                require(!secrets.get("sync_hub_token").isNullOrBlank()) { "请填写绑定令牌" }
                db.setSetting("sync_hub_url", url); db.setSetting("sync_enabled", if (body.optBoolean("enabled", true)) "1" else "0")
                if (body.has("direct_urls")) {
                    val incoming = body.optJSONArray("direct_urls") ?: JSONArray()
                    val valid = JSONArray()
                    for (i in 0 until incoming.length()) incoming.optString(i).trimEnd('/').takeIf { it.startsWith("http://") || it.startsWith("https://") }?.let(valid::put)
                    db.setSetting("sync_direct_urls", valid.toString())
                }
            } else {
                db.setSetting("sync_enabled", "0"); secrets.put("sync_hub_token", null)
            }
            db.setSetting("sync_role", role); call.ok(); if (role == "member") sync.request(false)
        }
        post("/api/sync/reconcile") { if (call.authorize()) { sync.request(true); call.ok() } }

        get("/") { call.serveAsset("index.html") }
        get("/{path...}") {
            val requested = call.parameters.getAll("path")?.joinToString("/").orEmpty().ifBlank { "index.html" }
            if (requested.startsWith("api/")) return@get call.error("接口不存在", HttpStatusCode.NotFound)
            // 段数不对或文件不存在的图片请求不能回落成 index.html，否则 <img> 拿到一页 HTML 只会显示破图
            if (requested.startsWith("media/")) return@get call.error("图片不存在", HttpStatusCode.NotFound)
            call.serveAsset(requested)
        }
    }

    private suspend fun ApplicationCall.body(): JSONObject = receiveText().takeIf { it.isNotBlank() }?.let(::JSONObject) ?: JSONObject()
    private fun ApplicationCall.isAuthed() = request.cookies[SESSION_COOKIE] == sessionToken
    private suspend fun ApplicationCall.authorize(): Boolean {
        if (isAuthed()) return true
        error("未授权", HttpStatusCode.Unauthorized); return false
    }
    private fun ApplicationCall.setSession() = response.header(HttpHeaders.SetCookie, "$SESSION_COOKIE=$sessionToken; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000")
    private suspend fun ApplicationCall.ok() = json(JSONObject().put("ok", true))
    private suspend fun ApplicationCall.error(message: String, status: HttpStatusCode) = json(JSONObject().put("error", message), status)
    private suspend fun ApplicationCall.json(value: Any, status: HttpStatusCode = HttpStatusCode.OK) = respondText(value.toString(), ContentType.Application.Json, status)

    /** /api/sync/status 与同步详情抽屉共用的状态对象（字段名对齐 server，web 两处都按这套读） */
    private fun syncStatus(): JSONObject = JSONObject()
        .put("role", db.setting("sync_role") ?: "none")
        .put("enabled", db.setting("sync_enabled") == "1")
        .put("connected", sync.connected).put("running", sync.isRunning()).put("syncing", sync.isRunning())
        .put("reconciling", false).put("revision", 0)
        .put("hubUrl", db.setting("sync_hub_url") ?: "")
        .put("directUrls", JSONArray(db.setting("sync_direct_urls") ?: "[]"))
        .put("hubToken", if (secrets.get("sync_hub_token").isNullOrBlank()) "" else "••••••••")
        .put("nodeId", db.setting("sync_node_id") ?: "").put("cursor", db.setting("sync_cursor")?.toLongOrNull() ?: 0)
        .put("pending", db.outboxCount()).put("pendingPulls", sync.pendingPulls).put("syncProgress", sync.syncProgress)
        .put("lastSyncAt", sync.lastSyncAt)
        // 本机内容版本号：每落地一项同步改动 +1。前端靠它在对账进行中就逐步刷新文件树/首页，
        // 而不是等整轮跑完（旧行为：首次全量对账期间侧栏与首页一直是空的）。
        .put("contentRevision", db.contentRevision())
        .put("lastError", sync.lastError).put("log", db.logs()).put("peers", JSONArray())

    /**
     * 收集箱与记灵感的窄代理：真正干活的是中枢（模型拟标题、语义转换、任务队列）。
     * 未绑定中枢时返回 409 + 一句能看懂的话，而不是让前端撞上兜底 404「接口不存在」。
     */
    private suspend fun ApplicationCall.proxyHub(method: String, path: String, requestBody: String? = null) {
        if (!authorize()) return
        if (!agent.configured()) return error(HUB_REQUIRED, HttpStatusCode.Conflict)
        val remote = agent.request(method, path, requestBody)
        if (remote.status == 401) return error(HUB_TOKEN_REJECTED, HttpStatusCode.BadGateway)
        val type = runCatching { ContentType.parse(remote.contentType) }.getOrDefault(ContentType.Application.Json)
        response.header(HttpHeaders.CacheControl, "no-store")
        response.header(HttpHeaders.ContentLength, remote.body.size.toString())
        respondOutputStream(type, HttpStatusCode.fromValue(remote.status)) { write(remote.body) }
    }

    /** 收集箱上传：把 WebView 发来的 multipart 原样流式转发到中枢，文件不整块进内存、不限单文件大小。 */
    private suspend fun ApplicationCall.proxyHubUpload() {
        if (!authorize()) return
        if (!agent.configured()) return error(HUB_REQUIRED, HttpStatusCode.Conflict)
        val boundary = "----EngramAndroid${UUID.randomUUID().toString().replace("-", "")}"
        val remote = agent.openMultipart("/api/inbox/upload", boundary)
        try {
            remote.doOutput = true
            remote.setChunkedStreamingMode(64 * 1024)
            remote.outputStream.buffered(64 * 1024).use { output ->
                receiveMultipart(formFieldLimit = MAX_HUB_FIELD_BYTES).forEachPart { part ->
                    when (part) {
                        is PartData.FormItem -> {
                            writeMultipartHeader(output, boundary, part.name.orEmpty().ifBlank { "dir" }, null, null)
                            output.write(part.value.toByteArray(Charsets.UTF_8))
                            output.write(MULTIPART_CRLF)
                        }
                        is PartData.FileItem -> {
                            writeMultipartHeader(
                                output,
                                boundary,
                                part.name.orEmpty().ifBlank { "file" },
                                sanitizeFileName(part.originalFileName ?: "file"),
                                part.contentType?.toString(),
                            )
                            part.provider().toInputStream().use { input -> input.copyTo(output, 64 * 1024) }
                            output.write(MULTIPART_CRLF)
                        }
                        else -> Unit
                    }
                    part.dispose()
                }
                output.write("--$boundary--\r\n".toByteArray(Charsets.UTF_8))
            }
            val status = remote.responseCode
            val source = if (status in 200..299) remote.inputStream else remote.errorStream
            val bytes = source?.use { it.readBytesLimited(MAX_HUB_JSON_BYTES) } ?: ByteArray(0)
            response.header(HttpHeaders.CacheControl, "no-store")
            response.header(HttpHeaders.ContentLength, bytes.size.toString())
            respondOutputStream(ContentType.Application.Json, HttpStatusCode.fromValue(status)) { write(bytes) }
        } finally {
            remote.disconnect()
        }
    }

    /** 收集箱原件下载：流式转发中枢响应（原件可能远大于 JSON 代理的响应上限）。 */
    private suspend fun ApplicationCall.proxyHubDownload() {
        if (!authorize()) return
        if (!agent.configured()) return error(HUB_REQUIRED, HttpStatusCode.Conflict)
        val path = request.queryParameters["path"].orEmpty()
        if (path.isBlank()) return error("缺少 path", HttpStatusCode.BadRequest)
        val remote = agent.stream("/api/inbox/download?path=${encoded(path)}", "application/octet-stream")
        val connection = remote.connection
        try {
            if (remote.status !in 200..299) {
                val message = connection.errorStream?.bufferedReader()?.use { it.readText().take(16_384) }.orEmpty()
                return error(message.ifBlank { "中枢返回 HTTP ${remote.status}" }, HttpStatusCode.fromValue(remote.status))
            }
            response.header(HttpHeaders.ContentDisposition, connection.getHeaderField(HttpHeaders.ContentDisposition) ?: "attachment")
            response.header(HttpHeaders.CacheControl, "no-store")
            respondOutputStream(ContentType.Application.OctetStream) {
                connection.inputStream.use { input -> input.copyTo(this, 64 * 1024) }
            }
        } finally {
            connection.disconnect()
        }
    }

    private suspend fun ApplicationCall.proxyAgent(method: String, path: String, requestBody: String? = null) {
        if (!authorize()) return
        val remote = agent.request(method, path, requestBody)
        if (remote.status == 401) return error(
            "Docker 中枢拒绝了成员令牌。请检查绑定令牌，并将中枢更新到支持手机 Agent 的版本。",
            HttpStatusCode.BadGateway,
        )
        val type = runCatching { ContentType.parse(remote.contentType) }.getOrDefault(ContentType.Application.Json)
        response.header(HttpHeaders.CacheControl, "no-store")
        response.header(HttpHeaders.ContentLength, remote.body.size.toString())
        respondOutputStream(type, HttpStatusCode.fromValue(remote.status)) { write(remote.body) }
    }

    private suspend fun ApplicationCall.proxyAgentEvents(path: String) {
        if (!authorize()) return
        val remote = agent.stream(path)
        val connection = remote.connection
        try {
            if (remote.status !in 200..299) {
                if (remote.status == 401) return error(
                    "Docker 中枢拒绝了成员令牌。请检查绑定令牌，并将中枢更新到支持手机 Agent 的版本。",
                    HttpStatusCode.BadGateway,
                )
                val message = connection.errorStream?.bufferedReader()?.use { it.readText().take(16_384) }.orEmpty()
                return error(message.ifBlank { "Docker Agent 返回 HTTP ${remote.status}" }, HttpStatusCode.fromValue(remote.status))
            }
            response.header(HttpHeaders.CacheControl, "no-cache")
            response.header(HttpHeaders.Connection, "keep-alive")
            respondOutputStream(ContentType.Text.EventStream) {
                connection.inputStream.use { input ->
                    val buffer = ByteArray(8 * 1024)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        write(buffer, 0, count)
                        flush()
                    }
                }
            }
        } finally {
            connection.disconnect()
        }
    }

    private suspend fun ApplicationCall.sendFile(inline: Boolean) {
        val path = request.queryParameters["path"] ?: return error("缺少 path", HttpStatusCode.BadRequest)
        val file = db.file(path); if (!file.isFile) return error("文件不存在", HttpStatusCode.NotFound)
        val type = mime(file.extension)
        response.header(HttpHeaders.ContentDisposition, "${if (inline) "inline" else "attachment"}; filename*=UTF-8''${encoded(file.name)}")
        response.header(HttpHeaders.AcceptRanges, "bytes")
        val range = request.header(HttpHeaders.Range)?.let { parseRange(it, file.length()) }
        if (range != null) {
            response.header(HttpHeaders.ContentRange, "bytes ${range.first}-${range.last}/${file.length()}")
            response.header(HttpHeaders.ContentLength, (range.last - range.first + 1).toString())
            respondOutputStream(type, HttpStatusCode.PartialContent) {
                file.inputStream().use { input -> input.skip(range.first); copyCount(input, this, range.last - range.first + 1) }
            }
        } else {
            response.header(HttpHeaders.ContentLength, file.length().toString())
            respondOutputStream(type) { file.inputStream().use { it.copyTo(this, 64 * 1024) } }
        }
    }

    private suspend fun ApplicationCall.download(file: File, name: String) {
        response.header(HttpHeaders.ContentDisposition, "attachment; filename*=UTF-8''${encoded(name)}")
        response.header(HttpHeaders.ContentLength, file.length().toString())
        respondOutputStream(ContentType("application", "zip")) {
            try { file.inputStream().use { it.copyTo(this, 64 * 1024) } }
            finally { file.delete() }
        }
    }

    private suspend fun ApplicationCall.serveAsset(requested: String) {
        val clean = requested.substringBefore('?').trimStart('/').takeIf { it.split('/').none { part -> part == ".." } } ?: "index.html"
        val candidate = "public/$clean"
        val resolved = if (runCatching { context.assets.open(candidate).use { } }.isSuccess) candidate else "public/index.html"
        val extension = resolved.substringAfterLast('.', "html")
        val length = context.assets.open(resolved).use { it.available().toLong() }
        response.header(HttpHeaders.ContentLength, length.toString())
        if (resolved.startsWith("public/assets/") || resolved.startsWith("public/vendor/")) {
            response.header(HttpHeaders.CacheControl, "public, max-age=31536000, immutable")
        } else {
            response.header(HttpHeaders.CacheControl, "no-cache")
        }
        // APK 内可能包含数 MB 的编辑器/PDF 资源。禁止 readBytes() 整块进堆，固定 64 KiB 流式发送。
        respondOutputStream(mime(extension)) {
            context.assets.open(resolved).use { input -> input.copyTo(this, 64 * 1024) }
        }
    }

    private fun createBackup(): File {
        val target = File(db.root, "backup-${UUID.randomUUID()}.zip")
        ZipOutputStream(target.outputStream().buffered()).use { zip ->
            val manifest = JSONObject().put("format", "engram-portable-backup").put("version", 2).put("createdAt", Instant.now().toString())
            addZipBytes(zip, "manifest.json", manifest.toString(2).toByteArray())
            addZipBytes(zip, "portable-metadata.json", db.portableMetadata().toString().toByteArray())
            db.brain.walkTopDown().filter { it.isFile && !it.canonicalPath.contains("${File.separator}.trash${File.separator}") }.forEach { file ->
                val rel = file.canonicalPath.removePrefix(db.brain.canonicalPath + File.separator).replace('\\', '/')
                addZipFile(zip, file, "brain/$rel")
            }
        }
        return target
    }

    private fun restoreBackup(archive: File): Int {
        val staging = File(db.root, "restore-staging-${UUID.randomUUID()}")
        val stagedBrain = File(staging, "brain")
        var metadata: JSONObject? = null; var files = 0; var expanded = 0L; var portableV2 = false
        try {
            stagedBrain.mkdirs()
            ZipInputStream(archive.inputStream().buffered()).use { zip ->
                while (true) {
                    val entry = zip.nextEntry ?: break
                    val name = entry.name.replace('\\', '/').trimStart('/')
                    require(name.split('/').none { it == ".." || it.isEmpty() }) { "备份包含非法路径" }
                    if (!entry.isDirectory && name == "manifest.json") {
                        val bytes = zip.readBytesLimited(1024L * 1024); expanded += bytes.size
                        val manifest = JSONObject(String(bytes))
                        portableV2 = manifest.optString("format") == "engram-portable-backup" && manifest.optInt("version") == 2
                    } else if (!entry.isDirectory && name == "portable-metadata.json") {
                        val bytes = zip.readBytesLimited(20L * 1024 * 1024); expanded += bytes.size; metadata = JSONObject(String(bytes))
                    } else if (!entry.isDirectory && name.startsWith("brain/")) {
                        val rel = name.removePrefix("brain/"); val target = File(stagedBrain, rel).canonicalFile
                        require(target.path.startsWith(stagedBrain.canonicalPath + File.separator)) { "备份包含越界路径" }
                        target.parentFile?.mkdirs(); target.outputStream().use { output -> expanded += copyLimited(zip, output, MAX_FILE_BYTES) }
                        files++
                    }
                    require(expanded <= MAX_BACKUP_BYTES) { "备份解压后过大" }
                    zip.closeEntry()
                }
            }
            require(files > 0 || portableV2) { "备份缺少 brain/ 内容" }
            db.replaceBrain(stagedBrain, metadata)
            return files
        } finally { archive.delete(); staging.deleteRecursively() }
    }

    companion object {
        const val PORT = 18182
        const val BASE_URL = "http://127.0.0.1:18182"
        private const val SESSION_COOKIE = "engram_local_session"
        private const val MAX_FILE_BYTES = 200L * 1024 * 1024
        private const val MAX_BACKUP_BYTES = 1024L * 1024 * 1024
        private const val MAX_HUB_FIELD_BYTES = 1024L * 1024
        private const val MAX_HUB_JSON_BYTES = 4L * 1024 * 1024
        /** 单张图片资产上限（与 server routes/assets.ts 的 MAX_ASSET_BYTES 一致） */
        private const val MAX_ASSET_BYTES = 12L * 1024 * 1024
        private const val HUB_REQUIRED = "请先在多端同步中绑定 Docker 中枢：收集箱与记灵感都用中枢的模型和任务队列"
        private const val HUB_TOKEN_REJECTED = "Docker 中枢拒绝了成员令牌。请检查绑定令牌，并将中枢更新到支持手机端的版本。"
        /** 图片资产目录名白名单：页面 id（UUID）或未归属池，同时挡掉 `..`、绝对路径等穿越写法（与 server lib/pageAssets.ts 同规则） */
        private val PARENT_ID_REGEX = Regex("^[A-Za-z0-9_-]{1,64}$")
        private val ASSET_EXTENSIONS = setOf("png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp")
        private val MULTIPART_CRLF = "\r\n".toByteArray(Charsets.UTF_8)
        @Volatile private var instance: EngramLocalServer? = null

        @JvmStatic fun getInstance(context: Context): EngramLocalServer = instance ?: synchronized(this) {
            instance ?: EngramLocalServer(context.applicationContext).also { instance = it }
        }
        @JvmStatic fun peek(): EngramLocalServer? = instance

        private fun randomToken(): String = ByteArray(32).also(SecureRandom()::nextBytes).joinToString("") { "%02x".format(it) }
        /** 转发 multipart 时手写分段头：文件名按 UTF-8 写出，与中枢 `defParamCharset: 'utf8'` 对齐（中文名不乱码）。 */
        private fun writeMultipartHeader(output: java.io.OutputStream, boundary: String, field: String, fileName: String?, contentType: String?) {
            val header = buildString {
                append("--").append(boundary).append("\r\n")
                append("Content-Disposition: form-data; name=\"").append(field.replace("\"", "")).append('"')
                if (fileName != null) append("; filename=\"").append(fileName.replace("\"", "")).append('"')
                append("\r\n")
                if (contentType != null) append("Content-Type: ").append(contentType).append("\r\n")
                append("\r\n")
            }
            output.write(header.toByteArray(Charsets.UTF_8))
        }
        private fun JSONObject.optStringOrNull(key: String) = if (!has(key) || isNull(key)) null else optString(key).takeIf { it.isNotBlank() }
        private fun JSONObject.ids(): List<String> = (optJSONArray("ids") ?: JSONArray()).let { arr -> (0 until arr.length()).mapNotNull { arr.optString(it).takeIf(String::isNotBlank) } }
        private fun JSONArray.contains(value: String) = (0 until length()).any { optString(it) == value }
        private fun JSONArray.filter(predicate: (JSONObject) -> Boolean) = JSONArray().also { out -> for (i in 0 until length()) optJSONObject(i)?.takeIf(predicate)?.let(out::put) }
        private fun decoded(value: String) = URLDecoder.decode(value, "UTF-8")
        private fun encoded(value: String) = java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")
        private fun sanitizeFileName(value: String) = File(value).name.replace(Regex("[\\\\/:*?\"<>|]"), "-").ifBlank { "file" }
        private fun mime(ext: String): ContentType = when (ext.lowercase()) {
            "html" -> ContentType.Text.Html; "js", "mjs" -> ContentType("application", "javascript"); "css" -> ContentType.Text.CSS
            "json" -> ContentType.Application.Json; "pdf" -> ContentType.Application.Pdf
            "png" -> ContentType.Image.PNG; "jpg", "jpeg" -> ContentType.Image.JPEG; "gif" -> ContentType.Image.GIF
            "svg" -> ContentType("image", "svg+xml"); "avif" -> ContentType("image", "avif"); "bmp" -> ContentType("image", "bmp"); "txt", "md", "markdown" -> ContentType.Text.Plain
            "woff" -> ContentType("font", "woff"); "woff2" -> ContentType("font", "woff2")
            "ico" -> ContentType("image", "x-icon"); "webmanifest" -> ContentType.Application.Json
            else -> ContentType.Application.OctetStream
        }
        private fun parseRange(value: String, size: Long): LongRange? {
            val match = Regex("bytes=(\\d+)-(\\d*)").matchEntire(value) ?: return null
            val start = match.groupValues[1].toLongOrNull() ?: return null
            val end = match.groupValues[2].toLongOrNull() ?: (size - 1)
            if (start < 0 || start >= size || end < start) return null
            return start..minOf(end, size - 1)
        }
        private fun copyCount(input: java.io.InputStream, output: java.io.OutputStream, requested: Long) {
            var remaining = requested; val buffer = ByteArray(64 * 1024)
            while (remaining > 0) { val read = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt()); if (read < 0) break; output.write(buffer, 0, read); remaining -= read }
        }
        private fun copyLimited(input: java.io.InputStream, output: java.io.OutputStream, limit: Long = MAX_FILE_BYTES): Long {
            var total = 0L; val buffer = ByteArray(64 * 1024)
            while (true) { val read = input.read(buffer); if (read < 0) break; total += read; require(total <= limit) { "单文件超过 200 MB 上限" }; output.write(buffer, 0, read) }
            return total
        }
        private fun java.io.InputStream.readBytesLimited(limit: Long): ByteArray {
            val output = java.io.ByteArrayOutputStream(); copyLimited(this, output, limit); return output.toByteArray()
        }
        private fun addZipBytes(zip: ZipOutputStream, name: String, bytes: ByteArray) { zip.putNextEntry(ZipEntry(name)); zip.write(bytes); zip.closeEntry() }
        private fun addZipFile(zip: ZipOutputStream, file: File, name: String) { if (!file.isFile) return; zip.putNextEntry(ZipEntry(name.replace('\\', '/'))); file.inputStream().use { it.copyTo(zip, 64 * 1024) }; zip.closeEntry() }
    }
}
