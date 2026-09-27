package com.engram.app

/**
 * 连接通道择优（Android 成员端）：局域网 → IPv6 → IPv4（都不通即「已断开」）。
 *
 * 与 desktop / Docker 端 server/src/sync/link.ts 同一套口径、同一组判定：中枢在
 * `/api/sync/announce` 里通告自己的内网地址，成员端把它并进候选（局域网优先），
 * 第一个通的作为当前通道；探不到局域网时必须与历史行为完全一致（退回「中枢地址 + 双栈选族」）。
 *
 * 纯函数、不依赖 Android 框架、不发请求，JVM 单测直接钉住候选排序、赢家与通道归类。
 */
object SyncLink {
    const val KIND_LAN = "lan"
    const val KIND_HUB = "hub"

    const val CHANNEL_LAN = "lan"
    const val CHANNEL_IPV6 = "ipv6"
    const val CHANNEL_IPV4 = "ipv4"
    const val CHANNEL_OFFLINE = "offline"

    private val SCHEME = Regex("^[a-zA-Z][a-zA-Z0-9+.\\-]*://")
    private val IPV4 = Regex("^\\d+\\.\\d+\\.\\d+\\.\\d+$")

    /** 一轮探测里的一个候选地址（顺序即优先级） */
    data class ProbeTarget(val kind: String, val label: String, val url: String)

    /** 单个候选的探测结果（设置页「候选探测明细」直接展示） */
    data class Candidate(
        val kind: String,
        val label: String,
        val url: String,
        val ok: Boolean,
        val latencyMs: Long?,
        val error: String? = null,
    )

    /** 去掉尾部斜杠（与中枢地址口径一致） */
    fun normalizeBase(url: String?): String = (url ?: "").trim().trimEnd('/')

    /** 展示用主机：带端口，IPv6 保留方括号 */
    fun hostPortOf(base: String?): String {
        val raw = normalizeBase(base)
        if (raw.isEmpty()) return ""
        return raw.replace(SCHEME, "").substringBefore('/')
    }

    /** 主机名部分（去掉端口与 IPv6 方括号），用于与双栈记账的键对齐 */
    fun hostnameOf(base: String?): String {
        val hostPort = hostPortOf(base)
        if (hostPort.isEmpty()) return ""
        if (hostPort.startsWith("[")) return hostPort.substringAfter('[').substringBefore(']')
        // 裸 IPv6（未加方括号）里冒号很多，不能再按 :port 切——切开后 classifyBase 会认不出它是内网 IPv6
        if (hostPort.count { it == ':' } > 1) return hostPort
        return hostPort.substringBefore(':')
    }

    /** 字面量 IP 的协议族；域名返回 null */
    fun ipFamilyOf(host: String?): Int? {
        val addr = (host ?: "").trim().split('%')[0]
        if (addr.isEmpty()) return null
        if (IPV4.matches(addr)) return 4
        if (addr.contains(':')) return 6
        return null
    }

    /** 链路本地地址：169.254/16 与 fe80::/10——能互访但需要 scope id，不作为局域网候选 */
    fun isLinkLocal(host: String?): Boolean {
        val addr = (host ?: "").trim().lowercase().split('%')[0]
        if (addr.startsWith("169.254.")) return true
        return Regex("^fe[89ab]").containsMatchIn(addr)
    }

    private fun isPrivateIpv4(addr: String): Boolean {
        val parts = addr.split('.').map { it.toIntOrNull() }
        if (parts.size != 4 || parts.any { it == null || it < 0 || it > 255 }) return false
        val (a, b) = parts[0]!! to parts[1]!!
        if (a == 10) return true
        if (a == 172 && b in 16..31) return true
        if (a == 192 && b == 168) return true
        return false
    }

    /** 本机/内网地址判定（局域网候选与「中枢地址本身就是内网」都靠它） */
    fun isPrivateHost(host: String?): Boolean {
        val addr = (host ?: "").trim().lowercase().split('%')[0]
        if (addr.isEmpty()) return false
        if (addr == "localhost" || addr.endsWith(".local")) return true
        if (IPV4.matches(addr)) return isPrivateIpv4(addr) || addr.startsWith("127.")
        if (addr == "::1") return true
        if (Regex("^f[cd][0-9a-f]{2}:").containsMatchIn(addr) || addr == "fc00::" || addr == "fd00::") return true
        return isLinkLocal(addr)
    }

    /**
     * 基地址本身给出的通道答案：内网字面量→lan，公网 IPv6/IPv4 字面量→对应协议族，
     * 域名→null（要等连上或拿到双栈记账才知道）。
     */
    fun classifyBase(base: String?): String? {
        val host = hostnameOf(base)
        if (host.isEmpty()) return null
        val family = ipFamilyOf(host)
        if (family == null) {
            val lower = host.lowercase()
            return if (lower == "localhost" || lower.endsWith(".local")) CHANNEL_LAN else null
        }
        if (isPrivateHost(host)) return CHANNEL_LAN
        return if (family == 6) CHANNEL_IPV6 else CHANNEL_IPV4
    }

    /**
     * 一轮探测的候选清单：局域网在前（仅在开启「优先局域网」时纳入），中枢主地址永远垫底——
     * 局域网探测失败必须还能回到原本那条路。
     */
    fun planProbes(hubBase: String?, announcedLan: List<String>, preferLan: Boolean): List<ProbeTarget> {
        val hub = normalizeBase(hubBase)
        val targets = mutableListOf<ProbeTarget>()
        val seen = mutableSetOf<String>()
        if (hub.isNotEmpty()) seen += hub
        if (preferLan) {
            for (raw in announcedLan) {
                val url = normalizeBase(raw)
                // 与主地址重复的不再单列：同一个地址探两次纯粹浪费一轮超时
                if (url.isEmpty() || url in seen || !Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(url)) continue
                seen += url
                targets += ProbeTarget(KIND_LAN, "局域网", url)
            }
        }
        if (hub.isNotEmpty()) targets += ProbeTarget(KIND_HUB, "中枢地址", hub)
        return targets
    }

    /** 赢家：开启「优先局域网」时先看局域网候选，通则用它；否则取第一个可达候选 */
    fun pickWinner(candidates: List<Candidate>, preferLan: Boolean): Candidate? {
        if (preferLan) {
            candidates.firstOrNull { it.kind == KIND_LAN && it.ok }?.let { return it }
        }
        return candidates.firstOrNull { it.ok }
    }

    /** 中枢通告的地址归一化：只留 http(s)、去重、去掉与主地址重复的 */
    fun normalizeAnnouncedLan(urls: List<String>, hubBase: String?): List<String> {
        val hub = normalizeBase(hubBase)
        val out = mutableListOf<String>()
        val seen = mutableSetOf<String>()
        for (raw in urls) {
            val url = normalizeBase(raw)
            if (url.isEmpty() || url == hub || url in seen) continue
            if (!Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(url)) continue
            seen += url
            out += url
        }
        return out
    }

    fun channelLabel(channel: String): String = when (channel) {
        CHANNEL_LAN -> "局域网直连"
        CHANNEL_IPV6 -> "IPv6 直连"
        CHANNEL_IPV4 -> "IPv4 直连"
        else -> "未连接"
    }
}
