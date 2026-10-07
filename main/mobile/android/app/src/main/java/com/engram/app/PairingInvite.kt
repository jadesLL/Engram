package com.engram.app

import java.net.URI
import java.net.URLDecoder

/** 与桌面/服务端 engram://join 契约一致；不将令牌写入日志。 */
data class PairingInvite(val hubUrl: String, val token: String) {
    companion object {
        fun parse(raw: String): PairingInvite? = runCatching {
            require(raw.length <= 2048)
            val text = Regex("engram://join\\?[^\\s\"'<>“”（）()【】]+", RegexOption.IGNORE_CASE).find(raw.trim())?.value
                ?: return null
            val link = URI(text)
            require(link.rawUserInfo == null && link.port == -1 && link.path.isNullOrEmpty())
            val params = link.rawQuery.split('&').associate { field ->
                val pair = field.split('=', limit = 2)
                URLDecoder.decode(pair[0], "UTF-8") to URLDecoder.decode(pair.getOrElse(1) { "" }, "UTF-8")
            }
            val hub = URI(params["hub"].orEmpty())
            require(hub.scheme in listOf("http", "https") && !hub.host.isNullOrBlank() && hub.rawUserInfo == null)
            val token = params["token"].orEmpty()
            require(Regex("^[A-Za-z0-9._~+/=-]{6,200}$").matches(token))
            PairingInvite("${hub.scheme}://${hub.rawAuthority}${hub.rawPath.orEmpty().trimEnd('/')}", token)
        }.getOrNull()
    }
}
