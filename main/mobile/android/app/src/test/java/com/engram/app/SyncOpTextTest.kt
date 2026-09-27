package com.engram.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 同步记录的措辞与计数口径回归：这些字符串直接出现在用户看的「同步详情」里，
 * 与 desktop 端 server/src/sync/opText.ts 同一套写法，改措辞要同步改那边（反之亦然）。
 */
class SyncOpTextTest {
    @Test fun formatsBytesInHumanUnits() {
        assertEquals("0 B", SyncOpText.formatBytes(0))
        assertEquals("512 B", SyncOpText.formatBytes(512))
        assertEquals("1.0 KB", SyncOpText.formatBytes(1024))
        assertEquals("1.5 KB", SyncOpText.formatBytes(1536))
        assertEquals("1.0 MB", SyncOpText.formatBytes(1024L * 1024))
        assertEquals("1.2 MB", SyncOpText.formatBytes(1260000))
    }

    @Test fun formatsLineDeltaWithoutRedundantZeros() {
        assertEquals("+3 行", SyncOpText.formatLineDelta(3, 0))
        assertEquals("+2 −1 行", SyncOpText.formatLineDelta(2, 1))
        assertEquals("−4 行", SyncOpText.formatLineDelta(0, 4))
        assertEquals("内容顺序调整（行数不变）", SyncOpText.formatLineDelta(0, 0))
    }

    @Test fun readsTitleFromFirstHeadingThenFileName() {
        assertEquals("会议纪要", SyncOpText.pageTitle("Wiki/概念/旧名.md", "# 会议纪要\n\n正文\n"))
        assertEquals("旧名", SyncOpText.pageTitle("Wiki/概念/旧名.md"))
        assertEquals("附件.bin", SyncOpText.pageTitle("原始资料/附件.bin"))
    }

    @Test fun countsLineDiffOnly() {
        assertEquals(0 to 0, SyncOpText.lineDiffCounts("a\nb\nc", "a\nb\nc"))
        assertEquals(1 to 1, SyncOpText.lineDiffCounts("a\nb\nc", "a\nx\nc"))
        assertEquals(2 to 0, SyncOpText.lineDiffCounts("a\nc", "a\nx\ny\nc"))
        assertEquals(0 to 2, SyncOpText.lineDiffCounts("a\nx\ny\nc", "a\nc"))
    }

    @Test fun describesNewPageWithLineAndByteDelta() {
        val item = SyncOpText.summarizePage("Wiki/概念/A.md", null, "# A\n\nx\n")
        assertEquals(SyncOpText.VERB_ADD, item.verb)
        assertEquals("新增页面「A」（+2 行，7 B）", SyncOpText.describe(item))
    }

    @Test fun describesUpdatedPageWithLineDelta() {
        val item = SyncOpText.summarizePage("Wiki/概念/A.md", "# A\n\nx\n", "# A\n\nx\ny\n")
        assertEquals(SyncOpText.VERB_UPDATE, item.verb)
        assertEquals("修改页面「A」（+1 行，7 B → 9 B）", SyncOpText.describe(item))
    }

    @Test fun describesFilesDeletesAndMoves() {
        val added = SyncOpText.summarizeFile("原始资料/演示附件.bin", 0, 1260000)
        assertEquals("新增文件「原始资料/演示附件.bin」（1.2 MB）", SyncOpText.describe(added))

        val updated = SyncOpText.summarizeFile("原始资料/演示附件.bin", 1048576, 1260000)
        assertEquals("更新文件「原始资料/演示附件.bin」（1.0 MB → 1.2 MB）", SyncOpText.describe(updated))

        assertEquals("删除页面「旧稿」（删除前 2.0 KB）", SyncOpText.describe(SyncOpText.summarizeDelete("Wiki/概念/旧稿.md", 2048, true)))
        assertEquals("删除文件「原始资料/x.bin」（删除前 1.0 MB）", SyncOpText.describe(SyncOpText.summarizeDelete("原始资料/x.bin", 1048576, false)))

        val moved = SyncOpText.summarizeMove("Wiki/概念/旧名.md", "Wiki/实体/新名.md")
        assertEquals("改名「旧名」→「新名」（Wiki/概念/旧名.md → Wiki/实体/新名.md）", SyncOpText.describe(moved))
    }

    @Test fun describesPushWithHubRevision() {
        assertEquals("推送本机页面「A」（7 B，中枢版本 12）", SyncOpText.describePush(SyncOpText.KIND_PAGE, "Wiki/概念/A.md", null, 7, 12))
        assertEquals("推送本机文件「原始资料/演示附件.bin」（1.2 MB，中枢版本 3）", SyncOpText.describePush(SyncOpText.KIND_FILE, "原始资料/演示附件.bin", null, 1260000, 3))
        assertEquals("推送本机删除：页面「A」", SyncOpText.describePush(SyncOpText.KIND_DELETE, "Wiki/概念/A.md", null, 0, 0))
        assertEquals("推送本机改名「旧名」→「新名」", SyncOpText.describePush(SyncOpText.KIND_MOVE, "Wiki/实体/新名.md", "Wiki/概念/旧名.md", 0, 0))
    }

