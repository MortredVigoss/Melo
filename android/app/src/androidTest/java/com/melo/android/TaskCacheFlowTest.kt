package com.melo.android

import android.os.Build
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.test.core.app.ApplicationProvider
import com.melo.android.data.*
import com.melo.android.data.Connection
import com.melo.android.device.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import java.security.MessageDigest
import java.io.File
import android.graphics.Bitmap

class TaskCacheFlowTest {
    @get:Rule val ui = createAndroidComposeRule<MainActivity>()
    private val app get() = ApplicationProvider.getApplicationContext<MeloApplication>()
    private var before: AppData? = null
    private val environment = CacheEnvironment("fixture-layout", mapOf("fixture.settings" to 1L))
    private val cacheScope get() = MessageDigest.getInstance("SHA-256").digest("||0|".toByteArray()).joinToString("") { "%02x".format(it) }

    @Before fun prepareFixtureOnlyOnEmulator() = runBlocking {
        assumeTrue(Build.FINGERPRINT.contains("generic") || Build.MODEL.contains("sdk_gphone"))
        withTimeout(15_000) { app.engine.runtime.first { it.initialized } }
        before = app.repository.data.value
        app.repository.change { it.copy(deviceScripts = emptyList()) }
        Unit
    }
    @After fun restoreFixture() = runBlocking {
        if (before != null) {
            withContext(Dispatchers.Main) { app.deviceAgent.cancel() }
            withTimeout(15_000) { while (app.deviceAgent.runtime.value.running) delay(50) }
            app.repository.change { before!! }
        }
        Unit
    }
    private fun args(action: String, vararg fields: Pair<String, String>) = buildJsonObject { put("action", action); fields.forEach { put(it.first, it.second) } }
    private fun screen(action: String) = DeviceToolResult(buildJsonObject {
        put("ok", true); put("screen_id", "fixture-screen"); put("window_id", 17); put("window_title", "Fixture"); put("package_name", "fixture.settings"); put("stable", true)
        if (action == "open_app") { put("target_package", "fixture.settings"); put("launch_dispatched", true) }
        put("nodes", buildJsonArray {
            add(buildJsonObject { put("node_id", "ready"); put("text", "Ready"); put("enabled", true) })
            add(buildJsonObject { put("node_id", "target"); put("text", "Target"); put("view_id", "fixture.settings:id/target"); put("enabled", true); put("clickable", true) })
        })
    })
    private open inner class FixtureDevice : DeviceExecutor {
        var taps = 0; var ended = false
        var cacheEnvironment = environment
        override fun cacheEnvironment(displayId: Int, packages: Set<String>) = cacheEnvironment
        override suspend fun begin(displayId: Int, screenshots: Boolean) { }
        override suspend fun execute(arguments: JsonObject): DeviceToolResult { if (arguments.text("action") == "tap") taps++; return screen(arguments.text("action")) }
        override fun end() { ended = true }
    }
    private fun call(id: String, arguments: JsonObject) = MockResponse().setBody(buildJsonObject {
        put("choices", buildJsonArray { add(buildJsonObject { put("finish_reason", "tool_calls"); put("message", buildJsonObject {
            put("role", "assistant"); put("tool_calls", buildJsonArray { add(buildJsonObject {
                put("id", id); put("type", "function"); put("function", buildJsonObject { put("name", "android_device"); put("arguments", arguments.toString()) })
            }) })
        }) }) })
    }.toString())
    private fun queueProbe(server: MockWebServer) {
        server.enqueue(call("observe", args("observe")))
        server.enqueue(call("open", args("open_app", "package_name" to "fixture.settings")))
        server.enqueue(call("finish", args("finish", "outcome" to "achieved", "summary" to "Fixture verified", "screen_id" to "fixture-screen", "expected_package" to "fixture.settings", "visible_text" to "Ready")))
    }
    private suspend fun connection(server: MockWebServer) {
        val connection = Connection(name = "Task Cache local HTTP fixture", endpoint = server.url("/model").toString(), model = "fixture")
        app.repository.saveConnection(connection, "fixture-key")
        app.repository.change { it.copy(settings = it.settings.copy(activeConnection = connection.id)) }
    }
    private suspend fun run(goal: String, device: DeviceExecutor = FixtureDevice(), scriptId: String? = null): DeviceRun {
        val ids = app.repository.data.value.deviceRuns.map { it.id }.toSet()
        withContext(Dispatchers.Main) { assertTrue(app.deviceAgent.start(goal, 0, false, device, scriptId = scriptId)) }
        withTimeout(20_000) { while (app.deviceAgent.runtime.value.running || app.repository.data.value.deviceRuns.none { it.id !in ids && it.goal == goal && it.status != "running" }) delay(40) }
        return app.repository.data.value.deviceRuns.last { it.id !in ids && it.goal == goal }
    }
    private fun cached(goal: String = "Fixture ${newId()}", steps: List<ScriptStep> = listOf(ScriptStep("open_app", "fixture.settings"))) = DeviceScript(
        name = "Fixture cache", goalTemplate = goal, steps = steps, completion = ScriptAssertion("fixture.settings", "Fixture", "Ready"), scope = cacheScope, verified = true, environment = environment)

