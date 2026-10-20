package com.melo.android.ui

import android.annotation.SuppressLint
import android.graphics.Color
import android.net.Uri
import android.webkit.*
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.*
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.melo.android.data.*
import kotlinx.serialization.json.*
import java.io.ByteArrayInputStream

/** Only packaged assets may load here. The bridge never exposes storage or credentials. */
@SuppressLint("SetJavaScriptEnabled")
@Composable fun SharedScene(payload: JsonObject, modifier: Modifier = Modifier, execution: Boolean = false, onOpenUrl: (String) -> Unit = {}, onSelect: (Int) -> Unit = {}) {
    var failure by remember { mutableStateOf(false) }
    val latestPayload by rememberUpdatedState(payload)
    val latestOpen by rememberUpdatedState(onOpenUrl)
    val latestSelect by rememberUpdatedState(onSelect)
    var browser by remember { mutableStateOf<WebView?>(null) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, browser) {
        val view = browser
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_PAUSE) { view?.evaluateJavascript("window.dispatchEvent(new Event('pagehide'));", null); view?.onPause() }
            if (event == Lifecycle.Event.ON_RESUME) { view?.onResume(); view?.evaluateJavascript("window.dispatchEvent(new Event('pageshow'));", null) }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    fun payloadFor(view: WebView, value: JsonObject): JsonObject {
        if (execution) return value
        val density = view.resources.displayMetrics.density
        val w = view.width / density; val h = view.height / density
        if (w < 48 || h < 48) return value
        val positions = listOf(Triple(1, .18f, .20f), Triple(4, .82f, .20f), Triple(2, .15f, .68f), Triple(5, .85f, .68f), Triple(3, .50f, .88f))
        return JsonObject(value + ("frames" to buildJsonObject { positions.forEach { (id, x, y) -> put(id.toString(), buildJsonObject {
            put("x", (w * x - 24).coerceIn(0f, w - 48)); put("y", (h * y - 24).coerceIn(0f, h - 48)); put("width", 48); put("height", 48)
        }) } }))
    }
    Box(modifier.clipToBounds()) {
        AndroidView(modifier = Modifier.fillMaxSize(), factory = { context ->
            val loader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context)).build()
            WebView(context).apply {
                browser = this
                setBackgroundColor(Color.TRANSPARENT)
                clipToOutline = true
                outlineProvider = android.view.ViewOutlineProvider.BOUNDS
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                settings.blockNetworkLoads = true
                isVerticalScrollBarEnabled = execution
                if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                    WebViewCompat.addWebMessageListener(this, "MeloBridge", setOf("https://appassets.androidplatform.net")) { view, message, origin, mainFrame, _ ->
                        if (!mainFrame || origin.toString() != "https://appassets.androidplatform.net") return@addWebMessageListener
                        val item = runCatching { MeloJson.parseToJsonElement(message.data.orEmpty()).jsonObject }.getOrNull() ?: return@addWebMessageListener
                        when (item.text("type")) {
                            "ready" -> view.evaluateJavascript("window.${if (execution) "meloReceive" else "meloNeuralReceive"}(${payloadFor(view, latestPayload)});", null)
                            "renderError" -> failure = true
                            "rendered" -> failure = false
                            "select" -> item["id"]?.jsonPrimitive?.intOrNull?.let(latestSelect)
                            "openURL" -> item.text("url").takeIf { it.startsWith("https://") || it.startsWith("http://") }?.let(latestOpen)
                        }
                    }
                }
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = request.url.host != "appassets.androidplatform.net" || request.url.scheme != "https"
                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                        val uri = request.url
                        if (uri.host != "appassets.androidplatform.net" || uri.scheme != "https") return WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                        if (uri.path == "/assets/scene/android-bridge.js") {
                            val code = """
                                window.__meloPost = value => window.MeloBridge?.postMessage(JSON.stringify(value));
                                window.__meloNeuralPost = window.__meloPost;
                                window.__meloFitViewport = () => {
                                  if (innerHeight > 0) {
                                    document.documentElement.style.height = innerHeight + 'px';
                                    if (document.body) document.body.style.height = innerHeight + 'px';
                                  }
                                };
                                window.addEventListener('resize', window.__meloFitViewport);
                                document.addEventListener('DOMContentLoaded', window.__meloFitViewport);
                                requestAnimationFrame(window.__meloFitViewport);
                            """.trimIndent()
                            return WebResourceResponse("application/javascript", "utf-8", ByteArrayInputStream(code.toByteArray()))
                        }
                        if (uri.path == "/assets/scene/android-viewport.css") {
                            // A WebView first measured at zero height can retain a zero percentage
                            // containing block. Viewport units track both initial layout and folding.
                            val css = "html,body{height:100vh;height:100dvh;}"
                            return WebResourceResponse("text/css", "utf-8", ByteArrayInputStream(css.toByteArray()))
                        }
                        if (uri.path in setOf("/assets/scene/neural.html", "/assets/scene/index.html")) {
                            val path = uri.path!!.removePrefix("/assets/")
                            val html = context.assets.open(path).bufferedReader().use { it.readText() }
                                .replace("</head>", "<link rel=\"stylesheet\" href=\"android-viewport.css\"></head>")
                                .replace("<script src=", "<script src=\"android-bridge.js\"></script><script src=", ignoreCase = false)
                            return WebResourceResponse("text/html", "utf-8", ByteArrayInputStream(html.toByteArray()))
                        }
                        return loader.shouldInterceptRequest(uri) ?: WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                    }
                    override fun onPageFinished(view: WebView, url: String) { view.evaluateJavascript("window.__meloFitViewport?.();window.${if (execution) "meloReceive" else "meloNeuralReceive"}?.(${payloadFor(view, latestPayload)});", null) }
                    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) { if (request.isForMainFrame) failure = true }
                    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                        failure = true; browser = null
                        (view.parent as? android.view.ViewGroup)?.removeView(view)
                        view.destroy(); return true
                    }
                }
                addOnLayoutChangeListener { view, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
                    if (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop) {
                        (view as WebView).evaluateJavascript("window.__meloFitViewport?.();window.${if (execution) "meloReceive" else "meloNeuralReceive"}?.(${payloadFor(view, latestPayload)});", null)
                    }
                }
                if (!execution) setOnTouchListener { _, event ->
                    if (event.action == android.view.MotionEvent.ACTION_UP) {
                        val density = resources.displayMetrics.density
                        val tap = buildJsonObject { put("id", newId()); put("x", event.x / density); put("y", event.y / density) }
                        evaluateJavascript("window.meloNeuralReceive?.(${JsonObject(payloadFor(this, latestPayload) + ("tap" to tap))});", null)
                        performClick()
                    }
                    false
                }
                loadUrl("https://appassets.androidplatform.net/assets/scene/${if (execution) "index" else "neural"}.html")
            }
        }, update = { view -> if (browser === view) view.evaluateJavascript("window.${if (execution) "meloReceive" else "meloNeuralReceive"}?.(${payloadFor(view, payload)});", null) }, onRelease = { view ->
            if (browser === view) {
                browser = null
                view.evaluateJavascript("window.meloNeuralDispose?.();window.dispatchEvent(new Event('pagehide'));", null)
                view.stopLoading(); view.destroy()
            }
        })
        if (failure) Text("场景暂时不可用，原生页面和任务记录仍可使用。", color = MeloMuted)
    }
}

