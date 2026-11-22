package com.engram.app

/**
 * 增量补拉的裁剪规则（纯逻辑，JVM 单测）。
 *
 * 中枢回放按 op 逐条给，但同一份内容在一批里可能出现很多次（AIWorks 系统页几乎每条都变）：
 *  - compact 回放里的页面正文取的是**当前**内容，不是那条 op 当时的历史版本，所以同一路径
 *    只需应用最后一条；前面的只推进水位即可，省掉每条两次的正文 / 证据请求。
 *  - 文件 / 页面 op 带 hash：本机 hash 相同说明内容已经一致，不必再下载。
 *
 * 这两条都不改变最终状态：最后一条 op 的内容就是中枢当前状态，hash 相同则本地已是最新。
 */
object SyncReplayPolicy {
    /** 回放里只关心「哪条路径、什么类型、中枢给的 hash」，与 JSON 解耦，便于单测 */
    data class Op(val kind: String, val target: String, val hash: String = "")

    /** 同一路径（page / file）在批内只认最后一条；返回需要跳过内容应用、仅推进水位的下标 */
    fun superseded(ops: List<Op>): Set<Int> {
        val last = HashMap<String, Int>()
        ops.forEachIndexed { index, op ->
            if (isContent(op.kind)) last[key(op)] = index
        }
        val out = HashSet<Int>()
        ops.forEachIndexed { index, op ->
            if (isContent(op.kind) && last[key(op)] != index) out += index
        }
        return out
    }

    /** op 带 hash 且与本机一致：内容未变，跳过下载 / 应用 */
    fun unchanged(op: Op, localHash: String): Boolean =
        isContent(op.kind) && op.hash.isNotBlank() && op.hash == localHash

    private fun isContent(kind: String) = kind == "page" || kind == "file"

    private fun key(op: Op) = op.kind + ":" + op.target
}
