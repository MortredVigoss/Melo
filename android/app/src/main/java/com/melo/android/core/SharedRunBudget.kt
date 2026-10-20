package com.melo.android.core

import android.os.SystemClock
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext

class SharedBudgetExhausted : IllegalStateException("Run budget exhausted; completed steps are preserved.")

/** Native ledger ownership only; every limit/accounting decision runs in Core. */
class SharedRunBudget private constructor(
    private val runtime: SharedCoreRuntime, private var state: JsonObject,
    private val parent: SharedRunBudget?, private val mutex: Mutex,
) {
    class Scope(val budget: SharedRunBudget) : AbstractCoroutineContextElement(Key) {
        companion object Key : CoroutineContext.Key<Scope>
    }
    private var available = true
    private fun healthy(): Boolean = available && (parent?.healthy() ?: true)
    private fun invalidate() { available = false; parent?.invalidate() }
    private fun snapshot(): JsonObject = JsonObject(state + ("parent" to (parent?.snapshot() ?: JsonNull)))
    private fun apply(value: JsonObject) {
        state = value
        parent?.apply(value.getValue("parent").jsonObject)
    }
    private suspend fun operation(action: String, fields: JsonObject = buildJsonObject {}): JsonElement {
        check(healthy()) { "共享预算策略不可用，已停止执行。" }
        return try { runtime.value("budget", JsonObject(fields + buildJsonObject {
            put("action", action); put("now", SystemClock.elapsedRealtime()); put("budget", snapshot())
        })) } catch (error: Throwable) { invalidate(); throw error }
    }
    suspend fun check() = mutex.withLock {
        val exhausted = operation("exhausted")
        if (exhausted != JsonNull) throw SharedBudgetExhausted()
    }
    suspend fun remaining(): Long = mutex.withLock { operation("remaining").jsonPrimitive.double.toLong().coerceAtLeast(0) }
    private suspend fun timeout(): Long = mutex.withLock { operation("timeout").jsonPrimitive.double.toLong().coerceAtLeast(0) }
    suspend fun record(inputTokens: Long = 0, toolCalls: Int = 0, providerCalls: Int = 0) = mutex.withLock {
        apply(operation("record", buildJsonObject { put("usage", buildJsonObject {
            put("inputTokens", inputTokens); put("toolCalls", toolCalls); put("providerCalls", providerCalls)
        }) }).jsonObject)
    }
    suspend fun <T> model(estimatedInput: Long, usage: (T) -> Long? = { null }, work: suspend () -> T): T {
        check()
        var input = estimatedInput.coerceAtLeast(0)
        try {
            val result = withTimeout(timeout()) { work() }
            input = usage(result)?.coerceAtLeast(0) ?: input
            return result
        } finally {
            withContext(NonCancellable) { record(inputTokens = input, providerCalls = 1) }
        }
    }
    suspend fun <T> effect(work: suspend () -> T): T {
        mutex.withLock {
            val admission = operation("admitTool").jsonObject
            apply(admission.getValue("budget").jsonObject)
            if (!admission.getValue("allowed").jsonPrimitive.boolean) throw SharedBudgetExhausted()
        }
        return withTimeout(remaining()) { work() }
    }
    companion object {
        // Host measurement fallback when the provider omits usage. Image bytes
        // are transport payload, not text tokens; count image parts separately.
        fun estimateInput(history: List<JsonObject>, instructions: String, tools: List<JsonObject> = emptyList()): Long {
            fun bytes(value: JsonElement): Long = when (value) {
                is JsonObject -> if (value["type"]?.jsonPrimitive?.content in setOf("input_image", "image_url", "image")) 6000L
                    else value.entries.sumOf { it.key.length.toLong() + bytes(it.value) }
                is JsonArray -> value.sumOf { bytes(it) }
                else -> value.toString().toByteArray(Charsets.UTF_8).size.toLong()
            }
            return (history.sumOf { bytes(it) } + instructions.toByteArray(Charsets.UTF_8).size + tools.sumOf { bytes(it) } + 2) / 3 + 32
        }
        suspend fun open(runtime: SharedCoreRuntime, parent: SharedRunBudget? = null, options: JsonObject = buildJsonObject {}): SharedRunBudget {
            val mutex = parent?.mutex ?: Mutex()
            return mutex.withLock {
                check(parent?.healthy() != false) { "上级预算不可用，子任务未开始。" }
                val state = runtime.value("budget", buildJsonObject {
                    put("action", if (parent == null) "create" else "narrow"); put("now", SystemClock.elapsedRealtime()); put("options", options)
                    parent?.let { put("budget", it.snapshot()) }
                }).jsonObject
                SharedRunBudget(runtime, state, parent, mutex)
            }
        }
    }
}
