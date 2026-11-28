package com.engram.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
    fun recognizesSharedWebArticleLink() {
        val linkOnly = ShareLinks.webArticleShare("https://mp.weixin.qq.com/s/abc")
        assertEquals("https://mp.weixin.qq.com/s/abc", linkOnly?.url)
        assertEquals("", linkOnly?.title)
        assertEquals("https://mp.weixin.qq.com/s/abc", ShareLinks.webArticleShare("  https://mp.weixin.qq.com/s/abc。\n")?.url)
        assertEquals(
            "公众号文章标题",
            ShareLinks.webArticleShare("公众号文章标题 https://mp.weixin.qq.com/s/abc")?.title,
        )
    }

    @Test
    fun keepsMultiLineOrTrailingTextAsPlainText() {
        assertNull(ShareLinks.webArticleShare("看这个\n再说一句 https://mp.weixin.qq.com/s/abc"))
        assertNull(ShareLinks.webArticleShare("https://mp.weixin.qq.com/s/abc 还有后文"))
    }

    @Test
    fun videoSharesAreNotFetchedAsArticles() {
        assertNull(ShareLinks.webArticleShare("https://b23.tv/AbCdEf"))
        assertNull(ShareLinks.webArticleShare("https://www.bilibili.com/video/BV1xx411c7mD"))
        assertNull(ShareLinks.webArticleShare("复制打开抖音，看看【山野阿川】的作品 https://v.douyin.com/abc123/ 07/15"))
    }

    @Test
    fun matchesShareTitleWithPageTitleAllowingPunctuation() {
        assertTrue(ShareLinks.titleMatches("《求是》杂志发表文章", "求是 杂志发表文章！"))
        assertTrue(ShareLinks.titleMatches("公众号标题", "公众号标题"))
        assertFalse(ShareLinks.titleMatches("这个不错", "求是杂志发表文章"))
    }

    @Test
    fun parsesOnlyVideoPlaceholder() {
        assertNull(ShareLinks.parseVideoPlaceholder("这是一段普通文字"))
        assertNull(ShareLinks.parseVideoPlaceholder("---\n类型: note\n---\n正文"))
    }

    @Test
    fun stripsYamlQuotesFromNormalizedPlaceholder() {
        // 历史占位稿被页面规范化重排过：链接/标题被 YAML 加了引号
        val quoted = "---\n类型: video-link\n平台: douyin\n" +
            "链接: 'https://www.douyin.com/video/7711679866428558643'\n" +
            "标题: '抖音视频：带冒号'\n" +
            "id: 8541d41b\n" +
            "创建日期: '2026-11-28T15:01:36.184Z'\n---\n"
        val parsed = ShareLinks.parseVideoPlaceholder(quoted)
        assertEquals("https://www.douyin.com/video/7711679866428558643", parsed?.link)
        assertEquals("抖音视频：带冒号", parsed?.title)
    }
}
