package com.melo.android.network

import com.melo.android.data.*
import kotlinx.serialization.json.*

/** Collect wire fragments; no call can be dispatched until a valid terminal receipt. */
internal class ToolStreamDecoder(private val protocol: String, private val progress: (String) -> Unit = {}) {
    private var model = ""
    private var text = ""
    private var reasoning: String? = null
    private var finishReason = ""
    private var terminal = false
    private var usage: JsonObject? = null
    private var response: JsonObject? = null
    private val calls = sortedMapOf<Int, JsonObject>()
    private val blocks = sortedMapOf<Int, JsonObject>()
    private val inputs = mutableMapOf<Int, String>()
    private val openBlocks = mutableSetOf<Int>()
    val isTerminal: Boolean get() = terminal

    private fun JsonObject.index(): Int = get("index")?.jsonPrimitive?.intOrNull?.also { require(it in 0..127) } ?: error("Missing stream index")
    fun accept(data: String) {
        if (data == "[DONE]") { require(protocol == "chat-completions" && finishReason.isNotBlank()); terminal = true; return }
        require(!terminal) { "Data after terminal response" }
        val value = MeloJson.parseToJsonElement(data).jsonObject
        require(value["error"] == null || value["error"] == JsonNull) { "Provider stream error" }
        if (protocol != "anthropic") value["usage"]?.takeIf { it is JsonObject }?.jsonObject?.let { usage = it }
        value.text("model").takeIf(String::isNotBlank)?.let { model = it }
        when (protocol) {
            "responses" -> when (value.text("type")) {
                "error", "response.failed", "response.incomplete" -> error("Incomplete response stream")
                "response.output_text.delta" -> progress("模型正在返回文字…")
                "response.function_call_arguments.delta" -> progress("模型正在生成工具参数，尚未执行…")
                "response.completed" -> { response = value["response"]!!.jsonObject; terminal = true }
            }
            "anthropic" -> when (value.text("type")) {
                "error" -> error("Provider stream error")
                "message_start" -> {
                    val message = value["message"]!!.jsonObject
                    model = message.text("model"); usage = message["usage"]?.jsonObject
                }
                "content_block_start" -> {
                    val index = value.index(); require(index !in blocks)
                    blocks[index] = value["content_block"]!!.jsonObject
                    openBlocks += index
                }
                "content_block_delta" -> {
                    val index = value.index(); val block = blocks[index] ?: error("Unknown block")
                    val delta = value["delta"]!!.jsonObject
                    when (delta.text("type")) {
                        "text_delta" -> { blocks[index] = JsonObject(block + ("text" to JsonPrimitive(block.text("text") + delta.text("text")))); progress("模型正在返回文字…") }
                        "input_json_delta" -> { inputs[index] = inputs[index].orEmpty() + delta.text("partial_json"); require(inputs[index]!!.length <= 12_000); progress("模型正在生成工具参数，尚未执行…") }
                        // Keep signed opaque content for subsequent provider requests. Never display it.
                        "thinking_delta" -> blocks[index] = JsonObject(block + ("thinking" to JsonPrimitive(block.text("thinking") + delta.text("thinking"))))
                        "signature_delta" -> blocks[index] = JsonObject(block + ("signature" to JsonPrimitive(block.text("signature") + delta.text("signature"))))
                    }
                }
                "content_block_stop" -> {
                    val index = value.index(); val block = blocks[index] ?: error("Unknown block")
                    require(openBlocks.remove(index))
                    inputs.remove(index)?.let { blocks[index] = JsonObject(block + ("input" to MeloJson.parseToJsonElement(it).jsonObject)) }
                }
                "message_delta" -> {
                    finishReason = value["delta"]!!.jsonObject.text("stop_reason")
                    value["usage"]?.jsonObject?.let { usage = JsonObject(usage.orEmpty() + it) }
                }
                "message_stop" -> { require(inputs.isEmpty() && openBlocks.isEmpty()); terminal = true }
            }
            else -> value["choices"]?.jsonArray.orEmpty().forEach { row ->
                val choice = row.jsonObject
                if ((choice["index"]?.jsonPrimitive?.intOrNull ?: 0) != 0) return@forEach
                val delta = choice["delta"]?.takeIf { it is JsonObject }?.jsonObject
                if (delta != null) {
                    delta["reasoning_content"]?.takeIf { it is JsonPrimitive && it != JsonNull }?.jsonPrimitive?.content?.let { reasoning = reasoning.orEmpty() + it }
                    delta["content"]?.takeIf { it is JsonPrimitive && it != JsonNull }?.jsonPrimitive?.content?.let { text += it; progress("模型正在返回文字…") }
                    delta["tool_calls"]?.jsonArray.orEmpty().forEach { item ->
                        val fragment = item.jsonObject; val index = fragment.index(); val prior = calls[index]
                        val oldFunction = prior?.get("function")?.jsonObject
                        val fn = fragment["function"]?.jsonObject
                        val args = oldFunction?.text("arguments").orEmpty() + fn?.text("arguments").orEmpty()
                        require(args.length <= 12_000)
                        calls[index] = buildJsonObject {
                            put("id", prior?.text("id").orEmpty() + fragment.text("id")); put("type", "function")
                            put("function", buildJsonObject { put("name", oldFunction?.text("name").orEmpty() + fn?.text("name").orEmpty()); put("arguments", args) })
                        }
                        progress("模型正在生成工具参数，尚未执行…")
                    }
                }
                choice.text("finish_reason").takeIf(String::isNotBlank)?.let { finishReason = it }
            }
        }
    }
    fun finish(): JsonObject = when (protocol) {
        "responses" -> { require(terminal); response ?: error("No completed response") }
        "anthropic" -> {
            require(terminal && finishReason in setOf("end_turn", "tool_use"))
            buildJsonObject { put("model", model); put("stop_reason", finishReason); put("content", JsonArray(blocks.values.toList())); usage?.let { put("usage", it) } }
        }
        else -> {
            // Compatible servers may end at finish_reason instead of sending [DONE].
            require(finishReason in setOf("stop", "tool_calls"))
            buildJsonObject {
                put("model", model); usage?.let { put("usage", it) }
                put("choices", buildJsonArray { add(buildJsonObject {
                    put("finish_reason", finishReason); put("message", buildJsonObject {
                        put("role", "assistant"); put("content", text); put("tool_calls", JsonArray(calls.values.toList()))
                        reasoning?.let { put("reasoning_content", it) }
                    })
                }) })
            }
        }
    }
}
