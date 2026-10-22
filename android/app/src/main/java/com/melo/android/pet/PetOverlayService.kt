package com.melo.android.pet

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Point
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.TypedValue
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.melo.android.MainActivity
import com.melo.android.MeloApplication
import com.melo.android.R
import com.melo.android.data.MeloJson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.Locale
import kotlin.math.roundToInt

/** Everything an instrumentation test (or the settings page) can observe about the floating pet. */
data class PetOverlayState(
    val attached: Boolean = false, val skin: String = "", val clip: String = "", val mode: PetMode = PetMode.IDLE, val token: Int = 0,
    val playing: Boolean = false, val videoWidth: Int = 0, val videoHeight: Int = 0, val bubble: String = "", val menu: Boolean = false,
    val window: Rect = Rect(), val body: Rect = Rect(), val transcript: String = "", val reply: String = "", val error: String = "", val microphone: Boolean = false,
)

/**
 * Foreground service that keeps 金冬天 (or 大肥鱼) floating over other apps.
 * The pet window is only as large as the opaque part of the current clip; a
 * second window carries the speech bubble and a third the long-press menu, so
 * the rest of the screen keeps receiving touches. Playback is a transparent
 * WebView showing the packaged VP9+alpha WebM clips.
 */
class PetOverlayService : Service() {
    companion object {
        const val ACTION_START = "com.melo.android.pet.START"
        const val ACTION_STOP = "com.melo.android.pet.STOP"
        const val ACTION_STOP_SPEECH = "com.melo.android.pet.STOP_SPEECH"
        const val NOTIFICATION_ID = 1301
        private const val CHANNEL = "pet"
        private const val UTTERANCE = "pet-reply"
        private const val TAG = "MeloPet"
        val state = kotlinx.coroutines.flow.MutableStateFlow(PetOverlayState())
        /** Replaces the system recognizer (instrumentation on emulators without one). */
        @Volatile var speechInputFactory: ((Context) -> PetSpeechInput)? = null
        fun canDraw(context: Context) = Settings.canDrawOverlays(context)
        fun start(context: Context) { context.startForegroundService(Intent(context, PetOverlayService::class.java).setAction(ACTION_START)) }
        fun stop(context: Context) { context.stopService(Intent(context, PetOverlayService::class.java)) }
    }

