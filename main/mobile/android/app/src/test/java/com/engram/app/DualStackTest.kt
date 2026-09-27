package com.engram.app

import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ConnectException
import java.net.Inet6Address
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLHandshakeException

/**
 * 双栈策略回归（与 server/src/sync/dualStack.test.ts 同一套口径，两端行为必须一致）：
 *  - 纯策略：IPv6 优先 →（连续 3 次 / 累计 15 秒失败）切 IPv4 → IPv4 每成功 10 次回探一次
 *  - OkHttp：FamilyDns 只给出选定协议族的地址（所以「只用 IPv6」/「只用 IPv4」是真的）
 *  - 换族重试只在「连都没连上」时允许，传输途中出错一律不换
 */
class DualStackTest {
    private fun config(
        failureThreshold: Int = 3,
        failureWindowMs: Long = 15_000,
        probeAfterSuccesses: Int = 10,
    ) = DualStackConfig(
        enabled = true,
        failureThreshold = failureThreshold,
        failureWindowMs = failureWindowMs,
        probeAfterSuccesses = probeAfterSuccesses,
        connectTimeoutMs = 5_000,
    )

    @Test
    fun `默认口径就是用户确认过的标准值`() {
        assertEquals(true, DualStackConfig.DEFAULT.enabled)
        assertEquals(3, DualStackConfig.DEFAULT.failureThreshold)
        assertEquals(15_000L, DualStackConfig.DEFAULT.failureWindowMs)
        assertEquals(10, DualStackConfig.DEFAULT.probeAfterSuccesses)
        assertEquals(5_000, DualStackConfig.DEFAULT.connectTimeoutMs)
    }

    @Test
    fun `设置读取：缺省用默认值，越界收敛`() {
        assertEquals(DualStackConfig.DEFAULT, DualStackConfig.fromSettings { null })

        val stored = mapOf(
            DualStackConfig.KEY_ENABLED to "0",
            DualStackConfig.KEY_FAILURES to "99",
            DualStackConfig.KEY_WINDOW_MS to "10",
            DualStackConfig.KEY_PROBE_AFTER to "0",
            DualStackConfig.KEY_CONNECT_TIMEOUT_MS to "999999",
        )
        val parsed = DualStackConfig.fromSettings { key -> stored[key] }
        assertEquals(false, parsed.enabled)
        assertEquals(20, parsed.failureThreshold)
        assertEquals(1_000L, parsed.failureWindowMs)
        assertEquals(1, parsed.probeAfterSuccesses)
        assertEquals(30_000, parsed.connectTimeoutMs)
    }

    @Test
    fun `IPv6 优先阶段：先 IPv6，同一个请求内用 IPv4 兜底`() {
        val plan = DualStack.plan(HostFamilyState(), hasIpv6 = true, hasIpv4 = true, bodyless = true)
        assertEquals(listOf(6, 4), plan.map { it.family })
        assertEquals(listOf(false, false), plan.map { it.probe })
    }

    @Test
    fun `单栈域名：没得选，直接用存在的那一族`() {
        assertEquals(listOf(4), DualStack.plan(HostFamilyState(), false, true, true).map { it.family })
        assertEquals(listOf(6), DualStack.plan(HostFamilyState(), true, false, true).map { it.family })
    }

    @Test
    fun `单栈域名：状态校准到实际那一族，界面不会假装在走 IPv6`() {
        val state = HostFamilyState()
        assertTrue(DualStack.alignSingleStack(state, hasIpv6 = false, hasIpv4 = true))
        assertEquals(4, state.family)
        assertEquals("域名只有 IPv4 记录", state.reason)
        // 已校准过的再调一次不再改状态（否则每个请求都会把计数清零）
        assertTrue(!DualStack.alignSingleStack(state, hasIpv6 = false, hasIpv4 = true))

        val v6Only = HostFamilyState()
        assertTrue(DualStack.alignSingleStack(v6Only, hasIpv6 = true, hasIpv4 = false))
        assertEquals(6, v6Only.family)
        assertEquals("域名只有 IPv6 记录", v6Only.reason)

        val both = HostFamilyState()
        assertTrue(!DualStack.alignSingleStack(both, hasIpv6 = true, hasIpv4 = true))
        assertNull(both.reason)

        // DDNS 补上另一族记录后：从「只有 IPv4」回到正常的 IPv6 优先
        val upgraded = HostFamilyState()
        DualStack.alignSingleStack(upgraded, hasIpv6 = false, hasIpv4 = true)
        assertEquals(4, upgraded.family)
        assertTrue(DualStack.alignSingleStack(upgraded, hasIpv6 = true, hasIpv4 = true))
        assertEquals(6, upgraded.family)
        assertNull(upgraded.reason)
    }

