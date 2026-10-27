package com.melo.android

import android.os.Build
import androidx.test.core.app.ApplicationProvider
import com.melo.android.core.*
import com.melo.android.data.*
import com.melo.android.network.SharedSearchAdapter
import com.melo.android.network.HostedSearchAdapter
import com.melo.android.network.ModelClient
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*
import java.util.concurrent.TimeUnit

/** Real Chat / JS Core / HTTP path; no Accessibility permission is needed. */
class SharedSearchFlowTest {
    private val app get() = ApplicationProvider.getApplicationContext<MeloApplication>()
    private var before: AppData? = null
    @Before fun setup() = runBlocking {
        Assume.assumeTrue("Search mutation fixtures only run on Emulator", Build.FINGERPRINT.contains("generic") || Build.MODEL.contains("sdk_gphone"))
        withTimeout(15_000) { app.engine.runtime.first { it.initialized } }
        before = app.repository.data.value
        withContext(Dispatchers.Main) { app.engine.dismissError() }
    }
    @After fun restore() = runBlocking {
        if (before == null) return@runBlocking
        withContext(Dispatchers.Main) { app.engine.cancel() }
        withTimeout(15_000) { while (app.engine.runtime.value.turns.isNotEmpty()) delay(30) }
        before?.let { snapshot -> app.repository.change { snapshot } }
        Unit
    }
    private suspend fun chat(server: MockWebServer, protocol: String = "chat-completions", config: JsonObject = buildJsonObject {}): String {
        val connection = Connection(name = "shared-search-fixture", endpoint = server.url("/model").toString(), model = "fixture-model", protocol = protocol, stream = false)
        app.repository.saveConnection(connection, "fixture-model-key")
        app.repository.change { it.copy(settings = it.settings.copy(agentRuntime = config)) }
        return app.repository.newChat().also { id -> app.repository.editChat(id) { it.copy(connectionId = connection.id) } }
    }
    private suspend fun send(id: String, text: String): RunRecord {
        withContext(Dispatchers.Main) { assertTrue(app.engine.send(id, text)) }
        withTimeout(25_000) { while (app.engine.runtime.value.turns.containsKey(id)) delay(30) }
        return app.repository.data.value.runs.last { it.chatId == id }
    }
    private fun tool(protocol: String, name: String = "web_search") = MockResponse().setBody(when (protocol) {
        "responses" -> """{"status":"completed","output":[{"type":"function_call","call_id":"search-1","name":"$name","arguments":"{\"query\":\"Surry Hills fixture\"}"}]}"""
        "anthropic" -> """{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"search-1","name":"$name","input":{"query":"Surry Hills fixture"}}]}"""
        else -> """{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"id":"search-1","type":"function","function":{"name":"$name","arguments":"{\"query\":\"Surry Hills fixture\"}"}}]}}]}"""
    })
    private fun final(protocol: String, text: String = "[Fixture A](https://fixture.invalid/menu) 营业状态未知。"): MockResponse {
        val encoded = MeloJson.encodeToString(text)
        return MockResponse().setBody(when (protocol) {
            "responses" -> """{"status":"completed","model":"fixture-model","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":$encoded}]}]}"""
            "anthropic" -> """{"stop_reason":"end_turn","model":"fixture-model","content":[{"type":"text","text":$encoded}]}"""
            else -> """{"model":"fixture-model","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":$encoded,"tool_calls":null}}]}"""
        })
    }
    private fun review(protocol: String, complete: Boolean = false, evidence: String = "") = final(protocol, buildJsonObject {
        put("decision", if (complete) "complete" else "partial"); put("reasonType", if (complete) "fulfilled" else "unavailable"); put("reason", "Fixture evidence check"); put("nextStep", "")
        put("requirements", buildJsonArray { add(buildJsonObject { put("text", "Public facts"); put("status", if (complete) "met" else "missing"); put("evidenceIds", buildJsonArray { if (complete) add(evidence) }) }) })
    }.toString())

