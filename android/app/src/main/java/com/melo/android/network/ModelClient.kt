package com.melo.android.network

import com.melo.android.data.*
import com.melo.android.data.Connection
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.io.EOFException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class ModelReply(val text: String, val model: String?, val simulated: Boolean = false, val outcome: String = "completed", val stopReason: String? = null, val publicSummary: String? = null)

object EndpointPolicy {
    private val fixtureHosts = setOf("127.0.0.1", "localhost", "10.0.2.2")
    fun validate(value: String, debug: Boolean = false): HttpUrl {
        val url = value.trim().toHttpUrlOrNull() ?: error("请输入有效的完整 HTTPS 服务地址。")
        require(url.username.isEmpty() && url.password.isEmpty() && url.fragment == null) { "服务地址不能包含凭证或 fragment。" }
        require(url.isHttps || debug && url.host in fixtureHosts && url.scheme == "http") { "模型和同步服务必须使用 HTTPS；HTTP 仅限 Debug 本地 Fixture。" }
        return url
    }
}

class ModelClient(private val debug: Boolean, val http: OkHttpClient = OkHttpClient.Builder()
    .followRedirects(false).followSslRedirects(false).connectTimeout(20, TimeUnit.SECONDS)
    .readTimeout(90, TimeUnit.SECONDS).callTimeout(15, TimeUnit.MINUTES).build()) {
    suspend fun reply(connection: Connection, key: String, messages: List<Message>, instructions: String,
                      imageData: (Attachment) -> String, onDelta: (String) -> Unit): ModelReply {
        ConnectionPolicy.validate(connection, key, debug)
        if (connection.protocol == "fixture") {
            val answer = "这是本地 Fixture 回复，用于验证 Melo Android 的聊天、取消、存储和后台恢复。\n\n收到：${messages.lastOrNull { it.role == "user" }?.content.orEmpty()}\n\n没有调用真实模型服务。"
            var text = ""
            for (chunk in answer.chunked(5)) { delay(70); text += chunk; onDelta(text) }
            return ModelReply(text, "local-fixture", true)
        }
        val url = EndpointPolicy.validate(connection.endpoint, debug)
        val context = messages.dropWhile { it.role != "user" }
        val requestMessages = buildJsonArray {
            if (connection.protocol == "chat-completions") add(buildJsonObject { put("role", "system"); put("content", instructions) })
            context.forEach { message -> add(buildJsonObject {
                put("role", message.role)
                if (message.attachments.isEmpty()) put("content", message.content)
                else put("content", buildJsonArray {
                    add(buildJsonObject { put("type", if (connection.protocol == "responses") "input_text" else "text"); put("text", message.content) })
                    message.attachments.forEach { image ->
                        val data = imageData(image)
                        add(buildJsonObject {
                            when (connection.protocol) {
                                "anthropic" -> { put("type", "image"); put("source", buildJsonObject { put("type", "base64"); put("media_type", image.mime); put("data", data) }) }
                                "responses" -> { put("type", "input_image"); put("image_url", "data:${image.mime};base64,$data") }
                                else -> { put("type", "image_url"); put("image_url", buildJsonObject { put("url", "data:${image.mime};base64,$data") }) }
                            }
                        })
                    }
                })
            }) }
        }
        val payload = buildJsonObject {
            put("model", connection.model); put("stream", connection.stream)
            if (connection.protocol == "responses") { put("input", requestMessages); put("max_output_tokens", minOf(8000, connection.contextTokens / 3)); put("instructions", instructions); put("store", false) }
            else { put("messages", requestMessages); if (connection.protocol == "anthropic") { put("system", instructions); put("max_tokens", minOf(8000, connection.contextTokens / 3)) } }
        }
        val request = Request.Builder().url(url).post(payload.toString().toRequestBody("application/json".toMediaType()))
            .header("Accept", if (connection.stream) "text/event-stream, application/json" else "application/json")
            .apply { if (connection.protocol == "anthropic") { header("x-api-key", key); header("anthropic-version", "2023-06-01") } else header("Authorization", "Bearer $key") }.build()
        return suspendCancellableCoroutine { continuation ->
            val call = http.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) { if (continuation.isActive) continuation.resumeWithException(IOException("模型连接中断，请检查网络后重试；原记录已保留。", e)) }
                override fun onResponse(call: Call, response: Response) {
                    try {
                        val result = response.use {
                            require(response.isSuccessful) { statusError(response.code) }
                            val body = response.body ?: error("模型没有返回内容。")
                            if (response.header("Content-Type").orEmpty().contains("text/event-stream")) {
                                val decoder = StreamDecoder(connection.protocol)
                                var frame = StringBuilder()
                                var bytes = 0L
                                fun flush() {
                                    if (frame.isEmpty()) return
                                    decoder.accept(frame.toString().trimEnd('\n'))
                                    onDelta(decoder.text)
                                    frame = StringBuilder()
                                }
                                val source = body.source()
                                while (!source.exhausted()) {
                                    if (!continuation.isActive) throw CancellationException()
                                    val line = try { source.readUtf8LineStrict(1024 * 1024L) }
                                    catch (_: EOFException) { require(source.buffer.size <= 1024 * 1024L) { "服务事件超过单条容量限制。" }; source.readUtf8Line() } ?: break
                                    bytes += line.toByteArray().size
                                    require(bytes <= 16 * 1024 * 1024) { "模型响应超过容量限制。" }
                                    when { line.isBlank() -> flush(); line.startsWith("data:") -> frame.append(line.substring(5).removePrefix(" ")).append('\n') }
                                }
                                flush(); decoder.finish()
                            } else {
                                val bytes = readBounded(body, 8 * 1024 * 1024)
                                decodeResponse(MeloJson.parseToJsonElement(String(bytes)).jsonObject, connection.protocol)
                            }
                        }
                        if (continuation.isActive) continuation.resume(result)
                    } catch (error: Throwable) { if (continuation.isActive) continuation.resumeWithException(error) }
                }
            })
        }
    }
    suspend fun sync(endpoint: String, token: String, snapshot: Snapshot): JsonObject = withContext(Dispatchers.IO) {
        require(token.length >= 32) { "同步密钥至少需要 32 个字符。" }
        val payload = MeloJson.encodeToString(snapshot)
        require(payload.toByteArray().size <= SyncProtocol.MAX_BYTES) { "同步资料超过 8 MiB。" }
        val request = Request.Builder().url(EndpointPolicy.validate(endpoint, debug)).header("Authorization", "Bearer $token")
            .post(payload.toRequestBody("application/json".toMediaType())).build()
        http.newCall(request).execute().use { response ->
            require(response.isSuccessful) { statusError(response.code) }
            val bytes = readBounded(response.body ?: error("同步服务没有返回内容。"), SyncProtocol.MAX_BYTES)
            MeloJson.parseToJsonElement(String(bytes)).jsonObject
        }
    }
    companion object {
        fun readBounded(body: ResponseBody, max: Int): ByteArray {
            val source = body.source()
            source.request(max.toLong() + 1)
            require(source.buffer.size <= max) { "服务响应超过容量限制，原记录已保留。" }
            return source.readByteArray()
        }
        fun statusError(code: Int): String = when (code) {
            401, 403 -> "服务拒绝凭证（$code），请检查连接设置。"
            409 -> "同步冲突，原有记录已保留。"
            413 -> "服务容量上限（413），请减少资料。"
            429 -> "服务限流或额度不足（429），请稍后重试。"
            in 300..399 -> "服务返回 Redirect，已停止，避免把凭证发送至其他地址。"
            else -> "服务请求失败（$code），原记录已保留。"
        }
        fun decodeResponse(value: JsonObject, protocol: String): ModelReply {
            require(value["error"] == null || value["error"] == JsonNull) { "模型返回错误，未保存为完整回答。" }
            val text = when (protocol) {
                "anthropic" -> { require(value.text("stop_reason") in setOf("end_turn", "stop_sequence")) { "模型未完成回复。" }; value["content"]?.jsonArray.orEmpty().filter { it.jsonObject.text("type") == "text" }.joinToString("") { it.jsonObject.text("text") } }
                "responses" -> { require(value.text("status") == "completed") { "模型回复尚未完成。" }; value["output"]?.jsonArray.orEmpty().flatMap { it.jsonObject["content"]?.jsonArray.orEmpty() }.filter { it.jsonObject.text("type") == "output_text" }.joinToString("") { it.jsonObject.text("text") } }
                else -> {
                    val choice = value["choices"]?.jsonArray?.firstOrNull()?.jsonObject ?: error("模型没有返回回答。")
                    require(choice.text("finish_reason") == "stop") { "模型回复被截断或缺少完成回执。" }
                    choice["message"]?.jsonObject?.text("content").orEmpty()
                }
            }
            require(text.isNotBlank()) { "模型没有返回文字内容。" }
            val summary = if (protocol == "responses") value["output"]?.jsonArray.orEmpty().filter { it.jsonObject.text("type") == "reasoning" }
                .flatMap { it.jsonObject["summary"]?.jsonArray.orEmpty() }.filter { it.jsonObject.text("type") == "summary_text" }.joinToString("\n") { it.jsonObject.text("text") }.take(12000).ifBlank { null } else null
            return ModelReply(text, value.text("model").ifBlank { null }, publicSummary = summary)
        }
    }
}

