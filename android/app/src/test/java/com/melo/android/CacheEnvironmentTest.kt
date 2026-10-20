package com.melo.android

import com.melo.android.data.*
import com.melo.android.device.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class CacheEnvironmentTest {
    private val outer = CacheEnvironment("0|900x2000|0|420|1.0|closed", mapOf("fixture.app" to 1L))
    private val inner = outer.copy(layout = "0|1800x2000|0|420|1.0|flat")
    private fun script(env: CacheEnvironment? = outer) = DeviceScript(name = "Open fixture", goalTemplate = "Open fixture",
        steps = listOf(ScriptStep("tap", "fixture.app", selector = NodeSelector(text = "Target"))),
        completion = ScriptAssertion("fixture.app", visibleText = "Ready"), verified = true, scope = "owner", environment = env)
    @Test fun layoutsHaveIndependentExactHitsWithoutAmbiguousFirstMatch() {
        val a = script(); val b = script(inner)
        assertEquals(a.id, TaskCacheRouter.lookup(a.goalTemplate, listOf(a, b), "owner", outer).exact!!.script.id)
        assertEquals(b.id, TaskCacheRouter.lookup(a.goalTemplate, listOf(a, b), "owner", inner).exact!!.script.id)
        assertEquals(1, TaskCacheRouter.lookup(a.goalTemplate, listOf(a, b), "owner", inner).incompatible)
    }
    @Test fun oldUnknownUpdatedAndPendingEnvironmentsCannotAutomaticallyRunOrPlanFromAnIncompatibleScript() {
        val saved = script()
        for (env in listOf(null, outer.copy(appVersions = emptyMap()), outer.copy(appVersions = mapOf("fixture.app" to 2L)), outer.copy(layout = "hinge-pending"))) {
            val match = TaskCacheRouter.lookup(saved.goalTemplate, listOf(saved), "owner", env)
            assertNull(match.exact); assertTrue(match.similar.isEmpty()); assertEquals(1, match.incompatible)
        }
        assertNull(TaskCacheRouter.lookup(saved.goalTemplate, listOf(script(null)), "owner", outer).exact)
    }
    @Test fun postureIsExplicitAndInvalidSensorsNeverPretendToBeFlat() {
        assertEquals("closed", hingePosture(0f)); assertEquals("half", hingePosture(90f)); assertEquals("flat", hingePosture(180f))
        assertEquals("hinge-pending", hingePosture(null)); assertEquals("hinge-pending", hingePosture(Float.NaN))
    }
    @Test fun environmentChangeStopsBeforeAnyActionAndKeepsUnsafePriorEffects() = runBlocking {
        var compatible = false; var effects = 0
        val blocked = ScriptRunner({ effects++; error("must not execute") }, compatible = { compatible }).run(script(), emptyMap())
        assertEquals("blocked", blocked.outcome.status); assertEquals(0, effects); assertFalse(blocked.unsafeToResume)
        compatible = true
        val two = script().copy(steps = script().steps + script().steps)
        val result = ScriptRunner({ args ->
            val action = args.text("action")
            if (action == "tap") { effects++; compatible = false }
            DeviceToolResult(buildJsonObject {
                put("ok", true); put("package_name", "fixture.app"); put("screen_id", "fresh-$effects")
                put("nodes", buildJsonArray { add(buildJsonObject { put("node_id", "fresh-node"); put("text", "Target") }) })
            })
        }, compatible = { compatible }).run(two, emptyMap())
        assertEquals(1, effects); assertEquals("blocked", result.outcome.status); assertTrue(result.unsafeToResume)
    }
    @Test fun splitWindowLayoutMismatchStopsEvenWhenSemanticSelectorStillMatches() = runBlocking {
        var effects = 0
        val recipe = script().copy(steps = listOf(script().steps.single().copy(windowWidth = 900, windowHeight = 2000)))
        val result = ScriptRunner({ args ->
            if (args.text("action") == "tap") effects++
            DeviceToolResult(buildJsonObject {
                put("ok", true); put("package_name", "fixture.app"); put("screen_id", "new-window")
                put("window_width", 450); put("window_height", 2000)
                put("nodes", buildJsonArray { add(buildJsonObject { put("node_id", "new-node"); put("text", "Target") }) })
            })
        }).run(recipe, emptyMap())
        assertEquals("blocked", result.outcome.status); assertEquals(0, effects)
    }
}
