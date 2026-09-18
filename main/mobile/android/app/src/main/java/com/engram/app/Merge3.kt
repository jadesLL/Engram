package com.engram.app

/** 与 server/src/sync/merge.ts 使用相同语义的字符级三方合并。 */
object Merge3 {
    data class Result(val content: String, val conflicts: List<String>)
    private data class Hunk(val start: Int, var end: Int, var text: String)
    private data class Op(val kind: Int, var text: String)
    private const val DELETE = -1
    private const val INSERT = 1
    private const val EQUAL = 0
    private const val MAX_EDIT_DISTANCE = 4000

    fun merge(base: String, ours: String, theirs: String): Result {
        val a = hunks(base, ours); val b = hunks(base, theirs)
        val conflicts = mutableListOf<String>(); val out = StringBuilder()
        var basePos = 0; var i = 0; var j = 0
        while (i < a.size || j < b.size) {
            val ha = a.getOrNull(i); val hb = b.getOrNull(j)
            if (ha != null && hb != null && interacts(ha, hb)) {
                if (ha == hb) {
                    out.append(base.substring(basePos, ha.start)).append(ha.text)
                    basePos = maxOf(ha.end, hb.end); i++; j++; continue
                }
                val start = minOf(ha.start, hb.start)
                var end = maxOf(ha.end, hb.end)
                val regionA = mutableListOf(ha); val texts = mutableListOf(hb.text); var extraB = 1
                while (true) {
                    var grew = false
                    while (i + regionA.size < a.size && a[i + regionA.size].start < end) {
                        val h = a[i + regionA.size]; regionA += h
                        if (h.end > end) { end = h.end; grew = true }
                    }
                    while (j + extraB < b.size && b[j + extraB].start < end) {
                        val h = b[j + extraB]; texts += h.text
                        if (h.end > end) { end = h.end; grew = true }; extraB++
                    }
                    if (!grew) break
                }
                out.append(base.substring(basePos, start)).append(mapToOurs(ours, a, start, end))
                conflicts += texts; basePos = end; i += regionA.size; j += extraB; continue
            }
            if (ha != null && hb != null && ha.start == hb.start) {
                out.append(base.substring(basePos, ha.start)).append(if (ha.end == hb.end && ha.text == hb.text) ha.text else ha.text + hb.text)
                basePos = maxOf(ha.end, hb.end); i++; j++; continue
            }
            if (ha != null && (hb == null || ha.start <= hb.start)) {
                out.append(base.substring(basePos, ha.start)).append(ha.text); basePos = ha.end; i++
            } else if (hb != null) {
                out.append(base.substring(basePos, hb.start)).append(hb.text); basePos = hb.end; j++
            }
        }
        out.append(base.substring(basePos))
        return Result(out.toString(), conflicts)
    }

    private fun hunks(base: String, text: String): List<Hunk> {
        val result = mutableListOf<Hunk>(); var basePos = 0; var current: Hunk? = null
        for (op in diffChars(base, text)) when (op.kind) {
            EQUAL -> { current = null; basePos += op.text.length }
            DELETE -> { if (current == null) Hunk(basePos, basePos, "").also { current = it; result += it }; current!!.end += op.text.length; basePos += op.text.length }
            INSERT -> { if (current == null) Hunk(basePos, basePos, "").also { current = it; result += it }; current!!.text += op.text }
        }
        return result
    }

    private fun diffChars(a: String, b: String): List<Op> {
        if (a == b) return listOf(Op(EQUAL, a))
        var suffix = 0
        while (suffix < minOf(a.length, b.length) && a[a.length - 1 - suffix] == b[b.length - 1 - suffix]) suffix++
        var prefix = 0
        while (prefix < minOf(a.length, b.length) - suffix && a[prefix] == b[prefix]) prefix++
        val midA = a.substring(prefix, a.length - suffix); val midB = b.substring(prefix, b.length - suffix)
        val middle = when {
            midA.isEmpty() && midB.isEmpty() -> mutableListOf()
            midA.isEmpty() -> mutableListOf(Op(INSERT, midB))
            midB.isEmpty() -> mutableListOf(Op(DELETE, midA))
            else -> myers(midA, midB) ?: mutableListOf(Op(DELETE, midA), Op(INSERT, midB))
        }
        val out = mutableListOf<Op>()
        if (prefix > 0) out += Op(EQUAL, a.substring(0, prefix))
        out += middle
        if (suffix > 0) out += Op(EQUAL, a.substring(a.length - suffix))
        return coalesce(out)
    }

    private fun myers(a: String, b: String): MutableList<Op>? {
        val n = a.length; val m = b.length; val max = n + m
        if (max > MAX_EDIT_DISTANCE * 2) return null
        val offset = max; val v = IntArray(2 * max + 2); val trace = mutableListOf<IntArray>(); var found = -1
        for (d in 0..max) {
            trace += v.copyOf()
            var k = -d
            while (k <= d) {
                var x = if (k == -d || (k != d && v[offset + k - 1] < v[offset + k + 1])) v[offset + k + 1] else v[offset + k - 1] + 1
                var y = x - k
                while (x < n && y < m && a[x] == b[y]) { x++; y++ }
                v[offset + k] = x
                if (x >= n && y >= m) { found = d; break }
                k += 2
            }
            if (found >= 0) break
        }
        if (found < 0) return null
        val path = mutableListOf<Op>(); var x = n; var y = m
        for (d in found downTo 1) {
            val previous = trace[d]; val k = x - y
            val prevK = if (k == -d || (k != d && previous[offset + k - 1] < previous[offset + k + 1])) k + 1 else k - 1
            val prevX = previous[offset + prevK]; val prevY = prevX - prevK
            while (x > prevX && y > prevY) { prepend(path, EQUAL, a[x - 1].toString()); x--; y-- }
            if (prevK == k + 1) { prepend(path, INSERT, b[y - 1].toString()); y-- }
            else { prepend(path, DELETE, a[x - 1].toString()); x-- }
            while (x > prevX && y > prevY) { prepend(path, EQUAL, a[x - 1].toString()); x--; y-- }
        }
        if (x > 0 && y > 0) prepend(path, EQUAL, a.substring(0, x))
        return coalesce(path).toMutableList()
    }

    private fun prepend(path: MutableList<Op>, kind: Int, text: String) {
        if (path.firstOrNull()?.kind == kind) path[0].text = text + path[0].text else path.add(0, Op(kind, text))
    }
    private fun coalesce(path: List<Op>): List<Op> {
        val out = mutableListOf<Op>()
        for (op in path) if (op.text.isNotEmpty()) {
            if (out.lastOrNull()?.kind == op.kind) out.last().text += op.text else out += Op(op.kind, op.text)
        }
        return out
    }
    private fun mapToOurs(ours: String, changes: List<Hunk>, start: Int, end: Int): String {
        fun offsetAt(point: Int): Int {
            var offset = 0
            for (h in changes) if (h.end <= point) offset += h.text.length - (h.end - h.start) else if (h.start < point) { offset += h.text.length - (h.end - h.start); break } else break
            return point + offset
        }
        return ours.substring(offsetAt(start), offsetAt(end))
    }
    private fun interacts(a: Hunk, b: Hunk): Boolean {
        if (a.start < b.end && b.start < a.end) return true
        val ap = a.start == a.end; val bp = b.start == b.end
        return (ap && !bp && b.start <= a.start && a.start <= b.end) || (bp && !ap && a.start <= b.start && b.start <= a.end)
    }
}
