package com.engram.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShareLinksTest {
    @Test
    fun findsFirstHttpUrlInChineseCaption() {
        val text = "复制打开抖音，看看【山野阿川】的作品 https://v.douyin.com/abc123/ 07/15"
        assertEquals("https://v.douyin.com/abc123/", ShareLinks.firstUrl(text))
    }

    @Test
    fun detectsBilibiliShortLink() {
        val link = ShareLinks.detectVideo("https://b23.tv/AbCdEf")
        assertEquals("bilibili", link?.platform)
    }

    @Test
    fun detectsBilibiliVideoPathButNotHomepage() {
        assertEquals("bilibili", ShareLinks.detectVideo("https://www.bilibili.com/video/BV1xx411c7mD")?.platform)
        assertNull(ShareLinks.detectVideo("https://www.bilibili.com/"))
    }

    @Test
    fun detectsDouyinLinks() {
        assertEquals("douyin", ShareLinks.detectVideo("https://v.douyin.com/abc123/")?.platform)
        assertEquals("douyin", ShareLinks.detectVideo("https://www.iesdouyin.com/share/video/123")?.platform)
    }

    @Test
    fun ignoresNormalArticleUrl() {
        assertNull(ShareLinks.detectVideo("https://mp.weixin.qq.com/s/abc"))
    }

    @Test
    fun titleFallsBackPerPlatformAndTrimsNewlines() {
        assertEquals("B 站视频", ShareLinks.title(null, "bilibili"))
        assertEquals("抖音视频", ShareLinks.title("  ", "douyin"))
        assertEquals("一个 标题", ShareLinks.title("一个\n标题", "bilibili"))
    }

    @Test
    fun markdownRoundTripsWithServerFormat() {
        val markdown = ShareLinks.videoMarkdown("https://b23.tv/AbCdEf", "bilibili", "测试标题")
        assertTrue(markdown.contains("类型: video-link"))
        val parsed = ShareLinks.parseVideoPlaceholder(markdown)
        assertEquals("bilibili", parsed?.platform)
        assertEquals("https://b23.tv/AbCdEf", parsed?.link)
        assertEquals("测试标题", parsed?.title)
    }

    @Test
    fun parsesOnlyVideoPlaceholder() {
        assertNull(ShareLinks.parseVideoPlaceholder("这是一段普通文字"))
        assertNull(ShareLinks.parseVideoPlaceholder("---\n类型: note\n---\n正文"))
    }
}
