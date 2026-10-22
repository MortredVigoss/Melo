package com.melo.android

import android.app.UiAutomation
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.melo.android.data.*
import com.melo.android.pet.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.junit.*
import org.junit.Assert.*

/**
 * Real overlay windows on the emulator: VP9+alpha clips decode in the WebView,
 * injected touches drive the chain, a fixture recognizer feeds the local
 * Fixture model, and the stop action removes everything. No personal device.
 */
class PetOverlayFlowTest {
    private val app get() = ApplicationProvider.getApplicationContext<MeloApplication>()
    private lateinit var automation: UiAutomation
    private var before: AppData? = null
    private var settingsBefore: PetSettings? = null
    private val state get() = PetOverlayService.state.value
    private fun shell(command: String) = automation.executeShellCommand(command).use { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { r -> r.readText().trim() } }
    // Generous budgets: a fresh WebView renderer plus VP9 software decode can take over a minute on a loaded CI emulator.
    private fun waitFor(timeout: Long = 60_000, message: String = "Condition not reached", check: () -> Boolean) {
        val end = SystemClock.elapsedRealtime() + timeout
        while (!check() && SystemClock.elapsedRealtime() < end) SystemClock.sleep(80)
        assertTrue("$message · $state", check())
    }
    /** A finger-shaped touch event, like the ones `adb shell input` produces. */
    private fun inject(action: Int, x: Float, y: Float, downTime: Long) {
        val properties = MotionEvent.PointerProperties().apply { id = 0; toolType = MotionEvent.TOOL_TYPE_FINGER }
        val coords = MotionEvent.PointerCoords().apply { this.x = x; this.y = y; pressure = 1f; size = 1f }
        val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, 1, arrayOf(properties), arrayOf(coords), 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
        assertTrue(automation.injectInputEvent(event, true)); event.recycle()
    }
    /** A stalled main thread would turn a synthetic tap into a long press (the UP is injected only after the DOWN is handled), so settle first. */
    private fun settle() { InstrumentationRegistry.getInstrumentation().waitForIdleSync() }
    private fun rawTap(x: Float, y: Float) { val down = SystemClock.uptimeMillis(); inject(MotionEvent.ACTION_DOWN, x, y, down); SystemClock.sleep(40); inject(MotionEvent.ACTION_UP, x, y, down) }
    private fun tap(x: Float, y: Float) { settle(); rawTap(x, y) }
    private fun doubleTap(x: Float, y: Float) { settle(); rawTap(x, y); SystemClock.sleep(60); rawTap(x, y) }
    /** Holds the finger still for `holdMs`, emitting the periodic MOVE samples a real touch stream carries. */
    private fun longPress(x: Float, y: Float, holdMs: Long = 900) {
        settle()
        val down = SystemClock.uptimeMillis()
        inject(MotionEvent.ACTION_DOWN, x, y, down)
        val end = down + holdMs
        while (SystemClock.uptimeMillis() < end) { SystemClock.sleep(60); inject(MotionEvent.ACTION_MOVE, x, y, down) }
        inject(MotionEvent.ACTION_UP, x, y, down)
    }
    private fun bodyCenter() = state.body.let { it.exactCenterX() to it.exactCenterY() }

    private object FixtureSpeech : PetSpeechInput {
        var text = "你好，桌宠"
        var started = 0
        override fun start(language: String, listener: PetSpeechListener) {
            started++
            Handler(Looper.getMainLooper()).postDelayed({ listener.onPartial("你好"); listener.onResult(text) }, 400)
        }
        override fun cancel() {}
        override fun destroy() {}
    }

    @Before fun setup() {
        Assume.assumeTrue(Build.FINGERPRINT.contains("generic") || Build.MODEL.contains("sdk_gphone"))
        automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        shell("appops set ${app.packageName} SYSTEM_ALERT_WINDOW allow")
        shell("pm grant ${app.packageName} android.permission.RECORD_AUDIO")
        if (Build.VERSION.SDK_INT >= 33) shell("pm grant ${app.packageName} android.permission.POST_NOTIFICATIONS")
        assertTrue("overlay permission granted through appops", PetOverlayService.canDraw(app))
        runBlocking {
            app.engine.initialize().join()
            withTimeout(15_000) { app.engine.runtime.first { it.initialized } }
            withContext(Dispatchers.Main) { app.engine.dismissError() }
            before = app.repository.data.value
            val fixture = Connection(id = "pet-fixture", name = "本地 Fixture", model = "local-fixture", protocol = "fixture")
            app.repository.saveConnection(fixture, null)
            app.repository.change { it.copy(settings = it.settings.copy(activeConnection = fixture.id)) }
        }
        settingsBefore = app.petPreferences.value
        app.petPreferences.update { it.copy(enabled = true, skin = "winter", sizeDp = 220, chatId = "", anchorX = -1, anchorY = -1, autoActions = true, speakReplies = true, speechLanguage = "") }
        FixtureSpeech.started = 0
        PetOverlayService.speechInputFactory = { FixtureSpeech }
        InstrumentationRegistry.getInstrumentation().runOnMainSync { PetOverlayService.start(app) }
        waitFor(timeout = 150_000, message = "pet window attached and first clip decoding") { state.attached && state.playing }
    }

    @After fun teardown() {
        if (!::automation.isInitialized) return
        PetOverlayService.speechInputFactory = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { PetOverlayService.stop(app) }
        waitFor(message = "pet window removed") { !state.attached }
        settingsBefore?.let { saved -> app.petPreferences.update { saved } }
        runBlocking {
            withContext(Dispatchers.Main) { app.engine.cancel(); app.engine.dismissError() }
            withTimeout(15_000) { while (app.engine.runtime.value.turns.isNotEmpty()) delay(40) }
            before?.let { snapshot -> app.repository.change { snapshot } }
        }
    }

