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

    fun textName(title: String?): String = cleanName(
        (title?.takeIf { it.isNotBlank() } ?: "手机分享-${Instant.now().toEpochMilli()}") + ".txt",
    )

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
