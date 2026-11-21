package com.engram.app

import java.security.MessageDigest

/**
 * 图片归属收编：把正文里指向「别的父项」的 `![..](/media/<父项id>/<文件>)` 复制进本页
 * 资产目录并改写成本页引用。与 server `lib/pageAssets.ts` 的 `adoptForeignAssetRefs` 同语义。
 *
 * 为什么需要：图片 URL 里写死了归属父项 id。正文被复制到另一个页面（用户复制粘贴、
 * Agent 转写）后引用还指着旧页面——编辑器和阅读页照常能显示，但侧栏「查看引用图片」
 * 是按当前页 id 列 `assets/<id>/` 的，会显示 0 张，看起来像「图没插进去」。
 *
 * 只复制不移动：旧父项可能只是进了回收站，恢复后它自己的引用还得能用。
 * 源文件不存在（同步还没拉到）时保留原引用，下次写入或扫描再试。
 * `#w=` 这类 fragment 与图片 title 原样保留。
 *
 * 纯函数 + 读写回调：文件 I/O 由 [LocalDatabase] 注入，单测直接在内存里跑。
 */
object PageAssetAdoption {
    const val MEDIA_PREFIX = "/media/"
    private const val UNASSIGNED_PARENT = "_unassigned"

    private val PARENT_ID = Regex("^[A-Za-z0-9_-]{1,64}$")
    private val ASSET_EXTENSIONS = setOf("png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp")
    private val CONTENT_HASH_PREFIX = Regex("^[0-9a-f]{8}-")
    private val MD_IMAGE = Regex("""!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+["']([^"']*)["'])?\s*\)""")
    private val HTML_IMAGE = Regex("""<img\b[^>]*?\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>""", RegexOption.IGNORE_CASE)
    /** 与 LocalDatabase.savePageAsset 同一套文件名词表：中文保留，其余标点收成连字符 */
    private val SLUG_BAD = Regex("[^A-Za-z0-9\\u4e00-\\u9fa5_-]")

    data class MediaRef(val parentId: String, val name: String)
    data class AdoptedFile(val name: String)
    data class Result(val content: String, val adopted: Int, val files: List<AdoptedFile>)

    /**
     * 反解 `/media/<parentId>/<file>`；不是本库媒体路径（或目录名不合法）时返回 null。
     * 与 server `parseMediaUrl` 同口径：先剥 `?query` / `#fragment`，再 URI 解码。
     */
    fun parseMediaRef(url: String): MediaRef? {
        val trimmed = url.trim()
        if (!trimmed.startsWith(MEDIA_PREFIX)) return null
        val cut = trimmed.indexOfFirst { it == '?' || it == '#' }
        val rest = if (cut >= 0) trimmed.substring(MEDIA_PREFIX.length, cut) else trimmed.substring(MEDIA_PREFIX.length)
        val slash = rest.indexOf('/')
        if (slash <= 0) return null
        val parentId = rest.substring(0, slash)
        if (!PARENT_ID.matches(parentId)) return null
        val name = try {
            java.net.URLDecoder.decode(rest.substring(slash + 1).replace("+", "%2B"), "UTF-8")
        } catch (_: Exception) {
            return null
        }
        if (name.isBlank() || name.contains('/') || name.contains('\\') || name.contains("..")) return null
        return MediaRef(parentId, name)
    }

    /** 扫描一段 markdown 里的全部本库图片引用（md + html，同名去重，保留出现顺序） */
    fun parseMediaRefs(markdown: String): List<MediaRef> {
        val out = ArrayList<MediaRef>()
        val seen = HashSet<String>()
        fun push(rawUrl: String) {
            val parsed = parseMediaRef(rawUrl) ?: return
            if (seen.add("${parsed.parentId}/${parsed.name}")) out += parsed
        }
        MD_IMAGE.findAll(markdown).forEach { push(it.groupValues[2]) }
        HTML_IMAGE.findAll(markdown).forEach { push(it.groupValues[2]) }
        return out
    }

