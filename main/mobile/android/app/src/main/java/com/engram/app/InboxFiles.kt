package com.engram.app

import java.io.File
import java.time.Instant

/** 收集箱原件的路径和列表规则；不把暂存内容当成知识页面。 */
object InboxFiles {
    const val DIRECTORY = "收集箱"
    fun contains(path: String) = path.replace('\\', '/').startsWith("$DIRECTORY/")

    fun resolve(brain: File, path: String): File {
        require(contains(path)) { "不是收集箱路径" }
        val target = SafePaths.resolve(brain, path)
        val root = SafePaths.resolve(brain, DIRECTORY)
        require(target.path.startsWith(root.path + File.separator)) { "不是收集箱路径" }
        return target
    }

    fun cleanName(raw: String): String {
        val leaf = raw.replace('\\', '/').substringAfterLast('/')
            .replace(Regex("[\\x00-\\x1f\\x7f<>:\"/\\\\|?*]"), "-").trim().trim('.')
            .ifBlank { "手机分享文件" }
        val extension = leaf.substringAfterLast('.', "").take(16)
        val stem = leaf.substringBeforeLast('.', leaf).take(70).trim('.').ifBlank { "手机分享文件" }
        // 不接受隐藏文件名，且保留扩展名；全中文名称也不越过 255-byte 文件系统限制。
        return if (extension.isBlank() || !leaf.contains('.')) stem else "$stem.$extension"
    }

    fun textName(title: String?, fallback: String? = null): String = cleanName(
        (title?.takeIf { it.isNotBlank() }
            ?: fallback?.takeIf { it.isNotBlank() }
            ?: "手机分享-${Instant.now().toEpochMilli()}") + ".txt",
    )

    /**
     * 分享方只给了「image」「clip」这类不带扩展名的 display name 时，用 MIME 补一个扩展名。
     *
     * 没有扩展名的文件在收集箱里只能落到「其他」分组，缩略图/预览也起不来（用户 2026-11
     * 报障「分享进来的图片只是一条 unknown」）。已有扩展名的一律原样保留，不按 MIME 改写。
     */
    fun withExtension(name: String, mime: String?): String {
        val clean = cleanName(name)
        if (clean.contains('.')) return clean
        val extension = MIME_EXTENSIONS[(mime ?: "").substringBefore(';').trim().lowercase()] ?: return clean
        return cleanName("$clean.$extension")
    }

    /** MIME → 扩展名（只列分享入口常见的类型；未列出的保持无扩展名）。 */
    private val MIME_EXTENSIONS = mapOf(
        "image/jpeg" to "jpg", "image/jpg" to "jpg", "image/png" to "png", "image/gif" to "gif",
        "image/webp" to "webp", "image/heic" to "heic", "image/heif" to "heif", "image/bmp" to "bmp",
        "image/svg+xml" to "svg",
        "video/mp4" to "mp4", "video/quicktime" to "mov", "video/webm" to "webm",
        "video/x-matroska" to "mkv", "video/3gpp" to "3gp",
        "audio/mpeg" to "mp3", "audio/mp4" to "m4a", "audio/aac" to "aac", "audio/wav" to "wav",
        "audio/x-wav" to "wav", "audio/ogg" to "ogg", "audio/flac" to "flac", "audio/amr" to "amr",
        "text/plain" to "txt", "text/html" to "html", "text/markdown" to "md", "text/csv" to "csv",
        "text/x-markdown" to "md",
        "application/pdf" to "pdf", "application/json" to "json", "application/zip" to "zip",
        "application/msword" to "doc", "application/rtf" to "rtf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" to "docx",
        "application/vnd.ms-excel" to "xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" to "xlsx",
        "application/vnd.ms-powerpoint" to "ppt",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" to "pptx",
        "application/vnd.oasis.opendocument.text" to "odt",
    )

    /**
     * 网页抓不到时的回退名：用域名代替时间戳，至少能看出链接来源（正文仍原样保存）。
     * 例：https://mp.weixin.qq.com/s/abc → 网页链接-mp.weixin.qq.com
     */
    fun linkStem(url: String): String {
        val host = runCatching { java.net.URI(url).host }.getOrNull()
            ?.lowercase()?.removePrefix("www.")?.takeIf { it.isNotBlank() && it.length <= 60 }
        return if (host == null) "网页链接" else "网页链接-$host"
    }

    fun uniquePath(brain: File, name: String): String {
        val clean = cleanName(name)
        val stem = clean.substringBeforeLast('.', clean)
        val suffix = if (clean.contains('.')) ".${clean.substringAfterLast('.')}" else ""
        var path = "$DIRECTORY/$clean"
        var index = 2
        while (resolve(brain, path).exists()) path = "$DIRECTORY/$stem-${index++}$suffix"
        return path
    }

    fun originals(brain: File): List<File> {
        val root = SafePaths.resolve(brain, DIRECTORY)
        if (!root.isDirectory) return emptyList()
        val derived = File(root, "转换结果")
        return root.walkTopDown().onEnter { !it.name.startsWith('.') && it != derived }
            .filter { it.isFile && !it.name.startsWith('.') }
            .filter { runCatching { resolve(brain, "$DIRECTORY/${it.relativeTo(root).invariantSeparatorsPath}") == it.canonicalFile }.getOrDefault(false) }
            .sortedByDescending { it.lastModified() }.toList()
    }
}
