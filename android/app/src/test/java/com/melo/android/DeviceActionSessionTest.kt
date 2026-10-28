package com.melo.android

import com.melo.android.data.*
import com.melo.android.device.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class DeviceActionSessionTest {
    private fun args(action: String, vararg fields: Pair<String, String>) = buildJsonObject { put("action", action); fields.forEach { put(it.first, it.second) } }
    private class Native : DeviceExecutor {
        var begun = 0; var ended = 0; var page = "Saved home"; var sequence = 0
        val actions = mutableListOf<String>()
        var entered = ""; var capturedQuery = ""
        override fun cacheEnvironment(displayId: Int, packages: Set<String>) = CacheEnvironment("folded", packages.associateWith { 1L })
        override suspend fun begin(displayId: Int, screenshots: Boolean) { begun++ }
        override fun end() { ended++ }
        override suspend fun execute(arguments: JsonObject): DeviceToolResult {
            val action = arguments.text("action"); actions += action
            when (action) {
                "tap" -> page = "Navigation active"
                "type_text" -> entered = arguments.text("text")
                "submit_input" -> { capturedQuery = entered; page = "Results for $entered" }
            }
            return DeviceToolResult(buildJsonObject {
                put("ok", true); put("screen_id", "screen-${++sequence}"); put("package_name", "fixture.app"); put("window_title", "Main"); put("stable", true)
                if (action == "open_app") put("target_package", "fixture.app")
                put("nodes", buildJsonArray {
                    add(buildJsonObject { put("node_id", "page"); put("text", page); put("view_id", "fixture.app:id/page") })
                    add(buildJsonObject { put("node_id", "editor"); put("text", entered); put("view_id", "fixture.app:id/editor"); put("editable", true); put("focused", true) })
                })
            })
        }
    }
    @Test fun verifiedNavigationEndsDeviceEffectsAndPreservesOneSessionWithoutAModel() = runBlocking {
        val native = Native(); val saved = mutableListOf<DeviceRun>(); val recipes = mutableListOf<DeviceScript>()
        val session = DeviceActionSession(native, "scope", DeviceRun(goal = "Navigate home", connectionName = "root", modelRequests = 0), { saved += it }, { recipes += it })
        val launched = session.execute(args("open_app", "package_name" to "fixture.app"))
        val started = session.execute(args("tap", "screen_id" to launched.data.text("screen_id"), "node_id" to "page"))
        assertFalse(started.data["nodes"].toString().contains("Saved home"))
        assertTrue(started.data["applied_effects"].toString().contains("Saved home"))
        val finish = session.execute(args("finish", "outcome" to "achieved", "summary" to "Navigation started", "screen_id" to started.data.text("screen_id"), "expected_package" to "fixture.app", "visible_text" to "Navigation active"))
        assertTrue(finish.ok); assertEquals("visible_facts", finish.data.text("verification"))
        val count = native.actions.size
        assertFalse(session.execute(args("back", "screen_id" to started.data.text("screen_id"))).ok)
        assertEquals(count, native.actions.size)
        assertTrue(session.execute(args("observe")).ok)
        session.close()
        assertEquals(1, native.begun); assertEquals(1, native.ended)
        assertEquals("achieved", saved.last().status); assertEquals(0, saved.last().modelRequests)
        assertEquals("action", recipes.single { it.cacheKind == "action" }.cacheKind)
        assertTrue(recipes.single { it.cacheKind == "subflow" }.goalTemplate.contains("Saved home"))
        assertFalse(session.execute(args("observe")).ok)
    }
    @Test fun partialTaskRetainsVerifiedSearchAndReplaysWithNewParameter() = runBlocking {
        val native = Native(); val recipes = mutableListOf<DeviceScript>()
        val session = DeviceActionSession(native, "scope", DeviceRun(goal = "Search and do more", connectionName = "root"), {}, { recipes += it })
        var result = session.execute(args("open_app", "package_name" to "fixture.app"))
        result = session.execute(args("type_text", "screen_id" to result.data.text("screen_id"), "node_id" to "editor", "text" to "alpha"))
        session.execute(args("submit_input", "screen_id" to result.data.text("screen_id"), "node_id" to "editor"))
        session.close(cancelled = true)
        val recipe = recipes.single { it.cacheKind == "subflow" }
        assertEquals(listOf("input_1"), recipe.parameters)
        assertFalse(MeloJson.encodeToString(recipe).contains("alpha"))
        native.entered = "stale content"; native.page = "Home"
        val replay = ScriptRunner(native::execute, completionTimeoutMs = 100).run(recipe, mapOf("input_1" to "beta"))
        assertEquals("achieved", replay.outcome.status); assertEquals("beta", native.capturedQuery)
    }
    @Test fun staleFinishIsRejectedWithoutChangingState() = runBlocking {
        val native = Native(); val session = DeviceActionSession(native, "scope", DeviceRun(goal = "Navigate", connectionName = "root"), {}, {})
        session.execute(args("open_app", "package_name" to "fixture.app"))
        val result = session.execute(args("finish", "outcome" to "achieved", "summary" to "done", "screen_id" to "stale", "visible_text" to "Navigation active"))
        assertFalse(result.ok); assertEquals("stale_evidence", result.data.text("code"))
        assertEquals(listOf("open_app"), native.actions)
        session.close()
    }
    @Test fun revocationDuringWorkflowStopsBeforeTheNextNativeEffectAndPreventsRestart() = runBlocking {
        val native = Native(); var allowed = true; var replays = 0
        val executor = object : DeviceExecutor by native {
            override suspend fun execute(arguments: JsonObject): DeviceToolResult {
                val result = native.execute(arguments)
                if (arguments.text("action") == "type_text") allowed = false
                return result
            }
        }
        val selector = NodeSelector(viewId = "fixture.app:id/editor", editable = true)
        val script = DeviceScript(name = "Search", goalTemplate = "Search {{query}}", parameters = listOf("query"), scope = "scope", verified = true,
            environment = CacheEnvironment("folded", mapOf("fixture.app" to 1L)),
            steps = listOf(ScriptStep("type_text", "fixture.app", selector = selector, parameter = "query"), ScriptStep("submit_input", "fixture.app", selector = selector)),
            completion = ScriptAssertion("fixture.app", visibleText = "Results for {{query}}"))
        val session = DeviceActionSession(executor, "scope", DeviceRun(goal = "Search beta", connectionName = "root"), {}, {}, validateCurrent = { allowed }, onReplay = { _, _ -> replays++ })
        assertFalse(session.replay(script, mapOf("query" to "beta")).ok)
        assertFalse("submit_input" in native.actions); assertEquals(1, replays)
        allowed = true
        val count = native.actions.size
        assertEquals("WORKFLOW_ALREADY_APPLIED", session.replay(script, mapOf("query" to "beta")).data.text("code"))
        assertEquals(count, native.actions.size)
        session.close()
    }
}
