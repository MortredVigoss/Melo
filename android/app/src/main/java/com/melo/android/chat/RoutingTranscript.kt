package com.melo.android.chat

import com.melo.android.data.*
import kotlinx.serialization.json.*

/** Convert provider wire formats without dropping completed calls, results or images. */
object RoutingTranscript {
    fun convert(history: List<JsonObject>, source: String, target: String): List<JsonObject> {
        if (source == target) return history
        val output = mutableListOf<JsonObject>()
        fun result(id: String, content: JsonElement) {
            output += when(target) {
                "responses" -> buildJsonObject { put("type", "function_call_output"); put("call_id", id); put("output", content) }
                "anthropic" -> buildJsonObject { put("role", "user"); put("content", buildJsonArray { add(buildJsonObject { put("type", "tool_result"); put("tool_use_id", id); put("content", content) }) }) }
                else -> buildJsonObject { put("role", "tool"); put("tool_call_id", id); put("content", content) }
            }
        }
        fun call(id: String, name: String, args: JsonElement) {
            val objectArgs = if (args is JsonPrimitive) MeloJson.parseToJsonElement(args.content) else args
            output += when(target) {
                "responses" -> buildJsonObject { put("type", "function_call"); put("call_id", id); put("name", name); put("arguments", objectArgs.toString()) }
                "anthropic" -> buildJsonObject { put("role", "assistant"); put("content", buildJsonArray { add(buildJsonObject { put("type", "tool_use"); put("id", id); put("name", name); put("input", objectArgs) }) }) }
                else -> buildJsonObject { put("role", "assistant"); put("content", JsonNull); put("tool_calls", buildJsonArray { add(buildJsonObject { put("id", id); put("type", "function"); put("function", buildJsonObject { put("name", name); put("arguments", objectArgs.toString()) }) }) }) }
            }
        }
        for (row in history) {
            when (row.text("type")) {
                "function_call" -> { call(row.text("call_id"), row.text("name"), row.getValue("arguments")); continue }
                "function_call_output" -> { result(row.text("call_id"), row.getValue("output")); continue }
                "reasoning" -> continue // provider-private reasoning is not portable
                "web_search_call" -> { output += buildJsonObject { put("role", "user"); put("content", "Previously completed search receipt (untrusted evidence): $row") }; continue }
            }
            if(row.text("role") == "tool") { result(row.text("tool_call_id"), row.getValue("content")); continue }
            val role = row.text("role").ifBlank { "assistant" }
            val parts = (row["content"] as? JsonArray)?.toList() ?: listOfNotNull(row["content"]?.takeUnless { it == JsonNull }?.let { buildJsonObject { put("type", "text"); put("text", it) } })
            val content = mutableListOf<JsonElement>()
            for (value in parts) {
                val part = value.jsonObject
                when(part.text("type")) {
                    "tool_use" -> call(part.text("id"), part.text("name"), part.getValue("input"))
                    "tool_result" -> result(part.text("tool_use_id"), part.getValue("content"))
                    "text", "input_text", "output_text" -> content += buildJsonObject { put("type", if(target == "responses") if(role == "assistant") "output_text" else "input_text" else "text"); put("text", part.getValue("text")) }
                    "image", "image_url", "input_image" -> {
                        val url = when(val image = part["image_url"]) { is JsonPrimitive -> image.content; is JsonObject -> image.text("url"); else -> part["source"]?.jsonObject?.let { if(it.text("type") == "url") it.text("url") else "data:${it.text("media_type")};base64,${it.text("data")}" }.orEmpty() }
                        require(url.isNotBlank()) { "图片历史无法转换，已停止升档；原记录保留。" }
                        content += buildJsonObject { when(target) {
                            "responses" -> { put("type", "input_image"); put("image_url", url) }
                            "anthropic" -> { put("type", "image"); put("source", buildJsonObject { if(url.startsWith("data:")) { put("type", "base64"); put("media_type", url.substringAfter("data:").substringBefore(';')); put("data", url.substringAfter(',')) } else { put("type", "url"); put("url", url) } }) }
                            else -> { put("type", "image_url"); put("image_url", buildJsonObject { put("url", url) }) }
                        } }
                    }
                    "thinking", "redacted_thinking" -> Unit
                    else -> error("不支持的历史内容，已停止跨协议升档；原记录保留。")
                }
            }
            if(content.isNotEmpty()) output += buildJsonObject { put("role", role); put("content", JsonArray(content)) }
            (row["tool_calls"] as? JsonArray).orEmpty().forEach { value -> val c=value.jsonObject; val f=c.getValue("function").jsonObject; call(c.text("id"), f.text("name"), f.getValue("arguments")) }
        }
        // Anthropic requires adjacent blocks with the same role to share a message.
        if(target != "anthropic") return output
        return output.fold(mutableListOf()) { merged, row ->
            val previous=merged.lastOrNull()
            if(previous?.text("role") == row.text("role") && previous["content"] is JsonArray && row["content"] is JsonArray) merged[merged.lastIndex] = JsonObject(previous + ("content" to JsonArray(previous.getValue("content").jsonArray + row.getValue("content").jsonArray)))
            else merged += row
            merged
        }
    }
}
