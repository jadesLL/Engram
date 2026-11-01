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

    /** 读取本地收集箱里的视频占位稿（只解析前 4KB，够 frontmatter 用）。 */
    fun parseVideoPlaceholder(raw: String): VideoMeta? {
        val text = (raw ?: "").replace("\r\n", "\n").replaceFirst("\uFEFF", "")
        if (!text.startsWith("---\n")) return null
        val end = text.indexOf("\n---\n", 4)
        if (end < 0) return null
        val frontmatter = text.substring(4, end)
        if (!VIDEO_MARKER.containsMatchIn(frontmatter)) return null
        val platform = VIDEO_PLATFORM.find(frontmatter)?.groupValues?.get(1) ?: return null
        val link = VIDEO_LINK.find(frontmatter)?.groupValues?.get(1)?.trim() ?: return null
        val title = VIDEO_TITLE.find(frontmatter)?.groupValues?.get(1)?.trim().orEmpty()
            .ifBlank { if (platform == "bilibili") "B 站视频" else "抖音视频" }
        return VideoMeta(platform, link, title)
    }
}