    @Test
    fun `IPv4 阶段：默认只用 IPv4，攒够成功次数且无请求体时才回探`() {
        val state = HostFamilyState().apply {
            family = 4
            ipv4Successes = 9
        }
        assertEquals(listOf(4), DualStack.plan(state, true, true, true).map { it.family })

        state.probePending = true
        // 带请求体的请求不消耗回探：大文件上传不该先送给 IPv6 再重传
        assertEquals(listOf(4), DualStack.plan(state, true, true, false).map { it.family })
        val withProbe = DualStack.plan(state, true, true, true)
        assertEquals(listOf(6, 4), withProbe.map { it.family })
        assertEquals(listOf(true, false), withProbe.map { it.probe })
    }

    @Test
    fun `连续失败到阈值：切 IPv4 并给出可读日志`() {
        val state = HostFamilyState()
        val cfg = config()
        assertNull(DualStack.record(cfg, state, 6, ok = false, elapsedMs = 100))
        assertNull(DualStack.record(cfg, state, 6, ok = false, elapsedMs = 100))
        val event = DualStack.record(cfg, state, 6, ok = false, elapsedMs = 100)
        assertNotNull(event)
        assertEquals("dualstack-ipv4-fallback", event!!.event)
        assertEquals("warn", event.level)
        assertTrue(event.detail.contains("连续失败 3 次"))
        assertEquals(4, state.family)
        assertEquals(0, state.consecutiveFailures)
        assertEquals(0L, state.failureMs)
    }

    @Test
    fun `次数没到但累计卡住超过阈值：同样切 IPv4`() {
        val state = HostFamilyState()
        val cfg = config()
        assertNull(DualStack.record(cfg, state, 6, ok = false, elapsedMs = 8_000))
        val event = DualStack.record(cfg, state, 6, ok = false, elapsedMs = 8_000)
        assertNotNull(event)
        assertTrue(event!!.detail.contains("累计卡住 16 秒"))
        assertEquals(4, state.family)
    }

    @Test
    fun `IPv6 中途成功一次即清零连续失败计数`() {
        val state = HostFamilyState()
        val cfg = config()
        DualStack.record(cfg, state, 6, ok = false, elapsedMs = 1_000)
        DualStack.record(cfg, state, 6, ok = false, elapsedMs = 1_000)
        assertNull(DualStack.record(cfg, state, 6, ok = true, elapsedMs = 0))
        assertEquals(0, state.consecutiveFailures)
        assertEquals(0L, state.failureMs)
        assertNull(DualStack.record(cfg, state, 6, ok = false, elapsedMs = 1_000))
        assertEquals(6, state.family)
    }

    @Test
    fun `IPv4 每成功 N 次排一次回探`() {
        val state = HostFamilyState().apply { family = 4 }
        val cfg = config(probeAfterSuccesses = 3)
        DualStack.record(cfg, state, 4, ok = true, elapsedMs = 0)
        DualStack.record(cfg, state, 4, ok = true, elapsedMs = 0)
        assertEquals(false, state.probePending)
        DualStack.record(cfg, state, 4, ok = true, elapsedMs = 0)
        assertEquals(true, state.probePending)
        assertEquals(0, state.ipv4Successes)
    }

    @Test
    fun `回探失败继续 IPv4；回探成功切回 IPv6 优先`() {
        val state = HostFamilyState().apply {
            family = 4
            probePending = true
        }
        val cfg = config()

        val failed = DualStack.record(cfg, state, 6, ok = false, elapsedMs = 200)
        assertEquals("dualstack-probe-failed", failed!!.event)
        assertEquals(4, state.family)
        assertEquals(false, state.probePending)

        state.probePending = true
        val recovered = DualStack.record(cfg, state, 6, ok = true, elapsedMs = 0, now = 1_700_000_000_000)
        assertEquals("dualstack-ipv6-recovered", recovered!!.event)
        assertEquals(6, state.family)
        assertEquals(1_700_000_000_000L, state.switchedAt)
    }

