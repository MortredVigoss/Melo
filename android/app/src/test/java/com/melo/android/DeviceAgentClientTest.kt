package com.melo.android

import com.melo.android.data.*
import com.melo.android.device.*
import com.melo.android.network.ModelRequestFailure
import com.melo.android.network.SharedSearchAdapter
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

class DeviceAgentClientTest {
    @Test fun oversizedAgentContextIsRejectedBeforeMakingAProviderRequest() {
        val error = runCatching { DeviceAgentClient.payload(Connection(model = "fixture"), DeviceAgentClient.initial("chat-completions", "goal"), "x".repeat(32_001)) }.exceptionOrNull()
        assertNotNull(error); assertTrue(error!!.message.orEmpty().contains("预算"))
    }
    @Test fun anthropicDeviceTransportRequestsOneSerialToolButChatKeepsBatches() {
        val c = Connection(model = "claude-opus", protocol = "anthropic")
        val device = DeviceAgentClient.payload(c, DeviceAgentClient.initial(c.protocol, "goal"))
        assertEquals("auto", device["tool_choice"]?.jsonObject?.text("type"))
        assertEquals(true, device["tool_choice"]?.jsonObject?.get("disable_parallel_tool_use")?.jsonPrimitive?.booleanOrNull)
        val chat = DeviceAgentClient.payload(c, emptyList(), chatTools = true)
        assertNull(chat["tool_choice"])
    }
    @Test fun appDiscoveryToolSupportsSearchingAndCompletePagination() {
        val properties = DeviceTools.schema["properties"]!!.jsonObject
        for (name in listOf("query", "browse", "offset", "limit")) assertTrue("Missing discovery argument $name", name in properties)
        DeviceTools.validate(buildJsonObject { put("action", "list_apps"); put("query", "炉石"); put("offset", 200); put("limit", 10) })
        for (value in listOf(-1, 0, 201)) assertTrue(runCatching {
            DeviceTools.validate(buildJsonObject { put("action", "list_apps"); put("limit", value) })
        }.isFailure)
        assertTrue(runCatching { DeviceTools.validate(buildJsonObject { put("action", "list_apps"); put("offset", -1) }) }.isFailure)
        assertTrue(runCatching { DeviceTools.validate(buildJsonObject { put("action", "list_apps"); put("query", "x".repeat(161)) }) }.isFailure)
    }
    @Test fun appDiscoveryRequiresTargetedQueryUnlessInventoryBrowsingIsExplicit() {
        for (query in listOf("", "   ")) assertTrue(runCatching {
            DeviceTools.validate(buildJsonObject { put("action", "list_apps"); put("query", query); put("limit", 200) })
        }.isFailure)
        for (limit in listOf(1, 10, 20)) DeviceTools.validate(buildJsonObject { put("action", "list_apps"); put("query", "Fixture"); put("limit", limit) })
        assertTrue(runCatching { DeviceTools.validate(buildJsonObject { put("action", "list_apps"); put("query", "Fixture"); put("limit", 200) }) }.isFailure)
        DeviceTools.validate(buildJsonObject { put("action", "list_apps"); put("browse", true); put("limit", 200) })
        for (invalid in listOf(JsonPrimitive("true"), JsonPrimitive(1), JsonNull)) assertTrue(runCatching {
            DeviceTools.validate(buildJsonObject { put("action", "list_apps"); put("browse", invalid) })
        }.isFailure)
        assertTrue(runCatching { DeviceTools.validate(buildJsonObject { put("action", "observe"); put("browse", true) }) }.isFailure)
        assertTrue(runCatching { DeviceTools.validate(buildJsonObject { put("action", "open_app") }) }.isFailure)
    }
    @Test fun proxyFinalReplyWithExplicitNullToolCallsIsACompletedAnswer() {
        val value = MeloJson.parseToJsonElement("""{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"已打开设置。","reasoning_content":"","tool_calls":null}}]}""").jsonObject
        val result = DeviceAgentClient.decode(value, "chat-completions")
        assertEquals("已打开设置。", result.text)
        assertTrue(result.calls.isEmpty())
    }
    private val protocols = listOf("chat-completions", "responses", "anthropic")
    private fun call(protocol: String, action: String = "observe") = when (protocol) {
        "responses" -> """{"status":"completed","output":[{"type":"function_call","id":"fc_1","call_id":"call_1","name":"android_device","arguments":"{\"action\":\"$action\"}"}]}"""
        "anthropic" -> """{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"call_1","name":"android_device","input":{"action":"$action"}}]}"""
        else -> """{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"android_device","arguments":"{\"action\":\"$action\"}"}}]}}]}"""
    }
    private fun final(protocol: String) = when (protocol) {
        "responses" -> """{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"已完成"}]}]}"""
        "anthropic" -> """{"stop_reason":"end_turn","content":[{"type":"text","text":"已完成"}]}"""
        else -> """{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"已完成","tool_calls":null}}]}"""
    }
    @Test fun eachNativeProtocolPerformsARealHttpToolRoundTripWithScreenshot() = runBlocking {
        for (protocol in protocols) MockWebServer().use { server ->
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(call(protocol)))
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(final(protocol))); server.start()
            val connection = Connection(endpoint = server.url("/tools").toString(), model = "fixture-model", protocol = protocol)
            val history = DeviceAgentClient.initial(protocol, "观察当前屏幕")
            val client = DeviceAgentClient(true)
            val turn = client.next(connection, "fixture-not-a-real-key", history)
            assertEquals("observe", turn.calls.single().arguments.text("action"))
            history += turn.wire
            DeviceAgentClient.appendResult(history, protocol, turn.calls.single(), DeviceToolResult(buildJsonObject { put("ok", true); put("screen_id", "screen-fixture"); put("nodes", JsonArray(emptyList())) }, "aW1hZ2U="))
            assertEquals("已完成", client.next(connection, "fixture-not-a-real-key", history).text)
            val first = MeloJson.parseToJsonElement(server.takeRequest(1, TimeUnit.SECONDS)!!.body.readUtf8()).jsonObject
            assertEquals(connection.stream, first["stream"]!!.jsonPrimitive.boolean)
            assertEquals(1, first["tools"]!!.jsonArray.size)
            val second = server.takeRequest(1, TimeUnit.SECONDS)!!
            val body = second.body.readUtf8()
            assertTrue(body.contains("call_1")); assertTrue(body.contains("screen-fixture")); assertTrue(body.contains("aW1hZ2U="))
            assertFalse(body.contains("fixture-not-a-real-key"))
            when (protocol) {
                "responses" -> assertTrue(body.contains("function_call_output"))
                "anthropic" -> assertTrue(body.contains("tool_use_id"))
                else -> assertTrue(body.contains("tool_call_id"))
            }
        }
    }
    @Test fun missingUsageEstimateDoesNotChargeBase64AsMillionsOfTextTokens() {
        val pixels = "a".repeat(2_000_000)
        for (type in listOf("input_image", "image_url", "image")) {
            val history = listOf(buildJsonObject { put("role", "user"); put("content", buildJsonArray {
                add(buildJsonObject { put("type", "text"); put("text", "观察当前画面") })
                add(buildJsonObject { put("type", type); put("image_url", "data:image/jpeg;base64,$pixels") })
            }) })
            val estimate = com.melo.android.core.SharedRunBudget.estimateInput(history, "instructions")
            assertTrue(estimate in 2000L..4000L)
        }
    }
    @Test fun genericChatAdmits32CallsAndUsageButDeviceActionsStaySingle() {
        fun batch(size: Int) = buildJsonObject {
            put("status", "completed"); put("usage", buildJsonObject { put("input_tokens", 123) })
            put("output", buildJsonArray { repeat(size) { i -> add(buildJsonObject {
                put("type", "function_call"); put("call_id", "c$i"); put("name", if (i == 0) "unknown" else "web_search"); put("arguments", "{\"query\":\"test\"}")
            }) } })
        }
        val result = DeviceAgentClient.decode(batch(32), "responses", toolNames = setOf("web_search"))
        assertEquals(32, result.calls.size); assertEquals(123L, result.inputTokens)
        assertTrue(runCatching { DeviceAgentClient.decode(batch(33), "responses", toolNames = setOf("web_search")) }.isFailure)
        assertTrue(runCatching { DeviceAgentClient.decode(batch(2), "responses") }.isFailure)
    }

    @Test fun oldScreenImagesAreRemovedWhileToolReceiptsRemain() {
        for (protocol in protocols) {
            val history = DeviceAgentClient.initial(protocol, "fixture")
            for (i in 1..3) DeviceAgentClient.appendResult(history, protocol, DeviceCall("call_$i", "android_device", buildJsonObject { put("action", "observe") }), DeviceToolResult(buildJsonObject { put("ok", true); put("screen_id", "screen_$i") }, "unique-pixels-$i"))
            val body = history.toString()
            assertFalse(body.contains("unique-pixels-1")); assertFalse(body.contains("unique-pixels-2")); assertTrue(body.contains("unique-pixels-3"))
            for (i in 1..3) assertTrue(body.contains("call_$i"))
            DeviceAgentClient.appendResult(history, protocol, DeviceCall("call_4", "android_device", buildJsonObject { put("action", "observe") }), DeviceToolResult(buildJsonObject { put("ok", true); put("screen_id", "screen_4"); put("screenshot_available", false) }))
            assertFalse(history.toString().contains("unique-pixels-3"))
        }
    }
    @Test fun unknownToolsParallelActionsAndIncompleteReceiptsAreRejected() {
        assertTrue(runCatching { DeviceAgentClient.decode(MeloJson.parseToJsonElement(final("chat-completions").replace("\"finish_reason\":\"stop\"", "\"finish_reason\":\"tool_calls\"")).jsonObject, "chat-completions") }.isFailure)
        val unknown = call("chat-completions").replace("android_device", "shell")
        assertTrue(runCatching { DeviceAgentClient.decode(MeloJson.parseToJsonElement(unknown).jsonObject, "chat-completions") }.isFailure)
        val parallel = """{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"id":"a","function":{"name":"android_device","arguments":"{}"}},{"id":"b","function":{"name":"android_device","arguments":"{}"}}]}}]}"""
        assertTrue(runCatching { DeviceAgentClient.decode(MeloJson.parseToJsonElement(parallel).jsonObject, "chat-completions") }.isFailure)
        for ((protocol, body) in listOf("chat-completions" to final("chat-completions").replace("stop", "length"), "responses" to final("responses").replace("completed", "incomplete"), "anthropic" to final("anthropic").replace("end_turn", "max_tokens"))) {
            assertTrue(runCatching { DeviceAgentClient.decode(MeloJson.parseToJsonElement(body).jsonObject, protocol) }.isFailure)
        }
    }
    @Test fun malformedMutationsNeedAnObservationAndUnknownParametersCannotReachExecutor() {
        for (action in listOf("tap", "type_text", "swipe", "back", "home")) assertTrue(runCatching { DeviceTools.validate(buildJsonObject { put("action", action) }) }.isFailure)
        assertTrue(runCatching { DeviceTools.validate(buildJsonObject { put("action", "shell"); put("command", "rm") }) }.isFailure)
        assertTrue(runCatching { DeviceTools.validate(buildJsonObject { put("action", "observe"); put("execute", "anything") }) }.isFailure)
        DeviceTools.validate(buildJsonObject { put("action", "type_text"); put("screen_id", "s"); put("node_id", "n1"); put("text", "中文输入") })
    }
    @Test fun cancellationClosesTheActualAgentHttpCall() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(final("chat-completions")).setBodyDelay(5, TimeUnit.SECONDS)); server.start()
            val work = launch { DeviceAgentClient(true).next(Connection(endpoint = server.url("/tools").toString(), model = "fixture"), "fixture", DeviceAgentClient.initial("chat-completions", "fixture")) }
            withContext(Dispatchers.IO) { server.takeRequest(2, TimeUnit.SECONDS) }
            withTimeout(1000) { work.cancelAndJoin() }; assertTrue(work.isCancelled)
        }
    }
    @Test fun malformedProviderBodiesNeverEnterThePersistedErrorMessage() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("{broken-json private-fixture-value")); server.start()
            val error = runCatching { DeviceAgentClient(true).next(Connection(endpoint = server.url("/tools").toString(), model = "fixture"), "fixture", DeviceAgentClient.initial("chat-completions", "fixture")) }.exceptionOrNull()
            assertNotNull(error); assertFalse(error!!.message.orEmpty().contains("private-fixture-value")); assertTrue(error.message.orEmpty().contains("Tool Calling"))
        }
    }
    @Test fun streamPreferenceIsRespectedForEveryProtocolAndToolCatalog() {
        for (protocol in protocols) for (stream in listOf(true, false)) {
            val value = DeviceAgentClient.payload(Connection(protocol = protocol, model = "fixture", stream = stream), emptyList(), chatTools = true, toolSpecs = emptyList())
            assertEquals(stream, value["stream"]!!.jsonPrimitive.boolean)
        }
    }
    private fun tool(name: String) = buildJsonObject { put("name", name); put("description", "fixture"); put("parameters", buildJsonObject { put("type", "object") }) }
    // 2026-11-10. The completion check and the limit write-up send no tools; such a request carries no tool fields.
    @Test fun aRequestWithoutToolsCarriesNoToolFieldsOnAnyProtocol() {
        for (protocol in protocols) {
            val value = DeviceAgentClient.payload(Connection(protocol = protocol, model = "fixture"), DeviceAgentClient.initial(protocol, "check"), "checker", chatTools = true, toolSpecs = emptyList())
            for (field in listOf("tools", "parallel_tool_calls", "tool_choice")) assertNull("$protocol $field", value[field])
        }
        // Hosted search is a tool: the request still lists it.
        val hosted = DeviceAgentClient.payload(Connection(protocol = "responses", model = "fixture"), emptyList(), chatTools = true, toolSpecs = emptyList(), nativeWebSearch = true)
        assertEquals("web_search", hosted.getValue("tools").jsonArray.single().jsonObject.text("type"))
    }
    // Phone steps stay one call per round. Any other chat round may batch independent calls on every
    // protocol; before, the two OpenAI protocols never could, so every page read cost a model round trip.
    @Test fun roundsWithoutPhoneToolsMayBatchCallsAndPhoneRoundsStaySerialOnEveryProtocol() {
        fun batches(protocol: String, specs: List<JsonObject>?, chat: Boolean = true): Boolean {
            val value = DeviceAgentClient.payload(Connection(protocol = protocol, model = "fixture"), DeviceAgentClient.initial(protocol, "goal"), chatTools = chat, toolSpecs = specs)
            return if (protocol == "anthropic") value["tool_choice"]?.jsonObject?.get("disable_parallel_tool_use")?.jsonPrimitive?.booleanOrNull != true
                else value.getValue("parallel_tool_calls").jsonPrimitive.boolean
        }
        for (protocol in protocols) {
            assertTrue(protocol, batches(protocol, listOf(tool("web_search"), tool("fetch_url"), tool("todo_list"))))
            for (phone in listOf("phone_action", "phone_workflow")) assertFalse("$protocol $phone", batches(protocol, listOf(tool("fetch_url"), tool(phone))))
            assertFalse("$protocol device transport", batches(protocol, null, chat = false))
        }
    }
    // 2026-11-10. The loop is stateless (store: false) and sends reasoning items back; without their
    // encrypted content the service answers "Item with id 'rs_…' not found" on the second request.
    @Test fun everyResponsesRequestAsksForEncryptedReasoningSoItsItemsCanBeSentBack() {
        val connection = Connection(protocol = "responses", model = "fixture")
        fun include(value: JsonObject) = value.getValue("include").jsonArray.map { it.jsonPrimitive.content }
        assertEquals(listOf("reasoning.encrypted_content"), include(DeviceAgentClient.payload(connection, DeviceAgentClient.initial("responses", "goal"), chatTools = true, toolSpecs = listOf(tool("web_search")))))
        assertEquals(listOf("reasoning.encrypted_content"), include(DeviceAgentClient.payload(connection, emptyList(), "checker", chatTools = true, toolSpecs = emptyList())))
        assertEquals(listOf("reasoning.encrypted_content"), include(DeviceAgentClient.payload(connection, DeviceAgentClient.initial("responses", "goal"))))
        assertEquals(listOf("reasoning.encrypted_content", "web_search_call.action.sources"), include(DeviceAgentClient.payload(connection, emptyList(), chatTools = true, toolSpecs = emptyList(), nativeWebSearch = true)))
        assertEquals(false, DeviceAgentClient.payload(connection, emptyList()).getValue("store").jsonPrimitive.boolean)
        // The reasoning item of a response travels back unchanged, encrypted content included.
        val response = MeloJson.parseToJsonElement("""{"status":"completed","output":[{"type":"reasoning","id":"rs_1","encrypted_content":"opaque","summary":[]},{"type":"function_call","call_id":"c1","name":"web_search","arguments":"{\"query\":\"x\"}"}]}""").jsonObject
        val turn = DeviceAgentClient.decode(response, "responses", toolNames = setOf("web_search"))
        val next = DeviceAgentClient.payload(connection, DeviceAgentClient.initial("responses", "goal") + turn.wire, chatTools = true, toolSpecs = listOf(tool("web_search")))
        assertTrue(next.getValue("input").jsonArray.any { it.jsonObject.text("type") == "reasoning" && it.jsonObject.text("encrypted_content") == "opaque" })
        // The other protocols carry no such field.
        for (protocol in listOf("chat-completions", "anthropic")) assertNull(DeviceAgentClient.payload(Connection(protocol = protocol, model = "fixture"), emptyList(), chatTools = true, toolSpecs = listOf(tool("web_search")))["include"])
    }
    // A chat answer on Anthropic may be as long as on the other hosts; a device step keeps its small cap.
    @Test fun aChatAnswerOnAnthropicMayUseTheSameLengthAsOtherHosts() {
        val connection = Connection(protocol = "anthropic", model = "fixture", contextTokens = 200_000)
        assertEquals(8192, DeviceAgentClient.payload(connection, emptyList(), chatTools = true, toolSpecs = listOf(tool("web_search"))).getValue("max_tokens").jsonPrimitive.int)
        assertEquals(4096, DeviceAgentClient.payload(connection, DeviceAgentClient.initial("anthropic", "goal")).getValue("max_tokens").jsonPrimitive.int)
        assertEquals(4000, DeviceAgentClient.payload(connection.copy(contextTokens = 12_000), emptyList(), chatTools = true, toolSpecs = emptyList()).getValue("max_tokens").jsonPrimitive.int)
    }
    // A picture sent without words: Anthropic rejects an empty text block, and the message stays in the chat.
    @Test fun anImageOnlyMessageCarriesNoEmptyTextPart() {
        val image = Attachment(name = "fixture.jpg", mime = "image/jpeg", file = "fixture.jpg")
        for (protocol in protocols) {
            val lone = com.melo.android.chat.ChatPhoneUse.history(listOf(Message(role = "user", content = "", attachments = listOf(image))), protocol) { "aW1hZ2U=" }.single().getValue("content").jsonArray
            assertEquals(protocol, 1, lone.size); assertTrue(lone.none { it.jsonObject.text("type") in setOf("text", "input_text") })
            val captioned = com.melo.android.chat.ChatPhoneUse.history(listOf(Message(role = "user", content = "这是什么？", attachments = listOf(image))), protocol) { "aW1hZ2U=" }.single().getValue("content").jsonArray
            assertEquals(2, captioned.size); assertEquals("这是什么？", captioned.first().jsonObject.text("text"))
            val blank = com.melo.android.chat.ChatPhoneUse.history(listOf(Message(role = "user", content = "  \n", attachments = listOf(image))), protocol) { "aW1hZ2U=" }.single().getValue("content").jsonArray
            assertEquals(1, blank.size)
        }
    }

    @Test fun aPageReadFailsAloneOnAnAddressThisBuildMayNotOpenAndALoadedPageIsReused() = runBlocking {
        val adapter = SharedSearchAdapter(true, okhttp3.OkHttpClient())
        fun args(url: String) = buildJsonObject { put("url", url) }
        // Plain http outside the debug fixture hosts: one failed read, not an exception that ends the reply.
        for (address in listOf("http://example.invalid/page", "https://user:secret@example.invalid/page")) {
            val refused = adapter.load(args(address), listOf(address))
            assertFalse(refused.ok); assertEquals(address, "FETCH_URL_UNSUPPORTED", refused.data.text("code"))
        }
        assertEquals("FETCH_URL_NOT_IN_EVIDENCE", adapter.load(args("https://example.invalid/other"), emptyList()).data.text("code"))
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setHeader("Content-Type", "text/plain").setBody("page body")); server.start()
            val page = server.url("/page").toString()
            assertEquals("page body", adapter.load(args(page), listOf(page)).data.text("body"))
            // Reading on (another offset) uses the body already loaded for this reply.
            assertEquals("page body", adapter.load(buildJsonObject { put("url", page); put("offset", 7000) }, listOf(page)).data.text("body"))
            assertEquals(1, server.requestCount)
            // A failed load is not kept: the next read asks again.
            server.enqueue(MockResponse().setResponseCode(503)); server.enqueue(MockResponse().setHeader("Content-Type", "text/plain").setBody("recovered"))
            val flaky = server.url("/flaky").toString()
            assertEquals("SEARCH_HTTP_503", adapter.load(args(flaky), listOf(flaky)).data.text("code"))
            assertEquals("recovered", adapter.load(args(flaky), listOf(flaky)).data.text("body"))
            assertEquals(3, server.requestCount)
        }
    }
    @Test fun pageLoadsRunSideBySideAndCancellingOneClosesItsRequest() = runBlocking {
        // The network half of a read never touches the shared Runtime, so several may be in flight together.
        MockWebServer().use { server ->
            val inFlight = java.util.concurrent.atomic.AtomicInteger(); val peak = java.util.concurrent.atomic.AtomicInteger()
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    peak.accumulateAndGet(inFlight.incrementAndGet(), ::maxOf)
                    try { Thread.sleep(400) } finally { inFlight.decrementAndGet() }
                    return MockResponse().setHeader("Content-Type", "text/plain").setBody("body of " + request.path)
                }
            }
            server.start()
            val adapter = SharedSearchAdapter(true, okhttp3.OkHttpClient())
            val urls = (1..3).map { server.url("/p$it").toString() }
            val started = System.nanoTime()
            val bodies = urls.map { url -> async(Dispatchers.IO) { adapter.load(buildJsonObject { put("url", url) }, urls) } }.awaitAll().map { it.data.text("body") }
            val elapsed = (System.nanoTime() - started) / 1_000_000
            assertEquals(listOf("body of /p1", "body of /p2", "body of /p3"), bodies)
            assertEquals("all three requests were in flight together", 3, peak.get())
            assertTrue("three 400 ms pages took $elapsed ms", elapsed < 1000)
        }
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setHeader("Content-Type", "text/plain").setBody("late").setBodyDelay(5, TimeUnit.SECONDS)); server.start()
            val url = server.url("/slow").toString()
            val read = async(Dispatchers.IO) { SharedSearchAdapter(true, okhttp3.OkHttpClient()).load(buildJsonObject { put("url", url) }, listOf(url)) }
            withContext(Dispatchers.IO) { assertNotNull(server.takeRequest(2, TimeUnit.SECONDS)) }
            withTimeout(1000) { read.cancelAndJoin() }; assertTrue(read.isCancelled)
        }
    }
    @Test fun httpGatewayErrorsKeepSafeStatusAndRequestIdWithoutProviderBody() = runBlocking {
        for (status in listOf(400, 401, 429, 504)) MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(status).setHeader("x-request-id", "fixture-request-1").setBody("private-provider-body fixture-not-a-real-key")); server.start()
            val error = runCatching { DeviceAgentClient(true).next(Connection(endpoint = server.url("/model").toString(), model = "fixture"), "fixture-not-a-real-key", emptyList()) }.exceptionOrNull()
            assertTrue(error is ModelRequestFailure); val failure = error as ModelRequestFailure
            assertEquals(status, failure.httpStatus); assertEquals("MODEL_HTTP_$status", failure.code); assertEquals("fixture-request-1", failure.requestId)
            assertTrue(failure.message!!.contains("HTTP $status")); assertFalse(failure.message!!.contains("private-provider-body")); assertFalse(failure.message!!.contains("fixture-not-a-real-key"))
            assertEquals(1, server.requestCount)
        }
    }
    @Test fun missingHeadersAndStalledBodiesHaveDifferentSafeTimeoutDiagnostics() = runBlocking {
        for (headers in listOf(false, true)) MockWebServer().use { server ->
            server.enqueue(if (headers) MockResponse().setBody("{}").setBodyDelay(600, TimeUnit.MILLISECONDS) else MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE)); server.start()
            val http = okhttp3.OkHttpClient.Builder().retryOnConnectionFailure(false).readTimeout(100, TimeUnit.MILLISECONDS).build()
            val error = runCatching { DeviceAgentClient(true, http).next(Connection(endpoint = server.url("/model").toString(), model = "fixture"), "fixture", emptyList()) }.exceptionOrNull() as ModelRequestFailure
            assertEquals("MODEL_TIMEOUT", error.code); assertEquals(if (headers) "reading-response" else "waiting-headers", error.phase)
            assertEquals(1, server.requestCount)
        }
    }
    @Test fun definitiveHttpErrorDoesNotWaitForAStalledProviderErrorBody() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(504).setBody("private-error-body").setBodyDelay(1, TimeUnit.SECONDS)); server.start()
            val http = okhttp3.OkHttpClient.Builder().readTimeout(100, TimeUnit.MILLISECONDS).build()
            val error = runCatching { DeviceAgentClient(true, http).next(Connection(endpoint = server.url("/model").toString(), model = "fixture"), "fixture", emptyList()) }.exceptionOrNull() as ModelRequestFailure
            assertEquals("MODEL_HTTP_504", error.code); assertEquals("http-response", error.phase)
        }
    }
}
