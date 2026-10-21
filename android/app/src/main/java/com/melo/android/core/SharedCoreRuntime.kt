package com.melo.android.core

import android.content.Context
import androidx.javascriptengine.JavaScriptIsolate
import androidx.javascriptengine.JavaScriptSandbox
import androidx.javascriptengine.IsolateStartupParameters
import androidx.javascriptengine.SandboxDeadException
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.*
import kotlinx.coroutines.guava.await
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.security.MessageDigest
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Only packaged code executes. Messages enter the engine as named data. */
class SharedCoreRuntime private constructor(
    private val sandbox: JavaScriptSandbox,
    private val isolate: JavaScriptIsolate,
    val bundleHash: String,
) : AutoCloseable {
    private val closed = AtomicBoolean(false)
    private val mutex = Mutex()
    private var sequence = 0L

    suspend fun evaluate(request: JsonObject): JsonObject = Json.parseToJsonElement(evaluateJSON(request.toString())).jsonObject

    suspend fun evaluateJSON(request: String): String = mutex.withLock {
        check(!closed.get()) { "共享 Runtime 已关闭；请重新开始任务。" }
        require(request.length <= 2_000_000) { "共享 Runtime 输入超过上限。" }
        try {
            withTimeout(5_000) {
                val name = "request-${sequence++}"
                isolate.provideNamedData(name, request.toByteArray(Charsets.UTF_16LE))
                // Only the generated numeric name enters code. UTF-16 code units
                // preserve Chinese, emoji and escaped JSON without TextDecoder.
                isolate.evaluateJavaScriptAsync("""android.consumeNamedDataAsArrayBuffer('$name').then(buffer => {
                    const bytes = new Uint8Array(buffer), chunks = [];
                    for (let offset = 0; offset < bytes.length; offset += 8192) {
                        const units = [];
                        for (let i = offset; i < Math.min(offset + 8192, bytes.length); i += 2) units.push(bytes[i] | (bytes[i + 1] << 8));
                        chunks.push(String.fromCharCode.apply(null, units));
                    }
                    return MeloAgent.evaluate(chunks.join(''));
                })""").await()
            }
        } catch (error: Throwable) {
            close()
            if (error is SandboxDeadException) CoreEnginePool.discard(sandbox)
            if (error is CancellationException) throw error
            throw IllegalStateException("共享 Runtime 执行中断，已停止；没有自动重放操作。", error)
        }
    }

    override fun close() { if (closed.compareAndSet(false, true)) isolate.close() }

    companion object {
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
                withTimeout(5_000) { isolate.evaluateJavaScriptAsync(bundle.toString(Charsets.UTF_8)).await() }
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