    @Test
    fun `域名状态按域名分桶，可清空重来`() {
        DualStack.reset()
        DualStack.record(config(), DualStack.state("hub.test"), 6, ok = false, elapsedMs = 5_000)
        DualStack.record(config(), DualStack.state("other.test"), 4, ok = true, elapsedMs = 0)

        val hub = DualStack.status().single { it.host == "hub.test" }
        assertEquals(6, hub.family)
        assertEquals("IPv6", hub.familyLabel)
        assertEquals(1, hub.consecutiveFailures)
        assertEquals(listOf("hub.test", "other.test"), DualStack.status().map { it.host })

        DualStack.reset()
        assertTrue(DualStack.status().isEmpty())
    }

    @Test
    fun `FamilyDns 只给出选定协议族的地址`() {
        val v4Only = FamilyDns(4).lookup("127.0.0.1")
        assertTrue(v4Only.all { it is java.net.Inet4Address })

        val v6 = InetAddress.getAllByName("::1")
        assertTrue(v6.any { it is Inet6Address })
        assertTrue(v6.none { FamilyDns.isFamily(it, 4) })
    }

    @Test
    fun `FamilyDns 解析不到该族地址时按域名不可用抛出`() {
        try {
            FamilyDns(6).lookup("127.0.0.1")
            throw AssertionError("解析不出 IPv6 地址时应当抛 UnknownHostException")
        } catch (expected: UnknownHostException) {
            assertTrue(expected.message!!.contains("IPv6"))
        }
    }

    @Test
    fun `OkHttp 真的按协议族建连：IPv6 客户端不会退化成 IPv4`() {
        // 用项目已有的 Ktor（本地服务同款）起一个真 HTTP 端点，域名交给自定义 Dns 解析：
        // 验证的是「FamilyDns 过滤后的地址列表真的决定了 OkHttp 连到哪一族」
        val loopbackV4 = InetAddress.getByName("127.0.0.1")
        val server = embeddedServer(CIO, port = 0, host = "127.0.0.1") {
            routing {
                get("/health") { call.respondText("ok") }
            }
        }
        server.start(wait = false)
        val port = runBlocking { server.engine.resolvedConnectors().first().port }
        // 域名必须不是 IP 字面量：OkHttp 对字面量不查 Dns（直连本来就只有一族）
        val url = "http://engram.test:$port/health"
        try {
            // 域名同时有 A/AAAA 时：IPv4 客户端拿到 127.0.0.1 → 连上
            val v4 = OkHttpClient.Builder().dns(FamilyDns(4) { listOf(loopbackV4) }).build()
            v4.newCall(Request.Builder().url(url).build()).execute().use { response ->
                assertEquals(200, response.code)
                assertEquals("ok", response.body!!.string())
            }

            // 只给 IPv6：127.0.0.1 不是 IPv6 地址 → 域名直接算不可用，绝不能偷偷退回 IPv4
            val v6 = OkHttpClient.Builder().dns(FamilyDns(6) { listOf(loopbackV4) }).build()
            try {
                v6.newCall(Request.Builder().url(url).build()).execute().close()
                throw AssertionError("只给 IPv6 地址时不该连上纯 IPv4 目标")
            } catch (expected: UnknownHostException) {
                assertTrue(expected.message!!.contains("IPv6"))
            }
        } finally {
            server.stop(200, 500)
        }
    }

    @Test
    fun `只有连都没连上才算可换族的失败`() {
        assertTrue(isConnectFailure(ConnectException("Connection refused")))
        assertTrue(isConnectFailure(UnknownHostException("没有可用的 IPv6 地址")))
        assertTrue(isConnectFailure(java.net.SocketTimeoutException("connect timed out")))
        assertTrue(isConnectFailure(SSLHandshakeException("handshake failed")))
        // 读超时／传输途中断流不换族：用户明确要求不在传输过程中切
        assertTrue(!isConnectFailure(java.net.SocketTimeoutException("Read timed out")))
        assertTrue(!isConnectFailure(java.io.IOException("unexpected end of stream")))
    }
}
