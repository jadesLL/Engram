package com.engram.app

import java.net.URI

/**
 * 系统分享内容的链接识别。
 *
 * 背景：Android 分享目标把所有文字原样写成 .txt，而中枢的「提炼视频」只认带
 * `类型: video-link` frontmatter 的 Markdown 占位稿——从分享入口进来的 B 站/抖音链接
 * 因此永远走不了视频管线。这里在落盘前识别视频链接，直接写成与中枢一致的占位稿；
 * 非视频链接仍按原来的 .txt 原样保存，不改变既有行为。
 *
 * 纯 JVM 工具，不依赖 Android API，单测直接覆盖。
 */
object ShareLinks {
    data class VideoLink(val platform: String, val link: String)
    data class VideoMeta(val platform: String, val link: String, val title: String)

    private const val MAX_LINK_TEXT = 4096
    /** 链接前允许随附的短标题上限：再长就当用户自己的说明文字，不抓网页。 */
    private const val MAX_SHARE_TITLE = 120
    private const val PADDING = " \t\r\n\u3000，。；：、！？…—–-_()（）[]【】<>《》「」『』\"'“”‘’"
    private val TITLE_NOISE = Regex("""[\s\u3000·•—–\-_.,，。;；:：!！?？"'`“”‘’()（）\[\]【】《》〈〉<>「」『』、/\\|#*~]+""")
    private val URL_PATTERN = Regex("""https?://[^\s<>"']+""", RegexOption.IGNORE_CASE)
    private val BILI_PATH = Regex("""^/video/(?:BV[0-9A-Za-z]{10}|av\d+)/?$""", RegexOption.IGNORE_CASE)
    private val VIDEO_MARKER = Regex("""(?m)^类型:\s*video-link\s*$""")
    private val VIDEO_PLATFORM = Regex("""(?m)^平台:\s*(bilibili|douyin)\s*$""")
    private val VIDEO_LINK = Regex("""(?m)^链接:\s*(\S.*?)\s*$""")
    private val VIDEO_TITLE = Regex("""(?m)^标题:\s*(.*?)\s*$""")

    /** 从分享文字里取第一条 http(s) 链接；抖音的「复制链接」常夹带口播文字。 */
    fun firstUrl(text: String?): String? {
        val match = URL_PATTERN.find(text ?: return null) ?: return null
        return match.value.trimEnd('.', ',', ';', ':', '，', '。', '；', '：', ')', '）', ']', '】', '"', '\'')
            .takeIf { it.isNotBlank() }
    }

    /** 分享里识别出的网页链接：链接本身 + 链接前面那行短文字（多半是文章标题，可能为空）。 */
    data class SharedLink(val url: String, val title: String)

    /**
     * 从分享文字里认出一条可抓取的网页链接。
     *
     * 微信「分享 → Engram」一篇文章通常只带一个 mp.weixin.qq.com 地址（EdgeEver 等同类应用
     * 的报障也印证了「只有来源链接」），原来会被当成普通文字存成 `手机分享-<时间戳>.txt`。
     * 这里允许链接前面带一行短标题（部分浏览器 / 分享方会给「标题 + 链接」），标题之后
     * 只允许空白与标点；链接夹在大段说明文字里的返回 null——那段文字属于用户内容，
     * 不能被网页抓取结果覆盖。
     */
    fun sharedLink(text: String?): SharedLink? {
        val raw = text?.trim().orEmpty()
        if (raw.isEmpty() || raw.length > MAX_LINK_TEXT) return null
        val match = URL_PATTERN.find(raw) ?: return null
        val before = raw.substring(0, match.range.first)
        val after = raw.substring(match.range.last + 1)
        if (!isPadding(after)) return null
        val url = firstUrl(raw) ?: return null
        val prefix = before.trim { it.isWhitespace() || PADDING.indexOf(it) >= 0 }
        if (prefix.isEmpty()) return SharedLink(url, "")
        if (prefix.length > MAX_SHARE_TITLE || prefix.contains('\n') || prefix.contains('\r')) return null
        return SharedLink(url, prefix)
    }

    /** 分享的是一条普通网页（B 站 / 抖音视频链接除外）：可以按网页抓取落袋。 */
    fun webArticleShare(text: String?): SharedLink? {
        val share = sharedLink(text) ?: return null
        return if (detectVideo(share.url) == null) share else null
    }

