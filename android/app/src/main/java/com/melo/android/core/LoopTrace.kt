package com.melo.android.core

import android.content.Context
import android.os.SystemClock
import com.melo.android.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext

/** Native storage/ownership only. JS Core normalizes every persisted event. */
class LoopTrace private constructor(private val engine: SharedCoreRuntime, private val directory: File, private var state: JsonObject, private val limits: JsonObject) {
    class Scope(val root: LoopTrace, val runId: String, val kind: String, val parentRunId: String? = null, val spanId: String = runId, val parentSpanId: String? = null) : AbstractCoroutineContextElement(Key) { companion object Key : CoroutineContext.Key<Scope> }
    class ToolScope(val callId: String?) : AbstractCoroutineContextElement(Key) { companion object Key : CoroutineContext.Key<ToolScope> }
    private val mutex = Mutex()
    private val worker = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val queue = Channel<() -> Unit>(Channel.UNLIMITED)
    private val pending = AtomicInteger()
    private val errors = AtomicInteger()
    private var bytes = 0L
    private var capped = false
    private var closed = false
    private var mediaOmitted = false
    private fun limit(name: String, fallback: Int) = limits[name]?.jsonPrimitive?.intOrNull ?: fallback
    val traceId: String get() = state.text("traceId")
    init {
        worker.launch { for (work in queue) try { work() } catch (_: Exception) { errors.incrementAndGet() } }
    }
    private fun enqueue(control: Boolean = false, work: () -> Unit) {
        if (!control && pending.get() >= limit("maxQueue", 128)) { errors.incrementAndGet(); return }
        pending.incrementAndGet()
        if (queue.trySend { try { work() } finally { pending.decrementAndGet() } }.isFailure) { pending.decrementAndGet(); errors.incrementAndGet() }
    }
    suspend fun record(scope: Scope, type: String, data: JsonObject = buildJsonObject {}, payload: JsonElement? = null, round: Int? = null) = withContext(NonCancellable) {
        // Trace capture has its own deadline/isolate. A broken diagnostic engine
        // never closes the execution policy engine or changes its decisions.
        if (closed) return@withContext
        val saved = withTimeoutOrNull(250) {
            mutex.withLock {
                if (closed) return@withLock
                if (capped && type != "run.finished") return@withLock
                try {
                    val value = engine.value("trace", buildJsonObject {
                        put("action", "append"); put("trace", state); put("now", maxOf(state["lastMono"]!!.jsonPrimitive.double, SystemClock.elapsedRealtime().toDouble())); put("at", now())
                        put("context", buildJsonObject { put("traceId", traceId); put("runId", scope.runId); put("scopeId", scope.kind); put("spanId", scope.spanId); scope.parentRunId?.let { put("parentRunId", it) }; scope.parentSpanId?.let { put("parentSpanId", it) } })
                        put("event", buildJsonObject { put("type", type); put("data", data); payload?.let { put("payload", it) }; round?.let { put("round", it) } })
                    }).jsonObject
                    state = value.getValue("trace").jsonObject
                    val record = value["record"]?.takeIf { it is JsonObject }?.jsonObject ?: return@withLock
                    var persisted = record
                    val artifact = value["artifact"]?.takeIf { it is JsonObject }?.jsonObject
                    val content = artifact?.text("json")
                    var ref: String? = null
                    if (content != null) {
                        val hash = MessageDigest.getInstance("SHA-256").digest(content.toByteArray()).joinToString("") { "%02x".format(it) }
                        ref = "artifacts/$hash.json"
                        persisted = JsonObject(record + ("data" to JsonObject(record.getValue("data").jsonObject + buildJsonObject { put("contentRef", ref); put("contentSha256", hash); put("contentBytes", content.toByteArray().size) })))
                    }
                    val capture = record["capture"]!!.jsonObject
                    mediaOmitted = mediaOmitted || capture["mediaOmitted"]?.jsonPrimitive?.booleanOrNull == true
                    if (capture["truncated"]?.jsonPrimitive?.booleanOrNull == true) errors.incrementAndGet()
                    val line = persisted.toString() + "\n"
                    val size = line.toByteArray().size + (content?.toByteArray()?.size ?: 0)
                    if (bytes + size > limit("maxRunBytes", 67108864) - 8192 && type != "run.finished") { capped = true; errors.incrementAndGet(); return@withLock }
                    bytes += size
                    val capturedRef = ref
                    enqueue(type == "run.finished") {
                        val artifacts = File(directory, "artifacts"); artifacts.mkdirs()
                        if (capturedRef != null && content != null) { val target = File(directory, capturedRef); if (!target.exists()) target.writeText(content) }
                        File(directory, "events.jsonl").appendText(line)
                    }
                } catch (_: Exception) { errors.incrementAndGet() }
            }
            true
        }
        if (saved == null) errors.incrementAndGet()
    }
    suspend fun flush() = withContext(NonCancellable) {
        val done = CompletableDeferred<Unit>(); enqueue(true) { done.complete(Unit) }
        if (withTimeoutOrNull(limit("flushMs", 100).toLong()) { done.await(); true } != true) errors.incrementAndGet()
    }
    private suspend fun finish(scope: Scope, outcome: String, reason: String?) {
        record(scope, "run.finished", buildJsonObject { put("outcome", outcome); reason?.let { put("reason", it) } })
        if (scope.parentRunId != null) { flush(); return }
        closed = true
        val manifest = buildJsonObject {
            put("schemaVersion", 1); put("traceId", traceId); put("runId", scope.runId); put("host", "android"); put("status", outcome); put("finishedAt", now()); put("lastSequence", state["sequence"]!!); put("bytes", bytes); put("pinned", false)
            put("replayability", buildJsonObject { put("text", "requires_artifact_validation"); put("multimodal", if (mediaOmitted) "unavailable" else "not_captured") })
        }
        val done = CompletableDeferred<Unit>()
        enqueue(true) {
            try {
            directory.mkdirs()
            val final = JsonObject(manifest + buildJsonObject { put("complete", errors.get() == 0); put("droppedEvents", errors.get()); put("problems", buildJsonArray { if (errors.get() > 0) add("capture_or_io_error") }) })
            val temp = File(directory, "manifest.json.tmp"); temp.writeText(final.toString()); check(temp.renameTo(File(directory, "manifest.json")))
            } finally { done.complete(Unit); queue.close() }
        }
        withContext(NonCancellable) { withTimeoutOrNull(limit("flushMs", 100).toLong()) { done.await() } }
        engine.close()
    }
    companion object {
        suspend fun emit(type: String, data: JsonObject = buildJsonObject {}, payload: JsonElement? = null, round: Int? = null) {
            val scope = captureScope() ?: return
            val inheritedCall = currentCoroutineContext()[ToolScope]?.callId
            val namedCall = data["callId"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
            val callId = namedCall ?: inheritedCall
            val target = if (callId != null) Scope(scope.root, scope.runId, scope.kind, scope.parentRunId, scope.runId + ":tool:" + callId, scope.runId) else scope
            val fields = if (inheritedCall != null && !data.containsKey("callId")) JsonObject(data + ("callId" to JsonPrimitive(inheritedCall))) else data
            target.root.record(target, type, fields, payload, round)
        }
        suspend fun captureScope(): Scope? {
            val parent = currentCoroutineContext()[Scope] ?: return null
            val call = currentCoroutineContext()[ToolScope]?.callId ?: return parent
            return Scope(parent.root, parent.runId, parent.kind, parent.parentRunId, parent.runId + ":tool:" + call, parent.spanId)
        }
        suspend fun <T> run(context: Context, runId: String, kind: String, goal: String, parent: Scope? = null, outcome: (T) -> String = { "unknown" }, block: suspend () -> T): T {
            val inherited = parent ?: currentCoroutineContext()[Scope]
            val root = inherited?.root ?: try {
                val engine = SharedCoreRuntime.open(context)
                val identity = newId()
                val value = engine.value("trace", buildJsonObject { put("action", "create"); put("context", buildJsonObject { put("traceId", identity); put("runId", runId) }); put("now", SystemClock.elapsedRealtime()) }).jsonObject
                val limits = engine.value("trace", buildJsonObject { put("action", "limits") }).jsonObject
                LoopTrace(engine, File(context.filesDir, "traces/$identity"), value.getValue("trace").jsonObject, limits)
            } catch (error: Exception) { if (error is CancellationException) throw error; return block() }
            val scope = Scope(root, runId, kind, inherited?.runId, runId, inherited?.spanId)
            return withContext(scope + ToolScope(null)) {
                emit("run.started", buildJsonObject { put("host", "android"); put("kind", kind); put("coreBundleHash", root.engine.bundleHash); put("appVersion", com.melo.android.BuildConfig.VERSION_NAME); put("appBuild", com.melo.android.BuildConfig.VERSION_CODE) }, buildJsonObject { put("goal", goal) })
                try { val result = block(); withContext(NonCancellable) { root.finish(scope, outcome(result), null) }; result }
                catch (error: Throwable) { withContext(NonCancellable) { root.finish(scope, if (error is CancellationException) "cancelled" else "failed", error::class.simpleName) }; throw error }
            }
        }
        suspend fun <T> model(payload: JsonObject, snapshot: (T) -> JsonElement, block: suspend () -> T): T {
            val parent = captureScope() ?: return block()
            val scope = Scope(parent.root, parent.runId, parent.kind, parent.parentRunId, parent.runId + ":model:" + newId(), parent.spanId)
            return withContext(scope + ToolScope(null)) {
                val start = SystemClock.elapsedRealtime()
                emit("context.snapshot", buildJsonObject { put("source", "provider-wire"); put("skillsCapturedInInstructions", true) }, payload)
                emit("capabilities.snapshot", buildJsonObject { put("source", "provider-wire"); put("toolSchemaCaptured", payload.containsKey("tools")) }, buildJsonObject { put("tools", payload["tools"] ?: JsonNull) })
                emit("model.request.prepared", buildJsonObject { put("model", payload.text("model")) }, payload)
                emit("model.provider.payload", buildJsonObject { put("source", "provider-wire") }, payload)
                emit("model.request.started", buildJsonObject { put("source", "provider-wire") }); parent.root.flush()
                try { val result = block(); emit("model.response", buildJsonObject { put("durationMs", SystemClock.elapsedRealtime() - start); put("firstEventMs", JsonNull); put("usageOrigin", "unknown") }, snapshot(result)); result }
                catch (error: Throwable) { emit("model.error", buildJsonObject { put("durationMs", SystemClock.elapsedRealtime() - start); put("code", error::class.simpleName ?: "ERROR") }); throw error }
            }
        }
    }
}
