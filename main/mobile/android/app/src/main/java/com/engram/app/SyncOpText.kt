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

    /** 采样里单行最多留多少字（与 server opText.ts 的 CHANGE_LINE_MAX 一致） */
    const val CHANGE_LINE_MAX = 160

    /** 一条记录最多采样几行改动（server CHANGE_SAMPLE_LINES） */
    const val CHANGE_SAMPLE_LINES = 6

    /** 一条日志记录里改动正文的预算：最多 20 行、1400 字（server CHANGE_LOG_MAX_LINES/CHARS） */
    const val CHANGE_LOG_MAX_LINES = 20
    const val CHANGE_LOG_MAX_CHARS = 1400

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
        /** 改动正文采样：`+ 新增的那一行` / `- 被删掉的那一行`（与 server data.changes 同口径） */
        val changes: List<String>? = null,
        /** 采样省略掉的改动行数 */
        val changesOmitted: Int = 0,
    )

    private data class LineEdit(val op: Char, val text: String)

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
        // 「改了哪几行」只采样正文（跳过应用自己写的 frontmatter）；正文逐字没变、只动过文件头时
        // 回退看整篇，免得条目写着「+1 行」却一行改动都不显示（与 server summarizePageChange 同口径）
        var sample: Pair<List<String>, Int> = emptyList<String>() to 0
        if (verb != VERB_SAME) {
            sample = diffSample(stripLeadingFrontmatter(before ?: ""), stripLeadingFrontmatter(after))
            if (sample.first.isEmpty() && before != null) sample = diffSample(before, after)
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
            changes = sample.first.takeIf { it.isNotEmpty() },
            changesOmitted = sample.second,
        )
    }

    /**
     * 采样用的正文：去掉文件头部的 frontmatter（`---` 包起来的 id / 创建日期 / 标题）。
     *
     * 这几行由应用自己写，不是用户改的内容；更麻烦的是新建页面时它们会把 6 行采样预算吃光。
     * 只认第一行就是 `---` 的块，正文里以 `---` 开头的内容（分隔线）不会被误吃。
     */
    fun stripLeadingFrontmatter(text: String): String {
        val match = Regex("^---[ \\t]*\\r?\\n[\\s\\S]*?\\r?\\n---[ \\t]*\\r?\\n?").find(text)
        return if (match != null) text.substring(match.value.length) else text
    }

    /**
     * 逐行比对出改动正文（LCS 回溯），顺序按文件从前到后、同一处先删后增（git diff 的口径）。
     * 只在剪掉公共前后缀后的中段上做，中段 ≤ 25 万格才走回溯；再大就退回多重集。
     */
    fun diffSample(before: String, after: String, maxLines: Int = CHANGE_SAMPLE_LINES): Pair<List<String>, Int> {
        if (before == after) return emptyList<String>() to 0
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
        val midA = a.subList(start, endA + 1).toList()
        val midB = b.subList(start, endB + 1).toList()
        val edits = when {
            midA.isEmpty() -> midB.map { LineEdit('+', it) }
            midB.isEmpty() -> midA.map { LineEdit('-', it) }
            else -> diffEdits(midA, midB)
        }
        return describeEditLines(edits, maxLines)
    }

    private fun diffEdits(midA: List<String>, midB: List<String>): List<LineEdit> {
        if (midA.size * midB.size <= LCS_CELL_BUDGET) {
            val n = midA.size
            val m = midB.size
            val width = m + 1
            // 后缀 LCS 长度表：dp[i * width + j] = a[i..] 与 b[j..] 的最长公共子序列长度
            val dp = IntArray((n + 1) * width)
            for (i in n - 1 downTo 0) {
                val row = i * width
                val next = row + width
                for (j in m - 1 downTo 0) {
                    dp[row + j] = if (midA[i] == midB[j]) dp[next + j + 1] + 1 else maxOf(dp[next + j], dp[row + j + 1])
                }
            }
            val edits = mutableListOf<LineEdit>()
            var i = 0
            var j = 0
            while (i < n && j < m) {
                if (midA[i] == midB[j]) {
                    i += 1
                    j += 1
                    continue
                }
                if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
                    edits += LineEdit('-', midA[i])
                    i += 1
                } else {
                    edits += LineEdit('+', midB[j])
                    j += 1
                }
            }
            while (i < n) {
                edits += LineEdit('-', midA[i])
                i += 1
            }
            while (j < m) {
                edits += LineEdit('+', midB[j])
                j += 1
            }
            return edits
        }
        // 中段太大（整页重写 / 超大文件）：多重集口径，只挑「一边有一边没有」的行
        val counts = HashMap<String, Int>()
        for (line in midA) counts[line] = (counts[line] ?: 0) + 1
        val addedLines = mutableListOf<String>()
        for (line in midB) {
            val left = counts[line] ?: 0
            if (left > 0) counts[line] = left - 1 else addedLines += line
        }
        val removedLines = mutableListOf<String>()
        for ((line, left) in counts) repeat(left) { removedLines += line }
        return removedLines.map { LineEdit('-', it) } + addedLines.map { LineEdit('+', it) }
    }

    /** 改动行 → 日志里的一行：空白行不值得占一行记录，过长只留开头 */
    private fun describeEditLines(edits: List<LineEdit>, maxLines: Int): Pair<List<String>, Int> {
        val lines = mutableListOf<String>()
        var omitted = 0
        for (edit in edits) {
            val text = edit.text.trim()
            if (text.isEmpty()) continue
            if (lines.size >= maxLines) {
                omitted += 1
                continue
            }
            lines += "${edit.op} " + if (text.length > CHANGE_LINE_MAX) text.take(CHANGE_LINE_MAX) + "…" else text
        }
        return lines to omitted
    }

    /**
     * 若干条目 → 写进日志 `data.changes` 的改动正文：多于一个文件时先写一行文件路径，再写它的改动行；
     * 超过条数或字符上限就收尾写「还有 N 行改动未记录」，绝不为了记全改动把日志撑爆。
     */
    fun flattenChangeLines(items: List<SyncOpSummary>): List<String>? {
        val withChanges = items.filter { !it.changes.isNullOrEmpty() }
        if (withChanges.isEmpty()) return null
        val withHeader = withChanges.size > 1
        val candidates = mutableListOf<String>()
        var omittedBySample = 0
        var lastHeader = ""
        for (op in withChanges) {
            if (withHeader && lastHeader != op.path) {
                candidates += op.path
                lastHeader = op.path
            }
            candidates += op.changes!!
            omittedBySample += op.changesOmitted
        }
        val kept = mutableListOf<String>()
        var chars = 0
        for (line in candidates) {
            if (kept.size >= CHANGE_LOG_MAX_LINES - 1) break
            if (chars + line.length > CHANGE_LOG_MAX_CHARS) break
            kept += line
            chars += line.length + 1
        }
        val omitted = candidates.size - kept.size + omittedBySample
        if (omitted > 0) {
            if (kept.size >= CHANGE_LOG_MAX_LINES) kept.removeAt(kept.size - 1)
            kept += "…（还有 $omitted 行改动未记录）"
        }
        return kept.takeIf { it.isNotEmpty() }
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
        // 改动正文：抽屉里展开这条记录能直接看到「这个文件改了什么」（与 server 的 data.changes 同键名）
        flattenChangeLines(listOf(item))?.let { out["changes"] = it }
        if (item.changesOmitted > 0) out["changesOmitted"] = item.changesOmitted
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

    /**
     * 本端推送的页面被中枢合并（本端与别的端都改过，中枢给的是合并结果）：
     * 这句是「我的改动怎么变了」的唯一解释，与 desktop 端 client.ts 的 push-merged 同措辞。
     */
    fun describePushMerged(path: String, title: String?, added: Int, removed: Int, localBytes: Long, mergedBytes: Long): String {
        val delta = if (added > 0 || removed > 0) "（合并后 ${formatLineDelta(added, removed)}）" else ""
        val name = title?.takeIf { it.isNotBlank() } ?: pageTitle(path)
        return "页面「$name」本端与中枢都有改动，已按中枢合并结果写回本端$delta"
    }

    /**
     * 兜底：中枢下发了本端不认识的同步类型（协议比本端新）。
     *
     * session / board 两类是「已知但不镜像」——手机不存会话与看板，读的是中枢那一份（窄代理）；
     * 除此之外的类型既不能瞎套页面逻辑、也不能静默吞掉：水位照常推进（否则后续 op 永远卡在它后面），
     * 但要在同步详情里留下一条 warn，让「这条改动为什么没落地」查得到。
     */
    fun describeUnknownKind(kind: String): String =
        "中枢下发了本端不认识的同步类型「$kind」，已跳过；升级 Engram 手机端后再同步可补齐"
}
