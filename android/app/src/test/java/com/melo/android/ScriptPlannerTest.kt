package com.melo.android

import com.melo.android.data.*
import com.melo.android.data.Connection
import com.melo.android.device.*
import com.melo.android.network.ModelClient
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test

class ScriptPlannerTest {
    private fun source() = DeviceScript(name = "Settings", goalTemplate = "Open settings", steps = listOf(ScriptStep("open_app", "com.android.settings")), completion = ScriptAssertion("com.android.settings", "Settings", "Settings"), verified = true)
    private fun response(script: DeviceScript, parameters: Map<String, String> = emptyMap()) = buildJsonObject {
        put("choices", buildJsonArray { add(buildJsonObject {
            put("finish_reason", "stop"); put("message", buildJsonObject { put("content", buildJsonObject {
                put("reuse", true); put("script", MeloJson.encodeToJsonElement(script)); put("parameters", MeloJson.encodeToJsonElement(parameters))
            }.toString()) })
        }) })
    }.toString()
    @Test fun similarPlanningUsesOneTextOnlyRequestAndKeepsGroundedActions() = runBlocking {
        MockWebServer().use { server ->
            val cached = source()
            server.enqueue(MockResponse().setBody(response(cached.copy(goalTemplate = "Please open settings")))); server.start()
            val result = ScriptPlanner(ModelClient(true)).adapt(Connection(endpoint = server.url("/chat").toString(), model = "fixture", stream = false), "fixture-key", "Please open settings", listOf(cached), "scope", "")
            assertNotNull(result); assertNotEquals(cached.id, result!!.script.id); assertFalse(result.script.verified)
            assertEquals(1, server.requestCount)
            val sent = server.takeRequest().body.readUtf8()
            assertFalse(sent.contains("image_url")); assertFalse(sent.contains("fixture-key")); assertFalse(sent.contains("sourceRunId"))
        }
    }
    @Test fun inventedTargetsAndWeakenedCompletionAreRejectedBeforeReplay() = runBlocking {
        MockWebServer().use { server ->
            val cached = source()
            val invented = cached.copy(goalTemplate = "New goal", steps = listOf(ScriptStep("tap", "com.android.settings", selector = NodeSelector(text = "Invented"))))
            val weakened = cached.copy(goalTemplate = "New goal", completion = ScriptAssertion("com.android.settings"))
            server.enqueue(MockResponse().setBody(response(invented))); server.enqueue(MockResponse().setBody(response(weakened))); server.start()
            val planner = ScriptPlanner(ModelClient(true)); val connection = Connection(endpoint = server.url("/chat").toString(), model = "fixture", stream = false)
            assertNull(planner.adapt(connection, "fixture-key", "New goal", listOf(cached), "scope", ""))
            assertNull(planner.adapt(connection, "fixture-key", "New goal", listOf(cached), "scope", ""))
        }
    }
    @Test fun modelCannotSubstituteADifferentValueForTheUsersBoundParameter() = runBlocking {
        MockWebServer().use { server ->
            val cached = source().copy(goalTemplate = "Search {{query}}", parameters = listOf("query"), steps = listOf(ScriptStep("type_text", "com.android.settings", selector = NodeSelector(viewId = "android:id/search_src_text", editable = true), parameter = "query")))
            server.enqueue(MockResponse().setBody(response(cached, mapOf("query" to "Unrequested value")))); server.start()
            val connection = Connection(endpoint = server.url("/chat").toString(), model = "fixture", stream = false)
            assertNull(ScriptPlanner(ModelClient(true)).adapt(connection, "fixture-key", "Search WiFi", listOf(cached), "scope", ""))
        }
    }
}
