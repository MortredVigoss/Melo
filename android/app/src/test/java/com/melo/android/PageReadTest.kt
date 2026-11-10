package com.melo.android

import com.melo.android.data.*
import com.melo.android.network.SharedSearchAdapter
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test

// 2026-11-10 follow-up to the Agent audit (Android 10b, 10c): which addresses a page read opens.
class PageReadTest {
    private fun args(url: String) = buildJsonObject { put("url", url) }
    private fun page(body: String) = MockResponse().setHeader("Content-Type", "text/html; charset=utf-8").setBody(body)
    private fun moved(location: String, code: Int = 302) = MockResponse().setResponseCode(code).setHeader("Location", location)

    // "#section" never reaches the server; a link with one (most documentation links) was refused as not HTTPS.
    @Test fun aLinkWithAFragmentIsThePageItPointsInto() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(page("install steps")); server.start()
            val plain = server.url("/docs").toString(); val link = "$plain#install"
            val adapter = SharedSearchAdapter(true, okhttp3.OkHttpClient())
            val read = adapter.load(args(link), listOf(link))
            assertTrue(read.data.toString(), read.ok); assertEquals("install steps", read.data.text("body"))
            assertEquals("/docs", server.takeRequest().path)
            // The same page under either spelling is one source: listed with the fragment, read without, and the other way round.
            assertTrue(adapter.load(args(plain), listOf(link)).ok); assertTrue(adapter.load(args("$plain#other"), listOf(plain)).ok)
            assertEquals("downloaded once", 1, server.requestCount)
            // A different page is still not in the evidence.
            assertEquals("FETCH_URL_NOT_IN_EVIDENCE", adapter.load(args(server.url("/other").toString() + "#install"), listOf(link)).data.text("code"))
        }
    }

    // A page that moved answered "检索服务返回 HTTP 301。" and could not be read at all.
    @Test fun aPageThatMovedIsReadWhereItMovedTo() = runBlocking {
        MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                    "/old" -> moved("/new", 301)
                    "/new" -> moved(server.url("/final?lang=zh#top").toString(), 302)
                    "/final?lang=zh" -> page("the page after two moves")
                    "/loop" -> moved("/loop")
                    "/away" -> moved("http://example.invalid/outside")
                    "/inside" -> moved("https://192.168.1.10/admin")
                    "/nowhere" -> MockResponse().setResponseCode(302)
                    "/gone" -> MockResponse().setResponseCode(404)
                    else -> MockResponse().setResponseCode(500)
                }
            }
            server.start()
            fun url(path: String) = server.url(path).toString()
            val adapter = SharedSearchAdapter(true, okhttp3.OkHttpClient())
            val read = adapter.load(args(url("/old")), listOf(url("/old")))
            assertTrue(read.data.toString(), read.ok); assertEquals("the page after two moves", read.data.text("body"))
            assertEquals(3, server.requestCount)
            // Read again under the address that was asked for: the loaded page is reused.
            assertEquals("the page after two moves", adapter.load(args(url("/old")), listOf(url("/old"))).data.text("body")); assertEquals(3, server.requestCount)
            // A chain that never ends stops after five hops.
            val loop = adapter.load(args(url("/loop")), listOf(url("/loop")))
            assertEquals("FETCH_REDIRECT_LIMIT", loop.data.text("code")); assertEquals("the first request and five hops", 3 + 6, server.requestCount)
            // A hop is held to the rules of a first address: no plain http outside the fixture hosts, no private network.
            for (path in listOf("/away", "/inside")) {
                val before = server.requestCount
                val refused = adapter.load(args(url(path)), listOf(url(path)))
                assertEquals(path, "FETCH_URL_UNSUPPORTED", refused.data.text("code")); assertEquals("$path: nothing further was requested", before + 1, server.requestCount)
            }
            // A redirect without a target, and a plain error, are that one failed read.
            assertEquals("SEARCH_HTTP_302", adapter.load(args(url("/nowhere")), listOf(url("/nowhere"))).data.text("code"))
            val gone = adapter.load(args(url("/gone")), listOf(url("/gone")))
            assertEquals("SEARCH_HTTP_404", gone.data.text("code")); assertTrue("named as the page's answer, not the search service's", gone.data.text("error").contains("网页返回 HTTP 404"))
        }
    }

    // The private-network rule looked names up, and OkHttp never looks a literal address up: it bypassed the rule.
    @Test fun aLiteralPrivateAddressIsRefusedWithoutAnyRequest() = runBlocking {
        val adapter = SharedSearchAdapter(false, okhttp3.OkHttpClient())
        for (address in listOf("https://192.168.1.1/admin", "https://10.0.0.5/", "https://127.0.0.1/x", "https://169.254.169.254/latest/meta-data", "https://172.16.3.4/", "https://[::1]/x", "https://[fd00::1]/x", "https://0.0.0.0/"))
            assertEquals(address, "FETCH_URL_UNSUPPORTED", adapter.load(args(address), listOf(address)).data.text("code"))
        // The debug fixture hosts stay readable in a debug build only (every other test of pages relies on them).
        MockWebServer().use { server ->
            server.enqueue(page("fixture")); server.start()
            val url = server.url("/p").toString()
            assertTrue(SharedSearchAdapter(true, okhttp3.OkHttpClient()).load(args(url), listOf(url)).ok)
            assertEquals("FETCH_URL_UNSUPPORTED", adapter.load(args(url), listOf(url)).data.text("code"))
        }
    }
}