    fun isAssetFile(name: String): Boolean = name.substringAfterLast('.', "").lowercase() in ASSET_EXTENSIONS

    /** 内容寻址名（与 savePageAsset 同规则）：已带 8 位哈希前缀的沿用，否则补 `<sha1-8>-<slug>.<ext>` */
    fun contentAddressedName(bytes: ByteArray, originalName: String): String {
        val base = originalName.substringBeforeLast('.', originalName)
        if (CONTENT_HASH_PREFIX.containsMatchIn(base)) return originalName
        val ext = originalName.substringAfterLast('.', "").lowercase()
        if (ext !in ASSET_EXTENSIONS) return originalName
        val hash = MessageDigest.getInstance("SHA-1").digest(bytes).joinToString("") { "%02x".format(it) }.take(8)
        val slug = base.replace(SLUG_BAD, "-").trim('-').take(40).ifBlank { "image" }
        return "$hash-$slug.$ext"
    }

    /**
     * 收编正文里属于别的父项的图片引用。
     *
     * @param read 读源文件（返回 null = 还没同步到，跳过这条引用）
     * @param write 写本页资产目录（返回 false = 拷贝失败，跳过这条引用）
     * @return 改写后的正文、改写了几处、新拷进本页的文件名
     */
    fun adopt(
        pageId: String,
        markdown: String,
        read: (MediaRef) -> ByteArray?,
        write: (String, ByteArray) -> Boolean,
    ): Result {
        val untouched = Result(markdown, 0, emptyList())
        if (!PARENT_ID.matches(pageId) || pageId == UNASSIGNED_PARENT) return untouched
        if (!markdown.contains(MEDIA_PREFIX)) return untouched
        val foreign = parseMediaRefs(markdown).filter { it.parentId != pageId }
        if (foreign.isEmpty()) return untouched

        // `<源父项>/<源文件名>` → 本页文件名。文件先写成功再登记，写失败的那条引用保持原样。
        val adoptedNames = HashMap<String, String>()
        val files = LinkedHashMap<String, AdoptedFile>()
        for (ref in foreign) {
            if (!isAssetFile(ref.name)) continue
            val bytes = read(ref) ?: continue
            val name = contentAddressedName(bytes, ref.name)
            if (!write(name, bytes)) continue
            adoptedNames["${ref.parentId}/${ref.name}"] = name
            files["$pageId/$name"] = AdoptedFile(name)
        }
        if (adoptedNames.isEmpty()) return untouched

        var adopted = 0
        fun rewrite(rawUrl: String): String {
            val parsed = parseMediaRef(rawUrl) ?: return rawUrl
            if (parsed.parentId == pageId) return rawUrl
            val name = adoptedNames["${parsed.parentId}/${parsed.name}"] ?: return rawUrl
            adopted++
            val cut = rawUrl.indexOfFirst { it == '?' || it == '#' }
            val suffix = if (cut >= 0) rawUrl.substring(cut) else ""
            return mediaUrl(pageId, name) + suffix
        }

        var content = MD_IMAGE.replace(markdown) { match ->
            val rawUrl = match.groupValues[2]
            val next = rewrite(rawUrl)
            if (next == rawUrl) match.value else {
                // title 原样保留（外链本地化记的原出处靠它）
                val title = match.groups[3]?.value
                "![${match.groupValues[1]}]($next${if (title == null) "" else " \"$title\""})"
            }
        }
        content = HTML_IMAGE.replace(content) { match ->
            val src = match.groups[2] ?: return@replace match.value
            val next = rewrite(src.value)
            if (next == src.value) match.value else {
                // 只替换 src 值本身，其余属性不动
                val start = src.range.first - match.range.first
                val end = src.range.last - match.range.first + 1
                match.value.substring(0, start) + next + match.value.substring(end)
            }
        }
        if (adopted == 0 || content == markdown) return untouched
        return Result(content, adopted, files.values.toList())
    }

    private fun mediaUrl(parentId: String, name: String) =
        "$MEDIA_PREFIX$parentId/${java.net.URLEncoder.encode(name, "UTF-8").replace("+", "%20")}"
}