    private val handler = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val preferences by lazy { (application as MeloApplication).petPreferences }
    private lateinit var catalog: PetCatalog
    private lateinit var skin: PetSkin
    private lateinit var scheduler: PetScheduler
    private lateinit var windowManager: WindowManager
    private var petView: PetView? = null
    private var webView: WebView? = null
    private var petParams: WindowManager.LayoutParams? = null
    private var bubbleView: TextView? = null
    private var bubbleParams: WindowManager.LayoutParams? = null
    private var menuView: LinearLayout? = null
    private var menuParams: WindowManager.LayoutParams? = null
    private val screen = Point()
    private var scale = 1f
    private var anchor = Point()
    private var bodyBox = PetBox(0, 0, 1, 1)
    private var playerReady = false
    private var currentPlayback: PetPlayback? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var ttsLanguage: String? = null
    private var speech: PetSpeechInput? = null
    private var conversation: Job? = null
    private var bubbleTimeout: Runnable? = null
    private var preferenceWatcher: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "Melo 桌宠", NotificationManager.IMPORTANCE_LOW).apply { description = "桌宠常驻时的通知" })
        ensureForeground(microphone = false)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> { preferences.update { it.copy(enabled = false) }; stopSelf(); return START_NOT_STICKY }
            ACTION_STOP_SPEECH -> { stopSpeaking(); return START_STICKY }
        }
        if (!preferences.value.enabled || !canDraw(this)) { stopSelf(); return START_NOT_STICKY }
        if (petView == null) runCatching { attach() }.onFailure { failure -> setState { it.copy(error = failure.message ?: failure.toString()) }; stopSelf(); return START_NOT_STICKY }
        return START_STICKY
    }

    override fun onDestroy() {
        preferenceWatcher?.cancel(); conversation?.cancel(); scope.cancel()
        speech?.destroy(); speech = null
        tts?.stop(); tts?.shutdown(); tts = null; ttsReady = false
        hideMenu(); hideBubble()
        petView?.let { runCatching { windowManager.removeView(it) } }
        webView?.let { runCatching { it.loadUrl("about:blank"); it.destroy() } }
        petView = null; webView = null; petParams = null
        setState { PetOverlayState(error = it.error) }
        super.onDestroy()
    }

    // ----- foreground notification -----
    private fun ensureForeground(microphone: Boolean) {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 1, Intent(this, PetOverlayService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val name = if (::skin.isInitialized) skin.name else "桌宠"
        val notification = Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_melo).setContentTitle("$name 在屏幕上")
            .setContentText(if (microphone) "正在听你说话" else "单击换动作 · 双击说话 · 长按菜单 · 拖动移动").setContentIntent(open).setOngoing(true)
            .addAction(Notification.Action.Builder(null, "关闭桌宠", stop).build()).build()
        val attempt = runCatching {
            when {
                Build.VERSION.SDK_INT >= 34 -> startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE or if (microphone) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0)
                Build.VERSION.SDK_INT >= 29 -> startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST)
                else -> startForeground(NOTIFICATION_ID, notification)
            }
        }
        if (attempt.isFailure && microphone && Build.VERSION.SDK_INT >= 34) runCatching { startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) }
        setState { it.copy(microphone = microphone && attempt.isSuccess) }
    }

    // ----- window setup -----
    private fun attach() {
        windowManager = getSystemService(WindowManager::class.java)
        catalog = PetCatalog.load(this)
        val saved = preferences.value
        skin = catalog.skin(saved.skin)
        scheduler = PetScheduler(catalog.animations).apply { autoActions = saved.autoActions; restMinMs = saved.restMinMs; restMaxMs = saved.restMaxMs }
        measureScreen()
        applySize(saved.sizeDp)
        bodyBox = skin.clips[catalog.animations.idle.first()]?.box ?: PetBox(0, 0, catalog.stage.width, catalog.stage.height)
        anchor = if (saved.anchorX < 0 || saved.anchorY < 0) defaultAnchor() else clampAnchor(Point(saved.anchorX, saved.anchorY))
        val view = PetView(this)
        val web = WebView(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.domStorageEnabled = false
            settings.cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
            isHorizontalScrollBarEnabled = false; isVerticalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            isFocusable = false; isFocusableInTouchMode = false; isClickable = false
            addJavascriptInterface(Bridge(), "PetBridge")
            webChromeClient = android.webkit.WebChromeClient()
        }
        view.addView(web, FrameLayout.LayoutParams(stageWidthPx(), stageHeightPx()))
        val params = WindowManager.LayoutParams(1, 1, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            PixelFormat.TRANSLUCENT).apply { gravity = Gravity.TOP or Gravity.START; title = "Melo desktop pet" }
        petView = view; webView = web; petParams = params
        layoutFor(null, add = true)
        web.loadUrl("file:///android_asset/${PetCatalog.ASSET_ROOT}/player.html")
        setState { it.copy(attached = true, skin = skin.id, error = "") }
        ensureForeground(microphone = false)
        // Selecting the voice is a blocking call into the TTS service (slow on first use); do it once now, not when a reply arrives.
        tts = TextToSpeech(applicationContext) { status -> ttsReady = status == TextToSpeech.SUCCESS; if (ttsReady) handler.post { applyTtsLanguage() } }.apply {
            setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {}
                override fun onDone(utteranceId: String?) { handler.post { if (scheduler.mode == PetMode.SPEAK) play(scheduler.done()) } }
                @Deprecated("Deprecated in Java") override fun onError(utteranceId: String?) { handler.post { if (scheduler.mode == PetMode.SPEAK) play(scheduler.done()) } }
                override fun onError(utteranceId: String?, errorCode: Int) { onError(utteranceId) }
            })
        }
        preferenceWatcher = scope.launch { preferences.settings.collect { applyPreferences(it) } }
    }

    private fun applyPreferences(settings: PetSettings) {
        if (petView == null) return
        if (!settings.enabled) { stopSelf(); return }
        scheduler.autoActions = settings.autoActions; scheduler.restMinMs = settings.restMinMs; scheduler.restMaxMs = settings.restMaxMs
        var relayout = false
        if (settings.skin != skin.id && catalog.hasSkin(settings.skin)) {
            skin = catalog.skin(settings.skin); bodyBox = skin.clips[catalog.animations.idle.first()]?.box ?: bodyBox
            setState { it.copy(skin = skin.id) }; ensureForeground(state.value.microphone)
            if (playerReady) { stopSpeaking(); play(scheduler.start()) }
            relayout = true
        }
        if (settings.sizeDp.toFloat() != currentSizeDp) { applySize(settings.sizeDp); relayout = true }
        if (relayout) { anchor = clampAnchor(anchor); layoutFor(currentPlayback) }
    }

    private var currentSizeDp = 0f
    private fun dp(value: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, resources.displayMetrics)
    private fun applySize(sizeDp: Int) {
        currentSizeDp = sizeDp.toFloat()
        scale = dp(sizeDp.toFloat()) / catalog.stage.width
        webView?.layoutParams = FrameLayout.LayoutParams(stageWidthPx(), stageHeightPx())
    }
    private fun stageWidthPx() = (catalog.stage.width * scale).roundToInt()
    private fun stageHeightPx() = (catalog.stage.height * scale).roundToInt()
    private fun measureScreen() {
        if (Build.VERSION.SDK_INT >= 30) { val bounds = windowManager.currentWindowMetrics.bounds; screen.set(bounds.width(), bounds.height()) }
        else { val metrics = resources.displayMetrics; screen.set(metrics.widthPixels, metrics.heightPixels) }
    }
    private fun bodyRect(at: Point = anchor): Rect {
        val left = at.x + (bodyBox.x * scale).roundToInt(); val top = at.y + (bodyBox.y * scale).roundToInt()
        return Rect(left, top, left + (bodyBox.w * scale).roundToInt(), top + (bodyBox.h * scale).roundToInt())
    }
    private fun defaultAnchor(): Point {
        val body = bodyRect(Point(0, 0))
        return clampAnchor(Point(screen.x - body.right, (screen.y * 0.55f).roundToInt() - body.top))
    }
    private fun clampAnchor(point: Point): Point {
        val body = bodyRect(Point(0, 0))
        val x = point.x.coerceIn(-body.left, (screen.x - body.right).coerceAtLeast(-body.left))
        val y = point.y.coerceIn(-body.top, (screen.y - body.bottom).coerceAtLeast(-body.top))
        return Point(x, y)
    }
    private fun snapToEdge() {
        measureScreen()
        val body = bodyRect()
        val left = body.centerX() < screen.x / 2
        val target = Point(if (left) -bodyRect(Point(0, 0)).left else screen.x - bodyRect(Point(0, 0)).right, anchor.y)
        anchor = clampAnchor(target)
        preferences.update { it.copy(anchorX = anchor.x, anchorY = anchor.y, edge = if (left) "left" else "right") }
        layoutFor(currentPlayback)
    }

    /** The window covers only the opaque box of the clip (plus a small margin); the stage is offset inside it. */
    private fun layoutFor(playback: PetPlayback?, add: Boolean = false) {
        val view = petView ?: return; val web = webView ?: return; val params = petParams ?: return
        val clipBox = playback?.let { skin.clips[it.clip]?.box } ?: bodyBox
        val mirroredX = if (playback?.mirrored == true) catalog.stage.width - clipBox.x - clipBox.w else clipBox.x
        val margin = 6
        val x0 = (mirroredX - margin).coerceAtLeast(0); val y0 = (clipBox.y - margin).coerceAtLeast(0)
        val x1 = (mirroredX + clipBox.w + margin).coerceAtMost(catalog.stage.width); val y1 = (clipBox.y + clipBox.h + margin).coerceAtMost(catalog.stage.height)
        val vx = (x0 * scale).roundToInt(); val vy = (y0 * scale).roundToInt()
        params.width = ((x1 - x0) * scale).roundToInt().coerceAtLeast(1); params.height = ((y1 - y0) * scale).roundToInt().coerceAtLeast(1)
        params.x = anchor.x + vx; params.y = anchor.y + vy
        web.translationX = -vx.toFloat(); web.translationY = -vy.toFloat()
        if (add) windowManager.addView(view, params) else windowManager.updateViewLayout(view, params)
        setState { it.copy(window = Rect(params.x, params.y, params.x + params.width, params.y + params.height), body = bodyRect()) }
        positionBubble()
    }

    // ----- playback -----
    private inner class Bridge {
        @JavascriptInterface fun onEvent(json: String) { handler.post { handleWebEvent(json) } }
    }
    private fun handleWebEvent(json: String) {
        if (petView == null) return
        val event = runCatching { MeloJson.parseToJsonElement(json).jsonObject }.getOrNull() ?: return
        if (event["type"]?.jsonPrimitive?.content != "playing") android.util.Log.d(TAG, "web event $json")
        val type = event["type"]?.jsonPrimitive?.content ?: return
        val token = event["token"]?.jsonPrimitive?.content?.toIntOrNull() ?: -1
        when (type) {
            "ready" -> { playerReady = true; play(scheduler.start()) }
            "playing" -> if (token == currentPlayback?.token) setState { it.copy(playing = true, videoWidth = event["width"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0, videoHeight = event["height"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0) }
            "ended" -> scheduler.clipEnded(token)?.let(::play)
            "error" -> if (token == currentPlayback?.token) {
                setState { it.copy(playing = false, error = "播放失败：${event["message"]?.jsonPrimitive?.content.orEmpty()} (${currentPlayback?.clip})") }
                handler.postDelayed({ if (petView != null && currentPlayback?.token == token) play(scheduler.idle()) }, 1500)
            }
        }
    }
    private fun play(playback: PetPlayback) {
        val web = webView ?: return
        val clip = skin.clips[playback.clip] ?: run { setState { it.copy(error = "缺少动作 ${playback.clip}") }; return }
        currentPlayback = playback
        layoutFor(playback)
        val file = MeloJson.encodeToString(String.serializer(), clip.file)
        web.evaluateJavascript("window.petPlayer && petPlayer.play($file, ${playback.token}, ${playback.mirrored})", null)
        setState { it.copy(clip = playback.clip, mode = playback.mode, token = playback.token, playing = false) }
    }

    // ----- touch -----
    private inner class PetView(context: Context) : FrameLayout(context) {
        private var downX = 0f; private var downY = 0f
        private var startAnchor = Point()
        private var dragging = false
        private val detector = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent) = true
            override fun onSingleTapConfirmed(e: MotionEvent): Boolean { android.util.Log.d(TAG, "tap"); onTap(); return true }
            override fun onDoubleTap(e: MotionEvent): Boolean { android.util.Log.d(TAG, "double tap"); onDoubleTap(); return true }
            override fun onLongPress(e: MotionEvent) { android.util.Log.d(TAG, "long press dragging=$dragging"); if (!dragging) showMenu() }
            override fun onScroll(e1: MotionEvent?, e2: MotionEvent, distanceX: Float, distanceY: Float): Boolean {
                if (!dragging) { dragging = true; hideMenu(); if (scheduler.mode in setOf(PetMode.IDLE, PetMode.ACTION, PetMode.CLICK, PetMode.DONE, PetMode.FAIL)) play(scheduler.dragStart()) }
                anchor = clampAnchor(Point(startAnchor.x + (e2.rawX - downX).roundToInt(), startAnchor.y + (e2.rawY - downY).roundToInt()))
                layoutFor(currentPlayback)
                return true
            }
        })
        init { clipChildren = true; clipToPadding = true }
        override fun onInterceptTouchEvent(ev: MotionEvent) = true
        override fun onTouchEvent(event: MotionEvent): Boolean {
            if (event.actionMasked == MotionEvent.ACTION_DOWN) { downX = event.rawX; downY = event.rawY; startAnchor = Point(anchor); dragging = false }
            detector.onTouchEvent(event)
            if ((event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) && dragging) {
                dragging = false
                if (scheduler.mode == PetMode.DRAG) play(scheduler.dragEnd())
                snapToEdge()
            }
            return true
        }
    }

    private fun onTap() {
        hideMenu()
        if (scheduler.mode == PetMode.SPEAK) { stopSpeaking(); return }
        scheduler.tap()?.let(::play)
    }
    private fun onDoubleTap() { hideMenu(); beginListening() }

    // ----- bubble -----
    private fun bubble(text: String, durationMs: Long) {
        bubbleTimeout?.let(handler::removeCallbacks); bubbleTimeout = null
        if (text.isBlank()) { hideBubble(); return }
        val view = bubbleView ?: TextView(this).apply {
            setTextColor(0xFFEDE8DF.toInt()); setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f); setLineSpacing(0f, 1.2f)
            setPadding(dp(14f).roundToInt(), dp(10f).roundToInt(), dp(14f).roundToInt(), dp(10f).roundToInt())
            maxLines = 6; ellipsize = android.text.TextUtils.TruncateAt.END
            background = GradientDrawable().apply { cornerRadius = dp(14f); setColor(0xF215171C.toInt()); setStroke(dp(1f).roundToInt(), 0x66D1B27D) }
        }.also { bubbleView = it }
        view.maxWidth = minOf((screen.x * 0.72f).roundToInt(), dp(300f).roundToInt())
        view.text = text
        val params = bubbleParams ?: WindowManager.LayoutParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, PixelFormat.TRANSLUCENT)
            .apply { gravity = Gravity.TOP or Gravity.START; title = "Melo desktop pet bubble" }.also { bubbleParams = it }
        if (view.parent == null) windowManager.addView(view, params)
        positionBubble()
        setState { it.copy(bubble = text) }
        if (durationMs > 0) { val timeout = Runnable { hideBubble() }; bubbleTimeout = timeout; handler.postDelayed(timeout, durationMs) }
    }
    private fun positionBubble() {
        val view = bubbleView ?: return; val params = bubbleParams ?: return
        if (view.parent == null) return
        view.measure(View.MeasureSpec.makeMeasureSpec(view.maxWidth, View.MeasureSpec.AT_MOST), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
        val body = bodyRect(); val gap = dp(6f).roundToInt()
        params.x = (body.centerX() - view.measuredWidth / 2).coerceIn(0, (screen.x - view.measuredWidth).coerceAtLeast(0))
        params.y = if (body.top - view.measuredHeight - gap >= 0) body.top - view.measuredHeight - gap else body.bottom + gap
        windowManager.updateViewLayout(view, params)
    }
    private fun hideBubble() {
        bubbleTimeout?.let(handler::removeCallbacks); bubbleTimeout = null
        bubbleView?.let { if (it.parent != null) runCatching { windowManager.removeView(it) } }
        setState { it.copy(bubble = "") }
    }

    // ----- long-press menu -----
    private fun showMenu() {
        android.util.Log.d(TAG, "show menu")
        hideMenu()
        val other = catalog.skins.values.firstOrNull { it.id != skin.id }
        val items = buildList {
            add("关闭桌宠" to { preferences.update { it.copy(enabled = false) } })
            if (other != null) add("换成${other.name}" to { preferences.update { it.copy(skin = other.id) } })
            add("打开 Melo" to { openApp(null) })
            if (scheduler.mode == PetMode.SPEAK) add("停止朗读" to { stopSpeaking() })
        }
        val menu = object : LinearLayout(this) {
            override fun onTouchEvent(event: MotionEvent): Boolean { if (event.actionMasked == MotionEvent.ACTION_OUTSIDE) hideMenu(); return super.onTouchEvent(event) }
        }.apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply { cornerRadius = dp(14f); setColor(0xF815171C.toInt()); setStroke(dp(1f).roundToInt(), 0x66D1B27D) }
            setPadding(dp(6f).roundToInt(), dp(6f).roundToInt(), dp(6f).roundToInt(), dp(6f).roundToInt())
            items.forEach { (label, action) -> addView(TextView(context).apply {
                text = label; setTextColor(0xFFEDE8DF.toInt()); setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                setPadding(dp(18f).roundToInt(), dp(12f).roundToInt(), dp(18f).roundToInt(), dp(12f).roundToInt())
                contentDescription = label
                setOnClickListener { hideMenu(); action() }
            }) }
        }
        val params = WindowManager.LayoutParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH, PixelFormat.TRANSLUCENT)
            .apply { gravity = Gravity.TOP or Gravity.START; title = "Melo desktop pet menu" }
        menu.measure(View.MeasureSpec.makeMeasureSpec(screen.x, View.MeasureSpec.AT_MOST), View.MeasureSpec.makeMeasureSpec(screen.y, View.MeasureSpec.AT_MOST))
        val body = bodyRect(); val gap = dp(8f).roundToInt()
        params.x = if (body.centerX() < screen.x / 2) (body.right + gap).coerceAtMost(screen.x - menu.measuredWidth) else (body.left - gap - menu.measuredWidth).coerceAtLeast(0)
        params.y = (body.top).coerceIn(0, (screen.y - menu.measuredHeight).coerceAtLeast(0))
        windowManager.addView(menu, params)
        menuView = menu; menuParams = params
        setState { it.copy(menu = true) }
    }
    private fun hideMenu() {
        menuView?.let { runCatching { windowManager.removeView(it) } }
        menuView = null; menuParams = null
        setState { it.copy(menu = false) }
    }
    private fun openApp(page: String?) {
        val intent = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (page != null) intent.putExtra("melo_page", page)
        runCatching { startActivity(intent) }.onFailure { bubble("请从通知或桌面打开 Melo。", 4000) }
    }

    // ----- speech -> Melo -> reading -----
    private fun beginListening() {
        if (scheduler.mode == PetMode.LISTEN || scheduler.mode == PetMode.THINK) return
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            bubble("需要麦克风权限：到 Melo → 系统 → 桌宠 授权。", 6000); play(scheduler.fail()); openApp("pet"); return
        }
        stopSpeaking()
        ensureForeground(microphone = true)
        play(scheduler.listen()); bubble("我在听…", 0)
        val input = speech ?: (speechInputFactory?.invoke(this) ?: SystemSpeechInput(this)).also { speech = it }
        input.start(preferences.value.speechLanguage, object : PetSpeechListener {
            override fun onPartial(text: String) { handler.post { if (scheduler.mode == PetMode.LISTEN) bubble(text, 0) } }
            override fun onResult(text: String) { handler.post { ensureForeground(microphone = false); if (scheduler.mode == PetMode.LISTEN) ask(text) } }
            override fun onError(message: String) { handler.post { ensureForeground(microphone = false); if (scheduler.mode == PetMode.LISTEN) { play(scheduler.fail()); bubble(message, 5000) } } }
        })
    }
    private fun ask(text: String) {
        conversation?.cancel()
        conversation = scope.launch {
            val app = application as MeloApplication
            try {
                withTimeout(15_000) { app.engine.runtime.first { it.initialized } }
                val chatId = PetChat.ensure(app.repository, preferences)
                setState { it.copy(transcript = text) }
                play(scheduler.think()); bubble("想想看…", 0)
                if (!app.engine.send(chatId, text)) { fail(app.engine.runtime.value.error ?: "Melo 现在没法回复。"); return@launch }
                val runId = withTimeout(10_000) { app.engine.runtime.map { it.turns[chatId]?.runId }.first { it != null } }!!
                var streaming = false
                app.engine.runtime.first { runtime ->
                    val turn = runtime.turns[chatId]
                    if (turn != null && turn.partial.isNotBlank() && !streaming) { streaming = true; play(scheduler.wait()) }
                    turn == null
                }
                val reply = PetDialogue.replyOutcome(app.repository.data.value, chatId, runId)
                PetChat.keepTitle(app.repository, chatId)
                if (reply?.ok == true) deliver(reply.text) else fail(PetDialogue.failureText(reply))
            } catch (error: kotlinx.coroutines.CancellationException) { throw error }
            catch (error: Exception) { fail(error.message ?: "这次没收到回复。") }
        }
    }
    private fun deliver(text: String) {
        setState { it.copy(reply = text) }
        bubble(PetDialogue.bubblePreview(text), (12_000L + text.length * 60L).coerceAtMost(40_000L))
        if (preferences.value.speakReplies && speak(text)) play(scheduler.speak()) else play(scheduler.done())
    }
    private fun fail(message: String) {
        setState { it.copy(error = message) }
        play(scheduler.fail()); bubble(message, 6000)
    }
    private fun applyTtsLanguage() {
        val engine = tts ?: return
        if (!ttsReady) return
        val language = preferences.value.speechLanguage
        if (ttsLanguage == language) return
        val locale = if (language.isBlank()) Locale.getDefault() else Locale.forLanguageTag(language)
        val support = runCatching { engine.setLanguage(locale) }.getOrDefault(TextToSpeech.LANG_NOT_SUPPORTED)
        if (support == TextToSpeech.LANG_MISSING_DATA || support == TextToSpeech.LANG_NOT_SUPPORTED) runCatching { engine.setLanguage(Locale.getDefault()) }
        ttsLanguage = language
    }
    private fun speak(text: String): Boolean {
        val engine = tts ?: return false
        if (!ttsReady) return false
        applyTtsLanguage()
        val spoken = PetDialogue.speechText(text).take(TextToSpeech.getMaxSpeechInputLength() - 1)
        if (spoken.isBlank()) return false
        return engine.speak(spoken, TextToSpeech.QUEUE_FLUSH, null, UTTERANCE) == TextToSpeech.SUCCESS
    }
    private fun stopSpeaking() {
        tts?.let { runCatching { it.stop() } }
        if (::scheduler.isInitialized && scheduler.mode == PetMode.SPEAK) { hideBubble(); play(scheduler.idle()) }
    }

    private fun setState(transform: (PetOverlayState) -> PetOverlayState) { state.value = transform(state.value) }
}
