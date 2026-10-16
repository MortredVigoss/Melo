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
    fun configureScreenshots(enabled: Boolean) { }
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
    private val targets = mutableMapOf<String, DeviceTarget>()
    private var overlay: Button? = null
    private var overlayManager: WindowManager? = null
    private var confirmationButton: Button? = null
    private var sessionApps: AppCatalog? = null
    private var lastLaunchTarget = ""
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
        sessionApps = null; lastLaunchTarget = ""; authorized = true; invalidateObservation()
    }
    override fun end() {
        authorized = false; sessionApps = null; lastLaunchTarget = ""; invalidateObservation()
        confirmationButton?.let { runCatching { overlayManager?.removeView(it) } }; confirmationButton = null
        overlay?.let { runCatching { overlayManager?.removeView(it) } }; overlay = null; overlayManager = null
    }
    override fun configureScreenshots(enabled: Boolean) { checkSession(); screenshots = enabled; invalidateObservation() }
    private fun invalidateObservation() {
        screenId = ""; nodes.values.forEach { @Suppress("DEPRECATION") it.recycle() }; nodes.clear(); targets.clear()
    }
    private fun checkSession() {
        check(authorized) { "手机助手尚未开始，或已停止。" }
        check(!getSystemService(KeyguardManager::class.java).isKeyguardLocked) { "手机已锁屏，请解锁后重新开始。" }
        check(getSystemService(DisplayManager::class.java).getDisplay(selectedDisplay) != null) { "所选 Display 已断开。" }
    }
    private fun readableWindows(): List<AccessibilityWindowInfo> {
        val windows = if (Build.VERSION.SDK_INT >= 30) windowsOnAllDisplays[selectedDisplay].orEmpty() else windows
        val states = windows.map { window ->
            val root = window.root
            val visible = try { root?.isVisibleToUser == true } finally { @Suppress("DEPRECATION") root?.recycle() }
            DeviceWindowState(window.id, window.isFocused, window.isActive, window.layer, visible,
                window.type == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY || window.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD)
        }
        val byId = windows.associateBy { it.id }
        return DeviceWindowPolicy.observationOrder(states).mapNotNull(byId::get)
    }
    private fun activeWindow(): AccessibilityWindowInfo = readableWindows().firstOrNull()
            ?: error("无法读取此 Display 的窗口，请让目标 App 保持可见。")
    private fun identity(window: AccessibilityWindowInfo): DeviceWindowIdentity {
        val rect = Rect().also(window::getBoundsInScreen)
        return DeviceWindowIdentity(window.id, window.root?.packageName?.toString().orEmpty(), listOf(rect.left, rect.top, rect.right, rect.bottom))
    }
    private fun selectedWindow(id: Int?): AccessibilityWindowInfo {
        val windows = readableWindows()
        val active = windows.firstOrNull() ?: error("无法读取此 Display 的窗口，请让目标 App 保持可见。")
        if (id == null || id == active.id) return active
        return windows.firstOrNull { it.id == id && it.type == AccessibilityWindowInfo.TYPE_APPLICATION && DeviceWindowPolicy.sameApp(identity(active), identity(it)) }
            ?: throw DeviceExecutionException("stale_screen", "所选窗口已不可见或不属于前台 App，请重新 observe。")
    }
    private fun requireFresh(arguments: JsonObject, contentSensitive: Boolean = true) {
        if (!(arguments.text("screen_id") == screenId && screenId.isNotBlank() && (!contentSensitive || observedGeneration == generation) && SystemClock.elapsedRealtime() - observedAt < 90_000)) throw DeviceExecutionException("stale_screen", "屏幕已变化或 observation 已过期，请重新 observe。")
        val current = selectedWindow(windowId); val currentBounds = Rect().also(current::getBoundsInScreen)
        if (current.id != windowId || currentBounds != bounds) throw DeviceExecutionException("stale_screen", "窗口或尺寸已改变，请重新 observe。")
    }
    private fun target(node: AccessibilityNodeInfo): DeviceTarget {
        val rect = Rect().also(node::getBoundsInScreen)
        return DeviceTarget(node.windowId, node.viewIdResourceName.orEmpty(), node.className?.toString().orEmpty(), node.text?.toString().orEmpty(), node.contentDescription?.toString().orEmpty(),
            listOf(rect.left, rect.top, rect.right, rect.bottom), node.isClickable, node.isEditable, node.isEnabled, node.isVisibleToUser, node.isPassword)
    }
    private fun freshNode(arguments: JsonObject): AccessibilityNodeInfo {
        val id = arguments.text("node_id")
        val node = nodes[id] ?: throw DeviceExecutionException("stale_target", "节点不存在，请重新 observe。")
        if (!node.refresh() || !DeviceTargetPolicy.unchanged(targets[id], target(node))) throw DeviceExecutionException("stale_target", "目标节点已改变，请重新观察并定位；不会点击替代节点。")
        return node
    }
    private suspend fun confirm(arguments: JsonObject, node: AccessibilityNodeInfo?): Boolean {
        if (!DeviceTargetPolicy.needsConfirmation(arguments.text("action"), node?.let(::target))) return true
        val agent = (application as MeloApplication).deviceAgent
        val label = node?.let { it.text?.toString()?.takeIf(String::isNotBlank) ?: it.contentDescription?.toString()?.takeIf(String::isNotBlank) ?: it.viewIdResourceName.orEmpty() }
            ?.filterNot(Char::isISOControl)?.take(60)
        val actionDescription = if (node == null) "点击坐标 (${arguments.text("x")}, ${arguments.text("y")}) / ${imageWidth}×${imageHeight}"
            else "点击「${label.orEmpty()}」"
        return coroutineScope {
            val reply = async(start = CoroutineStart.UNDISPATCHED) { agent.requestApproval(actionDescription) }
            val pending = agent.runtime.value.approval ?: error("确认请求无法创建。")
            val button = Button(overlay!!.context).apply {
                text = "允许本步${pending.action}"; isAllCaps = false; maxLines = 2
                setOnClickListener { agent.confirmApproval(pending.id, true) }
            }
            val manager = overlayManager!!
            confirmationButton = button
            try {
                manager.addView(button, WindowManager.LayoutParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY, WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, PixelFormat.TRANSLUCENT).apply {
                    gravity = Gravity.TOP or Gravity.END; x = 8; y = (140 * resources.displayMetrics.density).toInt(); title = "Melo action confirmation"
                })
                reply.await()
            } finally { runCatching { manager.removeView(button) }; if (confirmationButton === button) confirmationButton = null; reply.cancel() }
        }
    }
    override suspend fun execute(arguments: JsonObject): DeviceToolResult = withContext(Dispatchers.Main.immediate) {
        try {
            checkSession(); DeviceTools.validate(arguments)
            val action = arguments.text("action")
            var launchTarget: String? = null
            var launchDispatched = false
            require(action != "finish") { "finish 由任务循环校验，不能直接操作设备。" }
            if (action == "list_apps") return@withContext DeviceToolResult(catalog().page(arguments.text("query"), number(arguments, "offset", 0), number(arguments, "limit", 100)))
            // Home never targets content. Melo's own progress updates must not
            // prevent leaving its window; keep screen identity/age/window checks.
            val contentSensitive = action == "swipe" || action == "tap" && arguments.text("node_id").isBlank()
            if (action !in setOf("observe", "open_app", "wait")) requireFresh(arguments, contentSensitive)
            when (action) {
                "open_app" -> {
                    val requestedPackage = arguments.text("package_name")
                    // An exact cached package needs only a scoped launcher query.
                    // Never store this subset as the session's full app catalog.
                    val apps = if (sessionApps == null && requestedPackage.matches(Regex("[A-Za-z0-9_.]+"))) {
                        val scoped = AppCatalog(packageManager.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setPackage(requestedPackage), 0)
                            .map { LaunchableApp(it.activityInfo.packageName, it.loadLabel(packageManager).toString(), listOf(it.activityInfo.applicationInfo.loadLabel(packageManager).toString())) })
                        if (scoped.exactPackage(requestedPackage).isNotEmpty()) scoped else catalog()
                    } else catalog()
                    val candidates = if (arguments.text("package_name").isNotBlank()) apps.exactPackage(arguments.text("package_name")) else apps.exactName(arguments.text("app_name"))
                    if (candidates.size != 1) return@withContext apps.openFailure(arguments.text("package_name"), arguments.text("app_name"), candidates.size > 1)
                    launchTarget = candidates.single().packageName
                    // A first launch may intentionally return from a detail page to the app entry.
                    // A repeated launch without navigation must not restart an already visible app.
                    if (lastLaunchTarget != launchTarget || identity(activeWindow()).packageName != launchTarget) {
                        val intent = packageManager.getLaunchIntentForPackage(launchTarget) ?: error("该 App 没有可启动入口。")
                        val options = android.app.ActivityOptions.makeBasic().apply { if (Build.VERSION.SDK_INT >= 26) launchDisplayId = selectedDisplay }
                        startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), options.toBundle())
                        launchDispatched = true
                    }
                    lastLaunchTarget = launchTarget
                }
                "tap" -> {
                    val nodeId = arguments.text("node_id")
                    if (nodeId.isNotBlank()) {
                        var node = freshNode(arguments)
                        if (!confirm(arguments, node)) return@withContext DeviceToolResult.error("本步操作未获允许，已停止。", "user_declined")
                        checkSession(); requireFresh(arguments, false); node = freshNode(arguments)
                        if (!node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                            val rect = Rect().also(node::getBoundsInScreen)
                            require(rect.intersect(bounds)) { "节点不在当前窗口内。" }; gesture(rect.exactCenterX(), rect.exactCenterY(), verify = { checkSession(); requireFresh(arguments, false); freshNode(arguments) })
                        }
                    } else {
                        // Validate coordinates before asking; approval never bypasses freshness.
                        point(arguments, "x", "y")
                        if (!confirm(arguments, null)) return@withContext DeviceToolResult.error("本步操作未获允许，已停止。", "user_declined")
                        checkSession(); requireFresh(arguments)
                        val (x, y) = point(arguments, "x", "y"); gesture(x, y, verify = { checkSession(); requireFresh(arguments) })
                    }
                }
                "type_text" -> {
                    val node = freshNode(arguments)
                    require(node.isEditable) { "该节点不可编辑。" }
                    require(node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, arguments.text("text")) })) { "此 App 不支持节点输入。" }
                }
                "swipe" -> {
                    val start = point(arguments, "x", "y"); val end = point(arguments, "end_x", "end_y")
                    gesture(start.first, start.second, end.first, end.second, number(arguments, "duration_ms", 400).coerceIn(100, 1500).toLong(), verify = { checkSession(); requireFresh(arguments) })
                }
                "back", "home" -> {
                    require(selectedDisplay == android.view.Display.DEFAULT_DISPLAY) { "系统 back/home 仅支持主 Display；虚拟 Display 请使用页面节点。" }
                    require(performGlobalAction(if (action == "back") GLOBAL_ACTION_BACK else GLOBAL_ACTION_HOME)) { "系统拒绝了全局操作。" }
                }
                "wait" -> delay(number(arguments, "duration_ms", 600).coerceIn(100, 3000).toLong())
            }
            if (action in setOf("tap", "type_text", "swipe", "back", "home")) lastLaunchTarget = ""
            if (action != "observe") { invalidateObservation(); delay(650); checkSession() }
            val observation = observe(if (action == "observe") arguments["window_id"]?.jsonPrimitive?.intOrNull else null)
            DeviceToolResult(buildJsonObject {
                observation.data.forEach { (key, value) -> put(key, value) }; put("ok", true); put("action", action)
                launchTarget?.let {
                    put("target_package", it); put("launch_dispatched", launchDispatched)
                    if (!launchDispatched) { put("code", "already_foreground"); put("hint", "The app is already visible. Inspect the current pane and related_windows. Finish if the requested visible goal is satisfied; otherwise navigate. Do not relaunch again.") }
                }
            }, observation.jpeg)
        } catch (e: CancellationException) { throw e }
        catch (e: DeviceExecutionException) { DeviceToolResult.error(e.message.orEmpty(), e.code) }
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
    private suspend fun gesture(x: Float, y: Float, endX: Float = x, endY: Float = y, duration: Long = 60, verify: () -> Unit) {
        val path = Path().apply { moveTo(x, y); lineTo(endX, endY) }
        val builder = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, duration))
        if (Build.VERSION.SDK_INT >= 30) builder.setDisplayId(selectedDisplay)
        // The window screenshot excludes our overlay; let injected coordinates reach
        // the underlying app even when its target is underneath the stop button.
        overlay?.visibility = View.INVISIBLE
        val success = try { delay(80); currentCoroutineContext().ensureActive(); verify(); suspendCancellableCoroutine { continuation ->
            val accepted = dispatchGesture(builder.build(), object : GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) { if (continuation.isActive) continuation.resume(true) }
                override fun onCancelled(gestureDescription: GestureDescription?) { if (continuation.isActive) continuation.resume(false) }
            }, null)
            if (!accepted && continuation.isActive) continuation.resume(false)
        } } finally { overlay?.visibility = View.VISIBLE }
        check(success) { "手势被取消或系统拒绝。" }
    }
    private suspend fun observe(requestedWindowId: Int? = null): DeviceObservation {
        checkSession()
        // Bounded quiet wait: animated pages remain usable through node validation.
        for (attempt in 0 until 5) { val before = generation; delay(120); if (generation == before) break }
        checkSession(); invalidateObservation()
        val window = selectedWindow(requestedWindowId); val root = window.root ?: error("窗口内容不可读。")
        windowId = window.id; bounds = Rect().also(window::getBoundsInScreen)
        require(bounds.width() > 0 && bounds.height() > 0) { "窗口没有可见内容。" }
        val scale = minOf(1f, 1280f / maxOf(bounds.width(), bounds.height()))
        imageWidth = (bounds.width() * scale).toInt().coerceAtLeast(1); imageHeight = (bounds.height() * scale).toInt().coerceAtLeast(1)
        var visited = 0
        val before = generation
        val entries = buildJsonArray {
            fun visit(node: AccessibilityNodeInfo, depth: Int) {
                if (++visited > 1000 || nodes.size >= 160 || depth > 24 || !node.isVisibleToUser || node.isPassword) return
                val rect = Rect().also(node::getBoundsInScreen)
                if (!Rect.intersects(bounds, rect)) return
                val label = node.text?.toString().orEmpty().take(300)
                val description = node.contentDescription?.toString().orEmpty().take(200)
                if (label.isNotBlank() || description.isNotBlank() || node.isClickable || node.isEditable || node.isScrollable) {
                    val id = "n${nodes.size + 1}"; nodes[id] = AccessibilityNodeInfo.obtain(node); targets[id] = target(node)
                    add(buildJsonObject {
                        put("node_id", id); put("text", label); put("description", description); put("view_id", node.viewIdResourceName.orEmpty().take(200)); put("class_name", node.className?.toString().orEmpty().take(200))
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
        var screenshotError: String? = null
        val jpeg = if (screenshots) try { screenshot(windowId) } catch (e: CancellationException) { throw e } catch (e: Exception) { screenshotError = e.message ?: "截图不可用。"; null } else null
        screenId = newId(); observedGeneration = before; observedAt = SystemClock.elapsedRealtime()
        return DeviceObservation(buildJsonObject {
            put("screen_id", screenId); put("display_id", selectedDisplay); put("window_id", windowId); put("package_name", root.packageName?.toString().orEmpty())
            put("window_title", window.title?.toString().orEmpty().take(160))
            put("screenshot_scope", "selected_window_only")
            put("related_windows", buildJsonArray {
                for (related in readableWindows().filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION && DeviceWindowPolicy.sameApp(identity(window), identity(it)) }) add(buildJsonObject {
                    put("window_id", related.id); put("title", related.title?.toString().orEmpty().take(160)); put("selected", related.id == windowId)
                })
            })
            put("image_width", imageWidth); put("image_height", imageHeight); put("nodes", entries)
            put("screenshot_available", jpeg != null); screenshotError?.let { put("screenshot_error", it) }
            put("stable", generation == before)
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

private class DeviceExecutionException(val code: String, message: String) : IllegalStateException(message)
