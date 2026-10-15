package com.melo.android.device

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.app.KeyguardManager
import android.content.Intent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.graphics.*
import android.hardware.display.DisplayManager
import android.os.*
import android.util.Base64
import android.view.*
import android.view.accessibility.*
import android.widget.Button
import com.melo.android.MeloApplication
import com.melo.android.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.*
import java.io.ByteArrayOutputStream
import kotlin.coroutines.resume

object DeviceAccess {
    val connected = MutableStateFlow(false)
    var service: MeloAccessibilityService? = null; internal set
}

interface DeviceExecutor {
    suspend fun begin(displayId: Int, screenshots: Boolean)
    suspend fun execute(arguments: JsonObject): DeviceToolResult
    fun end()
}

/** User-enabled Android service. No screen collection occurs outside an explicit session. */
class MeloAccessibilityService : AccessibilityService(), DeviceExecutor {
    private var authorized = false
    private var selectedDisplay = 0
    private var screenshots = true
    private var generation = 0L
    private var screenId = ""
    private var observedGeneration = -1L
    private var observedAt = 0L
    private var windowId = -1
    private var bounds = Rect()
    private var imageWidth = 0
    private var imageHeight = 0
    private val nodes = mutableMapOf<String, AccessibilityNodeInfo>()
    private var overlay: Button? = null
    private var overlayManager: WindowManager? = null
    private var sessionApps: AppCatalog? = null
    private val screenOff = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (authorized && intent?.action == Intent.ACTION_SCREEN_OFF) { (application as MeloApplication).deviceAgent.cancel(); end() }
        }
    }

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(screenOff, IntentFilter(Intent.ACTION_SCREEN_OFF), Context.RECEIVER_NOT_EXPORTED)
        else registerReceiver(screenOff, IntentFilter(Intent.ACTION_SCREEN_OFF))
    }
    override fun onServiceConnected() { DeviceAccess.service = this; DeviceAccess.connected.value = true }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Background windows / our stop overlay must not invalidate the observed app.
        // Window identity and bounds are independently checked immediately before acting.
        if (event?.windowId == windowId && event.eventType in setOf(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED, AccessibilityEvent.TYPE_VIEW_SCROLLED, AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED)) generation++
    }
    override fun onInterrupt() { (application as MeloApplication).deviceAgent.cancel(); end() }
    override fun onDestroy() {
        (application as MeloApplication).deviceAgent.cancel(); end()
        if (DeviceAccess.service === this) { DeviceAccess.service = null; DeviceAccess.connected.value = false }
        unregisterReceiver(screenOff)
        super.onDestroy()
    }
    fun displays(): List<Pair<Int, String>> = getSystemService(DisplayManager::class.java).displays.map { it.displayId to "Display ${it.displayId} · ${it.name}" }

    override suspend fun begin(displayId: Int, screenshots: Boolean) = withContext(Dispatchers.Main.immediate) {
        check(!authorized) { "已有手机助手在运行。" }
        val display = getSystemService(DisplayManager::class.java).getDisplay(displayId) ?: error("所选 Display 已断开。")
        selectedDisplay = displayId; this@MeloAccessibilityService.screenshots = screenshots
        val displayContext = createDisplayContext(display)
        val wm = displayContext.getSystemService(WindowManager::class.java)
        val stop = Button(displayContext).apply {
            text = "停止 Melo"; contentDescription = "停止手机助手"; isAllCaps = false
            setTextColor(Color.WHITE); setBackgroundColor(Color.rgb(70, 53, 28))
            setOnClickListener { (application as MeloApplication).deviceAgent.cancel() }
        }
        val params = WindowManager.LayoutParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY, WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, PixelFormat.TRANSLUCENT).apply {
            gravity = Gravity.TOP or Gravity.END; x = 8; y = (80 * resources.displayMetrics.density).toInt()
            title = "Melo device assistant stop"
        }
        wm.addView(stop, params); overlayManager = wm; overlay = stop
        sessionApps = null; authorized = true; invalidateObservation()
    }
    override fun end() {
        authorized = false; sessionApps = null; invalidateObservation()
        overlay?.let { runCatching { overlayManager?.removeView(it) } }; overlay = null; overlayManager = null
    }
    private fun invalidateObservation() {
        screenId = ""; nodes.values.forEach { @Suppress("DEPRECATION") it.recycle() }; nodes.clear()
    }
    private fun checkSession() {
        check(authorized) { "手机助手尚未开始，或已停止。" }
        check(!getSystemService(KeyguardManager::class.java).isKeyguardLocked) { "手机已锁屏，请解锁后重新开始。" }
        check(getSystemService(DisplayManager::class.java).getDisplay(selectedDisplay) != null) { "所选 Display 已断开。" }
    }
    private fun activeWindow(): AccessibilityWindowInfo {
        val windows = if (Build.VERSION.SDK_INT >= 30) windowsOnAllDisplays[selectedDisplay].orEmpty() else windows
        return windows.filter { it.type != AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY && it.type != AccessibilityWindowInfo.TYPE_INPUT_METHOD && it.root != null }
            .sortedWith(compareByDescending<AccessibilityWindowInfo> { it.isActive }.thenByDescending { it.isFocused }.thenByDescending { it.layer }).firstOrNull()
            ?: error("无法读取此 Display 的窗口，请让目标 App 保持可见。")
    }
    private fun requireFresh(arguments: JsonObject) {
        require(arguments.text("screen_id") == screenId && screenId.isNotBlank() && observedGeneration == generation && SystemClock.elapsedRealtime() - observedAt < 90_000) { "屏幕已变化或 observation 已过期，请重新 observe。" }
        val current = activeWindow(); val currentBounds = Rect().also(current::getBoundsInScreen)
        require(current.id == windowId && currentBounds == bounds) { "窗口或尺寸已改变，请重新 observe。" }
    }
    override suspend fun execute(arguments: JsonObject): DeviceToolResult = withContext(Dispatchers.Main.immediate) {
        try {
            checkSession(); DeviceTools.validate(arguments)
            val action = arguments.text("action")
            if (action == "list_apps") return@withContext DeviceToolResult(catalog().page(arguments.text("query"), number(arguments, "offset", 0), number(arguments, "limit", 100)))
            if (action !in setOf("observe", "open_app", "wait")) requireFresh(arguments)
            when (action) {
                "open_app" -> {
                    val apps = catalog()
                    val candidates = if (arguments.text("package_name").isNotBlank()) apps.exactPackage(arguments.text("package_name")) else apps.exactName(arguments.text("app_name"))
                    if (candidates.size != 1) return@withContext apps.openFailure(arguments.text("package_name"), arguments.text("app_name"), candidates.size > 1)
                    val intent = packageManager.getLaunchIntentForPackage(candidates.single().packageName) ?: error("该 App 没有可启动入口。")
                    val options = android.app.ActivityOptions.makeBasic().apply { if (Build.VERSION.SDK_INT >= 26) launchDisplayId = selectedDisplay }
                    startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), options.toBundle())
                }
                "tap" -> {
                    val nodeId = arguments.text("node_id")
                    if (nodeId.isNotBlank()) {
                        val node = nodes[nodeId] ?: error("节点不存在，请重新 observe。")
                        require(node.refresh() && node.windowId == windowId && node.isVisibleToUser && node.isEnabled && !node.isPassword) { "节点已改变、被隐藏或受保护，请重新 observe。" }
                        if (!node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                            val rect = Rect().also(node::getBoundsInScreen)
                            require(rect.intersect(bounds)) { "节点不在当前窗口内。" }; gesture(rect.exactCenterX(), rect.exactCenterY())
                        }
                    } else { val (x, y) = point(arguments, "x", "y"); gesture(x, y) }
                }
                "type_text" -> {
                    val node = nodes[arguments.text("node_id")] ?: error("输入节点不存在，请重新 observe。")
                    require(node.refresh() && node.windowId == windowId && node.isEditable && node.isVisibleToUser && node.isEnabled && !node.isPassword) { "该节点不可编辑或是密码字段。" }
                    require(node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, arguments.text("text")) })) { "此 App 不支持节点输入。" }
                }
                "swipe" -> {
                    val start = point(arguments, "x", "y"); val end = point(arguments, "end_x", "end_y")
                    gesture(start.first, start.second, end.first, end.second, number(arguments, "duration_ms", 400).coerceIn(100, 1500).toLong())
                }
                "back", "home" -> {
                    require(selectedDisplay == android.view.Display.DEFAULT_DISPLAY) { "系统 back/home 仅支持主 Display；虚拟 Display 请使用页面节点。" }
                    require(performGlobalAction(if (action == "back") GLOBAL_ACTION_BACK else GLOBAL_ACTION_HOME)) { "系统拒绝了全局操作。" }
                }
                "wait" -> delay(number(arguments, "duration_ms", 600).coerceIn(100, 3000).toLong())
            }
            if (action != "observe") { invalidateObservation(); delay(650); checkSession() }
            val observation = observe()
            DeviceToolResult(JsonObject(observation.data + ("ok" to JsonPrimitive(true)) + ("action" to action.jp())), observation.jpeg)
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { DeviceToolResult.error(e.message ?: "设备操作失败。") }
    }
    private fun catalog(): AppCatalog = sessionApps ?: AppCatalog(packageManager.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
        .map { LaunchableApp(it.activityInfo.packageName, it.loadLabel(packageManager).toString(), listOf(it.activityInfo.applicationInfo.loadLabel(packageManager).toString())) })
        .also { sessionApps = it }
    private fun number(arguments: JsonObject, name: String, default: Int? = null): Int = arguments[name]?.jsonPrimitive?.intOrNull ?: default ?: error("缺少整数参数 $name。")
    private fun point(arguments: JsonObject, x: String, y: String): Pair<Float, Float> {
        val px = number(arguments, x); val py = number(arguments, y)
        require(px in 0 until imageWidth && py in 0 until imageHeight) { "坐标超出最近 screenshot 的范围。" }
        return (bounds.left + px.toFloat() * bounds.width() / imageWidth) to (bounds.top + py.toFloat() * bounds.height() / imageHeight)
    }
    private suspend fun gesture(x: Float, y: Float, endX: Float = x, endY: Float = y, duration: Long = 60) {
        val path = Path().apply { moveTo(x, y); lineTo(endX, endY) }
        val builder = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, duration))
        if (Build.VERSION.SDK_INT >= 30) builder.setDisplayId(selectedDisplay)
        // The window screenshot excludes our overlay; let injected coordinates reach
        // the underlying app even when its target is underneath the stop button.
        overlay?.visibility = View.INVISIBLE
        val success = try { delay(80); currentCoroutineContext().ensureActive(); suspendCancellableCoroutine { continuation ->
            val accepted = dispatchGesture(builder.build(), object : GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) { if (continuation.isActive) continuation.resume(true) }
                override fun onCancelled(gestureDescription: GestureDescription?) { if (continuation.isActive) continuation.resume(false) }
            }, null)
            if (!accepted && continuation.isActive) continuation.resume(false)
        } } finally { overlay?.visibility = View.VISIBLE }
        check(success) { "手势被取消或系统拒绝。" }
    }
    private suspend fun observe(): DeviceObservation {
        checkSession(); delay(250); checkSession(); invalidateObservation()
        val window = activeWindow(); val root = window.root ?: error("窗口内容不可读。")
        windowId = window.id; bounds = Rect().also(window::getBoundsInScreen)
        require(bounds.width() > 0 && bounds.height() > 0) { "窗口没有可见内容。" }
        val scale = minOf(1f, 1280f / maxOf(bounds.width(), bounds.height()))
        imageWidth = (bounds.width() * scale).toInt().coerceAtLeast(1); imageHeight = (bounds.height() * scale).toInt().coerceAtLeast(1)
        var visited = 0
        val entries = buildJsonArray {
            fun visit(node: AccessibilityNodeInfo, depth: Int) {
                if (++visited > 1000 || nodes.size >= 160 || depth > 24 || !node.isVisibleToUser || node.isPassword) return
                val rect = Rect().also(node::getBoundsInScreen)
                if (!Rect.intersects(bounds, rect)) return
                val label = node.text?.toString().orEmpty().take(300)
                val description = node.contentDescription?.toString().orEmpty().take(200)
                if (label.isNotBlank() || description.isNotBlank() || node.isClickable || node.isEditable || node.isScrollable) {
                    val id = "n${nodes.size + 1}"; nodes[id] = AccessibilityNodeInfo.obtain(node)
                    add(buildJsonObject {
                        put("node_id", id); put("text", label); put("description", description); put("view_id", node.viewIdResourceName.orEmpty().take(200))
                        put("clickable", node.isClickable); put("editable", node.isEditable); put("scrollable", node.isScrollable); put("enabled", node.isEnabled)
                        put("bounds", buildJsonArray { add(((rect.left - bounds.left) * scale).toInt()); add(((rect.top - bounds.top) * scale).toInt()); add(((rect.right - bounds.left) * scale).toInt()); add(((rect.bottom - bounds.top) * scale).toInt()) })
                    })
                }
                for (i in 0 until minOf(node.childCount, 200)) {
                    if (visited >= 1000 || nodes.size >= 160) break
                    val child = node.getChild(i) ?: continue; try { visit(child, depth + 1) } finally { @Suppress("DEPRECATION") child.recycle() }
                }
            }
            visit(root, 0)
        }
        val before = generation
        var screenshotError: String? = null
        val jpeg = if (screenshots) try { screenshot(windowId) } catch (e: CancellationException) { throw e } catch (e: Exception) { screenshotError = e.message ?: "截图不可用。"; null } else null
        screenId = newId(); observedGeneration = before; observedAt = SystemClock.elapsedRealtime()
        return DeviceObservation(buildJsonObject {
            put("screen_id", screenId); put("display_id", selectedDisplay); put("window_id", windowId); put("package_name", root.packageName?.toString().orEmpty())
            put("image_width", imageWidth); put("image_height", imageHeight); put("nodes", entries)
            put("screenshot_available", jpeg != null); screenshotError?.let { put("screenshot_error", it) }
            put("coordinate_space", "window screenshot pixels; top-left=(0,0)")
        }, jpeg)
    }
    private suspend fun screenshot(id: Int): String {
        if (Build.VERSION.SDK_INT < 30) throw IllegalStateException("此 Android 版本只支持 UI tree，截图需要 Android 11 或更新。")
        val bitmap = withTimeout(5000) { suspendCancellableCoroutine<Bitmap> { continuation ->
            val callback = object : TakeScreenshotCallback {
                override fun onSuccess(result: ScreenshotResult) {
                    val hardware = result.hardwareBuffer
                    try {
                        val wrapped = Bitmap.wrapHardwareBuffer(hardware, result.colorSpace) ?: error("无法读取截图。")
                        val copy = wrapped.copy(Bitmap.Config.ARGB_8888, false); wrapped.recycle()
                        if (continuation.isActive) continuation.resume(copy) else copy.recycle()
                    } catch (_: Exception) { if (continuation.isActive) continuation.resumeWith(Result.failure(IllegalStateException("截图转换失败。"))) }
                    finally { hardware.close() }
                }
                override fun onFailure(errorCode: Int) {
                    if (continuation.isActive) continuation.resumeWith(Result.failure(IllegalStateException(if (errorCode == 6) "此窗口包含受保护内容，系统禁止截图。" else "系统暂时无法截图（$errorCode）；请使用 UI tree 或稍后重试。")))
                }
            }
            if (Build.VERSION.SDK_INT >= 34) takeScreenshotOfWindow(id, mainExecutor, callback) else takeScreenshot(selectedDisplay, mainExecutor, callback)
        } }
        return try { withContext(Dispatchers.Default) {
                val cropped = if (Build.VERSION.SDK_INT < 34) Bitmap.createBitmap(bitmap, bounds.left.coerceAtLeast(0), bounds.top.coerceAtLeast(0), bounds.width().coerceAtMost(bitmap.width - bounds.left.coerceAtLeast(0)), bounds.height().coerceAtMost(bitmap.height - bounds.top.coerceAtLeast(0))) else bitmap
                val scaled = Bitmap.createScaledBitmap(cropped, imageWidth, imageHeight, true)
                val buffer = ByteArrayOutputStream(); scaled.compress(Bitmap.CompressFormat.JPEG, 75, buffer)
                if (scaled !== cropped) scaled.recycle(); if (cropped !== bitmap) cropped.recycle()
                Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP)
        } } finally { bitmap.recycle() }
    }
}
