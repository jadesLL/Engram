package com.engram.app

/**
 * 「已提炼」标记的对齐计划（纯逻辑，JVM 单测直接钉边界）。
 *
 * 标记只存在于账本里、没有对应的同步 op：中枢那边每提炼一份新材料，标记就变一次，
 * 而成员端只有在拿到清单（或这份轻量标记清单）时才知道。这里只算「中枢有、本机没有」
 * 与「中枢没有、本机标着」两个差集——两边都排好序，便于日志与断言。
 */
object LedgerMarks {
    data class Plan(val add: List<String>, val clear: List<String>) {
        val changed: Boolean get() = add.isNotEmpty() || clear.isNotEmpty()
    }

    fun plan(hub: Set<String>, local: Set<String>): Plan =
        Plan((hub - local).sorted(), (local - hub).sorted())
}
