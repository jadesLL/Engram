package com.engram.app

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL
import java.nio.charset.Charset
import java.nio.charset.StandardCharsets

/**
 * 分享进来的网页链接：在手机上当场抓 HTML 原件，并按页面标题命名。
 *
 * 背景（2026-11 用户报障）：微信「分享 → Engram」只带一个 mp.weixin.qq.com 链接，原来的
 * 落袋逻辑把文字原样写成 `手机分享-<时间戳>.txt`——同一篇文章「复制链接再粘进收集箱」
 * 能按标题存成 .html，两条路径的口径就此分叉。这里让分享链接走与粘贴同一条口径：
 * 抓静态 HTML、按页面标题（og:title > 微信 activity-name > <title> > 首个 H1）取名，
 * 文末补来源注释（与 server/src/lib/inboxWebFetch.ts 的 sourceUrlComment 同格式）。
 *
 * 只做静态抓取、不执行脚本：正文要等浏览器跑脚本的页面（分享页 / 单页应用）与反爬拦截页
 * 会以 [FetchError] 失败，调用方回退成原来的 .txt 落袋，链接本身不丢。
 *
 * 纯 JVM 工具（除 java.* 外不依赖 Android API），单测用本地 HttpServer 直连覆盖。
 */
object SharedWebPage {
    data class Page(val url: String, val title: String, val bytes: ByteArray)

    class FetchError(message: String) : Exception(message)

    private const val MAX_URL_LENGTH = 4096
    private const val MAX_REDIRECTS = 3
    private const val MAX_BYTES = 12 * 1024 * 1024
    private const val TITLE_SCAN_BYTES = 512 * 1024
    private const val SHELL_SCAN_BYTES = 4 * 1024 * 1024
    private const val CONNECT_TIMEOUT_MS = 8_000
    private const val READ_TIMEOUT_MS = 20_000
    private const val MAX_TITLE_LENGTH = 160
    private const val USER_AGENT =
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/124.0.0.0 Mobile Safari/537.36"

    // 与 server/src/lib/inboxWebFetch.ts 的空壳 / 反爬判据保持一致（阈值是该文件实测标定值）
    private const val SHELL_TEXT_LIMIT = 800
    private const val ANTI_BOT_TEXT_LIMIT = 1000
    private val MOUNT_PATTERN =
        Regex("""\bid\s*=\s*["']?(?:app|root|__next|__nuxt|___gatsby|svelte)\b""", RegexOption.IGNORE_CASE)
    /** 站点「打不开」的提示页标题：配上很少的正文即判定为拦截 / 失效页，回退 .txt（链接不丢） */
    private val BLOCKED_TITLES = listOf(
        "环境异常", "请在微信客户端打开", "页面不存在", "已被发布者删除", "内容已被删除", "参数错误",
    )
    private val ANTI_BOT_MARKERS = listOf(
        Regex("""\bzse-ck\b""", RegexOption.IGNORE_CASE),
        Regex("""\bcf-browser-verification\b""", RegexOption.IGNORE_CASE),
        Regex("""__cf_chl"""),
        Regex("""当前请求存在异常"""),
        Regex("""请求存在异常"""),
        Regex("""访问异常"""),
        Regex("""安全验证"""),
        Regex("""人机验证"""),
        Regex("""\bgeetest\b""", RegexOption.IGNORE_CASE),
    )

