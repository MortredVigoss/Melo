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
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** HTTP / TLS / credentials only. Schema, defaults and receipts come from Core. */
class SharedSearchAdapter(private val debug: Boolean, http: OkHttpClient) {
    companion object {
        fun credentialId(endpoint: String, debug: Boolean): String {
            val target = EndpointPolicy.validate(endpoint, debug).toString()
            return "search:" + MessageDigest.getInstance("SHA-256").digest(target.toByteArray()).joinToString("") { "%02x".format(it) }
        }
    }
    private val client = http.newBuilder().followRedirects(false).followSslRedirects(false).callTimeout(20, TimeUnit.SECONDS).build()
    suspend fun search(runtime: SharedCoreRuntime, args: JsonObject, config: JsonObject, credential: String): DeviceToolResult {
        val search = config["search"]?.jsonObject ?: return DeviceToolResult.error("没有配置 HTTP Search Backend。", "SEARCH_UNAVAILABLE")
        if (credential.isNotBlank() && (credential.length > 4096 || credential.any { it.code !in 33..126 })) return DeviceToolResult.error("Search 凭证格式无效，请只填写 API Key。", "SEARCH_CREDENTIAL_INVALID")
        if (search.text("backend") != "http" || search.text("endpoint").isBlank()) return DeviceToolResult.error("没有可用的 HTTP Search Backend。", "SEARCH_UNAVAILABLE")
        if (search.text("credentialRef").isNotBlank() && credential.isBlank()) return DeviceToolResult.error("Search Backend 缺少本机凭证。", "SEARCH_CREDENTIAL_UNAVAILABLE")
        val endpoint = EndpointPolicy.validate(search.text("endpoint"), debug)
        val effect = runtime.value("searchRequest", buildJsonObject { put("arguments", args); put("config", config) }).jsonObject
        val target = EndpointPolicy.validate(effect.text("url"), debug)
        require(target.host == endpoint.host && target.port == endpoint.port && target.scheme == endpoint.scheme && target.encodedPath == endpoint.encodedPath) { "检索请求与凭证地址不匹配。" }
        val request = Request.Builder().url(target).header("Accept", "application/json")
            .apply {
                if (credential.isNotBlank()) header(effect.text("credentialHeader"), effect.text("credentialPrefix") + credential)
                if (effect.text("method") == "POST") post(effect.getValue("body").toString().toRequestBody("application/json".toMediaType()))
            }.build()
        val result = exchange(request, 262_144)
        if (!result.ok) return result
        val raw = runCatching { MeloJson.parseToJsonElement(result.data.text("body")) }.getOrNull()
            ?: return DeviceToolResult.error("Search Backend 返回格式无效。", "INVALID_SEARCH_RESPONSE")
        return DeviceToolResult(runtime.value("searchResult", buildJsonObject {
            put("result", raw); put("observation", buildJsonObject { put("fetchedAt", now()); put("backend", effect.text("backend")) })
        }).jsonObject)
    }
    suspend fun fetch(runtime: SharedCoreRuntime, args: JsonObject, requestedUrls: List<String>): DeviceToolResult {
        val target = args.text("url")
        require(target in requestedUrls) { "本轮只允许读取用户指定的 URL。" }
        val request = Request.Builder().url(EndpointPolicy.validate(target, debug)).header("Accept", "text/html, text/plain, application/json").build()
        val result = exchange(request, 1_048_576)
        if (!result.ok) return result
        val type = result.data.text("contentType")
        if (!type.contains("text/") && !type.contains("json")) return DeviceToolResult.error("该页面不是可直接读取的文本；尚未处理附件或动态渲染。", "FETCH_CONTENT_TYPE_UNSUPPORTED")
        return DeviceToolResult(runtime.value("pageResult", buildJsonObject {
            put("result", buildJsonObject { put("url", target); put("content", result.data.text("body")); put("contentType", type) })
            put("observation", buildJsonObject { put("fetchedAt", now()) })
        }).jsonObject)
    }
    private suspend fun exchange(request: Request, limit: Int): DeviceToolResult = suspendCancellableCoroutine { continuation ->
        val call = client.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) {
                if (continuation.isActive) continuation.resume(DeviceToolResult.error("检索请求中断，未切换到手机屏幕。", "SEARCH_REQUEST_FAILED"))
            }
            override fun onResponse(call: Call, response: Response) {
                val result = try { response.use {
                    if (!it.isSuccessful) DeviceToolResult.error("检索服务返回 HTTP ${it.code}。", "SEARCH_HTTP_${it.code}")
                    else {
                        val body = it.body ?: error("Empty response")
                        val bytes = ModelClient.readBounded(body, limit)
                        DeviceToolResult(buildJsonObject { put("ok", true); put("body", bytes.toString(Charsets.UTF_8)); put("contentType", it.header("Content-Type").orEmpty()) })
                    }
                } } catch (_: Exception) { DeviceToolResult.error("检索响应过大或格式无效。", "SEARCH_RESPONSE_LIMIT") }
                if (continuation.isActive) continuation.resume(result)
            }
        })
    }
}
