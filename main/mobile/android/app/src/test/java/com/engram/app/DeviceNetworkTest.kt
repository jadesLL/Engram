package com.engram.app

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「本机当前网络有没有 IPv6 出口」的判定回归（纯逻辑，不碰 Android API）：
 * 只有全局 / ULA 地址算出口；链路本地（fe80::/10，需要 scope id）、回环、未指定地址都不算——
 * 它们连不到中枢，把它们当成「有 IPv6」会让双栈策略继续白等连接超时。
 */
class DeviceNetworkTest {
    @Test
    fun globalAndUlaIpv6CountAsOutlet() {
        assertTrue(DeviceNetwork.hasGlobalIpv6(listOf("2408:821b:5270:3500:2697:edff:fe2c:8bc1")))
        assertTrue(DeviceNetwork.hasGlobalIpv6(listOf("fd00::1")))
        assertTrue(DeviceNetwork.hasGlobalIpv6(listOf("fc12:3456::abcd")))
    }

    @Test
    fun linkLocalLoopbackAndIpv4DoNotCount() {
        assertTrue(!DeviceNetwork.hasGlobalIpv6(listOf("fe80::1%wlan0")))
        assertTrue(!DeviceNetwork.hasGlobalIpv6(listOf("::1")))
        assertTrue(!DeviceNetwork.hasGlobalIpv6(listOf("0:0:0:0:0:0:0:0")))
        assertTrue(!DeviceNetwork.hasGlobalIpv6(listOf("192.168.31.100", "10.0.2.2")))
        assertTrue(!DeviceNetwork.hasGlobalIpv6(emptyList()))
    }

    @Test
    fun oneUsableGlobalAddressIsEnough() {
        // 手机同时有 IPv4 与全局 IPv6：有出口（Wi-Fi 下发过 IPv6）
        assertTrue(DeviceNetwork.hasGlobalIpv6(listOf("192.168.31.100", "2408:8210:5405:e740::bcb")))
        // 只剩链路本地与 IPv4：没有出口（VPN 只转发 IPv4 时常见）
        assertTrue(!DeviceNetwork.hasGlobalIpv6(listOf("192.168.31.100", "fe80::a6ba:70ff:fe55:94a2%wlan0")))
    }
}