    private val META_TAG = Regex("""(?is)<meta\b[^>]*>""")
    private val ATTRIBUTE = Regex("""([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))""")
    private val TITLE_TAG = Regex("""(?is)<title\b[^>]*>([\s\S]*?)</title\s*>""")
    private val WECHAT_ACTIVITY_NAME =
        Regex("""(?is)<h1\b[^>]*\bid\s*=\s*["']?activity-name["']?[^>]*>([\s\S]*?)</h1\s*>""")
    private val WECHAT_RICH_TITLE =
        Regex("""(?is)<h1\b[^>]*\bclass\s*=\s*["'][^"']*\brich_media_title\b[^"']*["'][^>]*>([\s\S]*?)</h1\s*>""")
    private val FIRST_H1 = Regex("""(?is)<h1\b[^>]*>([\s\S]*?)</h1\s*>""")
    private val BODY = Regex("""(?is)<body\b[^>]*>([\s\S]*)$""")
    private val SCRIPT_OR_STYLE =
        Regex("""(?is)<(script|style|noscript|template|svg|iframe|object)\b[^>]*>[\s\S]*?</\1\s*>""")
    private val COMMENT = Regex("""(?s)<!--[\s\S]*?-->""")
    private val TAG = Regex("""<[^>]*>""")
    private val WHITESPACE = Regex("""[\s\u00a0]+""")
    private val ENTITY = Regex("""&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);""")

    private val NAMED_ENTITIES = mapOf(
        "amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\"", "apos" to "'", "nbsp" to " ",
        "mdash" to "—", "ndash" to "–", "hellip" to "…", "middot" to "·", "times" to "×",
        "ldquo" to "“", "rdquo" to "”", "lsquo" to "‘", "rsquo" to "’",
        "copy" to "©", "reg" to "®", "trade" to "™", "deg" to "°",
    )

    /**
     * 抓取网页 HTML 原件并读标题；失败抛 [FetchError]（调用方回退成 .txt）。
     *
     * [allowPrivateHosts] 只给单元测试用：放开私网 / 非标准端口限制，连本地 HttpServer。
     */
    fun fetch(rawUrl: String, allowPrivateHosts: Boolean = false): Page {
        var current = parse(rawUrl, allowPrivateHosts)
        var hop = 0
        while (true) {
            checkHost(current, allowPrivateHosts)
            val connection = current.openConnection() as HttpURLConnection
            try {
                connection.requestMethod = "GET"
                connection.instanceFollowRedirects = false
                connection.connectTimeout = CONNECT_TIMEOUT_MS
                connection.readTimeout = READ_TIMEOUT_MS
                connection.useCaches = false
                connection.setRequestProperty("Accept", "text/html,application/xhtml+xml;q=0.9")
                connection.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9")
                connection.setRequestProperty("User-Agent", USER_AGENT)
                val status = connection.responseCode
                if (status in 300..399) {
                    val location = connection.getHeaderField("Location")
                    if (location.isNullOrBlank() || hop >= MAX_REDIRECTS) throw FetchError("网页重定向次数过多")
                    current = parse(URL(current, location).toString(), allowPrivateHosts)
                    hop += 1
                    continue
                }
                if (status !in 200..299) throw FetchError("网页抓取失败（HTTP " + status + "）")
                val contentType = connection.contentType.orEmpty()
                val mime = contentType.substringBefore(';').trim().lowercase()
                if (mime.isNotEmpty() && mime != "text/html" && mime != "application/xhtml+xml") {
                    throw FetchError("目标没有返回 HTML 网页（" + mime + "）")
                }
                val bytes = connection.inputStream.use { readLimited(it) }
                if (bytes.isEmpty()) throw FetchError("网页内容为空")
                val scan = decode(bytes, minOf(bytes.size, SHELL_SCAN_BYTES), contentType)
                if (isAntiBot(scan)) throw FetchError("这个站点返回的是反爬验证页，不是文章正文")
                if (isScriptShell(scan)) throw FetchError("这个页面的正文要等浏览器执行脚本才会出现")
                val title = titleOf(scan)
                if (title.isEmpty()) throw FetchError("没有读到网页标题")
                if (BLOCKED_TITLES.any { title.contains(it) } && visibleTextLength(scan) < ANTI_BOT_TEXT_LIMIT) {
                    throw FetchError("这个页面是站点的拦截 / 失效提示页，不是文章正文")
                }
                // 与中枢抓取落盘同格式：原件末尾补来源注释，转换时据此记录出处
                val document = bytes + sourceComment(current.toString()).toByteArray(StandardCharsets.UTF_8)
                return Page(current.toString(), title, document)
            } finally {
                connection.disconnect()
            }
        }
    }