    @Test fun clipsDecodeAndTouchesDriveTheOverlay() {
        val catalog = PetCatalog.load(app)
        assertEquals("winter", state.skin)
        assertEquals(catalog.animations.idle.first(), state.clip)
        assertEquals("VP9 clip decoded at the packaged stage width", 480, state.videoWidth); assertEquals(270, state.videoHeight)
        assertFalse("window covers only the body, not the whole stage", state.window.isEmpty)
        assertTrue("body inside the window ${state.body} ${state.window}", state.window.contains(state.body))
        assertTrue("window narrower than the full stage", state.window.width() < 220 * app.resources.displayMetrics.density * 0.8f)

        // Single tap → a click reaction clip.
        val (x, y) = bodyCenter()
        tap(x, y)
        waitFor(message = "tap plays a click reaction") { state.mode == PetMode.CLICK && state.clip in catalog.animations.clicks }
        waitFor(message = "click clip decodes") { state.playing }

        // Drag → the window moves, the position is remembered and snapped to an edge.
        val windowBefore = android.graphics.Rect(state.window)
        settle()
        val down = SystemClock.uptimeMillis()
        inject(MotionEvent.ACTION_DOWN, x, y, down)
        for (step in 1..8) { SystemClock.sleep(30); inject(MotionEvent.ACTION_MOVE, x - step * 40f, y - step * 25f, down) }
        waitFor(message = "drag clip while moving") { state.mode == PetMode.DRAG }
        inject(MotionEvent.ACTION_UP, x - 320f, y - 200f, down)
        waitFor(message = "drag ends in idle") { state.mode == PetMode.IDLE }
        assertNotEquals(windowBefore.top, state.window.top)
        val saved = app.petPreferences.value
        assertTrue("anchor persisted", saved.anchorX >= -1000 && saved.anchorY >= 0)
        assertTrue(saved.edge == "left" || saved.edge == "right")
        assertTrue("body snapped to an edge", state.body.left <= 2 || state.body.right >= app.resources.displayMetrics.widthPixels - 2)

        // Long press → menu window; a touch outside closes it.
        val (mx, my) = bodyCenter()
        longPress(mx, my)
        waitFor(message = "long press opens the menu") { state.menu }
        tap(if (mx > app.resources.displayMetrics.widthPixels / 2) 20f else app.resources.displayMetrics.widthPixels - 20f, my + 500f)
        waitFor(message = "outside touch closes the menu") { !state.menu }

        // Double tap → listening → fixture transcript → Fixture model reply → bubble + dedicated chat.
        val (dx, dy) = bodyCenter()
        doubleTap(dx, dy)
        waitFor(message = "double tap starts listening") { state.mode == PetMode.LISTEN }
        assertEquals("我在听…", state.bubble)
        waitFor(message = "transcript handed to Melo") { state.transcript == FixtureSpeech.text }
        waitFor(message = "reply delivered") { state.reply.contains("这是本地 Fixture 回复") }
        waitFor(message = "bubble shows the beginning of the reply") { state.bubble.startsWith("这是本地 Fixture 回复") }
        waitFor(message = "reading or celebration after the reply") { state.mode == PetMode.SPEAK || state.mode == PetMode.DONE || state.mode == PetMode.IDLE }
        assertEquals(1, FixtureSpeech.started)
        val chatId = app.petPreferences.value.chatId
        val chat = app.repository.data.value.chats.first { it.id == chatId }
        assertEquals(PetChat.TITLE, chat.title)
        assertEquals(listOf("user", "assistant"), chat.messages.map { it.role })
        assertEquals(FixtureSpeech.text, chat.messages.first().content)
        assertTrue(chat.messages.last().content.contains(FixtureSpeech.text))
        assertEquals("completed", app.repository.data.value.runs.last { it.chatId == chatId }.status)

        // A second question reuses the same conversation.
        waitFor(message = "chain back in an interactive mode") { state.mode != PetMode.LISTEN && state.mode != PetMode.THINK }
        if (state.mode == PetMode.SPEAK) { val (sx, sy) = bodyCenter(); tap(sx, sy); waitFor(message = "tap stops reading") { state.mode == PetMode.IDLE } }
        FixtureSpeech.text = "第二个问题"
        val (ex, ey) = bodyCenter()
        doubleTap(ex, ey)
        waitFor(message = "second reply") { state.reply.contains("第二个问题") }
        assertEquals(chatId, app.petPreferences.value.chatId)
        assertEquals(4, app.repository.data.value.chats.first { it.id == chatId }.messages.size)
        FixtureSpeech.text = "你好，桌宠"
    }

    @Test fun skinSwitchAndStopActionRemoveAndRebuildTheWindows() {
        val catalog = PetCatalog.load(app)
        app.petPreferences.update { it.copy(skin = "fish") }
        waitFor(message = "fish skin plays") { state.skin == "fish" && state.playing && state.clip == catalog.animations.idle.first() }
        assertEquals(480, state.videoWidth)
        app.startService(Intent(app, PetOverlayService::class.java).setAction(PetOverlayService.ACTION_STOP))
        waitFor(message = "stop action removes the overlay") { !state.attached }
        assertFalse(app.petPreferences.value.enabled)
        assertTrue(state.menu.not() && state.bubble.isEmpty())
        // Re-enable from the "app" side as the settings page does.
        app.petPreferences.update { it.copy(enabled = true, skin = "winter") }
        InstrumentationRegistry.getInstrumentation().runOnMainSync { PetOverlayService.start(app) }
        waitFor(timeout = 150_000, message = "overlay rebuilt") { state.attached && state.playing && state.skin == "winter" }
    }
}
