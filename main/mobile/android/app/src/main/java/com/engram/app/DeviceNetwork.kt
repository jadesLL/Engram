package com.engram.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import java.net.InetAddress
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 本机当前网络有没有可用的 IPv6 出口（Android 成员端）。
 *
 * 为什么需要它：双栈策略默认「先试 IPv6、连不上再降级」，但手机经常处在本机根本没有 IPv6 的网络——
 * 路由器没下发 IPv6、VPN / 代理只转发 IPv4、老蜂窝网络只有 IPv4。这种网络里每次同步都要先白等一个
 * 连接超时（3 次才算降级），界面还会如实写成「IPv6 连不上（连续失败 3 次）」：用户看到的是
 * 「安卓端连不上 IPv6」，实际是本机没有出口，问题不在中枢域名，也不在 IPv6 入站放行。
 *
 * 本类只回答两个问题：
 *  1. **本机现在有没有 IPv6 出口**（hasIpv6）：看默认网络的 LinkProperties 上有没有全局 / ULA 地址；
 *     链路本地（fe80::/10，需要 scope id）、回环、未指定地址都不算——它们连不到中枢。
 *  2. **网络是否切换过**（onChange）：Wi-Fi ↔ 蜂窝、开 / 关 VPN、路由器重新下发前缀都会触发。
 *     双栈状态按域名记在进程里，网络变了必须清掉重学——否则在「没有 IPv6 的网络」学到的
 *     「这个域名走 IPv4」会一直留着，换到有 IPv6 的网络后仍显示 IPv6 连不上（10 次成功才回探一次）。
 *
 * 判定逻辑（hasGlobalIpv6）是纯函数，JVM 单测直接钉住；Android API 只在 register/hasIpv6 里用。
 */
interface Ipv6Outlet {
    /** 当前默认网络是否有可用的 IPv6 出口（拿不到网络信息时按「有」处理，退回历史行为） */
    fun hasIpv6(): Boolean
}

class DeviceNetwork(
    context: Context,
    private val clock: () -> Long = System::currentTimeMillis,
) : Ipv6Outlet {
    /** 网络变化回调（由本地服务在构造完 SyncEngine 后接上，避免两个对象循环初始化） */
    @Volatile private var onChange: () -> Unit = {}
    private val manager = context.applicationContext
        .getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    private val registered = AtomicBoolean(false)
    @Volatile private var cached: Boolean? = null
    @Volatile private var lastSignature: String? = null
    @Volatile private var lastNotifiedAt = 0L
    private var callback: ConnectivityManager.NetworkCallback? = null

    /** 开始监听默认网络变化。幂等；同一实例不重复注册。 */
    fun register() {
        val cm = manager ?: return
        if (!registered.compareAndSet(false, true)) return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: android.net.Network) = notifyIfChanged()
            override fun onLost(network: android.net.Network) = notifyIfChanged()
            override fun onLinkPropertiesChanged(network: android.net.Network, linkProperties: android.net.LinkProperties) = notifyIfChanged()
            override fun onCapabilitiesChanged(network: android.net.Network, capabilities: NetworkCapabilities) = notifyIfChanged()
        }
        callback = cb
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                cm.registerDefaultNetworkCallback(cb)
            } else {
                // API 23：没有 registerDefaultNetworkCallback，用带 INTERNET 能力的请求近似
                cm.registerNetworkCallback(
                    NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(),
                    cb,
                )
            }
        }.onFailure { registered.set(false) }
    }

    fun unregister() {
        val cm = manager ?: return
        val cb = callback ?: return
        if (!registered.compareAndSet(true, false)) return
        runCatching { cm.unregisterNetworkCallback(cb) }
        callback = null
    }

    fun setListener(listener: () -> Unit) {
        onChange = listener
    }

    /** 重新核对当前网络（回前台时调一次，补上回调可能漏掉的变更；真有变化会触发 listener） */
    fun refresh() {
        notifyIfChanged()
    }

    override fun hasIpv6(): Boolean = cached ?: currentHasIpv6().also { cached = it }

    private fun notifyIfChanged() {
        val has = currentHasIpv6()
        cached = has
        val signature = "${manager?.activeNetwork}|$has"
        synchronized(this) {
            if (signature == lastSignature) return
            lastSignature = signature
        }
        val now = clock()
        // 连续回调（available + capabilities + linkProperties 往往一起来）只处理一次
        if (now - lastNotifiedAt < MIN_NOTIFY_INTERVAL_MS) return
        lastNotifiedAt = now
        runCatching { onChange() }
    }

    private fun currentHasIpv6(): Boolean {
        val cm = manager ?: return true
        val network = cm.activeNetwork ?: return false
        val properties = cm.getLinkProperties(network) ?: return false
        val addresses = properties.linkAddresses.mapNotNull { it.address?.hostAddress }
        return hasGlobalIpv6(addresses)
    }

    companion object {
        private const val MIN_NOTIFY_INTERVAL_MS = 2_000L

        /** 有没有可用的 IPv6 出口：全局 / ULA 地址算，链路本地、回环、未指定地址不算 */
        fun hasGlobalIpv6(hostAddresses: List<String>): Boolean = hostAddresses.any { raw ->
            val address = raw.substringBefore('%').trim()
            if (address.isEmpty() || !address.contains(':')) return@any false
            // 只解析字面量（不带冒号的不算），不会触发 DNS
            val parsed = runCatching { InetAddress.getByName(address) }.getOrNull() ?: return@any false
            !parsed.isLoopbackAddress && !parsed.isAnyLocalAddress && !parsed.isLinkLocalAddress
        }
    }
}
