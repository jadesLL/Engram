package com.engram.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class Merge3Test {
    @Test fun nonOverlappingChangesAreCombined() {
        val base = "第一段：Alpha\n\n第二段：Beta\n\n第三段：Gamma"
        val result = Merge3.merge(base, base.replace("Alpha", "Alpha-A"), base.replace("Gamma", "Gamma-B"))
        assertTrue(result.conflicts.isEmpty())
        assertTrue(result.content.contains("Alpha-A")); assertTrue(result.content.contains("Gamma-B"))
    }

    @Test fun sameChangeIsAppliedOnce() {
        val base = "标题：知识库\n正文内容"; val changed = base.replace("知识库", "Engram 知识库")
        assertEquals(changed, Merge3.merge(base, changed, changed).content)
    }

    @Test fun competingChangeKeepsOursAndRecordsTheirs() {
        val result = Merge3.merge("结论：待定", "结论：采纳方案 A", "结论：采纳方案 B")
        assertEquals("结论：采纳方案 A", result.content)
        assertEquals(1, result.conflicts.size); assertTrue(result.conflicts[0].contains("方案 B"))
    }

    @Test fun insertionsAtSamePointAreBothKept() {
        val result = Merge3.merge("开头结尾", "开头[甲]结尾", "开头[乙]结尾")
        assertTrue(result.conflicts.isEmpty()); assertTrue(result.content.contains("[甲]")); assertTrue(result.content.contains("[乙]"))
    }
}
