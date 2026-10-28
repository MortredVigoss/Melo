package com.melo.android

import com.melo.android.data.*
import com.melo.android.device.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class DeviceContextBudgetTest {
    private val protocols = listOf("chat-completions", "responses", "anthropic")
    private fun add(history: MutableList<JsonObject>, protocol: String, id: String, result: DeviceToolResult) {
        val call = DeviceCall(id, "android_device", buildJsonObject { put("action", "observe") })
        history += when (protocol) {
            "responses" -> buildJsonObject { put("type", "function_call"); put("call_id", id); put("name", call.name); put("arguments", call.arguments.toString()) }
            "anthropic" -> buildJsonObject { put("role", "assistant"); put("content", buildJsonArray { add(buildJsonObject { put("type", "tool_use"); put("id", id); put("name", call.name); put("input", call.arguments) }) }) }
            else -> buildJsonObject { put("role", "assistant"); put("tool_calls", buildJsonArray { add(buildJsonObject { put("id", id); put("type", "function"); put("function", buildJsonObject { put("name", call.name); put("arguments", call.arguments.toString()) }) }) }) }
        }
        DeviceAgentClient.appendResult(history, protocol, call, result)
    }
    @Test fun ordinaryRoundsPreserveEarlierDestinationAndAppliedEffectsUnderBudget() {
        val history = DeviceAgentClient.initial("responses", "Navigate to saved home")
        repeat(9) { i -> add(history, "responses", "call-$i", DeviceToolResult(buildJsonObject { put("ok", true); put("screen_id", "screen-$i"); put("selected_destination", "saved-home"); put("effect_state", "applied") })) }
        val before = history.toList()
        DeviceContextBudget.compact(history, "responses")
        assertEquals(before, history)
    }
    @Test fun replacingPixelsDropsAllBoundThinkingButKeepsEveryToolPair() {
        val history = DeviceAgentClient.initial("anthropic", "goal")
        add(history, "anthropic", "a", DeviceToolResult(buildJsonObject { put("ok", true); put("screen_id", "a") }, "old-image"))
        history += buildJsonObject { put("role", "assistant"); put("content", buildJsonArray {
            add(buildJsonObject { put("type", "thinking"); put("thinking", "opaque fixture"); put("signature", "bound-signature") })
            add(buildJsonObject { put("type", "tool_use"); put("id", "b"); put("name", "android_device"); put("input", buildJsonObject { put("action", "observe") }) })
        }) }
        DeviceAgentClient.appendResult(history, "anthropic", DeviceCall("b", "android_device", buildJsonObject { put("action", "observe") }), DeviceToolResult(buildJsonObject { put("ok", true); put("screen_id", "b") }, "new-image"))
        val raw = history.toString()
        assertFalse(raw.contains("bound-signature")); assertFalse(raw.contains("old-image")); assertTrue(raw.contains("new-image"))
        for (id in listOf("a", "b")) assertEquals(2, Regex("\"$id\"").findAll(raw).count())
    }
    @Test fun condensingEarlierResultsCannotKeepThinkingBoundToTheOriginalPrefix() {
        val history = DeviceAgentClient.initial("anthropic", "goal")
        repeat(3) { index ->
            add(history, "anthropic", "c$index", DeviceToolResult(buildJsonObject { put("ok", true); put("screen_id", "s$index"); put("privateDetail", "old result") }))
            val assistant = history[history.lastIndex - 1]
            history[history.lastIndex - 1] = JsonObject(assistant + ("content" to JsonArray(listOf(buildJsonObject { put("type", "thinking"); put("thinking", "opaque fixture"); put("signature", "bound-$index") }) + assistant.getValue("content").jsonArray)))
        }
        DeviceContextBudget.compact(history, "anthropic", force = true)
        assertFalse(history.toString().contains("bound-"))
        for (id in 0..2) assertEquals(2, Regex("\"c$id\"").findAll(history.toString()).count())
    }
    @Test fun newlyPublishedSkillManifestInvalidatesEarlierBoundThinkingOnly() {
        val h = DeviceAgentClient.initial("anthropic", "goal")
        add(h, "anthropic", "one", DeviceToolResult(buildJsonObject { put("ok", true) }))
        val assistant = h[1]
        h[1] = JsonObject(assistant + ("content" to JsonArray(listOf(buildJsonObject { put("type", "thinking"); put("thinking", "opaque fixture"); put("signature", "old-manifest-signature") }) + assistant.getValue("content").jsonArray)))
        DeviceContextBudget.guardPrefix(h, "same-manifest", "same-manifest")
        assertTrue(h.toString().contains("old-manifest-signature"))
        DeviceContextBudget.guardPrefix(h, "same-manifest", "new-manifest")
        assertFalse(h.toString().contains("old-manifest-signature"))
        assertEquals(2, Regex("\"one\"").findAll(h.toString()).count())
    }
    @Test fun compactionKeepsPairedCallsGoalAndLatestObservationInEveryProtocol() {
        for (protocol in protocols) {
            val history = DeviceAgentClient.initial(protocol, "immutable original goal")
            repeat(20) { i ->
                add(history, protocol, "c$i", DeviceToolResult(buildJsonObject { put("ok", true); put("screen_id", "screen-$i"); put("nodes", buildJsonArray { add("tree-$i-" + "x".repeat(6000)) }) }))
                DeviceContextBudget.compact(history, protocol, force = true)
            }
            val raw = history.toString()
            assertTrue(raw.contains("immutable original goal")); assertTrue(raw.contains("tree-19-")); assertFalse(raw.contains("tree-18-"))
            assertFalse(raw.contains("\"c0\""))
            for (i in 16..19) assertEquals("Pair c$i in $protocol", 2, Regex("\"c$i\"").findAll(raw).count())
            assertTrue(raw.length < 12_000)
        }
    }
    @Test fun lastScreenSurvivesMultipleCompactionsAfterManyCatalogCalls() {
        for (protocol in protocols) {
            val history = DeviceAgentClient.initial(protocol, "goal")
            add(history, protocol, "screen", DeviceToolResult(buildJsonObject { put("ok", true); put("screen_id", "latest-screen"); put("nodes", buildJsonArray { add("retained-tree") }) }))
            repeat(12) { i ->
                add(history, protocol, "catalog-$i", DeviceToolResult(buildJsonObject { put("ok", true); put("apps", buildJsonArray { add("visible-app-row-$i") }) }))
                DeviceContextBudget.compact(history, protocol, force = true)
                assertTrue("Lost last screen after $i/$protocol", history.toString().contains("retained-tree"))
                assertTrue("Latest app search must remain readable", history.toString().contains("visible-app-row-$i"))
            }
        }
    }
    @Test fun currentPixelsSurviveCatalogOnlyTurnsAndAreRemovedWhenNextCaptureFails() {
        for (protocol in protocols) {
            val history = DeviceAgentClient.initial(protocol, "goal")
            DeviceAgentClient.appendResult(history, protocol, DeviceCall("image", "android_device", buildJsonObject { put("action", "observe") }), DeviceToolResult(buildJsonObject { put("ok", true); put("screen_id", "s1") }, "unique-current-pixels"))
            repeat(10) { i -> add(history, protocol, "catalog-$i", DeviceToolResult(buildJsonObject { put("ok", true); put("apps", JsonArray(emptyList())) })); DeviceContextBudget.compact(history, protocol, force = true) }
            assertTrue(history.toString().contains("unique-current-pixels"))
            add(history, protocol, "next-screen", DeviceToolResult(buildJsonObject { put("ok", true); put("screen_id", "s2"); put("screenshot_available", false) }))
            DeviceContextBudget.compact(history, protocol, force = true)
            assertFalse(history.toString().contains("unique-current-pixels"))
        }
    }
    @Test fun enormousCurrentScreenFailsExplicitlyInsteadOfDroppingTheGoalOrSendingUnboundedContext() {
        val history = DeviceAgentClient.initial("responses", "retained goal")
        add(history, "responses", "large", DeviceToolResult(buildJsonObject { put("ok", true); put("screen_id", "s"); put("nodes", "x".repeat(DeviceContextBudget.MAX_TEXT_CHARS + 1)) }))
        val error = runCatching { DeviceContextBudget.compact(history, "responses") }.exceptionOrNull()
        assertNotNull(error); assertTrue(error!!.message!!.contains("预算")); assertTrue(history.first().toString().contains("retained goal"))
    }
}