fun RunRecord.scene(): JsonObject = sharedScene?.let { JsonObject(it + mapOf("chatId" to chatId.jp(), "query" to prompt.jp(), "startedAt" to startedAt.jp(), "finishedAt" to (finishedAt?.jp() ?: JsonNull))) } ?: buildJsonObject {
    put("runId", id); put("chatId", chatId); put("status", status); put("query", prompt)
    put("startedAt", startedAt); put("finishedAt", finishedAt?.jp() ?: JsonNull)
    put("requestedModel", requestedModel); put("returnedModel", reportedModel?.jp() ?: JsonNull)
    put("lastModule", "compute")
    val stages = buildJsonArray { add(buildJsonObject {
        put("id", "model:response"); put("module", "compute"); put("name", if (simulated) "本地 Fixture" else "模型请求")
        put("status", status); put("input", prompt); put("output", error ?: if (status == "completed") "回复完成并已保存。" else "请求处理中。")
        put("model", requestedModel); put("returnedModel", reportedModel?.jp() ?: JsonNull)
        put("startedAt", startedAt); put("finishedAt", finishedAt?.jp() ?: JsonNull)
    }) }
    put("operations", stages); put("pipeline", stages)
    put("sources", buildJsonArray { sources.forEachIndexed { index, url -> add(buildJsonObject {
        put("id", "source-$index"); put("url", url); put("title", url); put("rank", index); put("order", index)
        put("cited", true); put("accessed", false); put("opened", false); put("appeared", true); put("reading", "unknown")
        put("providers", buildJsonArray { add("回复引用") }); put("queries", JsonArray(emptyList()))
    }) } })
}