    @Test fun threeProtocolsSearchPublicSourcesAndReturnToChatWithoutAnyDeviceRun() = runBlocking {
        for (protocol in listOf("chat-completions", "responses", "anthropic")) MockWebServer().use { model -> MockWebServer().use { backend ->
            model.enqueue(tool(protocol)); model.enqueue(final(protocol)); model.enqueue(review(protocol)); model.start()
            backend.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("""{"results":[{"title":"Fixture A","url":"https://fixture.invalid/menu","snippet":"Hours not verified"}]}""")); backend.start()
            val endpoint = backend.url("/search").toString()
            val config = buildJsonObject { put("search", buildJsonObject { put("backend", "http"); put("endpoint", endpoint); put("credentialRef", "search") }) }
            app.repository.saveCredential(SharedSearchAdapter.credentialId(endpoint, true), "fixture-search-key")
            val deviceCount = app.repository.data.value.deviceRuns.size
            val id = chat(model, protocol, config)
            val run = send(id, "搜索 Surry Hills 当前营业的餐厅")
            assertEquals(run.error, "partial", run.status)
            assertEquals("GOAL_UNAVAILABLE", run.sharedScene?.get("completion")?.jsonObject?.text("reason"))
            assertTrue(run.partial.contains("营业状态未知")); assertTrue(run.sources.contains("https://fixture.invalid/menu"))
            assertEquals(deviceCount, app.repository.data.value.deviceRuns.size); assertFalse(app.deviceAgent.runtime.value.running)
            val first = model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()
            assertTrue(first.contains("web_search")); assertTrue(first.contains("phone_use")); assertFalse(first.contains("android_device"))
            val lookup = backend.takeRequest(2, TimeUnit.SECONDS)!!
            assertEquals("Bearer fixture-search-key", lookup.getHeader("Authorization")); assertEquals("Surry Hills fixture", MeloJson.parseToJsonElement(lookup.body.readUtf8()).jsonObject.text("query"))
            val follow = model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()
            assertTrue(follow.contains("search-1")); assertTrue(follow.contains("Fixture A")); assertTrue(follow.contains("freshness"))
            assertFalse(follow.contains("fixture-search-key")); assertFalse(run.partial.contains("fixture-search-key"))
            assertEquals(3, model.requestCount); assertEquals(1, backend.requestCount)
            val check = model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8(); assertTrue(check.contains("task completion checker")); assertFalse(check.contains("\"name\":\"web_search\""))
        } }
    }

    @Test fun completionUsesActualReadBodiesAndPersistsTheEvidenceBoundary() = runBlocking {
        for (body in listOf("Sydney brunch menu with breakfast dishes and observed opening hours for this fixture.", "Distant stars and galaxies have different spectra and their light is redshifted.", "")) MockWebServer().use { model -> MockWebServer().use { backend ->
            backend.start()
            val page = backend.url("/menu").toString()
            backend.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(buildJsonObject { put("results", buildJsonArray { add(buildJsonObject { put("title", "Fixture"); put("url", page); put("snippet", "Sydney brunch summary") }) }) }.toString()))
            backend.enqueue(MockResponse().setHeader("Content-Type", "text/plain").setBody(body))
            model.enqueue(tool("chat-completions"))
            model.enqueue(MockResponse().setBody(buildJsonObject { put("choices", buildJsonArray { add(buildJsonObject { put("finish_reason", "tool_calls"); put("message", buildJsonObject { put("role", "assistant"); put("tool_calls", buildJsonArray { add(buildJsonObject { put("id", "read-1"); put("type", "function"); put("function", buildJsonObject { put("name", "fetch_url"); put("arguments", buildJsonObject { put("url", page) }.toString()) }) }) }) }) }) }) }.toString()))
            model.enqueue(MockResponse().setBody(buildJsonObject { put("choices", buildJsonArray { add(buildJsonObject { put("finish_reason", "stop"); put("message", buildJsonObject { put("role", "assistant"); put("content", "Sydney brunch: $page") }) }) }) }.toString()))
            model.enqueue(review("chat-completions", body.startsWith("Sydney"), "read-1:source:0"))
            model.start()
            val config = buildJsonObject { put("search", buildJsonObject { put("backend", "http"); put("endpoint", backend.url("/search").toString()) }) }
            val id = chat(model, config = config)
            val run = send(id, "搜索 Sydney brunch")
            val completion = run.sharedScene!!.getValue("completion").jsonObject
            assertEquals(if (body.startsWith("Sydney")) "completed" else "partial", run.status)
            assertEquals(if (body.startsWith("Sydney")) "supported" else "unverified", completion.text("goalState"))
            assertEquals(4, model.requestCount); assertEquals(2, backend.requestCount)
            assertFalse(completion.toString().contains("breakfast dishes"))
        } }
    }

    @Test fun unconfiguredSearchKeepsNativeOrganizerAvailableWithoutTakingOverScreen() = runBlocking {
        MockWebServer().use { model ->
            model.enqueue(final("chat-completions", "没有可用 Search Backend，未获取餐厅事实。")); model.enqueue(review("chat-completions")); model.start(); val deviceCount = app.repository.data.value.deviceRuns.size
            val id = chat(model)
            val run = send(id, "搜索 Surry Hills 现在营业的饭店")
            assertEquals("blocked", run.status); assertEquals("GOAL_UNAVAILABLE", run.sharedScene!!.getValue("completion").jsonObject.text("reason"))
            assertEquals(2, model.requestCount); assertEquals(deviceCount, app.repository.data.value.deviceRuns.size)
            val first = model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8(); assertTrue(first.contains("todo_list")); assertFalse(first.contains("\"name\":\"web_search\""))
        }
    }

    @Test fun modelCannotClaimSearchCompletionWithoutRunningTheTool() = runBlocking {
        MockWebServer().use { model -> MockWebServer().use { backend ->
            model.enqueue(final("chat-completions")); model.enqueue(review("chat-completions")); model.start(); backend.start()
            val config = buildJsonObject { put("search", buildJsonObject { put("backend", "http"); put("endpoint", backend.url("/search").toString()) }) }
            val id = chat(model, config = config)
            val run = send(id, "搜索 Surry Hills 餐厅")
            assertEquals("blocked", run.status); assertEquals("GOAL_UNAVAILABLE", run.sharedScene!!.getValue("completion").jsonObject.text("reason")); assertEquals(0, backend.requestCount)
            assertTrue(run.partial.contains("[Fixture A]")); assertEquals("unverified", run.sharedScene!!.getValue("completion").jsonObject.text("goalState"))
        } }
    }

    @Test fun malformedSearchSettingsCannotBlockAnOrdinaryAnswerOrReadItsKey() = runBlocking {
        MockWebServer().use { model ->
            model.enqueue(final("chat-completions")); model.start()
            val id = chat(model, config = buildJsonObject { put("search", buildJsonObject { put("backend", "http"); put("endpoint", "invalid"); put("credentialRef", "search") }) })
            val run = send(id, "1+1")
            assertEquals(run.error, "completed", run.status); assertEquals(1, model.requestCount)
            val names = MeloJson.parseToJsonElement(model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()).jsonObject.getValue("tools").jsonArray.map { it.jsonObject["function"]?.jsonObject?.text("name") }
            assertFalse(names.contains("web_search")); assertTrue(names.contains("todo_list"))
        }
    }

    @Test fun changedEndpointHasADifferentCredentialSlot() {
        assertNotEquals(SharedSearchAdapter.credentialId("https://one.example/search", false), SharedSearchAdapter.credentialId("https://two.example/search", false))
    }

    @Test fun hostedProbeAndRealChatRequireCompletedReceiptAndInvalidateChangedConnection() = runBlocking {
        MockWebServer().use { model ->
            fun hosted() = MockResponse().setBody("""{"status":"completed","model":"fixture-model","output":[{"type":"web_search_call","status":"completed","action":{"sources":[{"title":"Fixture A","url":"https://fixture.invalid/menu"}]}},{"type":"message","content":[{"type":"output_text","text":"Fixture A；营业状态未知。"}]}]}""")
            model.enqueue(hosted()); model.enqueue(hosted()); model.enqueue(review("responses")); model.start()
            val id = chat(model, "responses")
            val connection = app.repository.data.value.settings.connections.last()
            val proof = HostedSearchAdapter.probe(app, connection, "fixture-model-key", ModelClient(true), true)
            assertEquals("verified", proof.text("status")); assertFalse(proof.toString().contains("fixture-model-key"))
            app.repository.saveConnection(connection.copy(searchProof = proof), null)
            val deviceCount = app.repository.data.value.deviceRuns.size
            val run = send(id, "搜索 Surry Hills 餐厅")
            assertEquals(run.error, "partial", run.status); assertTrue(run.sources.contains("https://fixture.invalid/menu"))
            assertEquals(deviceCount, app.repository.data.value.deviceRuns.size)
            repeat(2) { index ->
                val body = MeloJson.parseToJsonElement(model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()).jsonObject
                assertEquals(1, body.getValue("tools").jsonArray.count { it.jsonObject.text("type") == "web_search" })
                if (index == 1) assertTrue(body.toString().contains("todo_list"))
                assertTrue(body.getValue("include").jsonArray.any { it.jsonPrimitive.content == "web_search_call.action.sources" })
            }
            assertTrue(model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8().contains("task completion checker"))
            model.enqueue(final("responses")); model.enqueue(review("responses"))
            val plain = send(id, "搜索现在还营业的餐厅")
            assertEquals("blocked", plain.status); assertTrue(plain.sharedScene.toString().contains("未收到 completed 与来源回执"))
            repeat(2) { model.takeRequest(2, TimeUnit.SECONDS) }
            app.repository.saveConnection(connection.copy(searchProof = proof, model = "changed-model"), null)
            model.enqueue(final("responses", "Search unavailable")); model.enqueue(review("responses"))
            val invalidated = send(id, "搜索餐厅")
            assertEquals("blocked", invalidated.status); assertEquals(7, model.requestCount)
            val changed = model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8(); assertTrue(changed.contains("todo_list")); assertFalse(changed.contains("\"type\":\"web_search\""))
            assertEquals(deviceCount, app.repository.data.value.deviceRuns.size)
        }
    }

    @Test fun failedBackendDoesNotEscalateToPhone() = runBlocking {
        MockWebServer().use { model -> MockWebServer().use { backend ->
            model.enqueue(tool("chat-completions")); model.enqueue(final("chat-completions")); model.enqueue(review("chat-completions")); model.start()
            backend.enqueue(MockResponse().setResponseCode(503)); backend.start()
            val config = buildJsonObject { put("search", buildJsonObject { put("backend", "http"); put("endpoint", backend.url("/search").toString()) }) }
            val deviceCount = app.repository.data.value.deviceRuns.size
            val id = chat(model, config = config)
            assertEquals("blocked", send(id, "搜索 Surry Hills 餐厅").status)
            model.takeRequest(2, TimeUnit.SECONDS)
            val follow = model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()
            assertTrue(follow.contains("SEARCH_HTTP_503")); assertTrue(follow.contains("phone_use"))
            assertEquals(1, backend.requestCount); assertEquals(deviceCount, app.repository.data.value.deviceRuns.size)
        } }
    }

    @Test fun cancellationDuringSearchDoesNotStartAnotherModelOrDeviceTask() = runBlocking {
        MockWebServer().use { model -> MockWebServer().use { backend ->
            model.enqueue(tool("chat-completions")); model.start()
            backend.enqueue(MockResponse().setBody("""{"results":[]}""").setBodyDelay(3, TimeUnit.SECONDS)); backend.start()
            val config = buildJsonObject { put("search", buildJsonObject { put("backend", "http"); put("endpoint", backend.url("/search").toString()) }) }
            val id = chat(model, config = config)
            val deviceCount = app.repository.data.value.deviceRuns.size
            withContext(Dispatchers.Main) { assertTrue(app.engine.send(id, "搜索 Surry Hills 餐厅")) }
            assertNotNull(withContext(Dispatchers.IO) { backend.takeRequest(15, TimeUnit.SECONDS) })
            withContext(Dispatchers.Main) { app.engine.cancel(id) }
            withTimeout(15_000) { while (app.engine.runtime.value.turns.containsKey(id)) delay(30) }
            assertEquals("cancelled", app.repository.data.value.runs.last { it.chatId == id }.status)
            assertEquals(1, model.requestCount); assertEquals(deviceCount, app.repository.data.value.deviceRuns.size)
        } }
    }
}
