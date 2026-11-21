package com.engram.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 图片归属收编：与 server lib/pageAssets.adoptForeignAssetRefs 的同一组场景（见 pageAssets.test.ts） */
class PageAssetAdoptionTest {
    private val pageId = "11111111-1111-1111-1111-111111111111"
    private val oldParent = "22222222-2222-2222-2222-222222222222"
    private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3)

    private val sources = HashMap<Pair<String, String>, ByteArray>()
    private val written = HashMap<String, ByteArray>()

    private fun adopt(markdown: String): PageAssetAdoption.Result = PageAssetAdoption.adopt(
        pageId,
        markdown,
        read = { ref -> sources[ref.parentId to ref.name] },
        write = { name, bytes -> written[name] = bytes; true },
    )

    @Test fun copiesIntoPageDirAndKeepsWidthAndTitle() {
        sources[oldParent to "photo.png"] = png
        val md = "![图](/media/$oldParent/photo.png#w=480 \"原图 https://example.com/a.png\")"

        val result = adopt(md)

        assertEquals(1, result.adopted)
        assertEquals(1, result.files.size)
        val name = result.files[0].name
        assertTrue("文件名要带内容哈希前缀：$name", Regex("^[0-9a-f]{8}-.+\\.png$").matches(name))
        assertTrue(written[name]!!.contentEquals(png))
        assertTrue(result.content.startsWith("![图](/media/$pageId/$name#w=480"))
        assertTrue(result.content.endsWith("\"原图 https://example.com/a.png\")"))
    }

    @Test fun secondRunIsIdempotent() {
        sources[oldParent to "photo.png"] = png
        val first = adopt("![](/media/$oldParent/photo.png)")
        val second = adopt(first.content)
        assertEquals(0, second.adopted)
        assertEquals(first.content, second.content)
    }

    @Test fun missingSourceKeepsOriginalRef() {
        val md = "![](/media/$oldParent/later.png)"
        val result = adopt(md)
        assertEquals(0, result.adopted)
        assertEquals(md, result.content)
        assertTrue(result.files.isEmpty())
    }

    @Test fun ownRefsAreUntouched() {
        val md = "![](/media/$pageId/mine.png)"
        val result = adopt(md)
        assertEquals(0, result.adopted)
        assertEquals(md, result.content)
    }

    @Test fun rewritesHtmlImgSrcOnly() {
        sources[oldParent to "photo.png"] = png
        val md = "<img alt=\"图\" src=\"/media/$oldParent/photo.png\" width=\"320\">"

        val result = adopt(md)

        assertEquals(1, result.adopted)
        val name = result.files[0].name
        assertTrue(result.content.contains("src=\"/media/$pageId/$name\""))
        assertTrue(result.content.contains("alt=\"图\""))
        assertTrue(result.content.contains("width=\"320\""))
    }

    @Test fun keepsAlreadyAddressedNames() {
        val addressed = "deadbeef-photo.png"
        sources[oldParent to addressed] = png
        val result = adopt("![](/media/$oldParent/$addressed)")
        assertEquals(addressed, result.files[0].name)
    }

    @Test fun failedWriteKeepsOriginalRef() {
        sources[oldParent to "photo.png"] = png
        val md = "![](/media/$oldParent/photo.png)"
        val result = PageAssetAdoption.adopt(pageId, md, read = { sources[it.parentId to it.name] }, write = { _, _ -> false })
        assertEquals(0, result.adopted)
        assertEquals(md, result.content)
        assertTrue(written.isEmpty())
    }
}
