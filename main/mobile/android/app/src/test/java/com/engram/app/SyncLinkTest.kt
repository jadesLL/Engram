package com.engram.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 连接通道择优的口径回归（Android 成员端）：
 * 与服务端 server/src/sync/link.ts + link.test.ts 同一套判定——候选排序、赢家、通道归类。
 * 这些值直接决定侧栏状态胶囊显示「局域网 / IPv6 / IPv4 / 已断开」，判错会让界面说谎。
 */
class SyncLinkTest {
    @Test fun plansLanBeforeHubAndKeepsHubLast() {
        val targets = SyncLink.planProbes(
            hubBase = "https://nas.example.com:18080",
            announcedLan = listOf("http://192.168.1.101:18080", "http://192.168.1.11:18080"),
            preferLan = true,
        )
        assertEquals(listOf("lan", "lan", "hub"), targets.map { it.kind })
        assertEquals("http://192.168.1.101:18080", targets[0].url)
        assertEquals("中枢地址", targets.last().label)
    }

    @Test fun skipsLanCandidatesWhenPreferLanOff() {
        val targets = SyncLink.planProbes("http://192.168.1.101:18080", listOf("http://192.168.1.101:18080"), false)
        assertEquals(1, targets.size)
        assertEquals("hub", targets[0].kind)
    }

    @Test fun dropsDuplicateAndNonHttpAnnouncements() {
        val targets = SyncLink.planProbes(
            hubBase = "http://192.168.1.101:18080/",
            announcedLan = listOf("http://192.168.1.101:18080", "ftp://192.168.1.9", "", "http://192.168.1.11:18080/"),
            preferLan = true,
        )
        // 与主地址重复的不再单列；非 http 的通告地址直接丢掉；尾部斜杠归一化；局域网候选仍在主地址之前
        assertEquals(listOf("http://192.168.1.11:18080", "http://192.168.1.101:18080"), targets.map { it.url })
    }

    @Test fun picksLanWinnerOnlyWhenPreferred() {
        val candidates = listOf(
            SyncLink.Candidate("lan", "局域网", "http://192.168.1.101:18080", true, 12),
            SyncLink.Candidate("hub", "中枢地址", "https://nas.example.com:18080", true, 80),
        )
        assertEquals("lan", SyncLink.pickWinner(candidates, true)?.kind)
        assertEquals("lan", SyncLink.pickWinner(candidates, false)?.kind)
        val lanDown = listOf(
            SyncLink.Candidate("lan", "局域网", "http://192.168.1.101:18080", false, null, "连不上"),
            SyncLink.Candidate("hub", "中枢地址", "https://nas.example.com:18080", true, 80),
        )
        assertEquals("hub", SyncLink.pickWinner(lanDown, true)?.kind)
        assertNull(SyncLink.pickWinner(lanDown.filter { !it.ok }, true))
    }

    @Test fun classifiesBaseAddressIntoChannel() {
        assertEquals("lan", SyncLink.classifyBase("http://192.168.1.101:18080"))
        assertEquals("lan", SyncLink.classifyBase("http://127.0.0.1:18080"))
        assertEquals("lan", SyncLink.classifyBase("http://localhost:18080"))
        assertEquals("lan", SyncLink.classifyBase("http://[fd00::1]:18080"))
        assertEquals("ipv6", SyncLink.classifyBase("http://[2400:3200::1]:18080"))
        assertEquals("ipv4", SyncLink.classifyBase("http://8.8.8.8:18080"))
        assertNull(SyncLink.classifyBase("https://nas.example.com:18080"))
    }

    @Test fun keepsIpv6BracketsInHostPort() {
        assertEquals("[fd00::1]:18080", SyncLink.hostPortOf("http://[fd00::1]:18080/media"))
        assertEquals("fd00::1", SyncLink.hostnameOf("http://[fd00::1]:18080"))
        // 未加方括号的裸 IPv6：保留整串（不能按 :port 切），否则 classifyBase 会认不出它是内网 IPv6
        assertEquals("fd00::1:18080", SyncLink.hostnameOf("http://fd00::1:18080"))
        assertEquals("nas.example.com", SyncLink.hostnameOf("https://nas.example.com:18080/"))
    }

    @Test fun normalizesAnnouncedLanAgainstHub() {
        val lan = SyncLink.normalizeAnnouncedLan(
            listOf("http://192.168.1.101:18080", "http://192.168.1.101:18080", "https://nas.example.com:18080", "not a url"),
            "https://nas.example.com:18080",
        )
        assertEquals(listOf("http://192.168.1.101:18080"), lan)
    }

    @Test fun detectsLinkLocalAndPrivateHosts() {
        assertTrue(SyncLink.isLinkLocal("fe80::1"))
        assertTrue(SyncLink.isLinkLocal("169.254.10.1"))
        assertTrue(SyncLink.isPrivateHost("10.1.2.3"))
        assertTrue(SyncLink.isPrivateHost("172.16.5.4"))
        assertTrue(SyncLink.isPrivateHost("192.168.9.9"))
        assertTrue(SyncLink.isPrivateHost("fc00::1"))
        assertTrue(!SyncLink.isPrivateHost("8.8.8.8"))
        assertTrue(!SyncLink.isPrivateHost("2400:3200::1"))
    }

    @Test fun labelsChannelsInHumanWords() {
        assertEquals("局域网直连", SyncLink.channelLabel("lan"))
        assertEquals("IPv6 直连", SyncLink.channelLabel("ipv6"))
        assertEquals("IPv4 直连", SyncLink.channelLabel("ipv4"))
        assertEquals("未连接", SyncLink.channelLabel("offline"))
    }
}
