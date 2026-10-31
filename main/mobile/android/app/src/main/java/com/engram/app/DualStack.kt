package com.engram.app

import okhttp3.Dns
import java.net.ConnectException
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.NoRouteToHostException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.SSLException

/**
 * 同步链路双栈策略（与服务端 server/src/sync/dualStack.ts 同一套口径，两端行为必须一致）：
 * IPv6 优先 → 失败切 IPv4 → IPv4 期间定期回探 IPv6。
 *
 *  1. 默认按 IPv6 地址建连（中枢域名同时有 A/AAAA 时）；
 *  2. IPv6 连续失败 failureThreshold 次、或累计卡住 failureWindowMs 毫秒 → 改用 IPv4，
 *     此后不再每个请求先撞一次 IPv6；
 *  3. 在 IPv4 上每成功 probeAfterSuccesses 次，下一次**不带请求体**的请求顺带回探一次 IPv6：
 *     通了切回 IPv6 优先，不通继续用 IPv4（只试一次）。
 *
 * 「不在传输途中切换」：协议族只在建连那一刻选定，一次请求（含大文件上传／下载）全程走
 * 同一条连接；回探只挂在下一个请求的起点上。回探也只挑无请求体的请求，避免把一次大文件
 * 上传先送给 IPv6 再重传。
 */
data class DualStackConfig(
    val enabled: Boolean = true,
    /** IPv6 连续失败多少次后改用 IPv4 */
    val failureThreshold: Int = 3,
    /** IPv6 累计卡住多少毫秒后改用 IPv4（与次数任一满足即切换） */
    val failureWindowMs: Long = 15_000,
    /** IPv4 上每成功多少次回探一次 IPv6 */
    val probeAfterSuccesses: Int = 10,
    /** 单次连接尝试的超时（毫秒） */
    val connectTimeoutMs: Int = 5_000,
) {
    companion object {
        const val KEY_ENABLED = "sync_dualstack_enabled"
        const val KEY_FAILURES = "sync_dualstack_failures"
        const val KEY_WINDOW_MS = "sync_dualstack_window_ms"
        const val KEY_PROBE_AFTER = "sync_dualstack_probe_after"
        const val KEY_CONNECT_TIMEOUT_MS = "sync_dualstack_connect_timeout_ms"

        /** 用户确认过的默认口径：3 次 / 15 秒切 IPv4，IPv4 每成功 10 次回探一次 */
        val DEFAULT = DualStackConfig()

        private fun clampInt(raw: String?, min: Int, max: Int, fallback: Int): Int {
            val value = raw?.trim()?.toIntOrNull() ?: return fallback
            return value.coerceIn(min, max)
        }

        private fun clampLong(raw: String?, min: Long, max: Long, fallback: Long): Long {
            val value = raw?.trim()?.toLongOrNull() ?: return fallback
            return value.coerceIn(min, max)
        }

        /** 从设置表读（没存过就是默认口径）；越界值收敛，避免 UI 传进 0 或天文数字 */
        fun fromSettings(read: (String) -> String?): DualStackConfig = DualStackConfig(
            // 只有显式存过 "0" 才算关闭：老库没有这个键，默认开启
            enabled = read(KEY_ENABLED) != "0",
            failureThreshold = clampInt(read(KEY_FAILURES), 1, 20, DEFAULT.failureThreshold),
            failureWindowMs = clampLong(read(KEY_WINDOW_MS), 1_000, 120_000, DEFAULT.failureWindowMs),
            probeAfterSuccesses = clampInt(read(KEY_PROBE_AFTER), 1, 1_000, DEFAULT.probeAfterSuccesses),
            connectTimeoutMs = clampInt(read(KEY_CONNECT_TIMEOUT_MS), 500, 30_000, DEFAULT.connectTimeoutMs),
        )

        fun familyLabel(family: Int): String = if (family == 6) "IPv6" else "IPv4"
    }
}

/** 本次请求按什么顺序试哪个协议族 */
data class PlannedAttempt(val family: Int, val probe: Boolean)

/** 每个中枢域名一份协议族记账 */
data class HostFamilyState(
    /** 6 = 正在用 IPv6（优先）；4 = 已切到 IPv4 */
    var family: Int = 6,
    var consecutiveFailures: Int = 0,
    var failureMs: Long = 0,
    var ipv4Successes: Int = 0,
    var probePending: Boolean = false,
    var switchedAt: Long? = null,
    var reason: String? = null,
)

data class HostFamilyStatus(
    val host: String,
    val family: Int,
    val familyLabel: String,
    val consecutiveFailures: Int,
    val failureMs: Long,
    val ipv4Successes: Int,
    val probePending: Boolean,
    val switchedAt: Long?,
    val reason: String?,
)

/** 需要写进同步日志的一条双栈事件 */
data class DualStackEvent(val level: String, val event: String, val detail: String)

