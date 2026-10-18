package com.melo.android.core

import android.content.Context
import android.os.SystemClock
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.*

/** Transport / lifecycle only; turn decisions live in the installed JS Core. */
class SharedCoreTurn private constructor(private val runtime: SharedCoreRuntime, private var state: JsonObject) : AutoCloseable {
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
    suspend fun request() { event("request"); check(active) { "共享 Agent 已停止（$reason）；已有操作保留。" } }
    suspend fun calls(calls: List<Pair<String, String>>, arguments: Map<String, JsonObject> = emptyMap()) {
        event("calls", buildJsonObject { put("calls", buildJsonArray { for ((id, name) in calls) add(buildJsonObject { put("id", id); put("name", name); arguments[id]?.let { put("arguments", it) } }) }) })
        check(state.getValue("permitted").jsonArray.size == calls.size) { "本轮工具请求已拒绝（${state["rejections"]}），未执行。" }
    }
    suspend fun result(id: String, ok: Boolean, progressKey: String? = null) {
        event("result", buildJsonObject { put("callId", id); put("ok", ok); progressKey?.let { put("progressKey", it) } })
    }
    override fun close() = runtime.close()

    companion object {
        suspend fun open(context: Context, runId: String, turnId: String, allowedTools: List<String>, rounds: Int, timeoutMs: Int = 600_000, requiredTools: List<String> = emptyList()): SharedCoreTurn {
            val runtime = SharedCoreRuntime.open(context)
            try {
                val reply = runtime.evaluate(buildJsonObject {
                    put("version", 1); put("op", "start")
                    put("turn", buildJsonObject {
                        put("runId", runId); put("turnId", turnId); put("now", SystemClock.elapsedRealtime())
                        put("allowedTools", JsonArray(allowedTools.map { JsonPrimitive(it) }))
                        put("requiredTools", JsonArray(requiredTools.map { JsonPrimitive(it) }))
                        put("limits", buildJsonObject { put("rounds", rounds); put("timeoutMs", timeoutMs); put("callsPerRound", 1) })
                    })
                })
                check(reply["ok"]?.jsonPrimitive?.boolean == true) { "共享 Agent 无法初始化。" }
                return SharedCoreTurn(runtime, reply.getValue("value").jsonObject)
            } catch (error: Throwable) { runtime.close(); throw error }
        }
    }
}