    /** 页面标题：og:title > twitter:title > 微信 activity-name > <title> > 首个 H1（与中枢 htmlTitle 同序） */
    fun titleOf(html: String): String {
        val head = if (html.length > TITLE_SCAN_BYTES) html.substring(0, TITLE_SCAN_BYTES) else html
        val meta = readMeta(head)
        val candidates = listOf(
            meta["og:title"],
            meta["twitter:title"],
            wechatElementTitle(head),
            TITLE_TAG.find(head)?.groupValues?.get(1),
            FIRST_H1.find(head)?.groupValues?.get(1),
        )
        for (candidate in candidates) {
            val title = cleanTitle(candidate.orEmpty())
            if (title.isNotEmpty()) return title
        }
        return ""
    }

    /** 原件末尾的来源注释，格式与 server/src/lib/inboxWebFetch.ts 的 sourceUrlComment 一致。 */
    fun sourceComment(url: String): String {
        val safe = url.replace("--", "- -").replace(">", "%3E")
        return "\n<!-- Engram source URL: " + safe + " -->\n"
    }

    private fun parse(raw: String, allowPrivateHosts: Boolean): URL {
        val text = raw.trim()
        if (text.isEmpty() || text.length > MAX_URL_LENGTH || text.contains('\\')) throw FetchError("网页地址无效")
        val url = try {
            URL(text)
        } catch (error: Exception) {
            throw FetchError("网页地址无效")
        }
        val scheme = url.protocol?.lowercase()
        if (scheme != "http" && scheme != "https") throw FetchError("只支持 http/https 网页地址")
        if (url.host.isNullOrBlank()) throw FetchError("网页地址无效")
        if (url.userInfo != null) throw FetchError("网页地址不能携带用户名或密码")
        if (!allowPrivateHosts && url.port != -1 && url.port != 80 && url.port != 443) {
            throw FetchError("网页地址只支持标准的 HTTP/HTTPS 端口")
        }
        return url
    }

    /** 只抓公网地址：禁止环回 / 私网 / 链路本地 / 运营商 NAT 段，避免把本机与内网当网页抓。 */
    private fun checkHost(url: URL, allowPrivateHosts: Boolean) {
        if (allowPrivateHosts) return
        val host = url.host.lowercase()
        if (host == "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
            host == "metadata.google.internal" || host.startsWith("metadata.")
        ) {
            throw FetchError("目标不是公网网页地址")
        }
        val addresses = try {
            InetAddress.getAllByName(host)
        } catch (error: Exception) {
            throw FetchError("网页域名无法解析")
        }
        if (addresses.isEmpty()) throw FetchError("网页域名无法解析")
        for (address in addresses) {
            val raw = address.address
            val carrierNat = raw.size == 4 && (raw[0].toInt() and 0xff) == 100 && (raw[1].toInt() and 0xc0) == 64
            val uniqueLocalV6 = raw.size == 16 && (raw[0].toInt() and 0xfe) == 0xfc
            if (address.isAnyLocalAddress || address.isLoopbackAddress || address.isLinkLocalAddress ||
                address.isSiteLocalAddress || address.isMulticastAddress || carrierNat || uniqueLocalV6
            ) {
                throw FetchError("目标指向私网、环回或保留地址，已阻止抓取")
            }
        }
    }

    private fun readLimited(input: InputStream): ByteArray {
        val output = ByteArrayOutputStream(64 * 1024)
        val buffer = ByteArray(32 * 1024)
        var total = 0
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            if (total > MAX_BYTES) throw FetchError("网页超过 12 MB，暂不支持保存")
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }

    private fun decode(bytes: ByteArray, length: Int, contentType: String): String {
        val head = bytes.copyOfRange(0, minOf(length, bytes.size))
        val charset = charsetOf(contentType, head)
        return try {
            String(head, charset)
        } catch (error: Exception) {
            String(head, StandardCharsets.UTF_8)
        }
    }

