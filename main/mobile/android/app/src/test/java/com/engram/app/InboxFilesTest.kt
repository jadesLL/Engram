package com.engram.app

import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class InboxFilesTest {
    @Test fun originalsExcludeProductsAndHiddenFilesAndSortNewestFirst() {
        val brain = Files.createTempDirectory("engram-inbox-test").toFile()
        try {
            val old = InboxFiles.resolve(brain, "收集箱/旧.txt").also { it.parentFile!!.mkdirs(); it.writeText("old"); it.setLastModified(1000) }
            val recent = InboxFiles.resolve(brain, "收集箱/子目录/新.pdf").also { it.parentFile!!.mkdirs(); it.writeText("pdf"); it.setLastModified(2000) }
            InboxFiles.resolve(brain, "收集箱/转换结果/结果.md").also { it.parentFile!!.mkdirs(); it.writeText("derived") }
            InboxFiles.resolve(brain, "收集箱/.tmp").writeText("unfinished")
            assertEquals(listOf(recent, old), InboxFiles.originals(brain))
        } finally { brain.deleteRecursively() }
    }

    @Test fun sharedNamesStayInsideInboxAndNeverOverwrite() {
        val brain = Files.createTempDirectory("engram-inbox-name").toFile()
        try {
            val first = InboxFiles.uniquePath(brain, "../合同.pdf")
            assertEquals("收集箱/合同.pdf", first)
            InboxFiles.resolve(brain, first).also { it.parentFile!!.mkdirs(); it.writeText("first") }
            assertEquals("收集箱/合同-2.pdf", InboxFiles.uniquePath(brain, "合同.pdf"))
            assertEquals("first", InboxFiles.resolve(brain, first).readText())
            assertFalse(InboxFiles.cleanName(".hidden").startsWith('.'))
            assertTrue(InboxFiles.cleanName("字".repeat(200) + ".pdf").toByteArray().size < 255)
            assertTrue(InboxFiles.textName("网页标题").endsWith(".txt"))
        } finally { brain.deleteRecursively() }
    }

    @Test fun rejectsTraversalAndKnowledgePaths() {
        val brain = Files.createTempDirectory("engram-inbox-path").toFile()
        try {
            assertThrows(IllegalArgumentException::class.java) { InboxFiles.resolve(brain, "收集箱/../Wiki/secret.md") }
            assertThrows(IllegalArgumentException::class.java) { InboxFiles.resolve(brain, "Wiki/page.md") }
        } finally { brain.deleteRecursively() }
    }
}
