package com.melo.android.chat

import com.melo.android.core.value
import com.melo.android.core.SharedCoreRuntime
import com.melo.android.core.SharedRunBudget
import com.melo.android.data.*
import com.melo.android.device.DeviceAgentClient
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

/** Immutable connection/credential snapshot. Tier decisions execute in shared JS. */
data class SmartRoutingConfig(val mode: String, val policy: JsonObject, val connections: List<Connection>, val keys: Map<String, String>, val fixedModel: String = "")
class SmartRouting(private val runtime: SharedCoreRuntime, private val config: SmartRoutingConfig, private val current: Connection, private val messages: List<Message>) {
    private lateinit var input: JsonObject
    lateinit var decision: JsonObject
        private set
    private val assigned = config.policy["tiers"]?.jsonObject?.values?.flatMap { it.jsonArray.map { row -> row.jsonObject } }.orEmpty()
    val model get() = decision.text("model")
    val connectionId get() = decision.text("connectionId")
    var sideEffects = false
    val active get() = decision.text("mode") == "smart"
    fun connection(): Connection = (config.connections.find { it.id == connectionId } ?: current.takeIf { it.id == connectionId } ?: error("所选智能模型的连接已不可用。")).copy(model = model)
    fun key(): String = config.keys[connectionId].orEmpty()
    suspend fun prepare(client: DeviceAgentClient, budget: SharedRunBudget, onDecision: suspend (String, String, String) -> Unit) {
        val candidates = config.connections.flatMap { c -> (c.models + c.model).filter(String::isNotBlank).distinct().map { model -> buildJsonObject {
            put("connectionId", c.id); put("model", model); put("contextWindow", c.contextTokens); put("available", config.keys[c.id]?.isNotBlank() == true)
            put("capabilities", buildJsonObject { put("tools", true); put("vision", assigned.any { it.text("connectionId") == c.id && it.text("model") == model && it["vision"]?.jsonPrimitive?.booleanOrNull == true }) }) } } }
        var policy = JsonObject(buildJsonObject { put("defaultMode", "fixed"); put("preference", "balanced"); put("allowEscalation", true); put("allowCrossConnection", false) } + config.policy)
        val local = candidates.filter { it.text("connectionId") == current.id }
        if (assigned.isEmpty() && local.size == 1) policy = JsonObject(policy + ("tiers" to buildJsonObject { for(tier in listOf("light","standard","strong")) put(tier, JsonArray(local)) }))
        input = buildJsonObject {
            put("mode", config.mode); put("policy", policy); put("candidates", JsonArray(candidates)); put("connectionId", current.id); put("defaultModel", current.model); put("fixedModel", config.fixedModel)
            put("text", messages.lastOrNull { it.role == "user" }?.content.orEmpty())
            put("context", JsonArray(messages.map { buildJsonObject { put("role", it.role); put("content", it.content) } }))
            put("attachments", JsonArray(messages.lastOrNull { it.role == "user" }?.attachments.orEmpty().map { buildJsonObject { put("kind", if(it.mime.startsWith("image/")) "image" else "file") } }))
        }
        decision = runtime.value("modelRouting", buildJsonObject { put("routing", input) }).jsonObject
        val cacheKey = java.security.MessageDigest.getInstance("SHA-256").digest((input.toString() + config.connections.toString() + config.keys.toSortedMap().toString()).toByteArray()).joinToString("") { "%02x".format(it) }
        val cached = cache[cacheKey]?.takeIf { System.currentTimeMillis() - it.first < 300_000 }?.second
        if (decision["judge"] is JsonObject && cached != null) {
            input = JsonObject(input + buildJsonObject { put("judgmentAttempted", true); put("judgment", cached) })
            decision = runtime.value("modelRouting", buildJsonObject { put("routing", input) }).jsonObject
        }
        val judge = decision["judge"] as? JsonObject
        if(judge != null) {
            val c = (config.connections.find { it.id == judge.text("connectionId") } ?: error("判断连接已不可用。")).copy(model = judge.text("model"))
            val prompt = runtime.value("modelRouting", buildJsonObject { put("action", "prompt") }).jsonPrimitive.content
            val history = listOf(buildJsonObject { put("role", "user"); put("content", messages.filter { it.role == "user" }.takeLast(4).joinToString("\n") { it.content }) })
            var judgment: JsonElement = JsonNull
            try {
                val result = withTimeout(3000) { budget.model(SharedRunBudget.estimateInput(history, prompt), { it.inputTokens }) {
                    client.next(c, config.keys[c.id].orEmpty(), history, prompt, true, emptyList(), nativeWebSearch = false, outputLimit = 512)
                } }
                judgment = runtime.value("modelRouting", buildJsonObject { put("action", "parse"); put("text", result.text) })
                if (judgment is JsonObject) { if(cache.size >= 128) cache.clear(); cache[cacheKey] = System.currentTimeMillis() to judgment }
                onDecision("model-routing:judge", c.model, "completed")
            } catch(error: Throwable) { currentCoroutineContext().ensureActive(); if(error is com.melo.android.core.SharedBudgetExhausted) throw error; onDecision("model-routing:judge", c.model, "failed") }
            input = JsonObject(input + buildJsonObject { put("judgmentAttempted", true); put("judgment", judgment) })
            decision = runtime.value("modelRouting", buildJsonObject { put("routing", input) }).jsonObject
        }
        if(active) onDecision("model-routing:0", runtime.value("modelRouting", buildJsonObject { put("action", "label"); put("decision", decision) }).jsonPrimitive.content, "completed")
    }
    suspend fun escalate(rounds: Int, failures: Int, requested: Boolean, stopped: Boolean): Boolean {
        val route = JsonObject(input + buildJsonObject { put("previous", decision); put("sideEffects", sideEffects); put("rounds", rounds); put("failures", failures); put("requested", requested); put("stopped", stopped) })
        val result = runtime.value("modelRouting", buildJsonObject { put("action", "escalate"); put("routing", route) }) as? JsonObject ?: return false
        decision = result; return true
    }
    companion object {
        private val cache = java.util.concurrent.ConcurrentHashMap<String, Pair<Long, JsonElement>>()
        val control = buildJsonObject { put("name", "melo_escalate"); put("description", "Request one higher configured model tier. Continue using existing tool results without repeating completed actions."); put("parameters", buildJsonObject { put("type", "object"); put("properties", buildJsonObject { put("reason", buildJsonObject { put("type", "string") }) }); put("required", buildJsonArray { add("reason") }); put("additionalProperties", false) }) }
    }
}