    @Test fun probePublishesCacheThenExactHitWorksWithoutAnyConnectionOrKey() = runBlocking {
        MockWebServer().use { server ->
            queueProbe(server); server.start(); connection(server)
            val goal = "Open fixture settings ${newId()}"
            val probe = run(goal)
            assertEquals("achieved", probe.status); assertEquals("probe", probe.executionMode); assertEquals(3, probe.modelRequests)
            val recipe = app.repository.data.value.deviceScripts.single { it.sourceRunId == probe.id }
            assertTrue(recipe.verified); assertEquals(probe.cacheId, recipe.id)
            assertFalse(MeloJson.encodeToString(app.repository.snapshot()).contains(recipe.id))
            val reloaded = Repository(app).also { it.initialize() }
            assertEquals(recipe, reloaded.data.value.deviceScripts.single { it.id == recipe.id })
            app.repository.change { it.copy(settings = it.settings.copy(activeConnection = null, connections = emptyList())) }
            val replay = run(goal)
            assertEquals("achieved", replay.status); assertEquals("exact", replay.executionMode); assertEquals(0, replay.modelRequests)
            assertEquals("visible_facts", replay.verification); assertEquals(3, server.requestCount)
        }
    }
    @Test fun similarHitMakesOnePlanRequestThenPublishesANewVerifiedEntry() = runBlocking {
        MockWebServer().use { server ->
            queueProbe(server); server.start(); connection(server)
            val goal = "Open fixture settings ${newId()}"
            run(goal)
            val source = app.repository.data.value.deviceScripts.single()
            val next = "$goal please"
            val proposal = buildJsonObject { put("reuse", true); put("script", MeloJson.encodeToJsonElement(source.copy(goalTemplate = next))); put("parameters", buildJsonObject {}) }
            server.enqueue(MockResponse().setBody(buildJsonObject { put("choices", buildJsonArray { add(buildJsonObject {
                put("finish_reason", "stop"); put("message", buildJsonObject { put("content", proposal.toString()) })
            }) }) }.toString()))
            val result = run(next)
            assertEquals("achieved", result.status); assertEquals("similar", result.executionMode); assertEquals(1, result.modelRequests)
            assertEquals(4, server.requestCount)
            val learned = app.repository.data.value.deviceScripts.single { it.id == result.cacheId }
            assertTrue(learned.verified); assertEquals(next, learned.goalTemplate); assertNotEquals(source.id, learned.id)
        }
    }
    @Test fun innerAndOuterVariantsSurviveReopenAndEachHitWithoutAKeyOrModel() = runBlocking {
        val outer = cached()
        val innerEnvironment = environment.copy(layout = "fixture-inner-flat")
        val inner = outer.copy(id = newId(), environment = innerEnvironment)
        val seeded = DeviceRun(goal = inner.goalTemplate, connectionName = "fixture", status = "achieved", verification = "visible_facts")
        app.repository.change { it.copy(deviceScripts = listOf(outer), deviceRuns = it.deviceRuns + seeded, settings = it.settings.copy(activeConnection = null, connections = emptyList())) }
        app.repository.commitDeviceOutcome(seeded, inner, listOf(outer), null)
        assertEquals(2, app.repository.data.value.deviceScripts.size)
        val reopened = Repository(app); reopened.initialize()
        assertEquals(2, reopened.data.value.deviceScripts.size)
        for ((env, expected) in listOf(environment to outer.id, innerEnvironment to inner.id)) {
            val device = FixtureDevice().apply { cacheEnvironment = env }
            val result = run(outer.goalTemplate, device)
            assertEquals("achieved", result.status); assertEquals("exact", result.executionMode)
            assertEquals(expected, result.scriptId); assertEquals(0, result.modelRequests)
            assertEquals(1, result.cacheIncompatible); assertTrue(result.cacheLookupMs >= 0); assertTrue(result.cacheReplayMs >= 0)
        }
    }
    @Test fun postureChangeAfterOneClickStopsWithoutASecondEffectOrProbe() = runBlocking {
        val recipe = cached(steps = listOf(ScriptStep("tap", "fixture.settings", "Fixture", NodeSelector(text = "Target")),
            ScriptStep("tap", "fixture.settings", "Fixture", NodeSelector(text = "Target"))))
        app.repository.change { it.copy(deviceScripts = listOf(recipe), settings = it.settings.copy(activeConnection = null, connections = emptyList())) }
        val device = object : FixtureDevice() {
            override suspend fun execute(arguments: JsonObject): DeviceToolResult {
                val result = super.execute(arguments)
                if (arguments.text("action") == "tap") cacheEnvironment = environment.copy(layout = "changed-posture")
                return result
            }
        }
        val result = run(recipe.goalTemplate, device)
        assertEquals("needs_user", result.status); assertEquals(1, device.taps); assertEquals(0, result.modelRequests)
        assertTrue(result.steps.any { it.code == "cache_environment_changed" })
    }
    @Test fun appUpdateExcludesOldCacheAndPerformsOneControlledProbe() = runBlocking {
        MockWebServer().use { server ->
            queueProbe(server); server.start(); connection(server)
            val recipe = cached()
            app.repository.change { it.copy(deviceScripts = listOf(recipe)) }
            val device = FixtureDevice().apply { cacheEnvironment = environment.copy(appVersions = mapOf("fixture.settings" to 2L)) }
            val result = run(recipe.goalTemplate, device)
            assertEquals("achieved", result.status); assertEquals("probe", result.executionMode)
            assertEquals(3, result.modelRequests); assertEquals(1, result.cacheIncompatible); assertEquals(3, server.requestCount)
            assertEquals(0, device.taps)
            assertEquals(setOf(1L, 2L), app.repository.data.value.deviceScripts.map { it.environment!!.appVersions.getValue("fixture.settings") }.toSet())
        }
    }
    @Test fun failedCacheAfterAPotentialWriteStopsWithoutAProbeOrSecondClick() = runBlocking {
        val recipe = cached(steps = listOf(
            ScriptStep("tap", "fixture.settings", "Fixture", NodeSelector(text = "Target")),
            ScriptStep("tap", "fixture.settings", "Fixture", NodeSelector(text = "Missing"), timeoutMs = 100),
        ))
        app.repository.change { it.copy(deviceScripts = listOf(recipe), settings = it.settings.copy(activeConnection = null, connections = emptyList())) }
        val device = FixtureDevice()
        val result = run(recipe.goalTemplate, device)
        assertEquals("needs_user", result.status); assertEquals(0, result.modelRequests); assertEquals(1, device.taps)
        assertTrue(app.repository.data.value.deviceScripts.single().invalidated)
    }
    @Test fun editingDuringReplayCannotMarkTheNewRevisionAsVerified() = runBlocking {
        val recipe = cached()
        app.repository.change { it.copy(deviceScripts = listOf(recipe)) }
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        val device = object : FixtureDevice() {
            override suspend fun execute(arguments: JsonObject): DeviceToolResult { if (arguments.text("action") == "open_app") { entered.complete(Unit); release.await() }; return super.execute(arguments) }
        }
        val task = async { run(recipe.goalTemplate, device) }
        withTimeout(10_000) { entered.await() }
        app.repository.editDeviceScript(recipe, recipe.copy(name = "Edited during execution"))
        release.complete(Unit)
        assertEquals("achieved", task.await().status)
        val edited = app.repository.data.value.deviceScripts.single()
        assertEquals(2, edited.revision); assertEquals("Edited during execution", edited.name); assertFalse(edited.verified)
    }
    @Test fun deletingTheRunningScriptCancelsBeforeRemovingIt() = runBlocking {
        val recipe = cached(steps = listOf(ScriptStep("wait")))
        app.repository.change { it.copy(deviceScripts = listOf(recipe)) }
        val entered = CompletableDeferred<Unit>()
        val device = object : FixtureDevice() { override suspend fun execute(arguments: JsonObject): DeviceToolResult { entered.complete(Unit); awaitCancellation() } }
        val task = async { run(recipe.goalTemplate, device, recipe.id) }
        withTimeout(10_000) { entered.await() }
        app.deviceAgent.deleteScript(recipe.id)
        assertEquals("cancelled", task.await().status); assertTrue(device.ended); assertTrue(app.repository.data.value.deviceScripts.isEmpty())
    }
    @Test fun cacheLibraryEditsAndDeletesTheSavedRecipe() {
        val recipe = cached()
        runBlocking { app.repository.change { it.copy(deviceScripts = listOf(recipe)) } }
        ui.onAllNodesWithText("系统").onFirst().performClick()
        ui.onNodeWithText("手机控制设置与诊断").performClick()
        ui.onNodeWithText("操作缓存 · 1").performClick()
        File(app.cacheDir, "task-cache-library-ui.png").outputStream().use { assertTrue(ui.onNodeWithTag("cache-library").captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)) }
        ui.onNodeWithTag("cache-edit-${recipe.id}").performClick()
        ui.onNodeWithTag("cache-name").performTextReplacement("Renamed fixture")
        val editedJson = JsonObject(MeloJson.encodeToJsonElement(recipe).jsonObject.filterKeys { it in setOf("goalTemplate", "parameters", "completion", "enabled") } +
            ("steps" to MeloJson.encodeToJsonElement(listOf(ScriptStep("wait", durationMs = 1500)))))
        ui.onNodeWithTag("cache-json").performTextReplacement(editedJson.toString())
        File(app.cacheDir, "task-cache-editor-ui.png").outputStream().use { assertTrue(ui.onNodeWithTag("cache-json").captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)) }
        ui.onNodeWithTag("cache-save").performClick()
        ui.waitUntil(10_000) { app.repository.data.value.deviceScripts.single().name == "Renamed fixture" }
        assertFalse(app.repository.data.value.deviceScripts.single().verified)
        assertEquals("wait", app.repository.data.value.deviceScripts.single().steps.single().action)
        assertEquals(1500, app.repository.data.value.deviceScripts.single().steps.single().durationMs)
        ui.onNodeWithText("待验证", substring = true).assertIsDisplayed()
        ui.onNodeWithTag("cache-delete-${recipe.id}").performClick()
        ui.onNodeWithTag("cache-confirm-delete").performClick()
        ui.waitUntil(10_000) { app.repository.data.value.deviceScripts.isEmpty() }
    }
    @Test fun nativeIcuSupportsTemplateBindingsAndChineseCacheLookup() {
        assertEquals(mapOf("query" to "WiFi"), GoalTemplate.bind("Search {{query}}", "Search WiFi"))
        assertEquals("{{b}}/literal", GoalTemplate.render("{{a}}/{{b}}", mapOf("a" to "{{b}}", "b" to "literal")))
        val recipe = cached("打开系统设置")
        assertEquals(recipe.id, TaskCacheRouter.lookup("打开手机设置", listOf(recipe), cacheScope, environment).similar.single().id)
    }
}
