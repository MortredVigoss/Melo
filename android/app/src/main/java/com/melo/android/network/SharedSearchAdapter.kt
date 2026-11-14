package com.melo.android.network

import com.melo.android.core.*
import com.melo.android.data.*
import com.melo.android.device.DeviceToolResult
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import okhttp3.Dns
import kotlin.coroutines.resume

/** HTTP / TLS / credentials only. Schema, defaults and receipts come from Core. */
class SharedSearchAdapter(private val debug: Boolean, http: OkHttpClient) {
    companion object {
        fun credentialId(endpoint: String, debug: Boolean): String {
            val target = EndpointPolicy.validate(endpoint, debug).toString()
            return "search:" + MessageDigest.getInstance("SHA-256").digest(target.toByteArray()).joinToString("") { "%02x".format(it) }
        }
        // Hops one page read follows. Each hop is a new address and is checked like the first one.
        private const val MAX_PAGE_REDIRECTS = 5
        private val fixtureHosts = setOf("localhost", "127.0.0.1", "10.0.2.2")
        private fun privateAddress(address: java.net.InetAddress) = address.isAnyLocalAddress || address.isLoopbackAddress || address.isLinkLocalAddress || address.isSiteLocalAddress || address.isMulticastAddress || address.address.size == 16 && (address.address[0].toInt() and 0xfe) == 0xfc
    }
    /**
     * An address a page read may open: HTTPS (plain http only for the debug fixture hosts), no
     * credentials, and not a literal local or private address. OkHttp connects to a literal address
     * without asking the Dns hook in [exchange], so that hook alone never saw "https://192.168.1.1/".
     */
    private fun pageAddress(value: String): HttpUrl? {
        val url = runCatching { EndpointPolicy.validate(value, debug) }.getOrNull() ?: return null
        val host = url.host.removeSurrounding("[", "]")
        if (debug && host in fixtureHosts) return url
        val literal = when {
            Regex("\\d{1,3}(\\.\\d{1,3}){3}").matches(host) -> runCatching { java.net.InetAddress.getByAddress(host.split('.').map { it.toInt().also { part -> require(part in 0..255) }.toByte() }.toByteArray()) }.getOrNull() ?: return null
            host.contains(':') -> runCatching { java.net.InetAddress.getByName(host) }.getOrNull() ?: return null
            else -> return url
        }
        return url.takeUnless { privateAddress(literal) }
    }
    private val client = http.newBuilder().followRedirects(false).followSslRedirects(false).callTimeout(20, TimeUnit.SECONDS).build()
    // Page bodies of this reply (one adapter serves one reply): reading on through a long page
    // neither downloads it again nor sees a page that changed between two parts.
    private val pages = object : LinkedHashMap<String, DeviceToolResult>(8, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, DeviceToolResult>?) = size > 4
    }
    suspend fun search(runtime: SharedCoreRuntime, args: JsonObject, config: JsonObject, credential: String): DeviceToolResult {
        val search = config["search"]?.jsonObject ?: return DeviceToolResult.error("没有配置 HTTP Search Backend。", "SEARCH_UNAVAILABLE")
        if (credential.isNotBlank() && (credential.length > 4096 || credential.any { it.code !in 33..126 })) return DeviceToolResult.error("Search 凭证格式无效，请只填写 API Key。", "SEARCH_CREDENTIAL_INVALID")
        if (search.text("backend") != "http" || search.text("endpoint").isBlank()) return DeviceToolResult.error("没有可用的 HTTP Search Backend。", "SEARCH_UNAVAILABLE")
        if (search.text("credentialRef").isNotBlank() && credential.isBlank()) return DeviceToolResult.error("Search Backend 缺少本机凭证。", "SEARCH_CREDENTIAL_UNAVAILABLE")
        // A search address this build may not call is an unavailable backend for this lookup, not a failed reply.
        val endpoint = runCatching { EndpointPolicy.validate(search.text("endpoint"), debug) }.getOrElse { return DeviceToolResult.error("Search Backend 地址不可用：" + (it.message ?: "需要完整的 HTTPS 地址。"), "SEARCH_UNAVAILABLE") }
        val effect = runtime.value("searchRequest", buildJsonObject { put("arguments", args); put("config", config) }).jsonObject
        val target = runCatching { EndpointPolicy.validate(effect.text("url"), debug) }.getOrElse { return DeviceToolResult.error("Search Backend 地址不可用：" + (it.message ?: "需要完整的 HTTPS 地址。"), "SEARCH_UNAVAILABLE") }
        if (!(target.host == endpoint.host && target.port == endpoint.port && target.scheme == endpoint.scheme && target.encodedPath == endpoint.encodedPath)) return DeviceToolResult.error("检索请求与凭证地址不匹配。", "SEARCH_UNAVAILABLE")
        val request = Request.Builder().url(target).header("Accept", "application/json")
            .apply {
                if (credential.isNotBlank()) header(effect.text("credentialHeader"), effect.text("credentialPrefix") + credential)
                if (effect.text("method") == "POST") post(effect.getValue("body").toString().toRequestBody("application/json".toMediaType()))
            }.build()
        // The backend's own time limit is one failed lookup. Until 2026-11-10 it left this function as a
        // TimeoutCancellationException, which the loop reads as the run deadline: one slow search ended the
        // reply as "limit reached" (or cut a member off) with most of the budget unused.
        val limit = search["timeoutMs"]?.jsonPrimitive?.longOrNull ?: 20000
        val result = withTimeoutOrNull(limit) { exchange(request, 262_144, timeoutMs = search["timeoutMs"]?.jsonPrimitive?.longOrNull) }
            ?: return DeviceToolResult.error("检索服务在 ${limit / 1000} 秒内没有返回，本次检索未完成。", "SEARCH_TIMEOUT")
        if (!result.ok) return result
        val raw = runCatching { MeloJson.parseToJsonElement(result.data.text("body")) }.getOrNull()
            ?: return DeviceToolResult.error("Search Backend 返回格式无效。", "INVALID_SEARCH_RESPONSE")
        return DeviceToolResult(runtime.value("searchResult", buildJsonObject {
            put("result", raw); put("observation", buildJsonObject { put("fetchedAt", now()); put("backend", effect.text("backend")); put("maxResults", minOf(args["maxResults"]?.jsonPrimitive?.intOrNull ?: search["maxResults"]?.jsonPrimitive?.intOrNull ?: 6, search["maxResults"]?.jsonPrimitive?.intOrNull ?: 8)) })
        }).jsonObject)
    }
    suspend fun fetch(runtime: SharedCoreRuntime, args: JsonObject, requestedUrls: List<String>): DeviceToolResult = page(runtime, args, load(args, requestedUrls))

    /** The network half of a page read. It never touches the shared Runtime, so several may run side by side. */
    suspend fun load(args: JsonObject, requestedUrls: List<String>): DeviceToolResult {
        // "#section" names a place inside a page and is never sent to its server: the page is the same
        // source with or without it. A link with a fragment (most documentation links) was refused as
        // "手机只能直接读取 HTTPS 网页", because the rule for service addresses forbids fragments.
        val target = args.text("url").substringBefore('#')
        if (requestedUrls.none { it.substringBefore('#') == target }) return DeviceToolResult.error("只能读取用户指定或本轮 Search 实际返回的来源 URL。", "FETCH_URL_NOT_IN_EVIDENCE")
        synchronized(pages) { pages[target] }?.let { return it }
        // An address this build may not open (plain http outside the debug fixture hosts, or one OkHttp
        // cannot parse) fails this read only. Thrown from here it used to end the whole reply.
        var url = pageAddress(target) ?: return DeviceToolResult.error("手机只能直接读取 HTTPS 网页，这个地址无法读取。", "FETCH_URL_UNSUPPORTED")
        fun request(address: HttpUrl) = Request.Builder().url(address).header("Accept", "text/html, text/plain, application/json").build()
        var result = exchange(request(url), 1_048_576, publicPage = true)
        // A page that moved (a bare host to www, a trailing slash, a new path) answers with a redirect.
        // The client never follows one by itself, so that no credential travels to another host; a page
        // read carries none, so it is followed here, each hop under the same address rules as the first.
        // Until 2026-11-10 such a page could not be read at all: "检索服务返回 HTTP 301。"
        var hops = 0
        while (true) {
            val location = result.data.text("location")
            if (location.isBlank()) break
            if (++hops > MAX_PAGE_REDIRECTS) return DeviceToolResult.error("这个网页连续跳转超过 $MAX_PAGE_REDIRECTS 次，没有读取。", "FETCH_REDIRECT_LIMIT")
            url = url.resolve(location)?.let { pageAddress(it.toString().substringBefore('#')) }
                ?: return DeviceToolResult.error("这个网页跳转到了手机不能直接读取的地址，没有读取。", "FETCH_URL_UNSUPPORTED")
            result = exchange(request(url), 1_048_576, publicPage = true)
        }
        if (!result.ok) return result
        val type = result.data.text("contentType")
        if (!type.contains("text/") && !type.contains("json")) return DeviceToolResult.error("该页面不是可直接读取的文本；尚未处理附件或动态渲染。", "FETCH_CONTENT_TYPE_UNSUPPORTED")
        synchronized(pages) { pages[target] = result }
        return result
    }

    /** The Core half: one window of a loaded page, starting at the requested offset. */
    suspend fun page(runtime: SharedCoreRuntime, args: JsonObject, loaded: DeviceToolResult): DeviceToolResult {
        if (!loaded.ok) return loaded
        return DeviceToolResult(runtime.value("pageResult", buildJsonObject {
            put("result", buildJsonObject {
                put("url", args.text("url")); put("content", loaded.data.text("body")); put("contentType", loaded.data.text("contentType"))
                args["offset"]?.let { put("offset", it) }
            })
            put("observation", buildJsonObject { put("fetchedAt", now()) })
        }).jsonObject)
    }
    private suspend fun exchange(request: Request, limit: Int, publicPage: Boolean = false, timeoutMs: Long? = null): DeviceToolResult = suspendCancellableCoroutine { continuation ->
        val scopedClient = if(timeoutMs == null) client else client.newBuilder().callTimeout(timeoutMs.coerceIn(3000,120000), TimeUnit.MILLISECONDS).build()
        val pageClient = if (!publicPage) scopedClient else scopedClient.newBuilder().dns { hostname ->
            val addresses = Dns.SYSTEM.lookup(hostname)
            if (!(debug && hostname in fixtureHosts) && addresses.any(::privateAddress)) throw java.net.UnknownHostException("网页来源不能读取本地或私有网络地址。")
            addresses
        }.build()
        val call = pageClient.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) {
                if (continuation.isActive) continuation.resume(DeviceToolResult.error("检索请求中断，未切换到手机屏幕。", "SEARCH_REQUEST_FAILED"))
            }
            override fun onResponse(call: Call, response: Response) {
                val result = try { response.use {
                    if (!it.isSuccessful) {
                        val failed = DeviceToolResult.error(if (publicPage) "网页返回 HTTP ${it.code}，没有读到内容。" else "检索服务返回 HTTP ${it.code}。", "SEARCH_HTTP_${it.code}")
                        val location = it.header("Location").orEmpty()
                        if (publicPage && it.isRedirect && location.isNotBlank()) DeviceToolResult(JsonObject(failed.data + ("location" to JsonPrimitive(location.take(4000))))) else failed
                    }
                    else {
                        val body = it.body
                        val bytes = ModelClient.readBounded(body, limit)
                        DeviceToolResult(buildJsonObject { put("ok", true); put("body", bytes.toString(Charsets.UTF_8)); put("contentType", it.header("Content-Type").orEmpty()) })
                    }
                } } catch (_: Exception) { DeviceToolResult.error("检索响应过大或格式无效。", "SEARCH_RESPONSE_LIMIT") }
                if (continuation.isActive) continuation.resume(result)
            }
        })
    }
}