    /**
     * 分享里随附的那行文字是不是网页标题（允许书名号、标点与空白差异）。
     *
     * 是标题 → 抓取结果可以直接替换掉这行文字（内容不丢）；不是（例如用户写了句
     * 「这个不错」）→ 仍按原文落成 .txt，保住用户自己写的话。
     */
    fun titleMatches(prefix: String, title: String): Boolean {
        val a = normalizeTitle(prefix)
        val b = normalizeTitle(title)
        if (a.isEmpty() || b.isEmpty()) return false
        return a == b || (a.length >= 4 && b.contains(a)) || (b.length >= 4 && a.contains(b))
    }

    private fun normalizeTitle(value: String): String = TITLE_NOISE.replace(value, "").lowercase()

    /** 识别 B 站 / 抖音视频链接；不是视频链接返回 null。 */
    fun detectVideo(url: String?): VideoLink? {
        val raw = (url ?: return null).trim()
        if (raw.isEmpty() || raw.length > 4096) return null
        if (Regex("^(?:javascript|data|vbscript|file):", RegexOption.IGNORE_CASE).containsMatchIn(raw)) return null
        val candidate = if (Regex("^[a-z][a-z0-9+.-]*://", RegexOption.IGNORE_CASE).containsMatchIn(raw)) raw else "https://$raw"
        val parsed = runCatching { URI(candidate) }.getOrNull() ?: return null
        val scheme = parsed.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        val host = parsed.host?.lowercase() ?: return null
        return when {
            host == "b23.tv" || host.endsWith(".b23.tv") ||
                host == "bili2233.cn" || host.endsWith(".bili2233.cn") ->
                VideoLink("bilibili", raw)
            host == "bilibili.com" || host.endsWith(".bilibili.com") ->
                if (BILI_PATH.matches(parsed.path ?: "")) VideoLink("bilibili", raw) else null
            host == "douyin.com" || host.endsWith(".douyin.com") ||
                host == "iesdouyin.com" || host.endsWith(".iesdouyin.com") ->
                VideoLink("douyin", raw)
            else -> null
        }
    }

    private fun isPadding(value: String): Boolean = value.all { it.isWhitespace() || PADDING.indexOf(it) >= 0 }

    /** 占位稿标题：优先用分享方给的标题，缺失时给平台默认名。 */
    fun title(rawTitle: String?, platform: String): String {
        val cleaned = (rawTitle ?: "")
            .replace(Regex("[\r\n\t]+"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
        return cleaned.take(80).ifBlank { if (platform == "bilibili") "B 站视频" else "抖音视频" }
    }

    /** 与 server/src/lib/videoLink.ts 的 buildVideoLinkMarkdown 保持一致的占位稿格式。 */
    fun videoMarkdown(link: String, platform: String, title: String): String {
        val safePlatform = if (platform == "douyin") "douyin" else "bilibili"
        val safeLink = link.replace(Regex("[\r\n]+"), " ").trim()
        val safeTitle = title.replace(Regex("[\r\n]+"), " ").trim().ifBlank {
            if (safePlatform == "bilibili") "B 站视频" else "抖音视频"
        }
        return "---\n类型: video-link\n平台: $safePlatform\n链接: $safeLink\n标题: $safeTitle\n---\n\n视频链接：$safeLink\n"
    }

    /**
     * 取 frontmatter 标量并去掉 YAML 引号。
     *
     * 与 server 的 parseVideoLinkMarkdown 同一口径：旧占位稿被页面规范化补过引号时
     * （`链接: 'https://…'`），手机端展示的链接不能带引号，否则点开是坏地址。
     */
    private fun scalar(value: String?): String {
        val text = (value ?: "").trim()
        if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
            return text.substring(1, text.length - 1).replace("''", "'").trim()
        }
        if (text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")) {
            return text.substring(1, text.length - 1).replace("\\\"", "\"").trim()
        }
        return text
    }

    /** 读取本地收集箱里的视频占位稿（只解析前 4KB，够 frontmatter 用）。 */
    fun parseVideoPlaceholder(raw: String): VideoMeta? {
        val text = (raw ?: "").replace("\r\n", "\n").replaceFirst("\uFEFF", "")
        if (!text.startsWith("---\n")) return null
        val end = text.indexOf("\n---\n", 4)
        if (end < 0) return null
        val frontmatter = text.substring(4, end)
        if (!VIDEO_MARKER.containsMatchIn(frontmatter)) return null
        val platform = VIDEO_PLATFORM.find(frontmatter)?.groupValues?.get(1) ?: return null
        val link = scalar(VIDEO_LINK.find(frontmatter)?.groupValues?.get(1))
        if (link.isEmpty()) return null
        val title = scalar(VIDEO_TITLE.find(frontmatter)?.groupValues?.get(1))
            .ifBlank { if (platform == "bilibili") "B 站视频" else "抖音视频" }
        return VideoMeta(platform, link, title)
    }
}
