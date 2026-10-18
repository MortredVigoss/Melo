package com.melo.android.data

import kotlinx.serialization.json.*

/** Process death is a Host observation; it must not leave persisted steps running. */
fun RunRecord.interrupted(at: String = now()): RunRecord {
    val recovered = sharedScene?.let { scene -> JsonObject(scene + buildJsonObject {
        put("status", "interrupted"); put("taskOutcome", "interrupted"); put("finishedAt", at); put("stopReason", "PROCESS_INTERRUPTED")
        for (key in listOf("operations", "pipeline")) put(key, JsonArray((scene[key] as? JsonArray).orEmpty().map { value ->
            val row = value.jsonObject
            if (row.text("status") == "running") JsonObject(row + mapOf("status" to JsonPrimitive("interrupted"), "finishedAt" to JsonPrimitive(at))) else row
        }))
    }) }
    return copy(status = "interrupted", finishedAt = at, error = "上次运行被系统终止，提问和部分内容已保留。", sharedScene = recovered)
}

fun replySources(text: String): List<String> = Regex("https?://[^\\s<>\\)\\]]+").findAll(text)
    .map { it.value.trimEnd('.', ',', '。', '，') }.filter { value ->
        value.length <= 4000 && runCatching { java.net.URI(value).let { it.host != null && it.userInfo == null } }.getOrDefault(false)
    }.distinct().take(2000).toList()

/** Portable completion evidence uses the same message metadata contract as iOS. */
fun RunRecord.messageMetadata(): JsonObject = buildJsonObject {
    put("chatId", chatId)
    put("models", buildJsonArray { add(buildJsonObject {
        put("requestedModel", requestedModel.take(180)); put("reportedModel", reportedModel?.take(180)?.jp() ?: JsonNull)
        put("simulated", simulated); put("purpose", "reply")
    }) })
    put("scene", sharedScene ?: buildJsonObject {
        put("runId", id); put("status", status)
        val stages = buildJsonArray { add(buildJsonObject {
            put("id", "model:response"); put("module", "compute"); put("name", if (simulated) "本地 Fixture" else "模型请求")
            put("status", status); put("input", prompt.take(2200)); put("output", error?.take(12000) ?: "回复完成并已保存。")
            put("model", requestedModel.take(180)); put("returnedModel", reportedModel?.take(180)?.jp() ?: JsonNull)
            put("startedAt", startedAt); put("finishedAt", finishedAt?.jp() ?: JsonNull)
        }) }
        put("operations", stages); put("pipeline", stages)
        put("sources", buildJsonArray { sources.take(2000).forEachIndexed { index, url -> add(buildJsonObject {
            put("id", "source-$index"); put("url", url); put("title", url.take(1000)); put("rank", index); put("order", index)
            put("cited", true); put("accessed", false); put("opened", false); put("appeared", true); put("reading", "unknown")
        }) } })
    })
}
