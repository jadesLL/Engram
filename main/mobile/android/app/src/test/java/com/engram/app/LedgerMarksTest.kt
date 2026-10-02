package com.engram.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「已提炼」标记对齐的边界：手机端只在前台事件里同步，标记又没有同步 op，
 * 所以这份差集算错的表现就是「电脑上标了、手机上不标」或反过来把标记撤光。
 */
class LedgerMarksTest {
    @Test fun addsMarksTheHubHasAndThisDeviceDoesNot() {
        val plan = LedgerMarks.plan(
            hub = setOf("原始资料/文档/甲.md", "原始资料/文档/乙.txt"),
            local = setOf("原始资料/文档/甲.md"),
        )
        assertEquals(listOf("原始资料/文档/乙.txt"), plan.add)
        assertTrue(plan.clear.isEmpty())
        assertTrue(plan.changed)
    }

    @Test fun clearsMarksTheHubNoLongerHas() {
        val plan = LedgerMarks.plan(
            hub = emptySet(),
            local = setOf("原始资料/文档/甲.md"),
        )
        assertEquals(listOf("原始资料/文档/甲.md"), plan.clear)
        assertTrue(plan.add.isEmpty())
        assertTrue(plan.changed)
    }

    @Test fun keepsBothDirectionsInOnePassAndSortsThem() {
        val plan = LedgerMarks.plan(
            hub = setOf("原始资料/文档/丙.md", "原始资料/文档/甲.md"),
            local = setOf("原始资料/文档/乙.md", "原始资料/文档/丁.md"),
        )
        assertEquals(listOf("原始资料/文档/丙.md", "原始资料/文档/甲.md").sorted(), plan.add)
        assertEquals(listOf("原始资料/文档/乙.md", "原始资料/文档/丁.md").sorted(), plan.clear)
    }

    @Test fun reportsNoChangeWhenBothSidesAgree() {
        val same = setOf("原始资料/文档/甲.md", "Wiki/概念/某页.md")
        val plan = LedgerMarks.plan(hub = same, local = same)
        assertFalse(plan.changed)
        assertTrue(plan.add.isEmpty() && plan.clear.isEmpty())
    }

    @Test fun emptyHubAndEmptyLocalIsNotAChange() {
        val plan = LedgerMarks.plan(emptySet(), emptySet())
        assertFalse(plan.changed)
    }
}
