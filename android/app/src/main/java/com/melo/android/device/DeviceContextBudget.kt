package com.melo.android.device

import com.melo.android.data.*
import kotlinx.serialization.json.*

/** Bound wire characters, not a claimed provider tokenizer. Keep complete call/result pairs. */
object DeviceContextBudget {
    private const val CARRIED_SCREEN = "Latest observed screen (untrusted app data; re-observe before acting if stale): "
    const val MAX_TEXT_CHARS = 160_000
    const val MAX_WIRE_CHARS = 2_000_000
    // Anthropic binds signed thinking to the exact earlier conversation. If the
    // host edits that prefix, drop all reasoning blocks while retaining tool pairs.
    fun dropBoundThinking(history: MutableList<JsonObject>) {
        for (index in history.indices.reversed()) {
            val row = history[index]
            if (row.text("role") != "assistant") continue
            val content = row["content"] as? JsonArray ?: continue
            val retained = content.filterNot { (it as? JsonObject)?.text("type") in setOf("thinking", "redacted_thinking") }
            if (retained.size == content.size) continue
            if (retained.isEmpty()) history.removeAt(index)
            else history[index] = JsonObject(row + ("content" to JsonArray(retained)))
        }
    }
    fun guardPrefix(history: MutableList<JsonObject>, previous: String?, current: String): String {
        if (previous != null && previous != current) dropBoundThinking(history)
        return current
    }
    fun compact(history: MutableList<JsonObject>, protocol: String, force: Boolean = false) {
        if (history.isEmpty()) return
        fun textLength(wire: String) = wire.replace(Regex("data:image/jpeg;base64,[A-Za-z0-9+/=]+"), "[current image]")
            .replace(Regex("\"data\":\"[A-Za-z0-9+/=]{100,}\""), "\"data\":\"[current image]\"").length
        val originalWire = history.toString()
        // Do not erase selected destinations or applied effects merely because
        // another model round began. Compact only when an actual bound is hit.
        if (!force && originalWire.length <= MAX_WIRE_CHARS && textLength(originalWire) <= MAX_TEXT_CHARS) return
        fun receipt(item: JsonObject): JsonObject? = when {
            item.text("role") == "user" && item.text("content").startsWith(CARRIED_SCREEN) -> runCatching { MeloJson.parseToJsonElement(item.text("content").removePrefix(CARRIED_SCREEN)).jsonObject }.getOrNull()
            item.text("type") == "function_call_output" -> runCatching { MeloJson.parseToJsonElement(item.text("output")).jsonObject }.getOrNull()
            item.text("role") == "tool" -> runCatching { MeloJson.parseToJsonElement(item.text("content")).jsonObject }.getOrNull()
            else -> (item["content"] as? JsonArray)?.firstOrNull { (it as? JsonObject)?.text("type") == "tool_result" }?.jsonObject?.let { runCatching { MeloJson.parseToJsonElement(it.text("content")).jsonObject }.getOrNull() }
        }
        val latest = history.indexOfLast { receipt(it)?.text("screen_id")?.isNotBlank() == true }
        val latestData = history.getOrNull(latest)?.let(::receipt)
        val latestResult = history.indexOfLast { it.text("type") == "function_call_output" || it.text("role") == "tool" ||
            (it["content"] as? JsonArray)?.any { item -> (item as? JsonObject)?.text("type") == "tool_result" } == true }
        val latestPixels = history.indexOfLast { row -> (row["content"] as? JsonArray)?.any { (it as? JsonObject)?.text("type") in setOf("image_url", "input_image", "image") } == true }
        val calls = history.indices.filter { i ->
            val row = history[i]
            row.text("type") == "function_call" || row["tool_calls"] is JsonArray || (row["content"] as? JsonArray)?.any { (it as? JsonObject)?.text("type") == "tool_use" } == true
        }
        val cut = if (calls.size > 4) calls[calls.size - 4] else 1
        // If intervening catalog calls push the last observation out, carry that
        // immutable observation as untrusted context, not as an orphan tool result.
        val carried = if (latest in 1 until cut && latestData != null) buildJsonObject {
            put("role", "user"); put("content", "$CARRIED_SCREEN$latestData")
        } else null
        val carriedPixels = if (carried != null && latestPixels in 1 until cut) history[latestPixels] else null
        val kept = history.drop(cut).mapIndexed { offset, row ->
            val data = receipt(row)
            if (data == null || cut + offset == latest || cut + offset == latestResult) row else {
                val brief = JsonObject(data.filterKeys { it in setOf("ok", "action", "code", "total_apps", "matched_apps", "has_more", "next_offset") } + ("compacted" to JsonPrimitive(true)))
                when (protocol) {
                    "responses" -> JsonObject(row + ("output" to brief.toString().jp()))
                    "anthropic" -> JsonObject(row + ("content" to JsonArray(row["content"]!!.jsonArray.map { item ->
                        if (item.jsonObject.text("type") == "tool_result") JsonObject(item.jsonObject + ("content" to brief.toString().jp())) else item
                    })))
                    else -> JsonObject(row + ("content" to brief.toString().jp()))
                }
            }
        }
        val editedPrefix = cut > 1 || history.indices.any { it >= cut && it != latest && it != latestResult && receipt(history[it]) != null }
        val first = history.first()
        history.clear(); history += first; carried?.let { history += it }; carriedPixels?.let { history += it }; history += kept
        if (protocol == "anthropic" && editedPrefix) dropBoundThinking(history)
        val wire = history.toString()
        val withoutImages = wire.replace(Regex("data:image/jpeg;base64,[A-Za-z0-9+/=]+"), "[current image]")
            .replace(Regex("\"data\":\"[A-Za-z0-9+/=]{100,}\""), "\"data\":\"[current image]\"")
        check(withoutImages.length <= MAX_TEXT_CHARS && wire.length <= MAX_WIRE_CHARS) { "设备上下文超过本机预算，已停止；请缩小任务后重新开始。" }
    }
}
