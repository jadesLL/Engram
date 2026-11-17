package com.engram.app

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.BufferedReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

/** 分享链接抓网页：标题口径与中枢一致，失败要能被调用方识别成「回退 .txt」。 */
class SharedWebPageTest {
    private lateinit var server: TestHttpServer

    @Before
    fun start() {
        server = TestHttpServer()
    }

    @After
    fun stop() {
        server.close()
    }

    private fun url(path: String): String = "http://127.0.0.1:" + server.port + path

    private fun article(title: String): String =
        "<html><head><title></title><meta property=\"og:title\" content=\"$title\"></head>" +
            "<body><div id=\"js_content\"><p>正文内容，至少够多字，避免被当成空壳页。</p></div></body></html>"

    @Test
    fun fetchesHtmlAndNamesByPageTitle() {
        server.route("/s/abc", body = article("公众号测试文章：IRT 与确定性"))
        val page = SharedWebPage.fetch(url("/s/abc"), allowPrivateHosts = true)
        assertEquals("公众号测试文章：IRT 与确定性", page.title)
        assertEquals(url("/s/abc"), page.url)
        val document = String(page.bytes, Charsets.UTF_8)
        assertTrue(document.contains("<div id=\"js_content\">"))
        assertTrue("文末要带来源注释", document.contains("<!-- Engram source URL: " + url("/s/abc") + " -->"))
    }

    @Test
    fun readsWechatActivityNameWhenTitleTagIsEmpty() {
        server.route(
            "/s/wechat",
            body = "<html><head><title></title></head><body>" +
                "<h1 class=\"rich_media_title\" id=\"activity-name\"> 标题：<span>微信文章</span> </h1>" +
                "<div id=\"js_content\"><p>正文。</p></div></body></html>",
        )
        val page = SharedWebPage.fetch(url("/s/wechat"), allowPrivateHosts = true)
        assertEquals("标题： 微信文章", page.title)
    }

    @Test
    fun prefersOgTitleOverTitleTagAndDecodesEntities() {
        val title = SharedWebPage.titleOf(
            "<html><head><title>网页标题</title>" +
                "<meta content=\"A &amp; B&nbsp;&nbsp;C\" property=\"og:title\"></head><body></body></html>",
        )
        assertEquals("A & B C", title)
    }

    @Test
    fun followsRedirectsAndTracksFinalUrl() {
        server.route("/go", status = 302, headers = mapOf("Location" to "/s/final"))
        server.route("/s/final", body = article("重定向后的文章"))
        val page = SharedWebPage.fetch(url("/go"), allowPrivateHosts = true)
        assertEquals("重定向后的文章", page.title)
        assertEquals(url("/s/final"), page.url)
    }

    @Test
    fun rejectsNonHtmlResponses() {
        server.route("/json", body = "{\"ok\":true}", headers = mapOf("Content-Type" to "application/json"))
        assertFails { SharedWebPage.fetch(url("/json"), allowPrivateHosts = true) }
    }

    @Test
    fun rejectsScriptShellPagesSoCallerFallsBackToText() {
        server.route("/shell", body = "<html><body><div id=\"app\"></div><script>render()</script></body></html>")
        assertFails { SharedWebPage.fetch(url("/shell"), allowPrivateHosts = true) }
    }

    @Test
    fun rejectsWechatBlockedPageSoCallerFallsBackToText() {
        server.route("/blocked", body = "<html><head><title>环境异常</title></head><body><p>请在微信客户端打开链接</p></body></html>")
        assertFails { SharedWebPage.fetch(url("/blocked"), allowPrivateHosts = true) }
    }

    @Test
    fun rejectsPagesWithoutAnyTitle() {
        server.route("/plain", body = "<html><body><p>没有标题的页面</p></body></html>")
        assertFails { SharedWebPage.fetch(url("/plain"), allowPrivateHosts = true) }
    }

    @Test
    fun blocksPrivateHostsUnlessExplicitlyAllowed() {
        assertFails { SharedWebPage.fetch("http://127.0.0.1/s/abc") }
    }

    @Test
    fun rejectsNonStandardPortForPublicFetches() {
        assertFails { SharedWebPage.fetch("http://example.com:8080/s/abc") }
    }

    @Test
    fun rejectsNonHttpScheme() {
        assertFails { SharedWebPage.fetch("javascript:alert(1)", allowPrivateHosts = true) }
    }

    @Test
    fun sourceCommentMatchesServerFormat() {
        assertEquals(
            "\n<!-- Engram source URL: https://example.com/a- -b -->\n",
            SharedWebPage.sourceComment("https://example.com/a--b"),
        )
        assertEquals(
            "\n<!-- Engram source URL: https://example.com/x-%3E -->\n",
            SharedWebPage.sourceComment("https://example.com/x->"),
        )
    }

    private fun assertFails(block: () -> Unit) {
        try {
            block()
        } catch (error: SharedWebPage.FetchError) {
            return
        }
        throw AssertionError("应当抓取失败，交给调用方回退成 .txt")
    }

    /**
     * 极简 HTTP/1.1 测试服务：Android 单测的编译类路径里没有 com.sun.net.httpserver
     * （jdk.httpserver 模块不在 android.jar 的 boot classpath 内），用 ServerSocket 手写。
     */
    private class TestHttpServer {
        private data class Route(
            val status: Int,
            val headers: Map<String, String>,
            val body: ByteArray,
        )

        private val socket = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        private val routes = HashMap<String, Route>()
        @Volatile
        private var running = true

        val port: Int = socket.localPort

        private val thread = Thread {
            while (running) {
                val client = try {
                    socket.accept()
                } catch (error: Exception) {
                    break
                }
                try {
                    handle(client)
                } catch (error: Exception) {
                    // 客户端提前断开（例如请求被引擎取消）不影响后续用例
                } finally {
                    runCatching { client.close() }
                }
            }
        }.apply {
            isDaemon = true
            start()
        }

        fun route(path: String, status: Int = 200, headers: Map<String, String> = emptyMap(), body: String = "") {
            val resolved = HashMap(headers)
            if (!resolved.containsKey("Content-Type")) resolved["Content-Type"] = "text/html; charset=utf-8"
            synchronized(routes) { routes[path] = Route(status, resolved, body.toByteArray(Charsets.UTF_8)) }
        }

        private fun handle(client: Socket) {
            client.soTimeout = 5_000
            val reader = client.getInputStream().bufferedReader(Charsets.ISO_8859_1)
            val requestLine = reader.readLine() ?: return
            readHeaders(reader)
            val path = requestLine.split(" ").getOrNull(1) ?: "/"
            val route = synchronized(routes) { routes[path] }
                ?: Route(404, mapOf("Content-Type" to "text/plain; charset=utf-8"), "not found".toByteArray())
            val reason = when (route.status) {
                200 -> "OK"
                302 -> "Found"
                404 -> "Not Found"
                else -> "Status"
            }
            val header = buildString {
                append("HTTP/1.1 ").append(route.status).append(' ').append(reason).append("\r\n")
                for ((name, value) in route.headers) append(name).append(": ").append(value).append("\r\n")
                append("Content-Length: ").append(route.body.size).append("\r\n")
                append("Connection: close\r\n\r\n")
            }
            val output = client.getOutputStream()
            output.write(header.toByteArray(Charsets.ISO_8859_1))
            output.write(route.body)
            output.flush()
        }

        private fun readHeaders(reader: BufferedReader) {
            while (true) {
                val line = reader.readLine() ?: return
                if (line.isEmpty()) return
            }
        }

        fun close() {
            running = false
            runCatching { socket.close() }
            runCatching { thread.join(1_000) }
        }
    }
}
