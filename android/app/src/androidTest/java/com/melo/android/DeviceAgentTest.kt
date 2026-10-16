package com.melo.android

import android.app.UiAutomation
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import androidx.test.core.app.ApplicationProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.melo.android.data.*
import com.melo.android.device.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import java.util.concurrent.TimeUnit

class DeviceAgentTest {
    private val app get() = ApplicationProvider.getApplicationContext<MeloApplication>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private lateinit var automation: UiAutomation
    private var enabledBefore = ""
    private val serviceName = "com.melo.android/com.melo.android.device.MeloAccessibilityService"
    private fun shell(command: String): String = automation.executeShellCommand(command).use { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { reader -> reader.readText().trim() } }
    private fun waitFor(check: () -> Boolean) { val end = SystemClock.elapsedRealtime() + 12_000; while (!check() && SystemClock.elapsedRealtime() < end) SystemClock.sleep(100); assertTrue("Condition not reached", check()) }
    @Before fun connectRealServiceOnEmulatorOnly() {
        assumeTrue("Device fixture tests only run on Emulator", Build.FINGERPRINT.contains("generic") || Build.MODEL.contains("sdk_gphone"))
        automation = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        enabledBefore = shell("settings get secure enabled_accessibility_services").takeUnless { it == "null" }.orEmpty()
        val enabled = (enabledBefore.split(':').filter { it.isNotBlank() } + serviceName).distinct().joinToString(":")
        shell("settings put secure enabled_accessibility_services $enabled")
        shell("settings put secure accessibility_enabled 1")
        waitFor { DeviceAccess.service != null }
        runBlocking { withTimeout(10_000) { app.engine.runtime.first { it.initialized } } }
        app.startActivity(Intent(app, DeviceFixtureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        SystemClock.sleep(1200)
    }
    @After fun restoreServiceSettings() {
        if (!::automation.isInitialized) return
        runBlocking { withContext(Dispatchers.Main) { app.deviceAgent.cancel(); DeviceAccess.service?.end() } }
        if (enabledBefore.isBlank()) shell("settings delete secure enabled_accessibility_services") else shell("settings put secure enabled_accessibility_services $enabledBefore")
        // Settings observers and Service teardown are asynchronous. Do not re-enable
        // the next test's service while the previous binding is still being removed.
        if (serviceName !in enabledBefore.split(':')) waitFor { DeviceAccess.service == null }
    }
    private suspend fun observe(service: DeviceExecutor): DeviceToolResult = service.execute(buildJsonObject { put("action", "observe") })
    private fun node(observation: DeviceToolResult, label: String): JsonObject = observation.data["nodes"]!!.jsonArray.map { it.jsonObject }.firstOrNull { it.text("text") == label || it.text("description") == label } ?: error("Missing $label in ${observation.data}")

    @Test fun actualScreenshotNodeClickCoordinateClickChineseTypingAndStaleScreenProtection() = runBlocking {
        val service = DeviceAccess.service!!
        service.begin(0, true)
        var screen = observe(service)
        assertTrue(screen.data.toString(), screen.ok)
        assertTrue(screen.data.toString(), screen.data["screenshot_available"]!!.jsonPrimitive.boolean)
        val bytes = android.util.Base64.decode(screen.jpeg, android.util.Base64.NO_WRAP)
        val bitmap = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        assertEquals(screen.data["image_width"]!!.jsonPrimitive.int, bitmap.width)
        assertEquals(screen.data["image_height"]!!.jsonPrimitive.int, bitmap.height); bitmap.recycle()
        assertFalse(screen.data.toString().contains("fixture-password-hidden"))
        val old = screen.data.text("screen_id")
        screen = service.execute(buildJsonObject { put("action", "tap"); put("screen_id", old); put("node_id", node(screen, "Target button").text("node_id")) })
        assertTrue(screen.data.toString(), screen.ok); node(screen, "Count 1")
        val stale = service.execute(buildJsonObject { put("action", "tap"); put("screen_id", old); put("x", 10); put("y", 10) })
        assertFalse(stale.ok)
        screen = observe(service)
        val button = node(screen, "Target button")["bounds"]!!.jsonArray.map { it.jsonPrimitive.int }
        // The right edge is underneath the floating stop control on this viewport.
        screen = service.execute(buildJsonObject { put("action", "tap"); put("screen_id", screen.data.text("screen_id")); put("x", button[2] - 20); put("y", (button[1] + button[3]) / 2) })
        assertTrue(screen.data.toString(), screen.ok); node(screen, "Count 2")
        screen = observe(service)
        screen = service.execute(buildJsonObject { put("action", "type_text"); put("screen_id", screen.data.text("screen_id")); put("node_id", node(screen, "Fixture input").text("node_id")); put("text", "真实中文输入") })
        assertTrue(screen.data.toString(), screen.ok); node(screen, "真实中文输入")
        service.end()
        assertFalse(observe(service).ok)
    }
    @Test fun launchableAppsAreDiscoverableAndOpenOnTheSelectedDisplay() = runBlocking {
        val service = DeviceAccess.service!!
        service.begin(0, false)
        val page = service.execute(buildJsonObject { put("action", "list_apps"); put("limit", 1) })
        assertTrue(page.ok); assertEquals(1, page.data["apps"]!!.jsonArray.size)
        assertTrue(page.data["has_more"]!!.jsonPrimitive.boolean)
        val next = service.execute(buildJsonObject { put("action", "list_apps"); put("limit", 1); put("offset", page.data["next_offset"]!!.jsonPrimitive.int) })
        assertNotEquals(page.data["apps"], next.data["apps"])
        val apps = service.execute(buildJsonObject { put("action", "list_apps"); put("query", "com.android.sett") })
        assertTrue(apps.ok)
        assertTrue(apps.data["apps"]!!.jsonArray.any { it.jsonObject.text("package_name") == "com.android.settings" })
        val miss = service.execute(buildJsonObject { put("action", "open_app"); put("app_name", "Setings") })
        assertFalse(miss.ok); assertEquals("app_not_found", miss.data.text("code"))
        assertTrue(miss.data["apps"]!!.jsonArray.any { it.jsonObject.text("package_name") == "com.android.settings" })
        val opened = service.execute(buildJsonObject { put("action", "open_app"); put("package_name", "com.android.settings") })
        assertTrue(opened.data.toString(), opened.ok)
        assertEquals("com.android.settings", opened.data.text("package_name"))
        service.end()
    }
    @Test fun homeCanLeaveAChangingWindowWhileCoordinateTapsStillRejectStaleContent() = runBlocking {
        ActivityScenario.launch<DeviceFixtureActivity>(Intent(app, DeviceFixtureActivity::class.java)).use { scenario ->
            val service = DeviceAccess.service!!
            service.begin(0, false)
            delay(700)
            val screen = observe(service)
            assertTrue(screen.data.toString(), screen.ok)
            scenario.onActivity { activity ->
                val content = activity.findViewById<android.view.ViewGroup>(android.R.id.content).getChildAt(0) as android.view.ViewGroup
                (content.getChildAt(0) as android.widget.TextView).text = "Progress updated while deciding"
            }
            delay(700)
            val tap = service.execute(buildJsonObject { put("action", "tap"); put("screen_id", screen.data.text("screen_id")); put("x", 10); put("y", 10) })
            assertFalse("Coordinate tap must reject changed content", tap.ok)
            val home = service.execute(buildJsonObject { put("action", "home"); put("screen_id", screen.data.text("screen_id")) })
            assertTrue(home.data.toString(), home.ok)
            assertNotEquals("com.melo.android", home.data.text("package_name"))
            service.end()
        }
    }
    private fun fixtureCall(id: String, arguments: JsonObject) = MockResponse().setBody(buildJsonObject {
        put("choices", buildJsonArray { add(buildJsonObject {
            put("finish_reason", "tool_calls"); put("message", buildJsonObject {
                put("role", "assistant"); put("content", JsonNull); put("tool_calls", buildJsonArray { add(buildJsonObject {
                    put("id", id); put("type", "function"); put("function", buildJsonObject { put("name", "android_device"); put("arguments", arguments.toString()) })
                }) })
            })
        }) })
    }.toString())
    private fun fixtureFinal(text: String) = MockResponse().setBody(buildJsonObject { put("choices", buildJsonArray { add(buildJsonObject {
        put("finish_reason", "stop"); put("message", buildJsonObject { put("role", "assistant"); put("content", text); put("tool_calls", JsonNull) })
    }) }) }.toString())
    private suspend fun waitForAgent(goal: String): DeviceRun {
        withTimeout(15_000) { while (app.repository.data.value.deviceRuns.none { it.goal == goal && it.status != "running" } || app.deviceAgent.runtime.value.running) delay(50) }
        return app.repository.data.value.deviceRuns.last { it.goal == goal }
    }
    @Test fun prematureAppFailureReplyCanRecoverThroughSearchAndVerifiedLaunch() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(fixtureCall("observe", buildJsonObject { put("action", "observe") }))
            server.enqueue(fixtureCall("wrong", buildJsonObject { put("action", "open_app"); put("app_name", "Setings") }))
            server.enqueue(fixtureFinal("未安装，停止。"))
            server.enqueue(fixtureCall("search", buildJsonObject { put("action", "list_apps"); put("query", "sett") }))
            server.enqueue(fixtureCall("right", buildJsonObject { put("action", "open_app"); put("package_name", "fixture.settings") }))
            server.enqueue(fixtureFinal("根据工具回执已打开 Settings。")); server.start()
            val connection = Connection(name = "Discovery recovery fixture", endpoint = server.url("/tools").toString(), model = "device-fixture")
            app.repository.saveConnection(connection, "fixture-key"); app.repository.change { it.copy(settings = it.settings.copy(activeConnection = connection.id)) }
            val catalog = AppCatalog(listOf(LaunchableApp("fixture.settings", "Settings")))
            val actions = mutableListOf<String>()
            val executor = object : DeviceExecutor {
                override suspend fun begin(displayId: Int, screenshots: Boolean) { }
                override suspend fun execute(arguments: JsonObject): DeviceToolResult {
                    actions += arguments.text("action")
                    return when {
                        arguments.text("action") == "list_apps" -> DeviceToolResult(catalog.page(arguments.text("query")))
                        arguments.text("app_name") == "Setings" -> catalog.openFailure("", "Setings", false)
                        else -> DeviceToolResult(buildJsonObject { put("ok", true); put("screen_id", "fixture-screen"); put("package_name", "fixture.settings") })
                    }
                }
                override fun end() { }
            }
            val goal = "Recover discovery ${newId()}"
            withContext(Dispatchers.Main) { app.deviceAgent.start(goal, 0, false, executor) }
            val run = waitForAgent(goal)
            assertEquals("completed", run.status)
            assertEquals(listOf("observe", "open_app", "list_apps", "open_app"), actions)
            assertEquals(1, run.steps.count { !it.ok })
            assertTrue(run.steps.first { it.action == "list_apps" }.detail.contains("匹配 1"))
            repeat(3) { assertNotNull(server.takeRequest(1, TimeUnit.SECONDS)) }
            val recovery = server.takeRequest(1, TimeUnit.SECONDS)!!.body.readUtf8()
            assertTrue(recovery.contains("Before concluding the app is unavailable"))
            assertTrue(recovery.contains("app_not_found"))
            assertEquals(6, server.requestCount)
        }
    }
    @Test fun discoveryRecoveryIsBoundedAndAmbiguityDoesNotForceAnotherAttempt() = runBlocking {
        for (code in listOf("app_not_found", "app_ambiguous")) MockWebServer().use { server ->
            server.enqueue(fixtureCall("observe", buildJsonObject { put("action", "observe") }))
            server.enqueue(fixtureCall("wrong", buildJsonObject { put("action", "open_app"); put("app_name", "Unknown") }))
            server.enqueue(fixtureFinal("无法确认目标 App，已停止。"))
            if (code == "app_not_found") server.enqueue(fixtureFinal("已经检查，仍受阻。"))
            server.start()
            val connection = Connection(name = "Bounded discovery fixture", endpoint = server.url("/tools").toString(), model = "device-fixture")
            app.repository.saveConnection(connection, "fixture-key"); app.repository.change { it.copy(settings = it.settings.copy(activeConnection = connection.id)) }
            val actions = mutableListOf<String>()
            val executor = object : DeviceExecutor {
                override suspend fun begin(displayId: Int, screenshots: Boolean) { }
                override suspend fun execute(arguments: JsonObject): DeviceToolResult {
                    actions += arguments.text("action")
                    return DeviceToolResult(buildJsonObject { put("ok", arguments.text("action") == "observe"); put("code", if (arguments.text("action") == "open_app") code else ""); put("error", "Fixture unavailable") })
                }
                override fun end() { }
            }
            val goal = "Bounded discovery $code ${newId()}"
            withContext(Dispatchers.Main) { app.deviceAgent.start(goal, 0, false, executor) }
            val run = waitForAgent(goal)
            assertEquals("blocked", run.status)
            assertEquals(listOf("observe", "open_app"), actions)
            assertEquals(if (code == "app_not_found") 4 else 3, server.requestCount)
            assertTrue(run.answer.isNotBlank())
        }
    }
    @Test fun modelDrivenHttpLoopExecutesARealScreenToolAndPersistsOnlyStepSummaries() = runBlocking {
        MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val messages = MeloJson.parseToJsonElement(request.body.clone().readUtf8()).jsonObject["messages"]!!.jsonArray.map { it.jsonObject }
                    val previous = messages.lastOrNull { it.text("role") == "tool" }?.text("content")?.let { MeloJson.parseToJsonElement(it).jsonObject }
                    val nodes = previous?.get("nodes")?.jsonArray.orEmpty().map { it.jsonObject }
                    if (nodes.any { it.text("text") == "Count 1" }) return MockResponse().setBody("""{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Fixture 已确认按钮点击一次","tool_calls":null}}]}""")
                    val arguments = if (previous == null || previous["ok"]?.jsonPrimitive?.booleanOrNull != true) buildJsonObject { put("action", "observe") } else buildJsonObject {
                        put("action", "tap"); put("screen_id", previous.text("screen_id")); put("node_id", nodes.first { it.text("text") == "Target button" }.text("node_id"))
                    }
                    return MockResponse().setBody(buildJsonObject { put("choices", buildJsonArray { add(buildJsonObject {
                        put("finish_reason", "tool_calls"); put("message", buildJsonObject { put("role", "assistant"); put("content", JsonNull); put("tool_calls", buildJsonArray { add(buildJsonObject {
                            put("id", if (previous == null) "observe_1" else "tap_2"); put("type", "function"); put("function", buildJsonObject { put("name", "android_device"); put("arguments", arguments.toString()) })
                        }) }) })
                    }) }) }.toString())
                }
            }; server.start()
            val connection = Connection(name = "Device HTTP fixture", endpoint = server.url("/v1/chat/completions").toString(), model = "device-fixture")
            app.repository.saveConnection(connection, "device-fixture-key")
            app.repository.change { it.copy(settings = it.settings.copy(activeConnection = connection.id)) }
            val goal = "点击测试按钮一次 ${newId().take(8)}"
            withContext(Dispatchers.Main) { app.deviceAgent.start(goal, 0, true) }
            try { withTimeout(15_000) { while (app.repository.data.value.deviceRuns.none { it.goal == goal && it.status == "completed" }) delay(100) } }
            catch (e: TimeoutCancellationException) { error("Agent runtime=${app.deviceAgent.runtime.value}; run=${app.repository.data.value.deviceRuns.last()}") }
            val run = app.repository.data.value.deviceRuns.last()
            assertTrue(run.steps.any { it.action == "observe" && it.ok }); assertEquals(1, run.steps.count { it.action == "tap" && it.ok })
            server.takeRequest(1, TimeUnit.SECONDS)
            val request = server.takeRequest(1, TimeUnit.SECONDS)!!.body.readUtf8()
            assertTrue("Missing call receipt", request.contains("tool_call_id")); assertTrue("Missing screenshot; steps=${run.steps}", request.contains("data:image/jpeg;base64,")); assertTrue("Missing fixture node; request without image=" + request.replace(Regex("data:image/jpeg;base64,[A-Za-z0-9+/=]+"), "[IMAGE]"), request.contains("Target button"))
            assertFalse(MeloJson.encodeToString(app.repository.snapshot()).contains("Device HTTP fixture"))
            assertFalse(MeloJson.encodeToString(run).contains("data:image"))
            assertFalse(MeloJson.encodeToString(run).contains("Target button"))
        }
    }
    @Test fun cancellingTheAgentPreventsAQueuedToolFromExecuting() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("""{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"id":"late","function":{"name":"android_device","arguments":"{\"action\":\"home\",\"screen_id\":\"s\"}"}}]}}]}""").setBodyDelay(2, TimeUnit.SECONDS)); server.start()
            val connection = Connection(name = "Cancel HTTP fixture", endpoint = server.url("/tools").toString(), model = "device-fixture")
            app.repository.saveConnection(connection, "device-fixture-key"); app.repository.change { it.copy(settings = it.settings.copy(activeConnection = connection.id)) }
            var executed = 0
            var ended = false
            val executor = object : DeviceExecutor {
                override suspend fun begin(displayId: Int, screenshots: Boolean) { }
                override suspend fun execute(arguments: JsonObject): DeviceToolResult { executed++; return DeviceToolResult.error("Should not run") }
                override fun end() { ended = true }
            }
            withContext(Dispatchers.Main) { app.deviceAgent.start("cancel fixture", 0, false, executor) }
            withContext(Dispatchers.IO) { assertNotNull(server.takeRequest(5, TimeUnit.SECONDS)) }
            withContext(Dispatchers.Main) { app.deviceAgent.cancel() }
            withTimeout(5000) { while (app.deviceAgent.runtime.value.running) delay(50) }
            assertTrue(ended); assertEquals(0, executed)
            assertEquals("cancelled", app.repository.data.value.deviceRuns.last().status)
        }
    }
    @Test fun screenOffCancelsAnInFlightSessionWithoutAutomaticallyResuming() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("{}").setBodyDelay(5, TimeUnit.SECONDS)); server.start()
            val connection = Connection(name = "Screen off fixture", endpoint = server.url("/tools").toString(), model = "device-fixture")
            app.repository.saveConnection(connection, "device-fixture-key"); app.repository.change { it.copy(settings = it.settings.copy(activeConnection = connection.id)) }
            withContext(Dispatchers.Main) { app.deviceAgent.start("screen off fixture", 0, false) }
            withContext(Dispatchers.IO) { assertNotNull(server.takeRequest(5, TimeUnit.SECONDS)) }
            try {
                shell("input keyevent 223")
                withTimeout(5000) { while (app.deviceAgent.runtime.value.running) delay(50) }
                assertEquals("cancelled", app.repository.data.value.deviceRuns.last().status)
                assertTrue(app.repository.data.value.deviceRuns.last().steps.isEmpty())
            } finally { shell("input keyevent 224"); shell("wm dismiss-keyguard") }
            delay(250); assertFalse(app.deviceAgent.runtime.value.running)
        }
    }
}
