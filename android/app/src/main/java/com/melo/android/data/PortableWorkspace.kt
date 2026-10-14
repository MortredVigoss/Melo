package com.melo.android.data

import kotlinx.serialization.json.*

/** Matches mobile-sync/workspaceProtocol.js portableValue, including its defaults.
 * Normalization must precede vector-clock comparison: the server returns normalized
 * values under the original clock, which must not create a spurious conflict.
 */
object PortableWorkspace {
    private fun safeId(value: String) = value !in setOf("__proto__", "prototype", "constructor") && Regex("^[A-Za-z0-9_-]{1,180}$").matches(value)
    private fun text(value: JsonObject, key: String, limit: Int = 12000): String {
        val item = value[key] ?: return ""
        if (item == JsonNull) return ""
        require(item is JsonPrimitive && item.isString && item.content.length <= limit) { "同步文字超过共享协议上限。" }
        return item.content
    }
    private fun yes(value: JsonObject, key: String) = value[key] == JsonPrimitive(true)
    private fun ids(value: JsonObject, key: String): JsonArray = JsonArray(value[key]?.takeIf { it != JsonNull }?.jsonArray.orEmpty().map { it.jsonPrimitive.content }.distinct().sorted().map { it.jp() })
    private fun list(value: JsonObject, key: String, limit: Int): List<JsonElement> = value[key]?.takeIf { it != JsonNull }?.jsonArray.orEmpty().also { require(it.size <= limit) }
    private fun url(value: JsonObject, key: String, endpoint: Boolean = false): String {
        val result = text(value, key, 4000)
        if (result.isNotEmpty()) {
            val uri = java.net.URI(result)
            require(uri.scheme in setOf("http", "https") && uri.host != null && uri.userInfo == null && (!endpoint || uri.query == null && uri.fragment == null)) { "同步网页地址无效。" }
        }
        return result
    }
    private fun model(value: JsonElement?): JsonElement {
        if (value == null || value == JsonNull) return JsonNull
        val row = value.jsonObject
        return buildJsonObject {
            put("connectionID", text(row, "connectionID", 180)); put("name", text(row, "name", 200)); put("model", text(row, "model", 180))
            put("authMode", row.text("authMode").takeIf { it in setOf("codex", "local") } ?: "api-key")
            put("baseURL", url(row, "baseURL", true)); put("apiProtocol", if (row.text("apiProtocol") == "anthropic") "anthropic" else "chat-completions")
        }
    }
    private fun stage(row: JsonObject): JsonObject = buildJsonObject {
        put("id", text(row, "id", 200)); put("module", row.text("module").takeIf { it in setOf("search", "compute", "files", "tools", "create") } ?: "tools")
        put("name", text(row, "name", 200)); put("status", row.text("status").takeIf { it in setOf("queued", "running", "completed", "failed", "cancelled", "interrupted") } ?: "interrupted")
        put("provider", text(row, "provider", 200)); put("input", text(row, "input", 2200)); put("output", text(row, "output"))
        put("query", text(row, "query", 2200)); put("resultSummary", text(row, "resultSummary", 2200)); put("model", text(row, "model", 180))
        put("returnedModel", text(row, "returnedModel", 180)); put("channel", text(row, "channel", 100))
        put("startedAt", text(row, "startedAt", 50)); put("finishedAt", text(row, "finishedAt", 50))
    }
    private fun scene(value: JsonElement?): JsonElement {
        if (value !is JsonObject) return JsonNull
        return buildJsonObject {
            put("runId", value.getValue("runId")); put("status", value.getValue("status")); put("query", text(value, "query"))
            put("startedAt", text(value, "startedAt", 50)); put("finishedAt", text(value, "finishedAt", 50)); put("lastModule", text(value, "lastModule", 50))
            put("requestedModel", text(value, "requestedModel", 180)); put("returnedModel", text(value, "returnedModel", 180)); put("sourceDevice", text(value, "sourceDevice", 200))
            listOf("operations", "pipeline").forEach { key -> put(key, JsonArray(list(value, key, 500).map { stage(it.jsonObject) })) }
            put("sources", buildJsonArray { list(value, "sources", 2000).forEachIndexed { index, item ->
                val row = item.jsonObject
                add(buildJsonObject {
                    put("id", text(row, "id", 200).ifBlank { "source-$index" }); put("url", url(row, "url")); put("title", text(row, "title", 1000)); put("titleProvided", yes(row, "titleProvided"))
                    listOf("order", "rank").forEach { key -> put(key, row[key]?.jsonPrimitive?.longOrNull ?: index.toLong()) }
                    put("reading", row.text("reading").takeIf { it in setOf("unknown", "snippet", "partial", "range-unknown", "extracted", "full") } ?: "unknown")
                    listOf("appeared", "accessed", "opened", "cited").forEach { put(it, yes(row, it)) }
                    listOf(Triple("providers", 30, 200), Triple("queries", 100, 2200)).forEach { (key, count, length) ->
                        put(key, JsonArray(list(row, key, count).map { entry -> text(jsonObject("text" to entry), "text", length).jp() }))
                    }
                })
            } })
        }
    }
    fun value(kind: String, row: JsonObject): JsonObject = buildJsonObject {
        when (kind) {
            "agent" -> {
                put("name", text(row, "name", 200)); put("subtitle", text(row, "subtitle")); put("instructions", text(row, "instructions", 50000))
                put("symbol", text(row, "symbol", 100).ifBlank { "person.crop.square" }); put("avatarData", text(row, "avatarData", 500000))
                listOf("identity", "soul", "systemPrompt").forEach { put(it, text(row, it, 50000)) }
                put("mood", text(row, "mood", 100).ifBlank { "warm" }); put("model", text(row, "model", 180))
            }
            "project" -> {
                put("name", text(row, "name", 200)); put("goal", text(row, "goal")); put("instructions", text(row, "instructions")); put("archived", yes(row, "archived")); put("knowledgeIds", ids(row, "knowledgeIds"))
                put("agentOverrides", JsonObject(row["agentOverrides"]?.jsonObject.orEmpty().mapValues { value("agent", it.value.jsonObject) }))
            }
            "knowledge" -> {
                put("title", text(row, "title", 500)); put("content", text(row, "content", 200000)); put("deleted", yes(row, "deleted"))
                put("kind", text(row, "kind", 100).ifBlank { "note" }); put("language", text(row, "language", 100).ifBlank { "text" })
                put("projectId", row.text("projectId").takeIf(::safeId)?.jp() ?: JsonNull)
            }
            "conversation" -> {
                put("agentId", row.text("agentId").takeIf(::safeId) ?: "main"); put("projectId", row.text("projectId").takeIf(::safeId)?.jp() ?: JsonNull)
                put("knowledgeIds", ids(row, "knowledgeIds")); put("model", model(row["model"]))
            }
            "memory" -> {
                listOf("id", "chatId", "agentId", "scope", "status", "updatedAt").forEach { put(it, row.getValue(it)) }
                put("memoryID", text(row, "memoryID", 180)); put("text", text(row, "text", 2000)); put("originalFact", text(row, "originalFact", 2000))
                put("messageId", text(row, "messageId", 180)); put("projectId", row.text("projectId")); put("sourceText", text(row, "sourceText", 1600)); put("category", text(row, "category", 100)); put("userEdited", yes(row, "userEdited"))
                row["validTo"]?.let { put("validTo", it) }; row.text("mergedInto").takeIf(String::isNotEmpty)?.let { put("mergedInto", it) }
            }
            "message" -> {
                put("chatId", row.getValue("chatId"))
                put("agent", row["agent"]?.takeIf { it != JsonNull }?.jsonObject?.let { agent -> buildJsonObject {
                    put("agentID", text(agent, "agentID", 180)); put("name", text(agent, "name", 200)); put("symbol", text(agent, "symbol", 100).ifBlank { "person.crop.square" })
                } } ?: JsonNull)
                put("models", JsonArray(list(row, "models", 200).map { item ->
                    val receipt = item.jsonObject
                    buildJsonObject {
                        put("requestedModel", text(receipt, "requestedModel", 180)); put("reportedModel", text(receipt, "reportedModel", 180)); put("simulated", yes(receipt, "simulated"))
                        receipt.text("purpose").takeIf(String::isNotEmpty)?.let { put("purpose", text(receipt, "purpose", 100)) }
                    }
                }))
                put("scene", scene(row["scene"]))
            }
            else -> error("Unknown workspace kind")
        }
    }
}
