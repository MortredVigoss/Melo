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
    private suspend fun chat(server: MockWebServer, protocol: String = "chat-completions", config: JsonObject = buildJsonObject {}, contextTokens: Int? = null): String {
        val connection = Connection(name = "shared-search-fixture", endpoint = server.url("/model").toString(), model = "fixture-model", protocol = protocol, stream = false).let { if (contextTokens == null) it else it.copy(contextTokens = contextTokens) }
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
    private fun call(protocol: String, name: String, id: String, args: JsonObject) = calls(protocol, listOf(Triple(name, id, args)))
    private fun calls(protocol: String, items: List<Triple<String, String, JsonObject>>) = MockResponse().setBody(when (protocol) {
        "responses" -> buildJsonObject { put("status", "completed"); put("output", buildJsonArray { for ((name, id, args) in items) add(buildJsonObject { put("type", "function_call"); put("call_id", id); put("name", name); put("arguments", args.toString()) }) }) }
        "anthropic" -> buildJsonObject { put("stop_reason", "tool_use"); put("content", buildJsonArray { for ((name, id, args) in items) add(buildJsonObject { put("type", "tool_use"); put("id", id); put("name", name); put("input", args) }) }) }
        else -> buildJsonObject { put("choices", buildJsonArray { add(buildJsonObject { put("finish_reason", "tool_calls"); put("message", buildJsonObject { put("role", "assistant"); put("tool_calls", buildJsonArray {
            for ((name, id, args) in items) add(buildJsonObject { put("id", id); put("type", "function"); put("function", buildJsonObject { put("name", name); put("arguments", args.toString()) }) })
        }) }) }) }) }
    }.toString())
    /**
     * The model of a routed reply, answering by the role of each request: the completion checker, the
     * research member (its scripted rounds in order) or the lead, which first assigns the lookup and
     * then answers. Since 2026-11-07 the lead holds no retrieval tools, so this is the only way a
     * search or a page read happens in a chat.
     */
    private inner class Routed(private val protocol: String, private val member: List<MockResponse>, private val answer: MockResponse, private val check: MockResponse) : Dispatcher() {
        val bodies = java.util.concurrent.CopyOnWriteArrayList<String>()
        private val memberRound = java.util.concurrent.atomic.AtomicInteger(); private val leadRound = java.util.concurrent.atomic.AtomicInteger()
        fun role(body: String) = if (body.contains("task completion checker")) "check" else if (body.contains("internal research specialist")) "member" else "lead"
        fun of(role: String) = bodies.filter { role(it) == role }
        override fun dispatch(request: RecordedRequest): MockResponse {
            val body = request.body.readUtf8(); bodies += body
            return when (role(body)) {
                "check" -> check
                "member" -> member[minOf(memberRound.getAndIncrement(), member.size - 1)]
                else -> if (leadRound.getAndIncrement() == 0) call(protocol, "route_task", "route-1", buildJsonObject { put("role", "research"); put("task", "Find the requested public facts") }) else answer
            }
        }
    }
    private fun toolNames(body: String): List<String> = MeloJson.parseToJsonElement(body).jsonObject["tools"]?.jsonArray.orEmpty().map { it.jsonObject.let { tool -> tool["function"]?.jsonObject?.text("name") ?: tool.text("name").ifBlank { tool.text("type") } } }
    private fun review(protocol: String, complete: Boolean = false, evidence: String = "") = final(protocol, buildJsonObject {
        put("decision", if (complete) "complete" else "partial"); put("reasonType", if (complete) "fulfilled" else "unavailable"); put("reason", "Fixture evidence check"); put("nextStep", "")
        put("requirements", buildJsonArray { add(buildJsonObject { put("text", "Public facts"); put("status", if (complete) "met" else "missing"); put("evidenceIds", buildJsonArray { if (complete) add(evidence) }) }) })
    }.toString())

    @Test fun threeProtocolsSearchPublicSourcesAndReturnToChatWithoutAnyDeviceRun() = runBlocking {
        for (protocol in listOf("chat-completions", "responses", "anthropic")) MockWebServer().use { model -> MockWebServer().use { backend ->
            val routed = Routed(protocol, listOf(tool(protocol), final(protocol, "Fixture A https://fixture.invalid/menu 营业时间未核实。")), final(protocol), review(protocol))
            model.dispatcher = routed; model.start()
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
            // The lead routes and holds no retrieval tool; the member holds the retrieval tools and nothing else.
            val lead = toolNames(routed.of("lead").first())
            assertTrue(protocol, "route_task" in lead && "phone_action" in lead); assertFalse("web_search" in lead); assertFalse("fetch_url" in lead)
            assertFalse(routed.of("lead").first().contains("\"name\":\"phone_use\"")); assertFalse(routed.of("lead").first().contains("android_device"))
            assertEquals(protocol, listOf("fetch_url", "web_search"), toolNames(routed.of("member").first()).sorted())
            val lookup = backend.takeRequest(2, TimeUnit.SECONDS)!!
            assertEquals("Bearer fixture-search-key", lookup.getHeader("Authorization")); assertEquals("Surry Hills fixture", MeloJson.parseToJsonElement(lookup.body.readUtf8()).jsonObject.text("query"))
            val follow = routed.of("member")[1]
            assertTrue(follow.contains("search-1")); assertTrue(follow.contains("Fixture A")); assertTrue(follow.contains("freshness"))
            assertTrue("the member's report reaches the lead as an untrusted handoff", routed.of("lead")[1].contains("memberReport"))
            for (body in routed.bodies) assertFalse(body.contains("fixture-search-key")); assertFalse(run.partial.contains("fixture-search-key"))
            assertEquals(5, model.requestCount); assertEquals(1, backend.requestCount)
            val check = MeloJson.parseToJsonElement(routed.of("check").single()).jsonObject
            for (field in listOf("tools", "parallel_tool_calls", "tool_choice")) assertNull("$protocol check request carries $field", check[field])
        } }
    }

    @Test fun completionUsesActualReadBodiesAndPersistsTheEvidenceBoundary() = runBlocking {
        for (body in listOf("Sydney brunch menu with breakfast dishes and observed opening hours for this fixture.", "Distant stars and galaxies have different spectra and their light is redshifted.", "")) MockWebServer().use { model -> MockWebServer().use { backend ->
            backend.start()
            val page = backend.url("/menu").toString()
            backend.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(buildJsonObject { put("results", buildJsonArray { add(buildJsonObject { put("title", "Fixture"); put("url", page); put("snippet", "Sydney brunch summary") }) }) }.toString()))
            backend.enqueue(MockResponse().setHeader("Content-Type", "text/plain").setBody(body))
            val routed = Routed("chat-completions", listOf(tool("chat-completions"), call("chat-completions", "fetch_url", "read-1", buildJsonObject { put("url", page) }), final("chat-completions", "Read $page")),
                final("chat-completions", "Sydney brunch: $page"), review("chat-completions", body.startsWith("Sydney"), "job-1:read-1:source:0"))
            model.dispatcher = routed; model.start()
            val config = buildJsonObject { put("search", buildJsonObject { put("backend", "http"); put("endpoint", backend.url("/search").toString()) }) }
            val id = chat(model, config = config)
            val run = send(id, "搜索 Sydney brunch")
            val completion = run.sharedScene!!.getValue("completion").jsonObject
            assertEquals(if (body.startsWith("Sydney")) "completed" else "partial", run.status)
            assertEquals(if (body.startsWith("Sydney")) "supported" else "unverified", completion.text("goalState"))
            assertEquals(6, model.requestCount); assertEquals(2, backend.requestCount)
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
            // An answer is followed by its completion check whenever the turn holds tools (2026-10-27).
            model.enqueue(final("chat-completions", "2")); model.enqueue(final("chat-completions", buildJsonObject {
                put("decision", "complete"); put("turnKind", "answer"); put("reasonType", "self_contained"); put("reason", "Arithmetic answered"); put("nextStep", "")
                put("requirements", buildJsonArray { add(buildJsonObject { put("text", "1+1"); put("kind", "response"); put("status", "met"); put("evidenceIds", buildJsonArray {}) }) })
            }.toString())); model.start()
            val id = chat(model, config = buildJsonObject { put("search", buildJsonObject { put("backend", "http"); put("endpoint", "invalid"); put("credentialRef", "search") }) })
            val run = send(id, "1+1")
            assertEquals(run.error, "completed", run.status); assertEquals(2, model.requestCount)
            val names = toolNames(model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8())
            assertFalse(names.contains("web_search")); assertTrue(names.contains("todo_list"))
        }
    }

    @Test fun changedEndpointHasADifferentCredentialSlot() {
        assertNotEquals(SharedSearchAdapter.credentialId("https://one.example/search", false), SharedSearchAdapter.credentialId("https://two.example/search", false))
    }

    @Test fun hostedProbeAndRealChatRequireCompletedReceiptAndInvalidateChangedConnection() = runBlocking {
        MockWebServer().use { model ->
            fun hosted() = MockResponse().setBody("""{"status":"completed","model":"fixture-model","output":[{"type":"web_search_call","status":"completed","action":{"sources":[{"title":"Fixture A","url":"https://fixture.invalid/menu"}]}},{"type":"message","content":[{"type":"output_text","text":"Fixture A；营业状态未知。"}]}]}""")
            fun route() = call("responses", "route_task", "route-1", buildJsonObject { put("role", "research"); put("task", "Find restaurants in Surry Hills") })
            // Probe, then one routed reply: the lead assigns, the member's request runs hosted search, the lead answers, the check.
            model.enqueue(hosted()); model.enqueue(route()); model.enqueue(hosted()); model.enqueue(final("responses", "Fixture A；营业状态未知。")); model.enqueue(review("responses")); model.start()
            val id = chat(model, "responses")
            val connection = app.repository.data.value.settings.connections.last()
            val proof = HostedSearchAdapter.probe(app, connection, "fixture-model-key", ModelClient(true), true)
            assertEquals("verified", proof.text("status")); assertFalse(proof.toString().contains("fixture-model-key"))
            app.repository.saveConnection(connection.copy(searchProof = proof), null)
            val deviceCount = app.repository.data.value.deviceRuns.size
            val run = send(id, "搜索 Surry Hills 餐厅")
            assertEquals(run.error, "partial", run.status); assertTrue(run.sources.contains("https://fixture.invalid/menu"))
            assertEquals(deviceCount, app.repository.data.value.deviceRuns.size)
            val probe = MeloJson.parseToJsonElement(model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()).jsonObject
            assertEquals(1, probe.getValue("tools").jsonArray.count { it.jsonObject.text("type") == "web_search" })
            // Hosted search is retrieval too: the lead never holds it, the research member does.
            val lead = MeloJson.parseToJsonElement(model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()).jsonObject
            assertEquals(0, lead.getValue("tools").jsonArray.count { it.jsonObject.text("type") == "web_search" }); assertTrue(lead.toString().contains("route_task")); assertTrue(lead.toString().contains("todo_list"))
            val member = MeloJson.parseToJsonElement(model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()).jsonObject
            assertEquals(1, member.getValue("tools").jsonArray.count { it.jsonObject.text("type") == "web_search" })
            assertTrue(member.getValue("include").jsonArray.any { it.jsonPrimitive.content == "web_search_call.action.sources" })
            assertTrue(model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8().contains("memberReport"))
            assertTrue(model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8().contains("task completion checker"))
            // A member reply without a completed search receipt is not a search.
            model.enqueue(route()); model.enqueue(final("responses", "Fixture A")); model.enqueue(final("responses")); model.enqueue(review("responses"))
            val plain = send(id, "搜索现在还营业的餐厅")
            assertEquals("blocked", plain.status); assertTrue(plain.sharedScene.toString().contains("未收到 completed 与来源回执"))
            repeat(4) { model.takeRequest(2, TimeUnit.SECONDS) }
            app.repository.saveConnection(connection.copy(searchProof = proof, model = "changed-model"), null)
            model.enqueue(final("responses", "Search unavailable")); model.enqueue(review("responses"))
            val invalidated = send(id, "搜索餐厅")
            assertEquals("blocked", invalidated.status); assertEquals(11, model.requestCount)
            val changed = model.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8(); assertTrue(changed.contains("todo_list")); assertFalse(changed.contains("\"type\":\"web_search\""))
            assertEquals(deviceCount, app.repository.data.value.deviceRuns.size)
        }
    }

    @Test fun failedBackendDoesNotEscalateToPhone() = runBlocking {
        MockWebServer().use { model -> MockWebServer().use { backend ->
            val routed = Routed("chat-completions", listOf(tool("chat-completions"), final("chat-completions", "The search backend failed.")), final("chat-completions"), review("chat-completions"))
            model.dispatcher = routed; model.start()
            backend.enqueue(MockResponse().setResponseCode(503)); backend.start()
            val config = buildJsonObject { put("search", buildJsonObject { put("backend", "http"); put("endpoint", backend.url("/search").toString()) }) }
            val deviceCount = app.repository.data.value.deviceRuns.size
            val id = chat(model, config = config)
            assertEquals("blocked", send(id, "搜索 Surry Hills 餐厅").status)
            val follow = routed.of("member")[1]
            assertTrue(follow.contains("SEARCH_HTTP_503"))
            // The member that met the failure holds no phone tool at all; the lead keeps it for an explicit request only.
            assertFalse("phone_action" in toolNames(follow)); assertTrue("phone_action" in toolNames(routed.of("lead").last())); assertFalse(routed.of("lead").last().contains("\"name\":\"phone_use\""))
            assertEquals(1, backend.requestCount); assertEquals(deviceCount, app.repository.data.value.deviceRuns.size)
        } }
    }

    @Test fun cancellationDuringSearchDoesNotStartAnotherModelOrDeviceTask() = runBlocking {
        MockWebServer().use { model -> MockWebServer().use { backend ->
            val routed = Routed("chat-completions", listOf(tool("chat-completions"), final("chat-completions", "never reached")), final("chat-completions"), review("chat-completions"))
            model.dispatcher = routed; model.start()
            backend.enqueue(MockResponse().setBody("""{"results":[]}""").setBodyDelay(3, TimeUnit.SECONDS)); backend.start()
            val config = buildJsonObject { put("search", buildJsonObject { put("backend", "http"); put("endpoint", backend.url("/search").toString()) }) }
            val id = chat(model, config = config)
            val deviceCount = app.repository.data.value.deviceRuns.size
            withContext(Dispatchers.Main) { assertTrue(app.engine.send(id, "搜索 Surry Hills 餐厅")) }
            assertNotNull(withContext(Dispatchers.IO) { backend.takeRequest(15, TimeUnit.SECONDS) })
            withContext(Dispatchers.Main) { app.engine.cancel(id) }
            withTimeout(15_000) { while (app.engine.runtime.value.turns.containsKey(id)) delay(30) }
            assertEquals("cancelled", app.repository.data.value.runs.last { it.chatId == id }.status)
            // The lead's assignment and the member's search request, and nothing after the stop.
            delay(500); assertEquals(2, model.requestCount); assertEquals(deviceCount, app.repository.data.value.deviceRuns.size)
        } }
    }

    // ---- 2026-11-10: page reads of one batch load side by side, long pages are read in parts, and a
    // ---- failed lookup stays a failed lookup.

    /** A page backend that records how many requests were in flight together. */
    private class Pages(private val delayMs: Long, private val body: (String) -> String) : Dispatcher() {
        val inFlight = java.util.concurrent.atomic.AtomicInteger(); val peak = java.util.concurrent.atomic.AtomicInteger()
        val arrivals = java.util.concurrent.CopyOnWriteArrayList<Pair<String, Long>>()
        override fun dispatch(request: RecordedRequest): MockResponse {
            arrivals += (request.path ?: "") to android.os.SystemClock.elapsedRealtime()
            peak.accumulateAndGet(inFlight.incrementAndGet(), ::maxOf)
            try { Thread.sleep(delayMs) } catch (_: InterruptedException) { } finally { inFlight.decrementAndGet() }
            return MockResponse().setHeader("Content-Type", "text/plain").setBody(body(request.path ?: ""))
        }
    }
    private fun order(body: String, ids: List<String>) = ids.map { body.indexOf(it) }

    @Test fun aBatchOfPageReadsLoadsSideBySideAndIsReportedInCallOrder() = runBlocking {
        MockWebServer().use { model -> MockWebServer().use { backend ->
            val pages = Pages(1500) { path -> "Fixture page $path holds the fact for $path and enough text to count as a read source." }
            backend.dispatcher = pages; backend.start()
            val urls = listOf("/a", "/b", "/c", "/d").map { backend.url(it).toString() }
            val reads = urls.mapIndexed { index, url -> Triple("fetch_url", "r${index + 1}", buildJsonObject { put("url", url) }) }
            val routed = Routed("chat-completions", listOf(calls("chat-completions", reads), final("chat-completions", "Read four pages.")),
                final("chat-completions", "Four pages compared: " + urls.joinToString(" ")), review("chat-completions", true, "job-1:r1:source:0"))
            model.dispatcher = routed; model.start()
            val id = chat(model)
            val run = send(id, "读取并比较这四个页面 " + urls.joinToString(" "))
            assertEquals(run.error, "completed", run.status)
            // Three reads were in flight together, never more; the fourth started when a slot freed.
            assertEquals(3, pages.peak.get()); assertEquals(4, backend.requestCount)
            val times = pages.arrivals.map { it.second }
            assertTrue("the first three requests arrive together: $times", times[2] - times[0] < 700)
            assertTrue("the fourth waits for a free slot: $times", times[3] - times[0] >= 1300)
            // Every result is paired with its own call and reported in call order.
            val follow = routed.of("member")[1]
            val results = MeloJson.parseToJsonElement(follow).jsonObject.getValue("messages").jsonArray.map { it.jsonObject }.filter { it.text("role") == "tool" }
            assertEquals(listOf("r1", "r2", "r3", "r4"), results.map { it.text("tool_call_id") })
            for ((index, path) in listOf("/a", "/b", "/c", "/d").withIndex()) assertTrue(results[index].text("content").contains("Fixture page $path "))
            // The execution record shows four completed reads with overlapping durations.
            val operations = run.sharedScene!!.getValue("operations").jsonArray.map { it.jsonObject }.filter { it.text("name") == "fetch_url" }
            assertEquals(4, operations.size); assertTrue(operations.all { it.text("status") == "completed" })
            assertTrue(operations.toString(), operations.all { (it["durationMs"]?.jsonPrimitive?.longOrNull ?: 0) in 1400..3500 })
        } }
    }

    @Test fun stoppingDuringAPageBatchSendsNoFurtherModelRequest() = runBlocking {
        MockWebServer().use { model -> MockWebServer().use { backend ->
            val pages = Pages(4000) { "late" }; backend.dispatcher = pages; backend.start()
            val urls = listOf("/a", "/b", "/c", "/d").map { backend.url(it).toString() }
            val routed = Routed("chat-completions", listOf(calls("chat-completions", urls.mapIndexed { index, url -> Triple("fetch_url", "r${index + 1}", buildJsonObject { put("url", url) }) }), final("chat-completions", "never reached")),
                final("chat-completions"), review("chat-completions"))
            model.dispatcher = routed; model.start()
            val id = chat(model)
            withContext(Dispatchers.Main) { assertTrue(app.engine.send(id, "读取这四个页面 " + urls.joinToString(" "))) }
            withTimeout(15_000) { while (pages.peak.get() < 3) delay(30) }
            withContext(Dispatchers.Main) { app.engine.cancel(id) }
            withTimeout(15_000) { while (app.engine.runtime.value.turns.containsKey(id)) delay(30) }
            assertEquals("cancelled", app.repository.data.value.runs.last { it.chatId == id }.status)
            delay(4500)
            // The fourth read never started, and no model request followed the stop.
            assertEquals(3, backend.requestCount); assertEquals(2, model.requestCount)
        } }
    }

    // 2026-11-10. A stop that lands while the shared Core is evaluating closes that Runtime. The
    // receipt was then asked of the closed Runtime, its error replaced the cancellation, and the
    // stopped reply was recorded as failed with "共享 Runtime 已关闭". The stops below are spread over
    // the busy stretch after a model response, where most of the Core work of a round happens.
    @Test fun aStopAtAnyMomentIsRecordedAsStoppedNeverAsFailed() = runBlocking {
        MockWebServer().use { model -> MockWebServer().use { backend ->
            backend.dispatcher = Pages(3000) { "late" }; backend.start()
            val url = backend.url("/slow").toString()
            val responded = java.util.concurrent.atomic.AtomicLong(0)
            model.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val member = request.body.readUtf8().contains("internal research specialist")
                    val response = if (member) call("chat-completions", "fetch_url", "s1", buildJsonObject { put("url", url) })
                        else call("chat-completions", "route_task", "route-1", buildJsonObject { put("role", "research"); put("task", "Read $url") })
                    responded.set(android.os.SystemClock.elapsedRealtime()); return response
                }
            }
            model.start()
            val outcomes = mutableListOf<String>()
            for (pause in listOf(0, 4, 8, 12, 18, 25, 35, 45, 60, 80, 90, 100, 110, 130, 160, 200, 250, 320, 400, 500)) {
                val id = chat(model); responded.set(0)
                withContext(Dispatchers.Main) { assertTrue(app.engine.send(id, "读一下 $url")) }
                withTimeout(15_000) { while (responded.get() == 0L) delay(1) }
                delay(pause.toLong())
                // A reply that ended on its own before the stop is a different failure; the message says which.
                val running = app.engine.runtime.value.turns.containsKey(id)
                withContext(Dispatchers.Main) { app.engine.cancel(id); app.engine.dismissError() }
                withTimeout(15_000) { while (app.engine.runtime.value.turns.containsKey(id)) delay(10) }
                val run = app.repository.data.value.runs.last { it.chatId == id }
                outcomes += "+${pause}ms ${run.status}" + if (run.status == "cancelled") "" else " (${run.error}; ${if (running) "running when stopped" else "ended before the stop"})"
                assertNotEquals("the stopped run keeps a closed scene", "running", run.sharedScene?.text("status"))
            }
            assertTrue("every stopped reply is recorded as stopped: $outcomes", outcomes.all { it.endsWith(" cancelled") })
        } }
    }

    // 2026-11-10. A tool chain that outgrew the model's context ended the whole reply with
    // "共享 Agent 拒绝请求：CONTEXT_BUDGET_EXCEEDED": no answer, no write-up, the evidence lost. It is a
    // limit of the run: the member hands back with a write-up of what it read and the lead answers.
    @Test fun aChainThatOutgrowsTheContextHandsBackInsteadOfFailingTheReply() = runBlocking {
        MockWebServer().use { model -> MockWebServer().use { backend ->
            backend.dispatcher = Pages(0) { path -> "Page $path. " + "forecast for the coming week ".repeat(800) }; backend.start()
            val urls = listOf("/a", "/b", "/c").map { backend.url(it).toString() }
            val routed = Routed("chat-completions", urls.mapIndexed { index, url -> call("chat-completions", "fetch_url", "o${index + 1}", buildJsonObject { put("url", url) }) } + final("chat-completions", "never reached"),
                final("chat-completions", "三个页面都是未来一周的预报。"), review("chat-completions", true, "job-1:o1:source:0"))
            model.dispatcher = routed; model.start()
            // 24 000 tokens of context: two of these pages fit a member's request, the third does not.
            val id = chat(model, contextTokens = 24_000)
            val run = send(id, "读取并比较 " + urls.joinToString(" "))
            assertFalse(run.error.orEmpty(), run.error.orEmpty().contains("CONTEXT_BUDGET_EXCEEDED")); assertNotEquals("failed", run.status)
            assertEquals("all three pages were read", 3, backend.requestCount)
            assertEquals("the request that would not fit was never sent", 3, routed.of("member").size)
            assertTrue("the member wrote up what it had read", routed.bodies.any { it.contains("The execution allowance is ending") })
            assertTrue("and the lead received it as a limited handoff", routed.of("lead").any { it.contains("memberReport") && it.contains("GOAL_INCOMPLETE") })
            assertTrue(run.partial.contains("三个页面都是未来一周的预报")); assertEquals(run.error, "completed", run.status)
            val member = run.sharedScene!!.getValue("pipeline").jsonArray.map { it.jsonObject }.first { it.text("id") == "internal:1" }
            assertEquals("interrupted", member.text("status"))
        } }
    }

    // 2026-11-10. The URLs a run may read were capped at 32 for the whole run. Five searches of eight
    // results passed it, and a result of the sixth was refused as "not returned by this run's search".
    @Test fun aResultOfALaterSearchCanStillBeRead() = runBlocking {
        MockWebServer().use { model -> MockWebServer().use { backend ->
            val searches = java.util.concurrent.atomic.AtomicInteger()
            backend.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if (request.path?.startsWith("/search") != true) return MockResponse().setHeader("Content-Type", "text/plain").setBody("The fortieth result holds the answer the member needs for its report.")
                    val round = searches.incrementAndGet()
                    return MockResponse().setHeader("Content-Type", "application/json").setBody(buildJsonObject { put("results", buildJsonArray { for (index in 1..8) add(buildJsonObject {
                        put("title", "Result $round-$index"); put("url", if (round == 5 && index == 8) backend.url("/fortieth").toString() else "https://fixture.invalid/s$round/r$index"); put("snippet", "Snippet $round-$index")
                    }) }) }.toString())
                }
            }
            backend.start()
            val target = backend.url("/fortieth").toString()
            // Five searches in two responses: the read and the report stay inside the member's six tool rounds.
            fun search(index: Int) = Triple("web_search", "q$index", buildJsonObject { put("query", "fixture query $index"); put("maxResults", 8) })
            val rounds = listOf(calls("chat-completions", (1..3).map(::search)), calls("chat-completions", (4..5).map(::search)))
            val routed = Routed("chat-completions", rounds + call("chat-completions", "fetch_url", "late", buildJsonObject { put("url", target) }) + final("chat-completions", "The fortieth result holds the answer."),
                final("chat-completions", "答案在第四十条结果里。来源 $target"), review("chat-completions", true, "job-1:late:source:0"))
            model.dispatcher = routed; model.start()
            val config = buildJsonObject { put("search", buildJsonObject { put("backend", "http"); put("endpoint", backend.url("/search").toString()); put("maxResults", 8) }) }
            val id = chat(model, config = config)
            val run = send(id, "搜索 fixture 资料并读最相关的一条")
            val read = routed.of("member").last()
            assertFalse("the fortieth URL was returned by this run's own search", read.contains("FETCH_URL_NOT_IN_EVIDENCE"))
            assertTrue(read.contains("The fortieth result holds the answer the member needs"))
            assertEquals(run.error, "completed", run.status); assertEquals(5, searches.get())
        } }
    }

    @Test fun aLongChinesePageIsReadInPartsAndDownloadedOnce() = runBlocking {
        MockWebServer().use { model -> MockWebServer().use { backend ->
            val sentence = "明天墨尔本多云转晴，气温十五到十九度。"
            val page = sentence.repeat(600) + "结尾处的降雨概率为百分之十。"
            backend.dispatcher = Pages(0) { page }; backend.start()
            val url = backend.url("/forecast").toString()
            val routed = Routed("chat-completions", listOf(
                call("chat-completions", "fetch_url", "p1", buildJsonObject { put("url", url) }),
                call("chat-completions", "fetch_url", "p2", buildJsonObject { put("url", url); put("offset", 7000) }),
                final("chat-completions", "降雨概率为百分之十。")), final("chat-completions", "明天降雨概率为百分之十。来源 $url"), review("chat-completions", true, "job-1:p2:source:0"))
            model.dispatcher = routed; model.start()
            val id = chat(model)
            val run = send(id, "读一下 $url 里明天的降雨概率")
            assertEquals(run.error, "completed", run.status)
            fun result(body: String, callId: String) = MeloJson.parseToJsonElement(MeloJson.parseToJsonElement(body).jsonObject.getValue("messages").jsonArray.map { it.jsonObject }.first { it.text("tool_call_id") == callId }.text("content")).jsonObject
            val first = result(routed.of("member")[1], "p1")
            assertEquals(7000, first.text("text").length); assertEquals(7000, first["nextOffset"]?.jsonPrimitive?.intOrNull); assertEquals(page.length, first["length"]?.jsonPrimitive?.intOrNull)
            assertEquals(true, first["truncated"]?.jsonPrimitive?.booleanOrNull); assertFalse(first.text("text").contains("降雨概率"))
            val second = result(routed.of("member")[2], "p2")
            assertEquals(7000, second["offset"]?.jsonPrimitive?.intOrNull); assertNull(second["nextOffset"]); assertTrue(second.text("text").endsWith("结尾处的降雨概率为百分之十。"))
            assertEquals(page, first.text("text") + second.text("text"))
            assertEquals("the second part reuses the body loaded for this reply", 1, backend.requestCount)
            // The fetch_url definition tells the model how to read on.
            assertTrue(routed.of("member").first().contains("nextOffset"))
            val summaries = run.sharedScene!!.getValue("operations").jsonArray.map { it.jsonObject.text("resultSummary") }
            assertTrue(summaries.toString(), summaries.any { it.contains("第 1–7000 字符") && it.contains("其余可续读") } && summaries.any { it.contains("第 7001–") && !it.contains("其余可续读") })
        } }
    }

    @Test fun aSlowSearchBackendIsOneFailedLookupNotTheEndOfTheRun() = runBlocking {
        MockWebServer().use { model -> MockWebServer().use { backend ->
            val routed = Routed("chat-completions", listOf(tool("chat-completions"), final("chat-completions", "The search backend did not answer in time.")), final("chat-completions", "检索服务超时，未取得结果。"), review("chat-completions"))
            model.dispatcher = routed; model.start()
            backend.enqueue(MockResponse().setBody("""{"results":[]}""").setBodyDelay(8, TimeUnit.SECONDS)); backend.start()
            val config = buildJsonObject { put("search", buildJsonObject { put("backend", "http"); put("endpoint", backend.url("/search").toString()); put("timeoutMs", 3000) }) }
            val id = chat(model, config = config)
            val run = send(id, "搜索 Surry Hills 餐厅")
            // The member receives the timeout as a tool result and reports it; nothing treats it as the run deadline.
            assertTrue(routed.of("member")[1].contains("SEARCH_TIMEOUT"))
            val completion = run.sharedScene!!.getValue("completion").jsonObject
            assertNotEquals("LIMIT_DELIVERED", completion.text("reason")); assertNotEquals("budget_exhausted", run.status)
            assertEquals(run.error, "blocked", run.status); assertTrue(run.partial.contains("检索服务超时"))
            assertEquals(5, model.requestCount); assertEquals(2, routed.of("member").size)
            // The member wrote its own report; it was not cut off as if its allowance had run out.
            val handoff = routed.of("lead").last().let { body -> body.substring(maxOf(0, body.indexOf("memberReport") - 400), minOf(body.length, body.indexOf("memberReport") + 300)) }
            assertTrue(handoff, handoff.contains("did not answer in time")); assertFalse(handoff, handoff.contains("GOAL_INCOMPLETE"))
        } }
    }

    @Test fun anAddressTheBuildMayNotOpenFailsOneReadAndTheReplyContinues() = runBlocking {
        MockWebServer().use { model ->
            val address = "http://example.invalid/page"
            val routed = Routed("chat-completions", listOf(call("chat-completions", "fetch_url", "h1", buildJsonObject { put("url", address) }), final("chat-completions", "This address cannot be read on the phone.")),
                final("chat-completions", "这个地址不是 HTTPS，手机无法直接读取。"), review("chat-completions"))
            model.dispatcher = routed; model.start()
            val id = chat(model)
            val run = send(id, "读一下 $address 讲了什么")
            assertTrue(routed.of("member")[1].contains("FETCH_URL_UNSUPPORTED"))
            assertNotEquals("failed", run.status); assertTrue(run.partial.contains("手机无法直接读取")); assertEquals(5, model.requestCount)
        }
    }

    // With batches allowed on every protocol the lead may send two assignments at once (the router
    // description invites research plus social). They are refused with the rule, not as an unknown tool.
    @Test fun twoAssignmentsInOneResponseAreToldTheOneCallRuleAndTheNextSingleOneRuns() = runBlocking {
        MockWebServer().use { model -> MockWebServer().use { backend ->
            backend.dispatcher = Pages(0) { "Fixture page with the forecast: nineteen degrees and partly cloudy tomorrow in the city." }; backend.start()
            val url = backend.url("/forecast").toString()
            val bodies = java.util.concurrent.CopyOnWriteArrayList<String>(); var lead = 0; var member = 0
            model.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val body = request.body.readUtf8(); bodies += body
                    fun route(id: String, role: String) = Triple("route_task", id, buildJsonObject { put("role", role); put("task", "Read $url") })
                    return when {
                        body.contains("task completion checker") -> review("chat-completions", true, "job-1:w1:source:0")
                        body.contains("internal research specialist") -> if (member++ == 0) call("chat-completions", "fetch_url", "w1", buildJsonObject { put("url", url) }) else final("chat-completions", "19 degrees, partly cloudy.")
                        else -> when (lead++) { 0 -> calls("chat-completions", listOf(route("both-a", "research"), route("both-b", "social"))); 1 -> calls("chat-completions", listOf(route("single", "research"))); else -> final("chat-completions", "明天多云，最高 19 度。来源 $url") }
                    }
                }
            }
            model.start()
            val id = chat(model)
            val run = send(id, "读一下 $url 明天的天气")
            assertEquals(run.error, "completed", run.status)
            val second = bodies.filter { !it.contains("task completion checker") && !it.contains("internal research specialist") }[1]
            assertTrue(second.contains("ROUTE_DENIED")); assertTrue(second.contains("one call per response"))
            assertFalse("no misleading prerequisite hint", second.contains("请先完成前置检索")); assertFalse(second.contains("UNKNOWN_TOOL"))
            assertEquals("the page is read once, by the single assignment that followed", 1, backend.requestCount)
        } }
    }

    @Test fun theAnswerIsVisibleWhileItIsCheckedAndAMemberReportNeverIs() = runBlocking {
        MockWebServer().use { model -> MockWebServer().use { backend ->
            backend.dispatcher = Pages(400) { "Fixture page with the forecast: nineteen degrees and partly cloudy tomorrow in the city." }; backend.start()
            val url = backend.url("/forecast").toString()
            val answer = "明天多云，最高 19 度。来源 $url"
            val routed = Routed("chat-completions", listOf(call("chat-completions", "fetch_url", "v1", buildJsonObject { put("url", url) }), final("chat-completions", "MEMBER-REPORT-MARKER 19 degrees").setBodyDelay(700, TimeUnit.MILLISECONDS)),
                final("chat-completions", answer), review("chat-completions", true, "job-1:v1:source:0").setBodyDelay(1500, TimeUnit.MILLISECONDS))
            model.dispatcher = routed; model.start()
            val id = chat(model)
            val seen = java.util.concurrent.CopyOnWriteArrayList<Pair<String, String>>()
            val watcher = launch(Dispatchers.Default) { app.engine.runtime.collect { state -> state.turns[id]?.let { seen += it.partial to it.phase } } }
            val run = send(id, "读一下 $url 明天的天气")
            watcher.cancelAndJoin()
            assertEquals(run.error, "completed", run.status)
            assertTrue("a member's report is never shown as the answer", seen.none { it.first.contains("MEMBER-REPORT-MARKER") })
            assertTrue("only the lead's answer is ever shown: " + seen.map { it.first }.distinct(), seen.all { it.first.isEmpty() || it.first == answer })
            assertTrue("the answer is on screen while the check runs", seen.any { it.first == answer && it.second == "正在核对回答是否完成…" })
            assertTrue(seen.any { it.second == "正在核对来源网页…" })
        } }
    }
}
