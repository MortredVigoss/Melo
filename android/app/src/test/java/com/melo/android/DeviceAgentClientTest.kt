package com.melo.android

import com.melo.android.data.*
import com.melo.android.device.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

class DeviceAgentClientTest {
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
            assertEquals(false, first["stream"]!!.jsonPrimitive.boolean)
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
}
