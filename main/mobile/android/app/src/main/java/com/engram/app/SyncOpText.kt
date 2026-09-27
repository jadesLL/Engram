package com.engram.app

/**
 * 同步条目的「人话描述」（Android 成员端）。
 *
 * 与 desktop / Docker 端 server/src/sync/opText.ts 同一套口径：把一次同步拆成
 * 「哪个文件 + 做了什么增量」（新增/修改/删除/改名 + 行数增量 + 体积变化），
 * 手机上的「同步详情」才看得出每次具体改了什么，而不是只有一句「同步已收敛」。
 *
 * 纯函数、不依赖 Android 框架（也不碰 org.json，JVM 单测直接钉措辞与计数口径）。
 */
object SyncOpText {
    const val KIND_PAGE = "page"
    const val KIND_FILE = "file"
    const val KIND_DELETE = "delete"
    const val KIND_MOVE = "move"

    const val VERB_ADD = "add"
    const val VERB_UPDATE = "update"
    const val VERB_DELETE = "delete"
    const val VERB_MOVE = "move"
    const val VERB_SAME = "same"

    /** 中段行数积超过这个格数就退回「行多重集」口径，不为了一个量级数字把手机卡住 */
    private const val LCS_CELL_BUDGET = 250_000

    data class SyncOpSummary(
        val kind: String,
        val verb: String,
        val path: String,
        val oldPath: String? = null,
        val title: String? = null,
        val added: Int = 0,
        val removed: Int = 0,
        val beforeBytes: Long = 0,
        val afterBytes: Long = 0,
    )

    /** 字节数转人话（结构化字段里仍保留原始字节数） */
    fun formatBytes(bytes: Long?): String {
        val value = bytes ?: 0
        if (value <= 0) return "0 B"
        if (value < 1024) return "$value B"
        if (value < 1024 * 1024) return "%.1f KB".format(value / 1024.0)
        return "%.1f MB".format(value / 1024.0 / 1024.0)
    }

    /** 「+3 −1 行」；只有增或只有删时不写多余的 0 */
    fun formatLineDelta(added: Int = 0, removed: Int = 0): String {
        val parts = mutableListOf<String>()
        if (added > 0) parts += "+$added"
        if (removed > 0) parts += "−$removed"
        if (parts.isEmpty()) return "内容顺序调整（行数不变）"
        return "${parts.joinToString(" ")} 行"
    }

    /** 页面标题：优先正文第一个 H1，其次文件名（用户认标题，不认路径） */
    fun pageTitle(relPath: String, raw: String? = null): String {
        val heading = Regex("^\\s{0,3}#\\s+(.+?)\\s*$", RegexOption.MULTILINE).find(raw ?: "")?.groupValues?.get(1)
        if (!heading.isNullOrBlank()) return heading.replace(Regex("[#*`]"), "").trim().take(60)
        val base = relPath.substringAfterLast('/').replace(Regex("\\.(md|markdown)$", RegexOption.IGNORE_CASE), "")
        return base.ifBlank { relPath }
    }

    /**
     * 行级增量计数：先剪掉公共前后缀，再对中段做 LCS；中段过大时退回行多重集口径。
     * 返回 added to removed。
     */
    fun lineDiffCounts(before: String, after: String): Pair<Int, Int> {
        if (before == after) return 0 to 0
        val a = before.split("\n")
        val b = after.split("\n")
        var start = 0
        while (start < a.size && start < b.size && a[start] == b[start]) start += 1
        var endA = a.size - 1
        var endB = b.size - 1
        while (endA >= start && endB >= start && a[endA] == b[endB]) {
            endA -= 1
            endB -= 1
        }
        val midA = a.subList(start, endA + 1)
        val midB = b.subList(start, endB + 1)
        if (midA.isEmpty()) return midB.size to 0
        if (midB.isEmpty()) return 0 to midA.size
        if (midA.size * midB.size <= LCS_CELL_BUDGET) {
            val lcs = lcsLength(midA, midB)
            return (midB.size - lcs) to (midA.size - lcs)
        }
        val counts = HashMap<String, Int>()
        for (line in midA) counts[line] = (counts[line] ?: 0) + 1
        var added = 0
        for (line in midB) {
            val left = counts[line] ?: 0
            if (left > 0) counts[line] = left - 1 else added += 1
        }
        var removed = 0
        for (left in counts.values) removed += left
        return added to removed
    }

    private fun lcsLength(a: List<String>, b: List<String>): Int {
        val prev = IntArray(b.size + 1)
        val cur = IntArray(b.size + 1)
        for (i in 1..a.size) {
            for (j in 1..b.size) {
                cur[j] = if (a[i - 1] == b[j - 1]) prev[j - 1] + 1 else maxOf(prev[j], cur[j - 1])
            }
            for (j in 0..b.size) prev[j] = cur[j]
        }
        return prev[b.size]
    }

    fun summarizePage(path: String, before: String?, after: String): SyncOpSummary {
        val delta = if (before == null) (countLines(after) to 0) else lineDiffCounts(before, after)
        val verb = when {
            before == null -> VERB_ADD
            before == after -> VERB_SAME
            else -> VERB_UPDATE
        }
        return SyncOpSummary(
            kind = KIND_PAGE,
            verb = verb,
            path = path,
            title = pageTitle(path, after),
            added = delta.first,
            removed = delta.second,
            beforeBytes = before?.toByteArray(Charsets.UTF_8)?.size?.toLong() ?: 0L,
            afterBytes = after.toByteArray(Charsets.UTF_8).size.toLong(),
        )
    }

