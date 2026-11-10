package com.melo.android.core

import android.content.Context
import androidx.javascriptengine.JavaScriptIsolate
import androidx.javascriptengine.JavaScriptSandbox
import androidx.javascriptengine.IsolateStartupParameters
import androidx.javascriptengine.SandboxDeadException
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.security.MessageDigest
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Only packaged code executes. Messages enter the engine as named data. */
class SharedCoreRuntime private constructor(
    private val sandbox: JavaScriptSandbox,
    private val isolate: JavaScriptIsolate,
    val bundleHash: String,
) : AutoCloseable {
    private val closed = AtomicBoolean(false)
    /** True once this Runtime was closed: by its owner, or because an evaluation was interrupted. */
    val isClosed: Boolean get() = closed.get()
    private val mutex = Mutex()
    private var sequence = 0L
    /** The evaluation this isolate is running or ran last; the isolate is closed only after it has ended. */
    private val evaluation = AtomicReference<ListenableFuture<*>?>(null)

    suspend fun evaluate(request: JsonObject): JsonObject = Json.parseToJsonElement(evaluateJSON(request.toString())).jsonObject

    suspend fun evaluateJSON(request: String): String = mutex.withLock {
        check(!closed.get()) { "共享 Runtime 已关闭；请重新开始任务。" }
        require(request.length <= 2_000_000) { "共享 Runtime 输入超过上限。" }
        val reply = try {
            // Null is this engine's own limit. It is an engine failure, not the run's deadline: thrown on
            // as a timeout it was read as DEADLINE_EXCEEDED and started a write-up on the closed Runtime.
            withTimeoutOrNull(EVALUATION_LIMIT_MS) {
                val name = "request-${sequence++}"
                isolate.provideNamedData(name, request.toByteArray(Charsets.UTF_16LE))
                // Only the generated numeric name enters code. UTF-16 code units
                // preserve Chinese, emoji and escaped JSON without TextDecoder.
                settled(isolate.evaluateJavaScriptAsync("""android.consumeNamedDataAsArrayBuffer('$name').then(buffer => {
                    const bytes = new Uint8Array(buffer), chunks = [];
                    for (let offset = 0; offset < bytes.length; offset += 8192) {
                        const units = [];
                        for (let i = offset; i < Math.min(offset + 8192, bytes.length); i += 2) units.push(bytes[i] | (bytes[i + 1] << 8));
                        chunks.push(String.fromCharCode.apply(null, units));
                    }
                    return MeloAgent.evaluate(chunks.join(''));
                })"""))
            }
        } catch (error: Throwable) {
            close()
            if (error is SandboxDeadException) CoreEnginePool.discard(sandbox)
            if (error is CancellationException) throw error
            // The cause is named: "执行中断" alone could not tell a dead sandbox from a script error.
            throw IllegalStateException("共享 Runtime 执行中断（${error::class.java.simpleName}），已停止；没有自动重放操作。", error)
        }
        if (reply == null) { close(); throw IllegalStateException("共享 Runtime 执行超时，已停止；没有自动重放操作。") }
        reply
    }

    /**
     * Waits for an evaluation without ever cancelling it: a stop or a timeout ends the wait only.
     * The evaluation runs on to its end in the isolate, a few milliseconds of packaged code.
     */
    private suspend fun <T> settled(future: ListenableFuture<T>): T {
        evaluation.set(future)
        return suspendCancellableCoroutine { continuation ->
            future.addListener({
                try { val value = future.get(); if (continuation.isActive) continuation.resume(value) }
                catch (error: ExecutionException) { if (continuation.isActive) continuation.resumeWithException(error.cause ?: error) }
                catch (error: Throwable) { if (continuation.isActive) continuation.resumeWithException(error) }
            }, Executor { it.run() })
        }
    }

    /**
     * New evaluations are refused at once; the isolate itself is closed when what it is running has
     * ended. An isolate closed while it was still loading the packaged bundle (a reply stopped while
     * a turn's Runtime was opening) took down the sandbox process that every isolate of the app
     * shares: the next evaluation of any reply then failed with SandboxDeadException and that reply
     * ended as "共享 Runtime 执行中断" (2026-11-10 on the emulator: about one stop in sixty, and two of
     * four runs of the direct test). Evaluations are waited for in the same way, so a stop or a trace
     * append past its limit never closes an isolate at work. One that never ends is closed after its limit.
     */
    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        val running = evaluation.get()
        if (running == null || running.isDone) { isolate.close(); return }
        closer.launch {
            withTimeoutOrNull(EVALUATION_LIMIT_MS) { suspendCancellableCoroutine<Unit> { continuation -> running.addListener({ if (continuation.isActive) continuation.resume(Unit) }, Executor { it.run() }) } }
            isolate.close()
        }
    }

    companion object {
        private const val EVALUATION_LIMIT_MS = 5_000L
        /** Outlives any reply: an isolate whose owner was stopped is still closed once its evaluation ends. */
        private val closer = CoroutineScope(SupervisorJob() + Dispatchers.Default)

        suspend fun open(context: Context): SharedCoreRuntime {
            val app = context.applicationContext
            val sandbox = CoreEnginePool.acquire(app)
            check(sandbox.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_PROVIDE_CONSUME_ARRAY_BUFFER) && sandbox.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_PROMISE_RETURN)) {
                "此设备 WebView 缺少共享 Runtime 所需能力，请更新 Android System WebView。"
            }
            val bundle = withContext(Dispatchers.IO) { app.assets.open("agent-core/agent-core.js").use { it.readBytes() } }
            val manifest = withContext(Dispatchers.IO) { app.assets.open("agent-core/manifest.json").bufferedReader().use { Json.parseToJsonElement(it.readText()).jsonObject } }
            val hash = MessageDigest.getInstance("SHA-256").digest(bundle).joinToString("") { "%02x".format(it) }
            check(hash == manifest.getValue("sha256").jsonPrimitive.content) { "共享 Runtime 资源校验失败。" }
            val parameters = IsolateStartupParameters()
            if (sandbox.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_ISOLATE_MAX_HEAP_SIZE)) parameters.setMaxHeapSizeBytes(32_000_000)
            val isolate = try { sandbox.createIsolate(parameters) }
            catch (error: SandboxDeadException) { CoreEnginePool.discard(sandbox); throw error }
            val runtime = SharedCoreRuntime(sandbox, isolate, hash)
            try {
                withTimeout(EVALUATION_LIMIT_MS) { runtime.settled(isolate.evaluateJavaScriptAsync(bundle.toString(Charsets.UTF_8))) }
                val hello = runtime.evaluate(buildJsonObject { put("version", 1); put("op", "hello") })
                check(hello["ok"]?.jsonPrimitive?.boolean == true) { "共享 Runtime 协议不兼容。" }
                return runtime
            } catch (error: Throwable) { runtime.close(); throw error }
        }
    }
}

/** One sandbox per Application, many independently owned per-turn isolates. */
private object CoreEnginePool {
    private val mutex = Mutex()
    private var connecting: ListenableFuture<JavaScriptSandbox>? = null
    suspend fun discard(sandbox: JavaScriptSandbox) = mutex.withLock {
        val future = connecting
        if (future?.isDone == true && runCatching { future.get() }.getOrNull() === sandbox) {
            connecting = null
            sandbox.close()
        }
    }
    suspend fun acquire(context: Context): JavaScriptSandbox = mutex.withLock {
        check(JavaScriptSandbox.isSupported()) { "此设备尚不支持共享 Runtime，请更新 Android System WebView。" }
        val future = connecting ?: JavaScriptSandbox.createConnectedInstanceAsync(context).also { connecting = it }
        try {
            // Cancelling one Chat must not cancel the Application's connection.
            withTimeout(10_000) { suspendCancellableCoroutine { continuation ->
                future.addListener({
                    try { if (continuation.isActive) continuation.resume(future.get()) }
                    catch (error: Throwable) { if (continuation.isActive) continuation.resumeWithException(error) }
                }, Executor { it.run() })
            } }
        } catch (error: Throwable) {
            if (error !is CancellationException) connecting = null
            throw error
        }
    }
}