    @Test fun dataFieldsMatchServerKeys() {
        val data = SyncOpText.summarizePage("Wiki/概念/A.md", "# A\n\nx\n", "# A\n\nx\ny\n").let(SyncOpText::data)
        assertEquals("page", data["kind"])
        assertEquals("update", data["verb"])
        assertEquals("Wiki/概念/A.md", data["path"])
        assertEquals("A", data["title"])
        assertEquals(1, data["added"])
        assertEquals(0, data["removed"])
        assertEquals(7L, data["beforeBytes"])
        assertEquals(9L, data["afterBytes"])
    }

    @Test fun skipsSystemPagesAndUnchangedContent() {
        assertFalse(SyncOpText.isNoteworthy(SyncOpText.summarizePage("AIWorks/log/log.md", null, "# log\n")))
        assertFalse(SyncOpText.isNoteworthy(SyncOpText.summarizePage("Wiki/概念/A.md", "# A\n", "# A\n")))
        assertTrue(SyncOpText.isNoteworthy(SyncOpText.summarizePage("Wiki/概念/A.md", null, "# A\n")))
    }

    @Test fun skipsSystemPagesOnPushToo() {
        assertFalse(SyncOpText.isNoteworthyPush("AIWorks/index/index.md"))
        assertFalse(SyncOpText.isNoteworthyPush("Wiki/概念/A.md", "AIWorks/概念/A.md"))
        assertTrue(SyncOpText.isNoteworthyPush("Wiki/概念/A.md"))
        assertTrue(SyncOpText.isNoteworthyPush("原始资料/文档/附件-1.bin"))
    }

    @Test fun samplesChangedLinesWithGitDiffOrder() {
        // 同一处先删后增；前缀 `+ ` / `- `（与 server opText.ts 的采样格式一致）
        val (lines, omitted) = SyncOpText.diffSample("a\n旧\nc", "a\n新\nc")
        assertEquals(listOf("- 旧", "+ 新"), lines)
        assertEquals(0, omitted)
    }

    @Test fun sampleSkipsBlankLinesAndTruncatesLongOnes() {
        val long = "x".repeat(200)
        val (lines, omitted) = SyncOpText.diffSample("a\n", "a\n\n$long\n")
        // 空白行不占一行记录、也不算「没记下的改动」
        assertEquals(0, omitted)
        assertEquals(1, lines.size)
        assertTrue(lines[0].startsWith("+ x"))
        assertTrue(lines[0].endsWith("…"))
        assertEquals(SyncOpText.CHANGE_LINE_MAX + 3, lines[0].length)
    }

    @Test fun sampleIgnoresAppWrittenFrontmatter() {
        val before = "---\nid: abc\n创建日期: 2026-09-01\n标题: A\n---\n\n第一行\n"
        val after = before.replace("第一行", "第一行改了")
        val (lines, _) = SyncOpText.diffSample(SyncOpText.stripLeadingFrontmatter(before), SyncOpText.stripLeadingFrontmatter(after))
        assertEquals(listOf("- 第一行", "+ 第一行改了"), lines)
        // 正文逐字没变、只动了文件头时回退看整篇，不能让条目「+1 行」却一行改动都不显示
        val headerOnly = SyncOpText.summarizePage("Wiki/概念/A.md", before, before.replace("id: abc", "id: xyz"))
        assertTrue((headerOnly.changes ?: emptyList()).isNotEmpty())
    }

    @Test fun summarizePageCarriesChangesAndDataKey() {
        val item = SyncOpText.summarizePage("Wiki/概念/A.md", "# A\n\nx\n", "# A\n\nx\ny\n")
        assertEquals(listOf("+ y"), item.changes)
        val data = SyncOpText.data(item)
        assertEquals(listOf("+ y"), data["changes"])
    }

    @Test fun flattensChangeLinesWithPathHeaderAndBudget() {
        val first = SyncOpText.summarizePage("Wiki/概念/A.md", "# A\n", "# A\nx\n")
        val second = SyncOpText.summarizePage("Wiki/概念/B.md", "# B\n", "# B\ny\n")
        val flat = SyncOpText.flattenChangeLines(listOf(first, second))!!
        // 多于一个文件时先写文件路径，再写该文件的改动行
        assertEquals(listOf("Wiki/概念/A.md", "+ x", "Wiki/概念/B.md", "+ y"), flat)

        val many = (1..40).map { SyncOpText.summarizePage("Wiki/概念/N$it.md", "# N\n", "# N\n第 $it 行\n") }
        val capped = SyncOpText.flattenChangeLines(many)!!
        assertTrue(capped.size <= SyncOpText.CHANGE_LOG_MAX_LINES)
        assertTrue(capped.last().startsWith("…（还有"))
        assertTrue(capped.joinToString("\n").length <= SyncOpText.CHANGE_LOG_MAX_CHARS + 40)
    }

    @Test fun describesMergedPushAndUnknownKind() {
        assertEquals(
            "页面「A」本端与中枢都有改动，已按中枢合并结果写回本端（合并后 +2 −1 行）",
            SyncOpText.describePushMerged("Wiki/概念/A.md", "A", 2, 1, 7, 9),
        )
        assertTrue(SyncOpText.describeUnknownKind("future-op").contains("future-op"))
    }
}