/**
 * 双栈策略状态机。纯 JVM 逻辑（不碰 Android API／JSON），单测直接钉行为。
 * 记账按域名分桶，进程内长期有效：一次同步里学到「IPv6 不通」，下一次同步不必重新踩坑。
 */
object DualStack {
    private val hosts = ConcurrentHashMap<String, HostFamilyState>()

    fun reset() {
        hosts.clear()
    }

    fun state(host: String): HostFamilyState = hosts.computeIfAbsent(host) { HostFamilyState() }

    // 状态由同步线程与 4 个并发取数线程共同读写：加对象锁串行化，避免「晚到的 v6 失败」
    // 被误当成回探失败、把 ipv4Successes 清零而推迟回探。
    @Synchronized
    fun status(): List<HostFamilyStatus> = hosts.entries
        .sortedBy { it.key }
        .map { (host, state) ->
            HostFamilyStatus(
                host = host,
                family = state.family,
                familyLabel = DualStackConfig.familyLabel(state.family),
                consecutiveFailures = state.consecutiveFailures,
                failureMs = state.failureMs,
                ipv4Successes = state.ipv4Successes,
                probePending = state.probePending,
                switchedAt = state.switchedAt,
                reason = state.reason,
            )
        }

    /**
     * 把状态校准到「域名解析」+「本机网络」共同决定的那一族：
     *  - 本机当前网络没有 IPv6 出口（Wi-Fi 没下发 / VPN·代理只转发 IPv4 / 老蜂窝网络）：落到 IPv4，
     *    说明写「本机当前网络没有 IPv6 出口」——不能记成「IPv6 连不上」，否则用户会去查中枢和
     *    路由器 IPv6 入站，其实问题在本机有没有出口；
     *  - 单栈域名（只有 A 或只有 AAAA）没得选，直接用存在的那一族；
     *  - 之前记过的「单栈 / 本机没 IPv6」不再成立（DDNS 补上另一族 / 换到支持 IPv6 的网络）：
     *    清掉说明并重新按 IPv6 优先试一遍。换网络后的首次请求就走这条路，不必等 10 次成功后的回探。
     */
    @Synchronized
    fun alignSingleStack(
        state: HostFamilyState,
        hasIpv6: Boolean,
        hasIpv4: Boolean,
        deviceIpv6: Boolean = true,
    ): Boolean {
        if (hasIpv6 && hasIpv4) {
            if (!deviceIpv6) {
                if (state.family == 4 && state.reason == NO_DEVICE_IPV6_REASON) return false
                state.family = 4
                clearFailureState(state)
                state.switchedAt = null
                state.reason = NO_DEVICE_IPV6_REASON
                return true
            }
            val stale = state.reason == SINGLE_STACK_REASON[4] ||
                state.reason == SINGLE_STACK_REASON[6] ||
                state.reason == NO_DEVICE_IPV6_REASON
            if (!stale) return false
            state.family = 6
            clearFailureState(state)
            state.reason = null
            return true
        }
        val family = if (hasIpv4 || !deviceIpv6) 4 else 6
        val reason = if (!hasIpv4 && !deviceIpv6) NO_DEVICE_IPV6_REASON else SINGLE_STACK_REASON[family]!!
        if (state.family == family && state.reason == reason) return false
        state.family = family
        clearFailureState(state)
        state.reason = reason
        return true
    }

    private fun clearFailureState(state: HostFamilyState) {
        state.consecutiveFailures = 0
        state.failureMs = 0
        state.ipv4Successes = 0
        state.probePending = false
    }

    /** 本机当前网络没有 IPv6 出口（不是中枢域名的问题）：中继到界面时用户能照着排查 Wi-Fi / VPN */
    const val NO_DEVICE_IPV6_REASON = "本机当前网络没有 IPv6 出口"

    private val SINGLE_STACK_REASON = mapOf(4 to "域名只有 IPv4 记录", 6 to "域名只有 IPv6 记录")

    /**
     * 本次请求的协议族顺序：
     *  - 本机没有 IPv6 出口：能走 IPv4 就直接走 IPv4（不再白等 IPv6 连接超时）；域名只有 AAAA 时
     *    返回空列表——试也连不上，由调用方给出「本机当前网络没有 IPv6 出口，而中枢只解析出 IPv6」；
     *  - 单栈域名没得选，直接用存在的那一族；
     *  - IPv6 优先阶段：先 IPv6，同一请求内连不上立刻用 IPv4 兜底；
     *  - IPv4 阶段：只用 IPv4；攒够成功次数且本次不带 body 时先回探一次 IPv6。
     */
    @Synchronized
    fun plan(
        state: HostFamilyState,
        hasIpv6: Boolean,
        hasIpv4: Boolean,
        bodyless: Boolean,
        deviceIpv6: Boolean = true,
    ): List<PlannedAttempt> = when {
        !hasIpv4 -> if (deviceIpv6) listOf(PlannedAttempt(6, probe = false)) else emptyList()
        !hasIpv6 -> listOf(PlannedAttempt(4, probe = false))
        !deviceIpv6 -> listOf(PlannedAttempt(4, probe = false))
        state.family == 6 -> listOf(PlannedAttempt(6, probe = false), PlannedAttempt(4, probe = false))
        state.probePending && bodyless -> listOf(PlannedAttempt(6, probe = true), PlannedAttempt(4, probe = false))
        else -> listOf(PlannedAttempt(4, probe = false))
    }

