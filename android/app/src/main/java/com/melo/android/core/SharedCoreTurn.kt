package com.melo.android.core

import android.content.Context
import android.os.SystemClock
import com.melo.android.data.text
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.*

class SharedTurnStopped(val reason: String) : IllegalStateException("Shared Agent stopped: $reason")

/** Transport / lifecycle only; turn decisions live in the installed JS Core. */
class SharedCoreTurn private constructor(private val runtime: SharedCoreRuntime, private var state: JsonObject, val budget: SharedRunBudget) : AutoCloseable {
    val completed get() = state["status"]?.jsonPrimitive?.content == "completed"
    val active get() = state["status"]?.jsonPrimitive?.content == "running"
    val reason get() = state["reason"]?.jsonPrimitive?.content.orEmpty()
    suspend fun event(type: String, fields: JsonObject = buildJsonObject {}): JsonObject {
        currentCoroutineContext().ensureActive()
        val reply = runtime.evaluate(buildJsonObject {
            put("version", 1); put("op", "advance"); put("state", state); put("now", SystemClock.elapsedRealtime())
            put("event", JsonObject(fields + buildJsonObject { put("type", type); put("runId", state.getValue("runId")); put("turnId", state.getValue("turnId")) }))
        })
        check(reply["ok"]?.jsonPrimitive?.boolean == true) { "共享 Agent 已停止：${reply["error"]?.jsonObject?.get("code")?.jsonPrimitive?.content.orEmpty()}。已执行操作保留。" }
        state = reply.getValue("value").jsonObject
        return state
    }
    suspend fun request() { budget.check(); event("request"); if (!active) throw SharedTurnStopped(reason) }
    fun permits(id: String) = active && state.getValue("pending").jsonArray.any { it.jsonPrimitive.content == id } && state.getValue("permitted").jsonArray.any { it.jsonPrimitive.content == id }
    fun rejection(id: String) = state["rejections"]?.jsonObject?.text(id).orEmpty()
    suspend fun calls(calls: List<Pair<String, String>>, arguments: Map<String, JsonObject> = emptyMap(), requireAll: Boolean = true) {
        event("calls", buildJsonObject { put("calls", buildJsonArray { for ((id, name) in calls) add(buildJsonObject { put("id", id); put("name", name); arguments[id]?.let { put("arguments", it); put("fingerprint", fingerprint(name, it)) } }) }) })
        check(!requireAll || state.getValue("permitted").jsonArray.size == calls.size) { "本轮工具请求已拒绝（${state["rejections"]}），未执行。" }
    }
    suspend fun result(id: String, ok: Boolean, progressKey: String? = null, code: String? = null, output: String = "") {
        event("result", buildJsonObject { put("callId", id); put("ok", ok); code?.let { put("code", it) }; put("output", output.take(500)); progressKey?.let { put("progressKey", it) } })
    }
    suspend fun observeDevice(action: String, ok: Boolean, progressKey: String) {
        event("device-observation", buildJsonObject { put("action", action); put("ok", ok); put("progressKey", progressKey) })
    }
    override fun close() = runtime.close()

    companion object {
        private fun canonical(value: JsonElement): JsonElement = when (value) {
            is JsonObject -> JsonObject(value.toSortedMap().mapValues { canonical(it.value) })
            is JsonArray -> JsonArray(value.map(::canonical))
            else -> value
        }
        private fun fingerprint(name: String, args: JsonObject) = java.security.MessageDigest.getInstance("SHA-256")
            .digest((name + canonical(args)).toByteArray()).joinToString("") { "%02x".format(it) }

        suspend fun open(context: Context, runId: String, turnId: String, allowedTools: List<String>, rounds: Int, timeoutMs: Int = 600_000, requiredTools: List<String> = emptyList(), toolDependencies: JsonObject = buildJsonObject {}, callsPerRound: Int = 32, budget: SharedRunBudget? = null): SharedCoreTurn {
            val runtime = SharedCoreRuntime.open(context)
            try {
                val reply = runtime.evaluate(buildJsonObject {
                    put("version", 1); put("op", "start")
                    put("turn", buildJsonObject {
                        put("runId", runId); put("turnId", turnId); put("now", SystemClock.elapsedRealtime())
                        put("allowedTools", JsonArray(allowedTools.map { JsonPrimitive(it) }))
                        put("requiredTools", JsonArray(requiredTools.map { JsonPrimitive(it) }))
                        put("toolDependencies", toolDependencies)
                        put("limits", buildJsonObject { put("rounds", rounds); put("timeoutMs", timeoutMs); put("callsPerRound", callsPerRound) })
                    })
                })
                check(reply["ok"]?.jsonPrimitive?.boolean == true) { "共享 Agent 无法初始化。" }
                return SharedCoreTurn(runtime, reply.getValue("value").jsonObject, budget ?: SharedRunBudget.open(runtime, options = buildJsonObject { put("deadlineMs", timeoutMs) }))
            } catch (error: Throwable) { runtime.close(); throw error }
        }
    }
}
