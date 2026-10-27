package com.melo.android

import com.melo.android.data.*
import com.melo.android.device.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class VerifiedScriptPublisherTest {
    private val environment = CacheEnvironment("outer", mapOf("fixture.app" to 1L))
    private fun args(action: String, vararg values: Pair<String, String>) = buildJsonObject { put("action", action); values.forEach { put(it.first, it.second) } }
    private fun screen(pkg: String = "fixture.app", verified: Boolean = false) = DeviceToolResult(buildJsonObject {
        put("ok", true); put("screen_id", "runtime-screen"); put("package_name", pkg); put("target_package", "fixture.app"); put("window_title", "Main")
        if (verified) put("verification", "visible_facts")
        put("nodes", buildJsonArray { add(buildJsonObject { put("node_id", "runtime-node"); put("view_id", "fixture.app:id/input"); put("editable", true); put("enabled", true) }) })
    })
    @Test fun openAppIsAnIndependentVerifiedRecipeAndDoesNotRequireWholeTaskFinish() = runBlocking {
        val saved = mutableListOf<DeviceScript>()
        val publisher = VerifiedScriptPublisher("owner", "run", { environment }) { saved += it }
        val open = args("open_app", "package_name" to "fixture.app")
        publisher.record(open, screen())
        publisher.record(args("tap", "x" to "10", "y" to "20"), DeviceToolResult.error("later action failed"))
        publisher.record(args("finish", "outcome" to "blocked"), DeviceToolResult(buildJsonObject { put("ok", true) }))
        assertEquals(1, saved.size); val recipe = saved.single()
        assertEquals("action", recipe.cacheKind); assertTrue(recipe.verified)
        assertEquals(listOf(ScriptStep("open_app", "fixture.app")), recipe.steps)
        assertEquals(ScriptAssertion("fixture.app"), recipe.completion)
        assertFalse(MeloJson.encodeToString(recipe).contains("runtime-"))
        assertTrue(TaskCacheRouter.lookup("Open fixture then search songs", saved, "owner", environment).similar.isEmpty())
    }
    @Test fun dispatchAloneMissingScreenWrongPackageOrUnknownEnvironmentNeverPublish() = runBlocking {
        for (result in listOf(DeviceToolResult.error("launch failed"), screen("unrelated.app"), DeviceToolResult(JsonObject(screen().data - "screen_id")), DeviceToolResult(JsonObject(screen().data - "target_package")))) {
            val saved = mutableListOf<DeviceScript>()
            VerifiedScriptPublisher("owner", "run", { environment }) { saved += it }.record(args("open_app"), result)
            assertTrue(saved.isEmpty())
        }
        val saved = mutableListOf<DeviceScript>()
        VerifiedScriptPublisher("owner", "run", { environment.copy(layout = "hinge-pending") }) { saved += it }.record(args("open_app"), screen())
        assertTrue(saved.isEmpty())
    }
    @Test fun checkpointsParameterizeInputsButCannotPublishUnverifiedOrCoordinateSegments() = runBlocking {
        for (coordinates in listOf(false, true)) {
            val saved = mutableListOf<DeviceScript>()
            val publisher = VerifiedScriptPublisher("owner", "run", { environment }) { saved += it }
            publisher.record(args("open_app"), screen())
            if (coordinates) publisher.record(args("tap", "x" to "10", "y" to "20"), screen())
            else publisher.record(args("type_text", "node_id" to "runtime-node", "text" to "PrivateQuery"), screen())
            val checkpoint = args("checkpoint", "goal" to "Search PrivateQuery in fixture", "expected_package" to "fixture.app", "visible_text" to "PrivateQuery")
            publisher.record(checkpoint, screen())
            assertEquals(1, saved.size)
            publisher.record(checkpoint, screen(verified = true))
            if (coordinates) assertEquals(1, saved.size) else {
                val subflow = saved.single { it.cacheKind == "subflow" }
                assertEquals("Search {{input_1}} in fixture", subflow.goalTemplate)
                val encoded = MeloJson.encodeToString(subflow)
                assertFalse(encoded.contains("PrivateQuery")); assertFalse(encoded.contains("runtime-"))
            }
        }
    }
    @Test fun foldOrAppVersionChangeBetweenOpenAndCheckpointPreventsOldSegmentPublication() = runBlocking {
        for (changed in listOf(environment.copy(layout = "inner"), environment.copy(appVersions = mapOf("fixture.app" to 2L)))) {
            var current = environment; val saved = mutableListOf<DeviceScript>()
            val publisher = VerifiedScriptPublisher("owner", "run", { current }) { saved += it }
            publisher.record(args("open_app"), screen())
            current = changed
            publisher.record(args("checkpoint", "goal" to "Open fixture page", "expected_package" to "fixture.app", "visible_text" to "Main"), screen(verified = true))
            assertEquals(1, saved.size); assertEquals(environment, saved.single().environment)
        }
    }
    @Test fun openAppReplayVerifiesForegroundWithoutWaitingForAnAnimatedAdToStop() = runBlocking {
        val action = DeviceScript(name = "Open fixture", goalTemplate = "Open app fixture.app", steps = listOf(ScriptStep("open_app", "fixture.app")), completion = ScriptAssertion("fixture.app"), cacheKind = "action")
        val animated = DeviceToolResult(JsonObject(screen().data + ("stable" to JsonPrimitive(false))))
        var effects = 0
        val replay = ScriptRunner(execute = { args -> if (args.text("action") == "open_app") effects++; animated }, completionTimeoutMs = 100).run(action, emptyMap())
        assertEquals("achieved", replay.outcome.status); assertEquals("visible_facts", replay.outcome.verification); assertEquals(1, effects)
        assertFalse(DeviceCompletion.verifyAppLaunch("fixture.app", animated, screen("unrelated.app")).ok)
        val claim = args("finish", "screen_id" to "runtime-screen", "expected_package" to "fixture.app", "visible_text" to "Main")
        assertFalse("Page/subflow verification must still reject unstable UI", DeviceCompletion.verify(claim, animated, animated).ok)
        assertTrue(runCatching { ScriptValidator.validate(action.copy(steps = action.steps + ScriptStep("tap", "fixture.app", selector = NodeSelector(text = "Target")))) }.isFailure)
    }
    @Test fun repeatedLaunchesInOneRunDoNotChurnPublishedRevision() = runBlocking {
        val saved = mutableListOf<DeviceScript>()
        val publisher = VerifiedScriptPublisher("owner", "run", { environment }) { saved += it }
        repeat(3) { publisher.record(args("open_app", "app_name" to "App alias $it"), screen()) }
        assertEquals(1, saved.size)
    }
}