    /** 记一次尝试结果；返回需要写进同步日志的事件（null = 不必记） */
    @Synchronized
    fun record(
        config: DualStackConfig,
        state: HostFamilyState,
        family: Int,
        ok: Boolean,
        elapsedMs: Long,
        now: Long = System.currentTimeMillis(),
    ): DualStackEvent? {
        if (family == 6 && ok) {
            val recovered = state.family == 4
            state.consecutiveFailures = 0
            state.failureMs = 0
            if (!recovered) return null
            state.family = 6
            state.probePending = false
            state.ipv4Successes = 0
            state.switchedAt = now
            state.reason = "回探成功，IPv6 已恢复"
            return DualStackEvent("info", "dualstack-ipv6-recovered", "回探成功：IPv6 已恢复，改回 IPv6 优先")
        }

        if (family == 6 && !ok) {
            if (state.family != 6) {
                // 回探失败：继续用 IPv4，攒够下一轮成功次数再试一次
                state.probePending = false
                state.ipv4Successes = 0
                state.reason = "回探失败，继续用 IPv4"
                return DualStackEvent(
                    "info",
                    "dualstack-probe-failed",
                    "回探 IPv6 仍未成功，继续使用 IPv4",
                )
            }
            state.consecutiveFailures += 1
            state.failureMs += elapsedMs.coerceAtLeast(0)
            val hitCount = state.consecutiveFailures >= config.failureThreshold
            val hitTime = state.failureMs >= config.failureWindowMs
            if (!hitCount && !hitTime) return null
            val failures = state.consecutiveFailures
            val wasted = state.failureMs
            state.family = 4
            state.probePending = false
            state.ipv4Successes = 0
            state.consecutiveFailures = 0
            state.failureMs = 0
            state.switchedAt = now
            state.reason = if (hitCount) "IPv6 连续失败 $failures 次" else "IPv6 累计卡住 ${wasted / 1000} 秒"
            return DualStackEvent(
                "warn",
                "dualstack-ipv4-fallback",
                "IPv6 连不上（${if (hitCount) "连续失败 $failures 次" else "累计卡住 ${wasted / 1000} 秒"}），已改用 IPv4；"
                    + "IPv4 用稳后会自动回探 IPv6，恢复即切回",
            )
        }

        if (family == 4 && ok && state.family == 4) {
            state.ipv4Successes += 1
            if (state.ipv4Successes < config.probeAfterSuccesses) return null
            state.ipv4Successes = 0
            state.probePending = true
            return null
        }

        // IPv4 自身的失败不改协议族：请求照常报错，由上层重试
        return null
    }
}

/**
 * 只喂选定协议族的地址：域名同时有 A/AAAA 时，这样才能真正「只用 IPv6」或「只用 IPv4」。
 * 地址不做固定（不缓存 IP）：家宽 IPv6 前缀会变，DDNS 更新后下次建连要能取到新地址。
 * OkHttp 对 IP 字面量不会走 Dns（直连即可，本来就只有一个协议族），所以这里只处理域名。
 */
class FamilyDns(
    private val family: Int,
    private val resolve: (String) -> List<InetAddress> = { InetAddress.getAllByName(it).toList() },
) : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        val wanted = resolve(hostname).filter { isFamily(it, family) }
        if (wanted.isEmpty()) {
            throw UnknownHostException("$hostname 没有可用的 ${DualStackConfig.familyLabel(family)} 地址")
        }
        return wanted
    }

    companion object {
        fun isFamily(address: InetAddress, family: Int): Boolean =
            if (family == 6) address is Inet6Address else address is Inet4Address
    }
}

/**
 * 只有「连都没连上」才允许换协议族重试：响应头都没拿到，说明这次尝试没产生任何副作用。
 * 传输途中出错（读超时、连接被重置、写到一半断了）一律不切——用户明确要求不在传输中换路。
 */
fun isConnectFailure(error: Throwable): Boolean {
    var current: Throwable? = error
    var depth = 0
    while (current != null && depth < 6) {
        when (current) {
            is UnknownHostException, is ConnectException, is NoRouteToHostException -> return true
            is SocketTimeoutException -> {
                val message = current.message.orEmpty().lowercase()
                if (message.contains("connect")) return true // OkHttp 的连接超时信息里带 connect
            }
            is SSLException -> return true // TLS 握手没成 = 还没发请求体
            is SocketException -> {
                val message = current.message.orEmpty().lowercase()
                if (message.contains("unreachable") || message.contains("refused")) return true
            }
        }
        current = current.cause
        depth += 1
    }
    return false
}