class StreamDecoder(private val protocol: String) {
    var text = ""; private set
    private var model: String? = null
    private var terminal = false
    private var stopped = false
    private var summary: String? = null
    fun accept(data: String) {
        if (data == "[DONE]") { terminal = true; return }
        val value = MeloJson.parseToJsonElement(data).jsonObject
        require((value["error"] == null || value["error"] == JsonNull) && value.text("type") !in setOf("error", "response.failed", "response.incomplete")) { "模型流返回错误或未完成，部分文字已保留。" }
        value.text("model").takeIf(String::isNotBlank)?.let { model = it }
        when (protocol) {
            "responses" -> when (value.text("type")) {
                "response.output_text.delta" -> text += value.text("delta")
                "response.completed" -> {
                    val response = value["response"]?.jsonObject ?: error("缺少完成回执。")
                    val final = ModelClient.decodeResponse(response, "responses")
                    // The terminal output is authoritative; deltas may be missing or revised.
                    text = final.text; model = final.model ?: model; summary = final.publicSummary; terminal = true; stopped = true
                }
            }
            "anthropic" -> when (value.text("type")) {
                "message_start" -> model = value["message"]?.jsonObject?.text("model")
                "content_block_delta" -> { val delta = value["delta"]?.jsonObject; if (delta?.text("type") == "text_delta") text += delta.text("text") }
                "message_delta" -> { val reason = value["delta"]?.jsonObject?.text("stop_reason").orEmpty(); if (reason.isNotEmpty()) { require(reason in setOf("end_turn", "stop_sequence")) { "模型回复未完成。" }; stopped = true } }
                "message_stop" -> terminal = true
            }
            else -> value["choices"]?.jsonArray.orEmpty().filter { it.jsonObject["index"]?.jsonPrimitive?.intOrNull in setOf(null, 0) }.forEach { item ->
                val choice = item.jsonObject
                text += choice["delta"]?.jsonObject?.text("content").orEmpty()
                val reason = choice.text("finish_reason")
                if (reason.isNotEmpty()) { require(reason == "stop") { "模型回复未完成（$reason）。" }; stopped = true }
            }
        }
    }
    fun finish(): ModelReply {
        require(stopped && (terminal || protocol == "chat-completions") && text.isNotBlank()) { "连接结束但缺少完整回复回执；部分文字已保留，可重试。" }
        return ModelReply(text, model, publicSummary = summary)
    }
}
