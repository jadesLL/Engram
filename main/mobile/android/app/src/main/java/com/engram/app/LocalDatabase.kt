package com.engram.app

import android.content.Context
import android.database.Cursor
import android.database.DefaultDatabaseErrorHandler
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.os.Build
import android.system.Os
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.util.UUID
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/** Android 本地知识库：Markdown/附件是事实源，SQLite 仅保存索引和设备状态。 */
class LocalDatabase(context: Context) : SQLiteOpenHelper(
    context,
    databasePath(context),
    null,
    3,
    DefaultDatabaseErrorHandler(),
) {
    val root = File(context.filesDir, "engram")
    val brain = File(root, "brain")
    private val trashRoot = File(brain, ".trash")
    private val lock = Any()

    init {
        root.mkdirs()
        seedDirectories()
        writableDatabase
        scan()
    }

    private fun seedDirectories() {
        STANDARD_DIRECTORIES.forEach { File(brain, it).mkdirs() }
        trashRoot.mkdirs()
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
        db.execSQL("""CREATE TABLE pages(
            id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,title TEXT NOT NULL,type TEXT NOT NULL,
            tags TEXT NOT NULL DEFAULT '[]',summary TEXT NOT NULL DEFAULT '',content TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,
            word_count INTEGER NOT NULL DEFAULT 0,sync_revision INTEGER NOT NULL DEFAULT 0
        )""")
        db.execSQL("""CREATE TABLE files(
            id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,name TEXT NOT NULL,ext TEXT NOT NULL DEFAULT '',
            size INTEGER NOT NULL DEFAULT 0,text TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0
        )""")
        db.execSQL("""CREATE TABLE search_tokens(
            term TEXT NOT NULL,ref_type TEXT NOT NULL,ref_id TEXT NOT NULL,
            PRIMARY KEY(term,ref_type,ref_id)
        )""")
        db.execSQL("CREATE INDEX idx_search_term ON search_tokens(term)")
        db.execSQL("""CREATE TABLE trash(
            id TEXT PRIMARY KEY,kind TEXT NOT NULL,original_path TEXT NOT NULL,stored_path TEXT NOT NULL,
            deleted_at TEXT NOT NULL,size INTEGER NOT NULL DEFAULT 0
        )""")
        db.execSQL("""CREATE TABLE sync_outbox(
            id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,target TEXT NOT NULL,old_path TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,UNIQUE(kind,target)
        )""")
        db.execSQL("""CREATE TABLE page_revisions(
            path TEXT NOT NULL,revision INTEGER NOT NULL,content TEXT NOT NULL,ts TEXT NOT NULL,
            PRIMARY KEY(path,revision)
        )""")
        db.execSQL("""CREATE TABLE evidence_snapshots(
            path TEXT PRIMARY KEY,payload TEXT NOT NULL,distilled INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL
        )""")
        db.execSQL("""CREATE TABLE sync_log(
            id INTEGER PRIMARY KEY AUTOINCREMENT,ts TEXT NOT NULL,level TEXT NOT NULL,event TEXT NOT NULL,detail TEXT NOT NULL DEFAULT ''
        )""")
        db.execSQL("CREATE TABLE file_extractions(path TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at TEXT NOT NULL)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) db.execSQL("CREATE TABLE IF NOT EXISTS file_extractions(path TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at TEXT NOT NULL)")
        // v3 只新增文件库标准目录，不改表；目录由每次启动的 seedDirectories() 幂等补齐。
    }

    fun setting(key: String): String? = synchronized(lock) {
        readableDatabase.rawQuery("SELECT value FROM settings WHERE key=?", arrayOf(key)).use {
            if (it.moveToFirst()) it.getString(0) else null
        }
    }

    fun setSetting(key: String, value: String) = synchronized(lock) {
        writableDatabase.execSQL("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", arrayOf(key, value))
    }

    fun authInitialized() = !setting("password_hash").isNullOrBlank()

    fun setPassword(password: String) {
        require(password.length >= 6) { "密码至少需要 6 位" }
        val salt = ByteArray(16).also(SecureRandom()::nextBytes)
        val algorithm = passwordAlgorithm()
        val spec = PBEKeySpec(password.toCharArray(), salt, 120_000, 256)
        val hash = SecretKeyFactory.getInstance(algorithm).generateSecret(spec).encoded
        setSetting("password_hash", "$algorithm:${Base64.encodeToString(salt, Base64.NO_WRAP)}:${Base64.encodeToString(hash, Base64.NO_WRAP)}")
    }

    fun checkPassword(password: String): Boolean {
        val stored = setting("password_hash") ?: return false
        val parts = stored.split(':')
        if (parts.size !in 2..3) return false
        return try {
            val algorithm = if (parts.size == 3) parts[0] else "PBKDF2WithHmacSHA256"
            val offset = if (parts.size == 3) 1 else 0
            val salt = Base64.decode(parts[offset], Base64.NO_WRAP)
            val expected = Base64.decode(parts[offset + 1], Base64.NO_WRAP)
            val actual = SecretKeyFactory.getInstance(algorithm)
                .generateSecret(PBEKeySpec(password.toCharArray(), salt, 120_000, 256)).encoded
            MessageDigest.isEqual(expected, actual)
        } catch (_: Exception) { false }
    }

    private fun passwordAlgorithm() =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) "PBKDF2WithHmacSHA256" else "PBKDF2WithHmacSHA1"

    fun scan() = synchronized(lock) {
        brain.walkTopDown().filter { it.isFile && !isInTrash(it) }.forEach { file ->
            val rel = relative(file)
            if (file.extension.equals("md", true) || file.extension.equals("markdown", true)) indexPage(rel)
            else indexFile(rel)
        }
        val existing = brain.walkTopDown().filter { it.isFile }.map(::relative).toSet()
        writableDatabase.rawQuery("SELECT path FROM pages WHERE deleted=0", null).use { c ->
            while (c.moveToNext()) if (!existing.contains(c.getString(0))) {
                writableDatabase.execSQL("UPDATE pages SET deleted=1 WHERE path=?", arrayOf(c.getString(0)))
            }
        }
        writableDatabase.rawQuery("SELECT id,path FROM files WHERE deleted=0", null).use { c ->
            while (c.moveToNext()) if (!existing.contains(c.getString(1))) {
                writableDatabase.execSQL("UPDATE files SET deleted=1 WHERE id=?", arrayOf(c.getString(0)))
                writableDatabase.execSQL("DELETE FROM search_tokens WHERE ref_type='file' AND ref_id=?", arrayOf(c.getString(0)))
            }
        }
    }

    private fun safe(rel: String): File {
        return SafePaths.resolve(brain, rel)
    }

    private fun isInTrash(file: File): Boolean = file.canonicalPath.startsWith(trashRoot.canonicalPath + File.separator)
    private fun relative(file: File): String = file.canonicalPath.removePrefix(brain.canonicalPath + File.separator).replace('\\', '/')
    private fun now() = Instant.now().toString()
    private fun newId() = UUID.randomUUID().toString()

    data class Markdown(val fields: LinkedHashMap<String, String>, val body: String)

    private fun parseMarkdown(raw: String): Markdown {
        val normalized = raw.replace("\r\n", "\n")
        if (!normalized.startsWith("---\n")) return Markdown(linkedMapOf(), normalized.trim())
        val end = normalized.indexOf("\n---\n", 4)
        if (end < 0) return Markdown(linkedMapOf(), normalized.trim())
        val fields = linkedMapOf<String, String>()
        normalized.substring(4, end).lines().forEach { line ->
            val colon = line.indexOf(':')
            if (colon > 0) fields[line.substring(0, colon).trim()] = line.substring(colon + 1).trim().trim('"', '\'')
        }
        return Markdown(fields, normalized.substring(end + 5).trim())
    }

    private fun field(fields: Map<String, String>, vararg names: String): String? = names.firstNotNullOfOrNull { fields[it] }

    private fun parseTags(value: String?): JSONArray {
        val arr = JSONArray()
        if (value.isNullOrBlank()) return arr
        val clean = value.trim().removePrefix("[").removeSuffix("]")
        clean.split(',', '，', '、').map { it.trim().trim('"', '\'') }.filter { it.isNotBlank() }.forEach(arr::put)
        return arr
    }

    private fun renderMarkdown(fields: LinkedHashMap<String, String>, body: String): String {
        val header = fields.entries.joinToString("\n") { (key, value) ->
            val rendered = if (value.startsWith("[") || value.matches(Regex("-?\\d+(\\.\\d+)?"))) value
            else "\"${value.replace("\"", "\\\"")}\""
            "$key: $rendered"
        }
        return "---\n$header\n---\n\n${body.trim()}\n"
    }

    private fun atomicWrite(file: File, bytes: ByteArray) {
        file.parentFile?.mkdirs()
        val temp = File(file.parentFile, ".${file.name}.${newId()}.tmp")
        temp.writeBytes(bytes)
        try { Os.rename(temp.absolutePath, file.absolutePath) }
        catch (error: Exception) { temp.delete(); throw error }
    }

    private fun indexPage(rel: String): JSONObject {
        val file = safe(rel)
        val parsed = parseMarkdown(file.readText())
        val id = field(parsed.fields, "id") ?: newId()
        val title = field(parsed.fields, "标题", "title")?.takeIf { it.isNotBlank() } ?: file.nameWithoutExtension
        val type = field(parsed.fields, "类型", "type") ?: if (rel.startsWith("Wiki/概念/")) "concept" else "note"
        val tags = parseTags(field(parsed.fields, "标签", "tags"))
        val created = field(parsed.fields, "创建日期", "created") ?: now()
        val updated = field(parsed.fields, "更新日期", "updated") ?: Instant.ofEpochMilli(file.lastModified()).toString()
        val fields = parsed.fields
        var rewrite = false
        if (!fields.containsKey("id")) { fields["id"] = id; rewrite = true }
        if (!fields.containsKey("标题")) { fields["标题"] = title; fields.remove("title"); rewrite = true }
        if (!fields.containsKey("创建日期")) { fields["创建日期"] = created; fields.remove("created"); rewrite = true }
        if (!fields.containsKey("类型")) { fields["类型"] = type; fields.remove("type"); rewrite = true }
        if (rewrite) atomicWrite(file, renderMarkdown(fields, parsed.body).toByteArray(StandardCharsets.UTF_8))
        val wordCount = parsed.body.count { it.code in 0x3400..0x9fff } + parsed.body.replace(Regex("[\\u3400-\\u9fff]"), " ").split(Regex("\\s+")).count { it.isNotBlank() }
        writableDatabase.execSQL(
            """INSERT OR REPLACE INTO pages(id,path,title,type,tags,summary,content,created_at,updated_at,deleted,word_count,sync_revision)
               VALUES(?,?,?,?,?,?,?,?,?,0,?,COALESCE((SELECT sync_revision FROM pages WHERE path=?),0))""",
            arrayOf(id, rel, title, type, tags.toString(), field(fields, "摘要", "summary") ?: "", parsed.body, created, updated, wordCount, rel),
        )
        reindex("page", id, "$title ${tags} ${parsed.body}")
        return pageJson(id)!!
    }

    private fun indexFile(rel: String, extractedText: String? = null): JSONObject {
        val file = safe(rel)
        val oldText = readableDatabase.rawQuery("SELECT text FROM files WHERE path=?", arrayOf(rel)).use { if (it.moveToFirst()) it.getString(0) else "" }
        val text = extractedText ?: if (file.extension.lowercase() in setOf("txt", "csv", "json", "html", "xml")) runCatching { file.readText() }.getOrDefault("") else oldText
        val id = readableDatabase.rawQuery("SELECT id FROM files WHERE path=?", arrayOf(rel)).use { if (it.moveToFirst()) it.getString(0) else newId() }
        writableDatabase.execSQL(
            """INSERT OR REPLACE INTO files(id,path,name,ext,size,text,updated_at,deleted) VALUES(?,?,?,?,?,?,?,0)""",
            arrayOf(id, rel, file.name, file.extension.lowercase(), file.length(), text, Instant.ofEpochMilli(file.lastModified()).toString()),
        )
        reindex("file", id, "${file.name} $text")
        return fileJson(id)!!
    }

    private fun tokens(text: String): Set<String> {
        val out = linkedSetOf<String>()
        Regex("[\\u3400-\\u9fff]+").findAll(text).forEach { match ->
            val run = match.value
            run.forEach { out += it.toString() }
            for (i in 0 until run.length - 1) out += run.substring(i, i + 2)
        }
        Regex("[A-Za-z0-9_]{2,}").findAll(text.lowercase()).forEach { out += it.value }
        return out
    }

    private fun reindex(type: String, id: String, text: String) {
        writableDatabase.execSQL("DELETE FROM search_tokens WHERE ref_type=? AND ref_id=?", arrayOf(type, id))
        val stmt = writableDatabase.compileStatement("INSERT OR IGNORE INTO search_tokens(term,ref_type,ref_id) VALUES(?,?,?)")
        tokens(text).forEach { term -> stmt.clearBindings(); stmt.bindString(1, term); stmt.bindString(2, type); stmt.bindString(3, id); stmt.executeInsert() }
    }

    private fun pageJson(id: String): JSONObject? = readableDatabase.rawQuery(
        "SELECT id,path,title,type,tags,summary,created_at,updated_at,word_count,sync_revision,content FROM pages WHERE id=? AND deleted=0",
        arrayOf(id),
    ).use { c -> if (!c.moveToFirst()) null else JSONObject().apply {
        put("id", c.getString(0)); put("path", c.getString(1)); put("title", c.getString(2)); put("type", c.getString(3))
        put("tags", JSONArray(c.getString(4))); put("summary", c.getString(5)); put("created_at", c.getString(6)); put("updated_at", c.getString(7))
        put("word_count", c.getInt(8)); put("sync_revision", c.getInt(9)); put("content", c.getString(10)); put("guide_version", 0)
    } }

    private fun fileJson(id: String): JSONObject? = readableDatabase.rawQuery(
        "SELECT id,path,name,ext,size,text,updated_at FROM files WHERE id=? AND deleted=0", arrayOf(id),
    ).use { c -> if (!c.moveToFirst()) null else JSONObject().apply {
        put("id", c.getString(0)); put("path", c.getString(1)); put("name", c.getString(2)); put("ext", c.getString(3)); put("size", c.getLong(4)); put("text", c.getString(5)); put("updated_at", c.getString(6))
        put("distilled", evidenceDistilled(c.getString(1)))
    } }

    fun pages(): JSONArray = synchronized(lock) {
        val arr = JSONArray()
        readableDatabase.rawQuery("SELECT id FROM pages WHERE deleted=0 ORDER BY updated_at DESC", null).use { c -> while (c.moveToNext()) pageJson(c.getString(0))?.let(arr::put) }
        arr
    }

    fun tags(): JSONArray {
        val counts = linkedMapOf<String, Int>()
        pages().let { arr -> for (i in 0 until arr.length()) arr.getJSONObject(i).getJSONArray("tags").let { tags -> for (j in 0 until tags.length()) counts[tags.getString(j)] = (counts[tags.getString(j)] ?: 0) + 1 } }
        return JSONArray().also { out -> counts.entries.sortedByDescending { it.value }.forEach { out.put(JSONObject().put("name", it.key).put("count", it.value)) } }
    }

    fun page(id: String): JSONObject? = synchronized(lock) { pageJson(id) }

    fun pageByTitle(title: String): JSONObject? = synchronized(lock) {
        readableDatabase.rawQuery("SELECT id FROM pages WHERE deleted=0 AND lower(title)=lower(?) LIMIT 1", arrayOf(title)).use { if (it.moveToFirst()) pageJson(it.getString(0)) else null }
    }

    fun suggest(query: String): JSONArray = synchronized(lock) {
        val out = JSONArray()
        readableDatabase.rawQuery("SELECT id,title,path FROM pages WHERE deleted=0 AND title LIKE ? ORDER BY updated_at DESC LIMIT 10", arrayOf("%$query%")).use { c ->
            while (c.moveToNext()) out.put(JSONObject().put("id", c.getString(0)).put("title", c.getString(1)).put("path", c.getString(2)))
        }; out
    }

    fun createPage(dir: String?, requestedTitle: String?, type: String?): JSONObject = synchronized(lock) {
        val title = sanitizeName(requestedTitle ?: "未命名页面").ifBlank { "未命名页面" }
        val allowedType = type ?: "concept"
        require(PAGE_TYPES.contains(allowedType)) { "非法页面类型：$allowedType" }
        val requestedDirectory = dir.orEmpty().replace('\\', '/').trim('/')
        val target = requestedDirectory.takeIf(PAGE_DIRECTORIES::contains) ?: typeDirectory(allowedType)
        var rel = "$target/$title.md"; var n = 1
        while (safe(rel).exists()) rel = "$target/$title-${n++}.md"
        val fields = linkedMapOf("id" to newId(), "标题" to title, "创建日期" to now(), "更新日期" to now(), "类型" to allowedType, "标签" to "[]")
        atomicWrite(safe(rel), renderMarkdown(fields, "# $title\n").toByteArray())
        val meta = indexPage(rel)
        enqueue("page", rel)
        meta
    }

    fun updatePage(id: String, body: JSONObject, fromSync: Boolean = false): JSONObject = synchronized(lock) {
        val current = pageJson(id) ?: error("页面不存在")
        val oldPath = current.getString("path")
        var rel = oldPath
        val parsed = parseMarkdown(safe(oldPath).readText())
        val title = body.optString("title", current.getString("title"))
        val type = body.optString("type", current.getString("type"))
        require(PAGE_TYPES.contains(type)) { "非法页面类型：$type" }
        val content = if (body.has("content")) body.optString("content") else parsed.body
        parsed.fields["标题"] = title; parsed.fields["类型"] = type; parsed.fields["更新日期"] = now()
        if (body.has("tags")) parsed.fields["标签"] = body.getJSONArray("tags").toString()
        atomicWrite(safe(oldPath), renderMarkdown(parsed.fields, content).toByteArray())
        var meta = indexPage(oldPath)
        if (type != current.getString("type") && oldPath.startsWith("Wiki/") && !oldPath.startsWith("Wiki/归档/")) {
            val targetPath = "${typeDirectory(type)}/${File(oldPath).name}"
            if (targetPath != oldPath && !safe(targetPath).exists()) {
                safe(targetPath).parentFile?.mkdirs()
                Os.rename(safe(oldPath).absolutePath, safe(targetPath).absolutePath)
                writableDatabase.execSQL("UPDATE pages SET path=? WHERE id=?", arrayOf(targetPath, id))
                rel = targetPath
                meta = indexPage(rel)
                if (!fromSync) enqueue("move", rel, oldPath)
            }
        }
        if (!fromSync) enqueue("page", rel)
        meta
    }

    fun writeSyncedPage(path: String, content: String, revision: Int) = synchronized(lock) {
        atomicWrite(safe(path), content.toByteArray())
        val meta = indexPage(path)
        writableDatabase.execSQL("UPDATE pages SET sync_revision=? WHERE id=?", arrayOf(revision, meta.getString("id")))
        writableDatabase.execSQL("INSERT OR REPLACE INTO page_revisions(path,revision,content,ts) VALUES(?,?,?,?)", arrayOf(path, revision, content, now()))
    }

    fun rawPage(path: String): String? = synchronized(lock) { safe(path).takeIf { it.exists() }?.readText() }
    fun pageIdByPath(path: String): String? = synchronized(lock) { readableDatabase.rawQuery("SELECT id FROM pages WHERE path=? AND deleted=0", arrayOf(path)).use { if (it.moveToFirst()) it.getString(0) else null } }
    fun pageRevision(path: String): Int = synchronized(lock) { readableDatabase.rawQuery("SELECT sync_revision FROM pages WHERE path=? AND deleted=0", arrayOf(path)).use { if (it.moveToFirst()) it.getInt(0) else 0 } }

    fun movePage(id: String, directory: String?, newTitle: String?, fromSync: Boolean = false): JSONObject = synchronized(lock) {
        val current = pageJson(id) ?: error("页面不存在")
        val old = current.getString("path")
        val targetDir = (directory ?: old.substringBeforeLast('/', "Wiki")).replace('\\', '/').trim('/')
        require(PAGE_DIRECTORIES.contains(targetDir)) { "页面只能移动到固定的 Wiki 目录内" }
        val title = sanitizeName(newTitle ?: current.getString("title")).ifBlank { "未命名页面" }
        val next = "$targetDir/$title.md"
        if (next != old) {
            require(!safe(next).exists()) { "目标已存在" }
            safe(next).parentFile?.mkdirs(); Os.rename(safe(old).absolutePath, safe(next).absolutePath)
            writableDatabase.execSQL("UPDATE pages SET path=? WHERE id=?", arrayOf(next, id))
        }
        if (newTitle != null) {
            val parsed = parseMarkdown(safe(next).readText())
            parsed.fields["标题"] = title
            parsed.fields["更新日期"] = now()
            atomicWrite(safe(next), renderMarkdown(parsed.fields, parsed.body).toByteArray())
        }
        val result = indexPage(next)
        if (!fromSync) {
            if (next != old) enqueue("move", next, old)
            if (newTitle != null) enqueue("page", next)
        }
        result
    }

    fun archive(id: String): JSONObject = synchronized(lock) {
        val page = pageJson(id) ?: error("页面不存在")
        if (page.getString("path").startsWith("Wiki/归档/")) return@synchronized page
        movePage(id, "Wiki/归档", uniqueTitle("Wiki/归档", File(page.getString("path")).nameWithoutExtension), false)
        updatePage(id, JSONObject().put("title", page.getString("title")))
    }

    fun unarchive(id: String): JSONObject {
        val page = page(id) ?: error("页面不存在")
        if (!page.getString("path").startsWith("Wiki/归档/")) return page
        val dir = typeDirectory(page.getString("type"))
        movePage(id, dir, uniqueTitle(dir, File(page.getString("path")).nameWithoutExtension), false)
        return updatePage(id, JSONObject().put("title", page.getString("title")))
    }

    fun renamePage(id: String, requestedTitle: String): JSONObject = synchronized(lock) {
        val page = pageJson(id) ?: error("页面不存在")
        val oldTitle = page.getString("title")
        val title = sanitizeName(requestedTitle).ifBlank { throw IllegalArgumentException("标题不能为空") }
        val result = movePage(id, null, title)
        if (oldTitle != title) rewriteWikiLinks(oldTitle, title, id)
        result
    }

    private fun uniqueTitle(directory: String, base: String): String {
        var candidate = base
        var suffix = 1
        while (safe("$directory/$candidate.md").exists()) candidate = "$base-${suffix++}"
        return candidate
    }

    private fun rewriteWikiLinks(oldTitle: String, newTitle: String, skipId: String) {
        val matcher = Regex("\\[\\[${Regex.escape(oldTitle)}(?=[#|\\]])")
        val all = pages()
        for (i in 0 until all.length()) {
            val page = all.getJSONObject(i)
            if (page.getString("id") == skipId) continue
            val path = page.getString("path")
            val parsed = parseMarkdown(safe(path).readText())
            val next = matcher.replace(parsed.body, "[[$newTitle")
            if (next == parsed.body) continue
            parsed.fields["更新日期"] = now()
            atomicWrite(safe(path), renderMarkdown(parsed.fields, next).toByteArray())
            indexPage(path)
            enqueue("page", path)
        }
    }

    fun deletePage(id: String, fromSync: Boolean = false) = synchronized(lock) {
        val current = pageJson(id) ?: error("页面不存在")
        moveToTrash(current.getString("path"), "page")
        writableDatabase.execSQL("UPDATE pages SET deleted=1 WHERE id=?", arrayOf(id))
        writableDatabase.execSQL("DELETE FROM search_tokens WHERE ref_type='page' AND ref_id=?", arrayOf(id))
        if (!fromSync) enqueue("delete", current.getString("path"))
    }

    private fun moveToTrash(rel: String, kind: String): JSONObject {
        val source = safe(rel); require(source.exists()) { "文件不存在" }
        val id = newId(); val stored = "$id-${source.name}"; val destination = File(trashRoot, stored)
        Os.rename(source.absolutePath, destination.absolutePath)
        val entry = JSONObject().put("id", id).put("kind", kind).put("name", source.name).put("originalPath", rel).put("deletedAt", now()).put("size", destination.length()).put("legacy", false)
        writableDatabase.execSQL("INSERT INTO trash(id,kind,original_path,stored_path,deleted_at,size) VALUES(?,?,?,?,?,?)", arrayOf(id, kind, rel, stored, entry.getString("deletedAt"), destination.length()))
        return entry
    }

    fun trash(): JSONObject = synchronized(lock) {
        val items = JSONArray(); var total = 0L
        readableDatabase.rawQuery("SELECT id,kind,original_path,stored_path,deleted_at,size FROM trash ORDER BY deleted_at DESC", null).use { c -> while (c.moveToNext()) {
            total += c.getLong(5); items.put(JSONObject().put("id", c.getString(0)).put("kind", c.getString(1)).put("name", File(c.getString(2)).name).put("originalPath", c.getString(2)).put("deletedAt", c.getString(4)).put("size", c.getLong(5)).put("legacy", false))
        } }; JSONObject().put("items", items).put("count", items.length()).put("totalSize", total)
    }

    fun restoreTrash(ids: List<String>): JSONObject = synchronized(lock) {
        val restored = JSONArray(); val errors = JSONArray()
        ids.forEach { id -> try {
            readableDatabase.rawQuery("SELECT kind,original_path,stored_path FROM trash WHERE id=?", arrayOf(id)).use { c ->
                require(c.moveToFirst()) { "项目不存在" }; val kind = c.getString(0); val rel = c.getString(1); val source = File(trashRoot, c.getString(2)); val destination = safe(rel)
                require(!destination.exists()) { "原路径已被占用" }; destination.parentFile?.mkdirs(); Os.rename(source.absolutePath, destination.absolutePath)
                writableDatabase.execSQL("DELETE FROM trash WHERE id=?", arrayOf(id)); if (kind == "page") indexPage(rel) else indexFile(rel); restored.put(id)
            }
        } catch (e: Exception) { errors.put(JSONObject().put("id", id).put("error", e.message ?: "恢复失败")) } }
        JSONObject().put("restored", restored).put("errors", errors)
    }

    fun deleteTrash(ids: List<String>): JSONObject = synchronized(lock) {
        val deleted = JSONArray(); val errors = JSONArray()
        ids.forEach { id -> try {
            readableDatabase.rawQuery("SELECT stored_path FROM trash WHERE id=?", arrayOf(id)).use { c -> require(c.moveToFirst()); File(trashRoot, c.getString(0)).delete() }
            writableDatabase.execSQL("DELETE FROM trash WHERE id=?", arrayOf(id)); deleted.put(id)
        } catch (e: Exception) { errors.put(JSONObject().put("id", id).put("error", e.message ?: "删除失败")) } }
        JSONObject().put("deleted", deleted).put("errors", errors)
    }

    fun emptyTrash(): JSONObject = synchronized(lock) {
        val ids = mutableListOf<String>(); readableDatabase.rawQuery("SELECT id FROM trash", null).use { while (it.moveToNext()) ids += it.getString(0) }; deleteTrash(ids)
    }

    fun files(dir: String? = null): JSONArray = synchronized(lock) {
        val out = JSONArray(); val prefix = (dir?.trimEnd('/') ?: "原始资料") + "/"
        readableDatabase.rawQuery("SELECT id,path FROM files WHERE deleted=0 AND path LIKE ? ORDER BY name", arrayOf("$prefix%")) .use { c ->
            while (c.moveToNext()) {
                val path = c.getString(1)
                if (!dir.isNullOrBlank() || !path.removePrefix(prefix).contains('/')) fileJson(c.getString(0))?.let(out::put)
            }
        }
        readableDatabase.rawQuery("SELECT id,path FROM pages WHERE deleted=0 AND path LIKE ? ORDER BY title", arrayOf("$prefix%")) .use { c ->
            while (c.moveToNext()) {
                val path = c.getString(1)
                if (!dir.isNullOrBlank() || !path.removePrefix(prefix).contains('/')) {
                    val file = safe(path)
                    out.put(JSONObject().put("id", c.getString(0)).put("pageId", c.getString(0)).put("path", path)
                        .put("name", file.name).put("ext", file.extension.lowercase()).put("size", file.length())
                        .put("updated_at", Instant.ofEpochMilli(file.lastModified()).toString()).put("distilled", evidenceDistilled(path)))
                }
            }
        }
        out
    }

    fun registerFile(rel: String, text: String? = null, fromSync: Boolean = false): JSONObject = synchronized(lock) {
        val result = indexFile(rel, text); if (!fromSync) enqueue("file", rel); result
    }

    fun installImportedFile(rel: String, staged: File): JSONObject = synchronized(lock) {
        val target = safe(rel)
        require(!target.exists()) { "已存在同名文件：${target.name}" }
        target.parentFile?.mkdirs()
        Os.rename(staged.absolutePath, target.absolutePath)
        if (target.extension.equals("md", true) || target.extension.equals("markdown", true)) {
            indexPage(rel).also { enqueue("page", rel) }
        } else {
            indexFile(rel).also { enqueue("file", rel) }
        }
    }

    fun createRawFile(name: String): JSONObject = synchronized(lock) {
        val clean = sanitizeName(File(name).name)
        require(clean.substringAfterLast('.', "").lowercase() in setOf("md", "markdown", "txt")) { "仅支持新建 .md / .txt 文件" }
        val rel = "原始资料/$clean"
        require(!safe(rel).exists()) { "已存在同名文件：$clean" }
        val content = if (clean.endsWith(".txt", true)) "" else "# ${clean.substringBeforeLast('.')}\n\n"
        atomicWrite(safe(rel), content.toByteArray())
        val result = if (clean.endsWith(".txt", true)) indexFile(rel) else indexPage(rel)
        enqueue(if (clean.endsWith(".txt", true)) "file" else "page", rel)
        JSONObject().put("ok", true).put("path", rel).put("pageId", if (result.has("title")) result.getString("id") else JSONObject.NULL)
    }

    /** Android 分享面板收到的文字先落本地事实源，再进入普通同步 outbox。 */
    fun importSharedText(requestedTitle: String?, text: String): String = synchronized(lock) {
        require(text.isNotBlank()) { "分享内容为空" }
        val fallback = "手机分享-${Instant.now().toString().replace(Regex("[:.]"), "-")}"
        // 80 个 UTF-16 字符即使全是中文也能留在常见 255-byte 文件名限制内。
        val title = sanitizeName(requestedTitle.orEmpty()).take(80).ifBlank { fallback }
        val rel = uniquePath("原始资料/收集箱", "$title.md")
        atomicWrite(safe(rel), "# $title\n\n${text.trim()}\n".toByteArray(StandardCharsets.UTF_8))
        indexPage(rel)
        enqueue("page", rel)
        rel
    }

    /** 分享来的图片/文档通过临时文件原子安装，保留原文件名并自动避让重名。 */
    fun installSharedFile(requestedName: String, staged: File): String = synchronized(lock) {
        require(staged.isFile) { "分享文件不存在" }
        val name = sanitizeName(File(requestedName).name).ifBlank { "手机分享文件" }
        val rel = uniquePath("原始资料/收集箱", name)
        installImportedFile(rel, staged)
        rel
    }

    private fun uniquePath(dir: String, requestedName: String): String {
        val clean = sanitizeName(File(requestedName).name).ifBlank { "file" }
        val dot = clean.lastIndexOf('.')
        val stem = if (dot > 0) clean.substring(0, dot) else clean
        val suffix = if (dot > 0) clean.substring(dot) else ""
        var candidate = "$dir/$clean"
        var index = 2
        while (safe(candidate).exists()) candidate = "$dir/$stem-$index${suffix}".also { index++ }
        return candidate
    }

    fun writeSyncedFile(rel: String, bytes: ByteArray) = synchronized(lock) {
        atomicWrite(safe(rel), bytes)
        indexFile(rel)
    }

    fun installSyncedFile(rel: String, staged: File) = synchronized(lock) {
        val target = safe(rel)
        target.parentFile?.mkdirs()
        Os.rename(staged.absolutePath, target.absolutePath)
        indexFile(rel)
    }

    fun saveExtraction(path: String, incoming: JSONArray): JSONObject = synchronized(lock) {
        require(safe(path).isFile) { "文件不存在" }
        val pages = JSONArray(); val allText = StringBuilder(); var extracted = 0
        for (i in 0 until incoming.length()) {
            val source = incoming.optJSONObject(i) ?: continue
            val text = source.optString("text").trim()
            if (text.isNotBlank()) { extracted++; if (allText.isNotEmpty()) allText.append("\n\n"); allText.append(text) }
            pages.put(JSONObject().put("pageNumber", source.optInt("pageNumber", i + 1))
                .put("method", "embedded").put("status", if (text.isBlank()) "skipped" else "completed")
                .put("text", text).put("error", JSONObject.NULL).put("updatedAt", now()))
        }
        val result = JSONObject()
            .put("status", if (extracted > 0) "completed" else "blocked")
            .put("method", "embedded").put("pageCount", pages.length()).put("extractedPages", extracted)
            .put("ocrPages", 0).put("skippedPages", pages.length() - extracted)
            .put("error", if (extracted > 0) JSONObject.NULL else "文件没有内嵌文字；Android 端不提供 OCR")
            .put("pages", pages)
        writableDatabase.execSQL("INSERT OR REPLACE INTO file_extractions(path,payload,updated_at) VALUES(?,?,?)", arrayOf(path, result.toString(), now()))
        if (pageIdByPath(path) == null) indexFile(path, allText.toString())
        result
    }

    fun extraction(path: String): JSONObject? = synchronized(lock) {
        readableDatabase.rawQuery("SELECT payload FROM file_extractions WHERE path=?", arrayOf(path)).use { if (it.moveToFirst()) JSONObject(it.getString(0)) else null }
    }

    fun deleteFile(path: String, fromSync: Boolean = false) = synchronized(lock) {
        val id = readableDatabase.rawQuery("SELECT id FROM files WHERE path=? AND deleted=0", arrayOf(path)).use { require(it.moveToFirst()) { "文件不存在" }; it.getString(0) }
        moveToTrash(path, "file"); writableDatabase.execSQL("UPDATE files SET deleted=1 WHERE id=?", arrayOf(id)); writableDatabase.execSQL("DELETE FROM search_tokens WHERE ref_type='file' AND ref_id=?", arrayOf(id)); if (!fromSync) enqueue("delete", path)
    }

    fun file(path: String): File = safe(path)

    fun deleteSyncedPath(path: String) = synchronized(lock) {
        pageIdByPath(path)?.let { runCatching { deletePage(it, true) }; return@synchronized }
        if (safe(path).exists()) runCatching { deleteFile(path, true) }
    }

    fun moveSyncedPath(oldPath: String, newPath: String, revision: Int) = synchronized(lock) {
        val id = pageIdByPath(oldPath)
        if (id != null) {
            val dir = newPath.substringBeforeLast('/', "Wiki")
            val title = File(newPath).nameWithoutExtension
            movePage(id, dir, title, true)
            writableDatabase.execSQL("UPDATE pages SET sync_revision=? WHERE path=?", arrayOf(revision, newPath))
        }
    }

    fun snapshotEntries(): JSONArray = synchronized(lock) {
        val out = JSONArray()
        brain.walkTopDown().filter { it.isFile && !isInTrash(it) }.forEach { file ->
            val rel = relative(file)
            out.put(JSONObject()
                .put("kind", if (file.extension.equals("md", true) || file.extension.equals("markdown", true)) "page" else "file")
                .put("path", rel)
                .put("hash", sha256(file))
                .put("revision", pageRevision(rel))
                .put("distilled", evidenceDistilled(rel)))
        }
        out
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    fun tree(): JSONArray = synchronized(lock) { treeAt(brain, true) }
    private fun treeAt(dir: File, top: Boolean = false): JSONArray {
        val out = JSONArray(); val hidden = setOf(".trash", "assets")
        dir.listFiles()?.filter { !it.name.startsWith('.') && !(top && hidden.contains(it.name)) }?.sortedWith(compareBy<File> { !it.isDirectory }.thenBy { it.name })?.forEach { file ->
            val rel = relative(file)
            if (file.isDirectory) out.put(JSONObject().put("kind", "dir").put("name", file.name).put("path", rel).put("children", treeAt(file)))
            else if (file.extension.equals("md", true) || file.extension.equals("markdown", true)) {
                val page = readableDatabase.rawQuery("SELECT id,title,type,tags,updated_at FROM pages WHERE path=? AND deleted=0", arrayOf(rel)).use { c -> if (!c.moveToFirst()) null else JSONObject().put("kind", "page").put("name", file.name).put("path", rel).put("id", c.getString(0)).put("title", c.getString(1)).put("type", c.getString(2)).put("tags", JSONArray(c.getString(3))).put("updated_at", c.getString(4)).put("guide_version", 0) }
                if (page != null) out.put(page)
            } else out.put(JSONObject().put("kind", "file").put("name", file.name).put("path", rel).put("ext", file.extension.lowercase()).put("size", file.length()))
        }; return out
    }

    fun search(query: String): JSONArray = synchronized(lock) {
        val terms = tokens(query).ifEmpty { setOf(query.lowercase()) }.toList(); if (terms.isEmpty()) return@synchronized JSONArray()
        val marks = terms.joinToString(",") { "?" }; val args = terms.toTypedArray(); val hits = JSONArray()
        readableDatabase.rawQuery("SELECT ref_type,ref_id,COUNT(*) score FROM search_tokens WHERE term IN ($marks) GROUP BY ref_type,ref_id ORDER BY score DESC LIMIT 24", args).use { c -> while (c.moveToNext()) {
            val type = c.getString(0); val id = c.getString(1); val score = c.getInt(2)
            if (type == "page") pageJson(id)?.let { p -> hits.put(JSONObject().put("refType", "page").put("refId", id).put("title", p.getString("title")).put("path", p.getString("path")).put("heading", "").put("snippet", snippet(p.getString("content"), query)).put("score", score).put("evidence", JSONArray().put("关键词")).put("updated_at", p.getString("updated_at")).put("type", p.getString("type")).put("tags", p.getJSONArray("tags"))) }
            else fileJson(id)?.let { f -> hits.put(JSONObject().put("refType", "file").put("refId", id).put("title", f.getString("name")).put("path", f.getString("path")).put("heading", "").put("snippet", snippet(f.optString("text"), query)).put("score", score).put("evidence", JSONArray().put("关键词")).put("updated_at", f.getString("updated_at"))) }
        } }; hits
    }

    private fun snippet(text: String, query: String): String { val compact = text.trim(); if (compact.length <= 220) return compact; val at = compact.indexOf(query, ignoreCase = true).coerceAtLeast(0); val start = (at - 70).coerceAtLeast(0); return (if (start > 0) "…" else "") + compact.substring(start, (start + 220).coerceAtMost(compact.length)) + if (start + 220 < compact.length) "…" else "" }

    fun graph(scope: String?, pageId: String?): JSONObject = synchronized(lock) {
        val nodes = JSONArray(); val edges = JSONArray(); val selected = if (scope == "page" && pageId != null) relatedIds(pageId, 3) + pageId else pages().let { arr -> (0 until minOf(arr.length(), 150)).map { arr.getJSONObject(it).getString("id") }.toSet() }
        selected.forEach { id -> pageJson(id)?.let { p -> nodes.put(JSONObject().put("id", id).put("label", p.getString("title")).put("group", p.getString("type")).put("raw", p.getString("path").startsWith("原始资料/")).put("words", p.getInt("word_count"))) } }
        selected.forEach { id -> pageJson(id)?.let { p -> Regex("\\[\\[([^]#|]+)").findAll(p.getString("content")).forEach { m -> val target = pageByTitle(m.groupValues[1].trim()); if (target != null && selected.contains(target.getString("id"))) edges.put(JSONObject().put("from", id).put("to", target.getString("id"))) } } }
        JSONObject().put("nodes", nodes).put("edges", edges)
    }

    private fun relatedIds(id: String, depth: Int): Set<String> { val found = linkedSetOf<String>(); var frontier = setOf(id); repeat(depth) { val next = linkedSetOf<String>(); frontier.forEach { source -> pageJson(source)?.let { page -> Regex("\\[\\[([^]#|]+)").findAll(page.getString("content")).forEach { pageByTitle(it.groupValues[1].trim())?.getString("id")?.let(next::add) } } }; pages().let { arr -> for (i in 0 until arr.length()) { val p = arr.getJSONObject(i); if (Regex("\\[\\[${Regex.escape(pageJson(id)?.getString("title") ?: "")}([#|\\]])").containsMatchIn(p.getString("content"))) next += p.getString("id") } }; next.removeAll(found); found.addAll(next); frontier = next }; return found }

    fun related(id: String): JSONObject { val related = JSONArray(); relatedIds(id, 1).forEach { rid -> pageJson(rid)?.let { related.put(it) } }; return JSONObject().put("neighbors", related).put("similar", JSONArray()).put("entities", JSONArray()) }

    fun enqueue(kind: String, target: String, oldPath: String = "") = synchronized(lock) {
        writableDatabase.execSQL("INSERT OR REPLACE INTO sync_outbox(kind,target,old_path,created_at) VALUES(?,?,?,?)", arrayOf(kind, target, oldPath, now()))
        EngramLocalServer.peek()?.requestSync(false)
    }

    fun outbox(): List<JSONObject> = synchronized(lock) { val out = mutableListOf<JSONObject>(); readableDatabase.rawQuery("SELECT id,kind,target,old_path FROM sync_outbox ORDER BY id", null).use { c -> while (c.moveToNext()) out += JSONObject().put("id", c.getLong(0)).put("kind", c.getString(1)).put("target", c.getString(2)).put("old_path", c.getString(3)) }; out }
    fun ackOutbox(id: Long) = synchronized(lock) { writableDatabase.execSQL("DELETE FROM sync_outbox WHERE id=?", arrayOf(id)) }
    fun dropOutboxForTarget(target: String) = synchronized(lock) { writableDatabase.execSQL("DELETE FROM sync_outbox WHERE target=?", arrayOf(target)) }
    fun outboxCount(): Int = readableDatabase.rawQuery("SELECT COUNT(*) FROM sync_outbox", null).use { it.moveToFirst(); it.getInt(0) }

    fun log(level: String, event: String, detail: String = "") = synchronized(lock) { writableDatabase.execSQL("INSERT INTO sync_log(ts,level,event,detail) VALUES(?,?,?,?)", arrayOf(now(), level, event, detail)); writableDatabase.execSQL("DELETE FROM sync_log WHERE id NOT IN (SELECT id FROM sync_log ORDER BY id DESC LIMIT 100)") }
    fun logs(): JSONArray { val out = JSONArray(); readableDatabase.rawQuery("SELECT ts,level,event,detail FROM sync_log ORDER BY id", null).use { c -> while (c.moveToNext()) out.put(JSONObject().put("ts", c.getString(0)).put("level", c.getString(1)).put("event", c.getString(2)).put("detail", c.getString(3))) }; return out }

    fun evidenceDistilled(path: String): Boolean = readableDatabase.rawQuery("SELECT distilled FROM evidence_snapshots WHERE path=?", arrayOf(path)).use { it.moveToFirst() && it.getInt(0) == 1 }
    fun saveEvidence(path: String, payload: JSONObject, distilled: Boolean = true) = synchronized(lock) { writableDatabase.execSQL("INSERT OR REPLACE INTO evidence_snapshots(path,payload,distilled,updated_at) VALUES(?,?,?,?)", arrayOf(path, payload.toString(), if (distilled) 1 else 0, now())) }
    fun evidence(path: String): JSONObject? = readableDatabase.rawQuery("SELECT payload FROM evidence_snapshots WHERE path=?", arrayOf(path)).use { if (it.moveToFirst()) JSONObject(it.getString(0)) else null }

    fun pageEvidence(id: String): JSONObject = synchronized(lock) {
        val page = pageJson(id) ?: error("页面不存在")
        evidence(page.getString("path")) ?: JSONObject()
            .put("pageId", id)
            .put("pagePath", page.getString("path"))
            .put("sources", JSONArray())
            .put("contributions", JSONArray())
    }

    fun publicSettings(): JSONObject = JSONObject().put("search_synonyms", setting("search_synonyms") ?: "")

    fun portableMetadata(): JSONObject = synchronized(lock) {
        val evidence = JSONArray()
        readableDatabase.rawQuery("SELECT path,payload,distilled,updated_at FROM evidence_snapshots", null).use { c ->
            while (c.moveToNext()) evidence.put(JSONObject()
                .put("path", c.getString(0)).put("payload", JSONObject(c.getString(1)))
                .put("distilled", c.getInt(2) == 1).put("updated_at", c.getString(3)))
        }
        JSONObject().put("format", "engram-portable-metadata-v2").put("evidence", evidence)
    }

    fun importPortableMetadata(metadata: JSONObject) = synchronized(lock) {
        val rows = metadata.optJSONArray("evidence") ?: JSONArray()
        for (i in 0 until rows.length()) {
            val row = rows.optJSONObject(i) ?: continue
            val path = row.optString("path")
            val payload = row.optJSONObject("payload") ?: continue
            if (path.isNotBlank()) saveEvidence(path, payload, row.optBoolean("distilled", true))
        }
    }

    fun knowledgeFileCount(): Int = brain.walkTopDown().count { it.isFile && !isInTrash(it) }

    fun replaceBrain(stagedBrain: File, metadata: JSONObject?) = synchronized(lock) {
        require(stagedBrain.isDirectory) { "备份缺少 brain/" }
        val replacement = File(root, "brain.restore-${newId()}")
        val previous = File(root, "brain.previous-${newId()}")
        stagedBrain.copyRecursively(replacement, overwrite = true)
        try {
            Os.rename(brain.absolutePath, previous.absolutePath)
            Os.rename(replacement.absolutePath, brain.absolutePath)
        } catch (error: Exception) {
            if (!brain.exists() && previous.exists()) runCatching { Os.rename(previous.absolutePath, brain.absolutePath) }
            replacement.deleteRecursively()
            throw error
        }
        previous.deleteRecursively()
        seedDirectories()
        writableDatabase.execSQL("DELETE FROM pages")
        writableDatabase.execSQL("DELETE FROM files")
        writableDatabase.execSQL("DELETE FROM search_tokens")
        writableDatabase.execSQL("DELETE FROM trash")
        writableDatabase.execSQL("DELETE FROM sync_outbox")
        writableDatabase.execSQL("DELETE FROM page_revisions")
        writableDatabase.execSQL("DELETE FROM evidence_snapshots")
        writableDatabase.execSQL("DELETE FROM file_extractions")
        scan()
        metadata?.let(::importPortableMetadata)
        val entries = snapshotEntries()
        for (i in 0 until entries.length()) {
            val item = entries.getJSONObject(i)
            enqueue(item.getString("kind"), item.getString("path"))
        }
    }

    fun wipe() = synchronized(lock) {
        brain.listFiles()?.filter { it != trashRoot }?.forEach { it.deleteRecursively() }; trashRoot.deleteRecursively()
        seedDirectories()
        writableDatabase.execSQL("DELETE FROM pages"); writableDatabase.execSQL("DELETE FROM files"); writableDatabase.execSQL("DELETE FROM search_tokens"); writableDatabase.execSQL("DELETE FROM trash"); writableDatabase.execSQL("DELETE FROM sync_outbox"); writableDatabase.execSQL("DELETE FROM page_revisions"); writableDatabase.execSQL("DELETE FROM evidence_snapshots"); writableDatabase.execSQL("DELETE FROM file_extractions")
    }

    private fun sanitizeName(value: String) = value.replace(Regex("[\\\\/:*?\"<>|]"), "-").trim()

    companion object {
        private val STANDARD_DIRECTORIES = listOf(
            "原始资料", "原始资料/对话", "原始资料/收集箱", "Wiki", "Wiki/概念", "Wiki/实体", "Wiki/查询", "Wiki/归档", "Wiki/关系",
            "AIWorks/index", "AIWorks/log", "AIWorks/scheme", "assets",
        )
        private val PAGE_DIRECTORIES = setOf("Wiki", "Wiki/概念", "Wiki/实体", "Wiki/查询", "Wiki/归档", "Wiki/关系")
        private val PAGE_TYPES = setOf("concept", "person", "customer", "org", "project", "other", "doc", "note")

        private fun typeDirectory(type: String) = when (type) {
            "person", "customer", "org", "project", "other" -> "Wiki/实体"
            else -> "Wiki/概念"
        }

        private fun databasePath(context: Context) =
            File(File(context.filesDir, "engram"), "wiki.db").absolutePath
    }
}
