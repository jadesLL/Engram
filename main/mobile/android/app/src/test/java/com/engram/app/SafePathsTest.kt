package com.engram.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.File

class SafePathsTest {
    private val root = File(System.getProperty("java.io.tmpdir"), "engram-safe-path-test")

    @Test fun acceptsNormalizedRelativePath() {
        assertEquals(File(root, "Wiki/概念/页面.md").canonicalFile, SafePaths.resolve(root, "Wiki\\概念/页面.md"))
    }

    @Test fun rejectsTraversalAndEmptySegments() {
        assertThrows(IllegalArgumentException::class.java) { SafePaths.resolve(root, "../secret") }
        assertThrows(IllegalArgumentException::class.java) { SafePaths.resolve(root, "Wiki//page.md") }
    }
}
