package com.melo.android

import android.app.UiAutomation
import android.os.Build
import android.os.ParcelFileDescriptor
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.melo.android.data.*
import com.melo.android.device.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*

class DynamicAdFlowTest {
    private val app get() = ApplicationProvider.getApplicationContext<MeloApplication>()
    private var before: AppData? = null
    private var enabledBefore = ""
    private fun shell(command: String) = InstrumentationRegistry.getInstrumentation().getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES).executeShellCommand(command).use { ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { r -> r.readText().trim() } }
    @Before fun setup() = runBlocking<Unit> {
        Assume.assumeTrue(Build.FINGERPRINT.contains("generic") || Build.MODEL.contains("sdk_gphone"))
        app.engine.initialize().join(); before = app.repository.data.value
        enabledBefore = shell("settings get secure enabled_accessibility_services").takeUnless { it == "null" }.orEmpty()
        val services = (enabledBefore.split(':').filter(String::isNotBlank) + "com.melo.android/com.melo.android.device.MeloAccessibilityService").distinct().joinToString(":")
        shell("settings put secure enabled_accessibility_services $services"); shell("settings put secure accessibility_enabled 1")
        withTimeout(15000) { while (DeviceAccess.service == null) delay(50) }
    }
    @After fun restore() = runBlocking<Unit> {
        if (before == null) return@runBlocking
        withContext(Dispatchers.Main) { app.deviceAgent.cancel() }
        withTimeout(15000) { while (app.deviceAgent.runtime.value.running) delay(50) }
        app.repository.change { before!! }
        if (enabledBefore.isBlank()) shell("settings delete secure enabled_accessibility_services") else shell("settings put secure enabled_accessibility_services $enabledBefore")
    }
    private fun call(id: String, args: JsonObject) = MockResponse().setBody(buildJsonObject {
        put("choices", buildJsonArray { add(buildJsonObject { put("finish_reason", "tool_calls"); put("message", buildJsonObject { put("role", "assistant"); put("tool_calls", buildJsonArray { add(buildJsonObject { put("id", id); put("type", "function"); put("function", buildJsonObject { put("name", "android_device"); put("arguments", args.toString()) }) }) }) }) }) })
    }.toString())
    private suspend fun exercise(changeTarget: Boolean, dim: Boolean = false) {
        ActivityScenario.launch(DynamicAdFixtureActivity::class.java).use { scenario -> MockWebServer().use { server ->
            scenario.onActivity { it.canvas.dim = dim; it.canvas.invalidate() }
            var taps = 0
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val body = MeloJson.parseToJsonElement(request.body.readUtf8()).jsonObject
                    val previous = body.getValue("messages").jsonArray.map { it.jsonObject }.lastOrNull { it.text("role") == "tool" }?.text("content")?.let { MeloJson.parseToJsonElement(it).jsonObject }
                    if (previous == null) return call("observe", buildJsonObject { put("action", "observe") })
                    if (previous["ok"]?.jsonPrimitive?.booleanOrNull == false) return call("blocked", buildJsonObject { put("action", "finish"); put("outcome", "blocked"); put("summary", "Fixture target changed; nothing clicked") })
                    if (previous["nodes"]?.jsonArray.orEmpty().any { it.jsonObject.text("description") == "Ad closed" }) return call("done", buildJsonObject { put("action", "finish"); put("outcome", "achieved"); put("summary", "Offline fixture ad closed"); put("screen_id", previous.text("screen_id")); put("expected_package", "com.melo.android"); put("visible_text", "Ad closed") })
                    if (changeTarget) scenario.onActivity { it.canvas.changed = true; it.canvas.invalidate() }
                    Thread.sleep(350) // Several unrelated ad refreshes occur after observation.
                    taps++
                    val area = previous.getValue("nodes").jsonArray.first { it.jsonObject.text("description") == "Animated advertisement" }.jsonObject.getValue("bounds").jsonArray.map { it.jsonPrimitive.int }
                    android.util.Log.i("DynamicAdFixture", "model bounds=$area image=${previous.text("image_width")}x${previous.text("image_height")}")
                    return call("tap-$taps", buildJsonObject { put("action", "tap"); put("screen_id", previous.text("screen_id")); put("x", (area[0] + (area[2]-area[0]) * .88).toInt()); put("y", (area[1] + (area[3]-area[1]) * .13).toInt()) })
                }
            }
            server.start()
            val connection = Connection(name = "Dynamic ad fixture", endpoint = server.url("/model").toString(), model = "fixture", stream = false)
            app.repository.saveConnection(connection, "fixture-local-only")
            app.repository.change { it.copy(settings = it.settings.copy(activeConnection = connection.id)) }
            val goal = "Close offline fixture ad ${newId()}"
            withContext(Dispatchers.Main) { app.deviceAgent.start(goal, 0, true, forceProbe = true) }
            withTimeout(20000) { while (app.deviceAgent.runtime.value.running) delay(50) }
            val run = app.repository.data.value.deviceRuns.last { it.goal == goal }
            assertNull("Ordinary task-authorized coordinates must not request per-step approval", app.deviceAgent.runtime.value.approval)
            assertEquals(run.error, if (changeTarget) "blocked" else "achieved", run.status)
            scenario.onActivity { assertEquals(if (changeTarget) 0 else 1, it.canvas.clicks) }
            assertEquals(1, taps)
            if (changeTarget) assertTrue(run.steps.any { !it.ok && it.code == "stale_screen" })
        } }
    }
    @Test fun unrelatedAdAnimationDoesNotInvalidateStableCloseTarget() = runBlocking { exercise(false) }
    @Test fun changedCloseTargetIsRejectedWithoutClicking() = runBlocking { exercise(true) }
    @Test fun lowContrastCloseControlExecutesWithoutPerStepApproval() = runBlocking { exercise(false, true) }
    @Test fun replacementOfLowContrastCloseControlStillExecutesNothing() = runBlocking { exercise(true, true) }
}