    private fun charsetOf(contentType: String, head: ByteArray): Charset {
        Regex("""charset\s*=\s*["']?([^;"'\s]+)""", RegexOption.IGNORE_CASE)
            .find(contentType)?.groupValues?.get(1)?.let { charsetOrNull(it)?.let { charset -> return charset } }
        val ascii = String(head, StandardCharsets.ISO_8859_1)
        Regex("""(?is)<meta\b[^>]*charset\s*=\s*["']?([a-zA-Z0-9_\-]+)""")
            .find(ascii)?.groupValues?.get(1)?.let { charsetOrNull(it)?.let { charset -> return charset } }
        return StandardCharsets.UTF_8
    }

    private fun charsetOrNull(name: String): Charset? = try {
        Charset.forName(name.trim())
    } catch (error: Exception) {
        null
    }

    private fun readMeta(html: String): Map<String, String> {
        val meta = HashMap<String, String>()
        for (tag in META_TAG.findAll(html)) {
            val attributes = attributesOf(tag.value)
            val key = (attributes["property"] ?: attributes["name"] ?: "").trim().lowercase()
            if (key.isEmpty() || meta.containsKey(key)) continue
            val content = attributes["content"] ?: continue
            meta[key] = decodeEntities(content).trim()
        }
        return meta
    }

    private fun attributesOf(tag: String): Map<String, String> {
        val attributes = HashMap<String, String>()
        for (match in ATTRIBUTE.findAll(tag)) {
            val value = match.groupValues[2].ifEmpty {
                match.groupValues[3].ifEmpty { match.groupValues[4] }
            }
            attributes[match.groupValues[1].lowercase()] = value
        }
        return attributes
    }

    private fun wechatElementTitle(html: String): String {
        val raw = WECHAT_ACTIVITY_NAME.find(html)?.groupValues?.get(1)
            ?: WECHAT_RICH_TITLE.find(html)?.groupValues?.get(1)
            ?: return ""
        return cleanTitle(raw)
    }

    /** 与中枢 cleanTitle 同口径：去脚本/标签、解实体、压空白，限制长度。 */
    private fun cleanTitle(raw: String): String {
        if (raw.isBlank()) return ""
        return stripMarkupText(raw).replace(WHITESPACE, " ").trim().take(MAX_TITLE_LENGTH)
    }

    private fun stripMarkupText(fragment: String): String =
        decodeEntities(fragment.replace(SCRIPT_OR_STYLE, " ").replace(TAG, " ")).trim()

    private fun decodeEntities(text: String): String {
        if (!text.contains('&')) return text
        return ENTITY.replace(text) { match ->
            val entity = match.groupValues[1]
            if (entity.startsWith("#")) {
                val hex = entity.length > 1 && (entity[1] == 'x' || entity[1] == 'X')
                val code = entity.substring(if (hex) 2 else 1).toIntOrNull(if (hex) 16 else 10)
                if (code == null) match.value else runCatching { String(Character.toChars(code)) }.getOrDefault(match.value)
            } else {
                NAMED_ENTITIES[entity] ?: match.value
            }
        }
    }

    private fun isAntiBot(source: String): Boolean {
        val body = BODY.find(source)?.groupValues?.get(1) ?: source
        if (visibleTextLength(body) >= ANTI_BOT_TEXT_LIMIT) return false
        return ANTI_BOT_MARKERS.any { it.containsMatchIn(source) }
    }

    private fun isScriptShell(source: String): Boolean {
        val body = BODY.find(source)?.groupValues?.get(1) ?: return false
        if (visibleTextLength(body) >= SHELL_TEXT_LIMIT) return false
        return MOUNT_PATTERN.containsMatchIn(body)
    }

    private fun visibleTextLength(source: String): Int =
        source.replace(SCRIPT_OR_STYLE, " ")
            .replace(COMMENT, " ")
            .replace(TAG, " ")
            .replace(Regex("""&[a-zA-Z#0-9]+;"""), "x")
            .replace(Regex("""\s+"""), "")
            .length
}
