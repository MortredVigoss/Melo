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
        // A preceding live search can leave Settings Intelligence on top of the
        // Settings task. These launcher fixtures require a fresh external task.
        // This is emulator fixture isolation, never a production launch workaround.
        shell("am force-stop com.android.settings")
        shell("am force-stop com.google.android.settings.intelligence")
        enabledBefore = shell("settings get secure enabled_accessibility_services").takeUnless { it == "null" }.orEmpty()
        val enabled = (enabledBefore.split(':').filter { it.isNotBlank() } + serviceName).distinct().joinToString(":")
        shell("settings put secure enabled_accessibility_services $enabled")
        shell("settings put secure accessibility_enabled 1")
        waitFor { DeviceAccess.service != null }
        runBlocking { withTimeout(10_000) { app.engine.runtime.first { it.initialized } } }
        app.startActivity(Intent(app, DeviceFixtureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        automation.waitForIdle(500, 10_000)
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

    @Test fun treeFirstSupportsOrdinaryCoordinateTapsWithoutApprovalAndExplicitVisualFallback() = runBlocking {
        val service = DeviceAccess.service!!; service.begin(0, true)
        val tree = observe(service)
        assertTrue(tree.ok); assertNull(tree.jpeg); assertEquals("ui_tree", tree.data.text("observation_mode"))
        val target = node(tree, "Target button"); val bounds = target.getValue("bounds").jsonArray.map { it.jsonPrimitive.int }
        val tapped = service.execute(buildJsonObject { put("action", "tap"); put("screen_id", tree.data.text("screen_id")); put("x", (bounds[0] + bounds[2]) / 2); put("y", (bounds[1] + bounds[3]) / 2) })
        assertTrue(tapped.data.toString(), tapped.ok); assertNull(app.deviceAgent.runtime.value.approval)
        val image = service.execute(buildJsonObject { put("action", "observe"); put("include_screenshot", true) })
        assertTrue(image.ok); assertNotNull(image.jpeg); assertEquals("ui_tree_and_screenshot", image.data.text("observation_mode"))
        assertNotNull(node(image, "Count 1"))
    }

    @Test fun actualScreenshotNodeClickChineseTypingAndStaleScreenProtection() = runBlocking {
        val service = DeviceAccess.service!!
        service.begin(0, true)
        var screen = service.execute(buildJsonObject { put("action", "observe"); put("include_screenshot", true) })
        assertTrue(screen.data.toString(), screen.ok)
        assertTrue(screen.data.toString(), screen.data["screenshot_available"]!!.jsonPrimitive.boolean)
        val bytes = android.util.Base64.decode(screen.jpeg, android.util.Base64.NO_WRAP)
        val bitmap = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        assertEquals(screen.data["image_width"]!!.jsonPrimitive.int, bitmap.width)
        assertEquals(screen.data["image_height"]!!.jsonPrimitive.int, bitmap.height); bitmap.recycle()
        service.configureScreenshots(false)
        screen = observe(service)
        assertTrue(screen.ok); assertNull(screen.jpeg); assertFalse(screen.data["screenshot_available"]!!.jsonPrimitive.boolean)
        service.configureScreenshots(true); delay(400)
        screen = service.execute(buildJsonObject { put("action", "observe"); put("include_screenshot", true) })
        assertTrue(screen.ok); assertNotNull(screen.jpeg)
        assertFalse(screen.data.toString().contains("fixture-password-hidden"))
        val old = screen.data.text("screen_id")
        screen = service.execute(buildJsonObject { put("action", "tap"); put("screen_id", old); put("node_id", node(screen, "Target button").text("node_id")) })
        assertTrue(screen.data.toString(), screen.ok); node(screen, "Count 1")
        val stale = service.execute(buildJsonObject { put("action", "tap"); put("screen_id", old); put("x", 10); put("y", 10) })
        assertFalse(stale.ok)
        screen = observe(service)
        screen = service.execute(buildJsonObject { put("action", "tap"); put("screen_id", screen.data.text("screen_id")); put("node_id", node(screen, "Fixture input").text("node_id")) })
        assertTrue(screen.data.toString(), screen.ok)
        screen = service.execute(buildJsonObject { put("action", "type_text"); put("screen_id", screen.data.text("screen_id")); put("node_id", node(screen, "Fixture input").text("node_id")); put("text", "真实中文输入") })
        assertTrue(screen.data.toString(), screen.ok); node(screen, "真实中文输入")
        service.end()
        assertFalse(observe(service).ok)
    }
    @Test fun unfocusedTextInputReturnsNoEffectInsteadOfPretendingToHaveTyped() = runBlocking {
        ActivityScenario.launch<DeviceFixtureActivity>(Intent(app, DeviceFixtureActivity::class.java)).use { scenario ->
            scenario.onActivity { activity ->
                val column = activity.findViewById<android.view.ViewGroup>(android.R.id.content).getChildAt(0) as android.view.ViewGroup
                column.isFocusableInTouchMode = true; column.requestFocus()
            }
            val service = DeviceAccess.service!!; service.begin(0, false)
            val before = observe(service); val input = node(before, "Fixture input")
            assertFalse(input.toString(), input["focused"]!!.jsonPrimitive.boolean)
            val result = service.execute(buildJsonObject { put("action", "type_text"); put("screen_id", before.data.text("screen_id")); put("node_id", input.text("node_id")); put("text", "should-not-appear") })
            assertFalse(result.ok); assertEquals("input_not_focused", result.data.text("code"))
            assertFalse(observe(service).data.toString().contains("should-not-appear"))
            service.end()
        }
    }
    @Test fun inputIsNotAResultUntilTheAdvertisedSearchActionIsSubmitted() = runBlocking {
        val service = DeviceAccess.service!!; service.begin(0, false)
        var screen = observe(service)
        screen = service.execute(buildJsonObject { put("action", "tap"); put("screen_id", screen.data.text("screen_id")); put("node_id", node(screen, "Fixture input").text("node_id")) })
        assertTrue(screen.data.toString(), screen.ok)
        screen = service.execute(buildJsonObject { put("action", "type_text"); put("screen_id", screen.data.text("screen_id")); put("node_id", node(screen, "Fixture input").text("node_id")); put("text", "浅影阿 牡丹亭") })
        assertTrue(screen.data.toString(), screen.ok)
        assertFalse(screen.data.toString().contains("Search result: 浅影阿 牡丹亭"))
        val editor = node(screen, "Fixture input")
        assertTrue(editor.toString(), editor["submit_available"]?.jsonPrimitive?.booleanOrNull == true)
        assertEquals("Search", editor.text("submit_label"))
        screen = service.execute(buildJsonObject { put("action", "submit_input"); put("screen_id", screen.data.text("screen_id")); put("node_id", editor.text("node_id")) })
        assertTrue(screen.data.toString(), screen.ok); node(screen, "Search result: 浅影阿 牡丹亭")
        assertNull(app.deviceAgent.runtime.value.approval)
        service.end()
    }
    @Test fun actualFocusedEditorInfoIdentifiesSearchDespiteGenericEnterLabel() = runBlocking {
        ActivityScenario.launch<DeviceFixtureActivity>(Intent(app, DeviceFixtureActivity::class.java)).use { scenario ->
            scenario.onActivity { activity ->
                val column = activity.findViewById<android.view.ViewGroup>(android.R.id.content).getChildAt(0) as android.view.ViewGroup
                (column.getChildAt(2) as android.widget.EditText).apply {
                    contentDescription = null // The native hint remains a stable accessible label.
                    setImeActionLabel("Enter", android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH)
                }
            }
            val service = DeviceAccess.service!!; service.begin(0, false)
            var screen = observe(service)
            screen = service.execute(buildJsonObject { put("action", "tap"); put("screen_id", screen.data.text("screen_id")); put("node_id", node(screen, "Fixture input").text("node_id")) })
            assertTrue(screen.data.toString(), screen.ok)
            val editor = node(screen, "Fixture input")
            assertEquals("Fixture input", editor.text("description"))
            assertEquals("Enter", editor.text("submit_label"))
            assertEquals(editor.toString(), 3, editor["ime_action"]?.jsonPrimitive?.int)
            screen = service.execute(buildJsonObject { put("action", "submit_input"); put("screen_id", screen.data.text("screen_id")); put("node_id", editor.text("node_id")) })
            assertTrue(screen.data.toString(), screen.ok)
            node(screen, "Search result: ")
            assertNull(app.deviceAgent.runtime.value.approval)
            service.end()
        }
    }
    @Test fun installedLabelOpensWithoutPreflightAndUnnamedInventoryReturnsNoApps() = runBlocking {
        val service = DeviceAccess.service!!
        service.begin(0, false)
        val rejected = service.execute(buildJsonObject { put("action", "list_apps"); put("limit", 200) })
        assertFalse(rejected.ok); assertNull(rejected.data["apps"])
        assertTrue(rejected.data.text("error").contains("query"))
        val label = app.applicationInfo.loadLabel(app.packageManager).toString()
        val opened = service.execute(buildJsonObject { put("action", "open_app"); put("app_name", label) })
        assertTrue(opened.data.toString(), opened.ok)
        assertEquals(app.packageName, opened.data.text("target_package"))
        assertEquals(app.packageName, opened.data.text("package_name"))
        assertTrue(opened.data.text("screen_id").isNotBlank())
        val candidates = service.execute(buildJsonObject { put("action", "list_apps"); put("query", "com.android") })
        assertTrue(candidates.ok); assertTrue(candidates.data["apps"]!!.jsonArray.size <= 10)
        assertTrue(candidates.data["apps"]!!.jsonArray.all { it.jsonObject.text("package_name").contains("com.android") })
        service.end()
    }
    @Test fun launchableAppsAreDiscoverableAndOpenOnTheSelectedDisplay() = runBlocking {
        val service = DeviceAccess.service!!
        service.begin(0, false)
        val page = service.execute(buildJsonObject { put("action", "list_apps"); put("browse", true); put("limit", 1) })
        assertTrue(page.ok); assertEquals(1, page.data["apps"]!!.jsonArray.size)
        assertTrue(page.data["has_more"]!!.jsonPrimitive.boolean)
        val next = service.execute(buildJsonObject { put("action", "list_apps"); put("browse", true); put("limit", 1); put("offset", page.data["next_offset"]!!.jsonPrimitive.int) })
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
        assertTrue(opened.data["launch_dispatched"]!!.jsonPrimitive.boolean)
        assertEquals("selected_window_only", opened.data.text("screenshot_scope"))
        assertTrue(opened.data["related_windows"]!!.jsonArray.any { it.jsonObject["selected"]?.jsonPrimitive?.booleanOrNull == true })
        val selected = service.execute(buildJsonObject { put("action", "observe"); put("window_id", opened.data["window_id"]!!) })
        assertTrue(selected.data.toString(), selected.ok)
        val unavailable = service.execute(buildJsonObject { put("action", "observe"); put("window_id", Int.MAX_VALUE) })
        assertFalse(unavailable.ok); assertEquals("stale_screen", unavailable.data.text("code"))
        val repeated = service.execute(buildJsonObject { put("action", "open_app"); put("package_name", "com.android.settings") })
        assertTrue(repeated.data.toString(), repeated.ok)
        assertFalse(repeated.data["launch_dispatched"]!!.jsonPrimitive.boolean)
        assertEquals("already_foreground", repeated.data.text("code"))
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
    @Test fun exactCachedPackageLaunchDoesNotNarrowSubsequentAppDiscovery() = runBlocking {
        val service = DeviceAccess.service!!
        service.begin(0, false)
        val opened = service.execute(buildJsonObject { put("action", "open_app"); put("package_name", "com.android.settings") })
        assertTrue(opened.data.toString(), opened.ok)
        assertEquals("com.android.settings", opened.data.text("package_name"))
        val page = service.execute(buildJsonObject { put("action", "list_apps"); put("browse", true); put("limit", 1) })
        assertTrue(page.ok); assertTrue(page.data["total_apps"]!!.jsonPrimitive.int > 1)
        assertTrue(page.data["has_more"]!!.jsonPrimitive.boolean)
        service.end()
    }
    @Test fun changingSiblingDoesNotInvalidateNodeButRelabelingTargetDoes() = runBlocking {
        ActivityScenario.launch<DeviceFixtureActivity>(Intent(app, DeviceFixtureActivity::class.java)).use { scenario ->
            val service = DeviceAccess.service!!
            service.begin(0, false)
            val screen = observe(service)
            val buttonId = node(screen, "Target button").text("node_id")
            scenario.onActivity { activity ->
                val content = activity.findViewById<android.view.ViewGroup>(android.R.id.content).getChildAt(0) as android.view.ViewGroup
                // Keep the sibling on one line on narrow emulators. Wrapping it
                // moves the target, which must correctly invalidate a saved tap.
                (content.getChildAt(0) as android.widget.TextView).text = "Count 9"
            }
            delay(500)
            val tapped = service.execute(buildJsonObject { put("action", "tap"); put("screen_id", screen.data.text("screen_id")); put("node_id", buttonId) })
            assertTrue(tapped.data.toString(), tapped.ok); node(tapped, "Count 1")
            val second = observe(service)
            scenario.onActivity { activity ->
                val content = activity.findViewById<android.view.ViewGroup>(android.R.id.content).getChildAt(0) as android.view.ViewGroup
                (content.getChildAt(1) as android.widget.Button).text = "Different target"
            }
            delay(500)
            val rejected = service.execute(buildJsonObject { put("action", "tap"); put("screen_id", second.data.text("screen_id")); put("node_id", node(second, "Target button").text("node_id")) })
            assertFalse(rejected.ok); assertEquals("stale_target", rejected.data.text("code"))
            service.end()
        }
    }
    @Test fun focusedWindowWithHiddenAccessibilityLabelsStillProvidesItsOwnPixels() = runBlocking {
        ActivityScenario.launch<DeviceFixtureActivity>(Intent(app, DeviceFixtureActivity::class.java)).use { scenario ->
            scenario.onActivity {
                it.window.decorView.accessibilityDelegate = object : android.view.View.AccessibilityDelegate() {
                    override fun onInitializeAccessibilityNodeInfo(host: android.view.View, info: android.view.accessibility.AccessibilityNodeInfo) {
                        super.onInitializeAccessibilityNodeInfo(host, info)
                        info.isVisibleToUser = false
                    }
                }
            }
            delay(600)
            val service = DeviceAccess.service!!
            service.begin(0, true)
            val screen = observe(service)
            assertTrue(screen.data.toString(), screen.ok)
            assertEquals("com.melo.android", screen.data.text("package_name"))
            assertNotNull(screen.jpeg)
            assertTrue(screen.data["nodes"]!!.jsonArray.isEmpty())
            service.end()
        }
    }
    @Test fun changingTheActiveWindowRejectsEvenAnOtherwiseValidNode() = runBlocking {
        val service = DeviceAccess.service!!
        service.begin(0, false)
        val before = observe(service)
        app.startActivity(Intent(android.provider.Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        delay(1000)
        val rejected = service.execute(buildJsonObject { put("action", "tap"); put("screen_id", before.data.text("screen_id")); put("node_id", node(before, "Target button").text("node_id")) })
        assertFalse(rejected.ok); assertEquals("stale_screen", rejected.data.text("code")); service.end()
    }
    @Test fun sameAppModalStillInvalidatesTheObscuredWindow() = runBlocking {
        ActivityScenario.launch<DeviceFixtureActivity>(Intent(app, DeviceFixtureActivity::class.java)).use { scenario ->
            val service = DeviceAccess.service!!
            service.begin(0, false)
            val before = observe(service)
            scenario.onActivity { android.app.AlertDialog.Builder(it).setTitle("Fixture modal").setMessage("Foreground dialog").setPositiveButton("Close", null).show() }
            delay(700)
            val rejected = service.execute(buildJsonObject { put("action", "tap"); put("screen_id", before.data.text("screen_id")); put("node_id", node(before, "Target button").text("node_id")) })
            assertFalse(rejected.ok); assertEquals("stale_screen", rejected.data.text("code")); service.end()
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
    private fun finishArgs(outcome: String, screen: String = "fixture-screen", visible: String = "") = buildJsonObject {
        put("action", "finish"); put("outcome", outcome); put("summary", "Fixture 结果")
        if (outcome == "achieved") { put("screen_id", screen); if (visible.isBlank()) put("expected_package", "fixture.settings") else put("visible_text", visible) }
    }
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
            server.enqueue(fixtureCall("finish", finishArgs("achieved"))); server.start()
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
            withContext(Dispatchers.Main) { app.deviceAgent.start(goal, 0, false, executor, forceProbe = true) }
            val run = waitForAgent(goal)
            assertEquals("achieved", run.status)
            assertEquals(listOf("observe", "open_app", "list_apps", "open_app", "observe"), actions)
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
            if (code == "app_not_found") server.enqueue(fixtureFinal("无法确认目标 App，已停止。"))
            server.enqueue(fixtureCall("blocked", finishArgs("blocked")))
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
            withContext(Dispatchers.Main) { app.deviceAgent.start(goal, 0, false, executor, forceProbe = true) }
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
                    if (nodes.any { it.text("text") == "Count 1" }) return fixtureCall("finish", finishArgs("achieved", previous!!.text("screen_id"), "Count 1"))
                    val arguments = if (previous == null || previous["ok"]?.jsonPrimitive?.booleanOrNull != true) buildJsonObject { put("action", "observe"); put("include_screenshot", true) } else buildJsonObject {
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
            withContext(Dispatchers.Main) { app.deviceAgent.start(goal, 0, true, forceProbe = true) }
            try { withTimeout(15_000) { while (app.repository.data.value.deviceRuns.none { it.goal == goal && it.status == "achieved" }) delay(100) } }
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
            withContext(Dispatchers.Main) { app.deviceAgent.start("cancel fixture", 0, false, executor, forceProbe = true) }
            withContext(Dispatchers.IO) { assertNotNull(server.takeRequest(5, TimeUnit.SECONDS)) }
            withContext(Dispatchers.Main) { app.deviceAgent.cancel() }
            withTimeout(5000) { while (app.deviceAgent.runtime.value.running) delay(50) }
            assertTrue(ended); assertEquals(0, executed)
            assertEquals("cancelled", app.repository.data.value.deviceRuns.last().status)
        }
    }
    @Test fun sensitiveCoordinatesAndNodesKeepApprovalAndDeclineOrCancelExecutesNothing() = runBlocking {
        for (decision in listOf("allow", "decline", "cancel", "changed", "node_commit")) ActivityScenario.launch<DeviceFixtureActivity>(Intent(app, DeviceFixtureActivity::class.java)).use { scenario ->
            scenario.onActivity { activity ->
                val content = activity.findViewById<android.view.ViewGroup>(android.R.id.content).getChildAt(0) as android.view.ViewGroup
                (content.getChildAt(1) as android.widget.Button).text = "Send"
            }
            MockWebServer().use { server ->
                server.dispatcher = object : Dispatcher() {
                    var postTapObservations = 0
                    override fun dispatch(request: RecordedRequest): MockResponse {
                        val messages = MeloJson.parseToJsonElement(request.body.clone().readUtf8()).jsonObject["messages"]!!.jsonArray.map { it.jsonObject }
                        val previous = messages.lastOrNull { it.text("role") == "tool" }?.text("content")?.let { MeloJson.parseToJsonElement(it).jsonObject }
                        if (previous == null) return fixtureCall("observe", buildJsonObject { put("action", "observe") })
                        if (previous["ok"]?.jsonPrimitive?.booleanOrNull != true) return fixtureCall("blocked", finishArgs("blocked"))
                        if (previous["nodes"]!!.jsonArray.any { it.jsonObject.text("text") == "Count 1" }) return fixtureCall("finish", finishArgs("achieved", previous.text("screen_id"), "Count 1"))
                        if (previous.text("action") == "tap" || postTapObservations > 0) {
                            check(postTapObservations < 3) { "Fixture tap did not reach a fresh visible result." }
                            postTapObservations++
                            return fixtureCall("after-tap-$postTapObservations", buildJsonObject { put("action", "observe") })
                        }
                        val target = node(DeviceToolResult(previous), "Send")
                        val bounds = target["bounds"]!!.jsonArray.map { it.jsonPrimitive.int }
                        return fixtureCall("coordinate", buildJsonObject {
                            put("action", "tap"); put("screen_id", previous.text("screen_id"))
                            if (decision == "node_commit") put("node_id", target.text("node_id")) else { put("x", (bounds[0] + bounds[2]) / 2); put("y", (bounds[1] + bounds[3]) / 2) }
                        })
                    }
                }; server.start()
                val connection = Connection(name = "Native approval fixture", endpoint = server.url("/tools").toString(), model = "device-fixture")
                app.repository.saveConnection(connection, "fixture-key"); app.repository.change { it.copy(settings = it.settings.copy(activeConnection = connection.id)) }
                val goal = "Coordinate approval $decision ${newId()}"
                withContext(Dispatchers.Main) { app.deviceAgent.start(goal, 0, false, forceProbe = true) }
                val approval = withTimeout(10_000) { app.deviceAgent.runtime.first { it.approval != null }.approval!! }
                fun assertCount(expected: String) { scenario.onActivity { activity ->
                    val content = activity.findViewById<android.view.ViewGroup>(android.R.id.content).getChildAt(0) as android.view.ViewGroup
                    assertEquals(expected, (content.getChildAt(0) as android.widget.TextView).text.toString())
                } }
                assertCount("Count 0")
                if (decision == "changed") {
                    scenario.onActivity { activity ->
                        val content = activity.findViewById<android.view.ViewGroup>(android.R.id.content).getChildAt(0) as android.view.ViewGroup
                        (content.getChildAt(1) as android.widget.Button).text = "Target changed while pending"
                    }
                    delay(500)
                }
                val allow = decision in setOf("allow", "changed", "node_commit")
                withContext(Dispatchers.Main) { if (decision == "cancel") app.deviceAgent.cancel() else app.deviceAgent.confirmApproval(approval.id, allow) }
                val run = waitForAgent(goal)
                assertEquals("decision=$decision; error=${run.error}", when (decision) { "allow", "node_commit" -> "achieved"; "cancel" -> "cancelled"; "changed" -> "blocked"; else -> "needs_user" }, run.status)
                assertCount(if (decision in setOf("allow", "node_commit")) "Count 1" else "Count 0")
                if (decision == "changed") assertTrue(run.steps.any { it.code == "stale_screen" && !it.ok })
                withContext(Dispatchers.Main) { app.deviceAgent.confirmApproval(approval.id, true) }
                assertFalse(app.deviceAgent.runtime.value.running)
            }
        }
    }
    @Test fun screenOffCancelsAnInFlightSessionWithoutAutomaticallyResuming() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("{}").setBodyDelay(5, TimeUnit.SECONDS)); server.start()
            val connection = Connection(name = "Screen off fixture", endpoint = server.url("/tools").toString(), model = "device-fixture")
            app.repository.saveConnection(connection, "device-fixture-key"); app.repository.change { it.copy(settings = it.settings.copy(activeConnection = connection.id)) }
            withContext(Dispatchers.Main) { app.deviceAgent.start("screen off fixture", 0, false, forceProbe = true) }
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