    fun summarizeFile(path: String, beforeBytes: Long, afterBytes: Long): SyncOpSummary = SyncOpSummary(
        kind = KIND_FILE,
        verb = if (beforeBytes > 0) VERB_UPDATE else VERB_ADD,
        path = path,
        beforeBytes = beforeBytes,
        afterBytes = afterBytes,
    )

    fun summarizeDelete(path: String, beforeBytes: Long, isPage: Boolean): SyncOpSummary = SyncOpSummary(
        kind = KIND_DELETE,
        verb = VERB_DELETE,
        path = path,
        title = if (isPage) pageTitle(path) else null,
        beforeBytes = beforeBytes,
    )

    fun summarizeMove(oldPath: String, newPath: String): SyncOpSummary = SyncOpSummary(
        kind = KIND_MOVE,
        verb = VERB_MOVE,
        path = newPath,
        oldPath = oldPath,
        title = pageTitle(newPath),
    )

    /** 是否值得写进同步记录：AIWorks/ 下的系统页不打扰用户，内容没变也不记 */
    fun isNoteworthy(item: SyncOpSummary?): Boolean {
        if (item == null) return false
        if (item.verb == VERB_SAME) return false
        if (item.path.startsWith("AIWorks/")) return false
        if (item.kind == KIND_MOVE && (item.oldPath ?: "").startsWith("AIWorks/")) return false
        return true
    }

    /** 推送方向同一条过滤：手机首次启动会种下 AIWorks/index|log|scheme，不该冒进用户的同步记录 */
    fun isNoteworthyPush(path: String, oldPath: String? = null): Boolean =
        !path.startsWith("AIWorks/") && !(oldPath ?: "").startsWith("AIWorks/")

    private fun subject(item: SyncOpSummary): String = when {
        item.kind == KIND_FILE -> "文件「${item.path}」"
        item.kind == KIND_DELETE && item.title == null -> "文件「${item.path}」"
        else -> "页面「${item.title ?: pageTitle(item.path)}」"
    }

    /** 条目 → 一行中文（同步详情列表里直接展示，不展开也看得懂） */
    fun describe(item: SyncOpSummary): String {
        val name = subject(item)
        return when (item.verb) {
            VERB_ADD -> if (item.kind == KIND_FILE) {
                "新增文件「${item.path}」（${formatBytes(item.afterBytes)}）"
            } else {
                val delta = if (item.added > 0) "${formatLineDelta(item.added, 0)}，" else ""
                "新增$name（$delta${formatBytes(item.afterBytes)}）"
            }
            VERB_UPDATE -> if (item.kind == KIND_FILE) {
                "更新文件「${item.path}」（${formatBytes(item.beforeBytes)} → ${formatBytes(item.afterBytes)}）"
            } else {
                "修改$name（${formatLineDelta(item.added, item.removed)}，${formatBytes(item.beforeBytes)} → ${formatBytes(item.afterBytes)}）"
            }
            VERB_DELETE -> "删除$name（删除前 ${formatBytes(item.beforeBytes)}）"
            VERB_MOVE -> "改名「${pageTitle(item.oldPath ?: "")}」→「${pageTitle(item.path)}」（${item.oldPath} → ${item.path}）"
            else -> "$name 内容无变化"
        }
    }

    /** 结构化字段：抽屉展开详情与导出用（键名与 server 的 data 对齐） */
    fun data(item: SyncOpSummary): LinkedHashMap<String, Any> {
        val out = LinkedHashMap<String, Any>()
        out["kind"] = item.kind
        out["verb"] = item.verb
        out["path"] = item.path
        item.oldPath?.let { out["oldPath"] = it }
        item.title?.takeIf { it.isNotBlank() }?.let { out["title"] = it }
        if (item.kind == KIND_PAGE) {
            out["added"] = item.added
            out["removed"] = item.removed
        }
        if (item.beforeBytes > 0) out["beforeBytes"] = item.beforeBytes
        if (item.afterBytes > 0) out["afterBytes"] = item.afterBytes
        return out
    }

    private fun countLines(text: String): Int = if (text.isEmpty()) 0 else text.split("\n").count { it.isNotEmpty() }

    /** 推送方向的一行话：本机改动送上中枢，措辞与「拉取」分开，回看时一眼分得清方向 */
    fun describePush(kind: String, path: String, oldPath: String? = null, bytes: Long = 0, revision: Int = 0): String {
        val size = if (revision > 0) "（${formatBytes(bytes)}，中枢版本 $revision）" else "（${formatBytes(bytes)}）"
        return when (kind) {
            KIND_PAGE -> "推送本机页面「${pageTitle(path)}」$size"
            KIND_FILE -> "推送本机文件「$path」$size"
            KIND_DELETE -> if (path.endsWith(".md", true)) "推送本机删除：页面「${pageTitle(path)}」" else "推送本机删除：文件「$path」"
            KIND_MOVE -> "推送本机改名「${pageTitle(oldPath ?: "")}」→「${pageTitle(path)}」"
            else -> "推送本机改动「$path」"
        }
    }

    /** 推送条目的结构化字段（与 data() 同键名口径） */
    fun pushData(kind: String, path: String, oldPath: String? = null, bytes: Long = 0, revision: Int = 0): LinkedHashMap<String, Any> {
        val out = LinkedHashMap<String, Any>()
        out["kind"] = kind
        out["verb"] = "push"
        out["path"] = path
        oldPath?.let { out["oldPath"] = it }
        if (bytes > 0) out["afterBytes"] = bytes
        if (revision > 0) out["revision"] = revision
        return out
    }
}
