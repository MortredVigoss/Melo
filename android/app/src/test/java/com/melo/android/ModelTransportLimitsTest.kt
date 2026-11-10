package com.melo.android

import com.melo.android.data.*
import com.melo.android.device.*
import com.melo.android.network.ModelRequestFailure
import com.melo.android.network.ToolStreamDecoder
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

// 2026-11-10 follow-up to the Agent audit (Android items 1 and 4): what a chat request asks of the
// provider and how a reply that did not end normally is read. The rules mirror the desktop host:
// src/shared/fastGeneration.js (output-limit field), src/openai.js createApiResponsesReply (no fixed
// cap on Responses), src/tools/functionSchema.js (argument size, "" as no arguments).
class ModelTransportLimitsTest {
    private val protocols = listOf("chat-completions", "responses", "anthropic")
    private fun tool(name: String) = buildJsonObject { put("name", name); put("description", "fixture"); put("parameters", buildJsonObject { put("type", "object") }) }
    private fun json(value: String) = MeloJson.parseToJsonElement(value).jsonObject

    // OpenAI's reasoning models reject `max_tokens`; the limit write-up and its check carried it on every host.
    @Test fun theOutputLimitFieldFollowsTheDesktopRule() = runBlocking {
        fun chat(endpoint: String, capabilities: JsonObject = buildJsonObject {}) = Connection(endpoint = endpoint, model = "m", protocol = "chat-completions", modelCapabilities = capabilities)
        assertEquals("max_completion_tokens", DeviceAgentClient.outputLimitField(chat("https://api.openai.com/v1/chat/completions")))
        assertEquals("max_tokens", DeviceAgentClient.outputLimitField(chat("https://api.deepseek.com/chat/completions")))
        assertEquals("max_tokens", DeviceAgentClient.outputLimitField(chat("https://openrouter.ai/api/v1/chat/completions")))
        // A connection that declares its field wins over the host rule, either way.
        val declared = buildJsonObject { put("m", buildJsonObject { put("outputTokenParameter", "max_completion_tokens") }) }
        assertEquals("max_completion_tokens", DeviceAgentClient.outputLimitField(chat("https://example.invalid/v1/chat/completions", declared)))
        assertEquals("max_tokens", DeviceAgentClient.outputLimitField(chat("https://api.openai.com/v1/chat/completions", buildJsonObject { put("m", buildJsonObject { put("outputTokenParameter", "max_tokens") }) })))
        assertEquals("max_tokens", DeviceAgentClient.outputLimitField(chat("https://example.invalid/v1/chat/completions", buildJsonObject { put("m", buildJsonObject { put("outputTokenParameter", "anything") }) })))
        assertEquals("max_output_tokens", DeviceAgentClient.outputLimitField(Connection(protocol = "responses", model = "m")))
        assertEquals("max_tokens", DeviceAgentClient.outputLimitField(Connection(protocol = "anthropic", model = "m")))
        // On the wire: the declared field carries the limit and the other one is absent.
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("""{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]}""")); server.start()
            DeviceAgentClient(true).next(chat(server.url("/model").toString(), declared), "fixture", listOf(buildJsonObject { put("role", "user"); put("content", "check") }), "checker", true, emptyList(), outputLimit = 2048)
            val sent = json(server.takeRequest(1, TimeUnit.SECONDS)!!.body.readUtf8())
            assertEquals(2048, sent.getValue("max_completion_tokens").jsonPrimitive.int); assertNull(sent["max_tokens"])
        }
    }

    // A request's own limit replaced the rule of its base request: 8192 on a model whose whole output share is 4000.
    @Test fun aRequestsOwnLimitNeverExceedsTheModelsOutputShare() {
        fun limit(connection: Connection, wanted: Int, device: Boolean = false): Int {
            val base = if (device) DeviceAgentClient.payload(connection, DeviceAgentClient.initial(connection.protocol, "goal")) else DeviceAgentClient.payload(connection, emptyList(), "writer", chatTools = true, toolSpecs = emptyList())
            return DeviceAgentClient.limited(connection, base, wanted).getValue(DeviceAgentClient.outputLimitField(connection)).jsonPrimitive.int
        }
        for (protocol in protocols) {
            val large = Connection(protocol = protocol, model = "m", contextTokens = 200_000); val small = Connection(protocol = protocol, model = "m", contextTokens = 12_000)
            assertEquals(protocol, 8192, limit(large, 8192)); assertEquals(protocol, 2048, limit(large, 2048))
            assertEquals("$protocol small model", 4000, limit(small, 8192)); assertEquals(protocol, 2048, limit(small, 2048))
        }
        // No limit asked: the request is the base request.
        val connection = Connection(protocol = "chat-completions", model = "m")
        val base = DeviceAgentClient.payload(connection, emptyList(), "writer", chatTools = true, toolSpecs = emptyList())
        assertSame(base, DeviceAgentClient.limited(connection, base, null)); assertNull(base["max_tokens"]); assertNull(base["max_completion_tokens"])
    }

    // On Responses the cap also counts reasoning: at 8000 a reasoning model ran out before it had written its answer.
    @Test fun aChatRequestOnResponsesCarriesNoFixedOutputCapAndADeviceStepKeepsIts() {
        val connection = Connection(protocol = "responses", model = "m", contextTokens = 200_000)
        assertNull(DeviceAgentClient.payload(connection, emptyList(), "lead", chatTools = true, toolSpecs = listOf(tool("route_task")))["max_output_tokens"])
        assertNull(DeviceAgentClient.payload(connection, emptyList(), "checker", chatTools = true, toolSpecs = emptyList())["max_output_tokens"])
        assertEquals(8000, DeviceAgentClient.payload(connection, DeviceAgentClient.initial("responses", "goal")).getValue("max_output_tokens").jsonPrimitive.int)
        assertEquals(4000, DeviceAgentClient.payload(connection.copy(contextTokens = 12_000), DeviceAgentClient.initial("responses", "goal")).getValue("max_output_tokens").jsonPrimitive.int)
    }

    // "" is how compatible servers send a call without arguments; 12 000 characters was sized for one device action.
    @Test fun aCallWithoutArgumentsAndACitedBatchAreBothValidChatCalls() {
        val names = setOf("todo_list", "task_progress")
        val empty = mapOf(
            "chat-completions" to """{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"id":"c1","type":"function","function":{"name":"todo_list","arguments":""}}]}}]}""",
            "responses" to """{"status":"completed","output":[{"type":"function_call","call_id":"c1","name":"todo_list","arguments":""}]}""")
        for ((protocol, body) in empty) {
            val call = DeviceAgentClient.decode(json(body), protocol, toolNames = names).calls.single()
            assertEquals(protocol, "todo_list", call.name); assertTrue(protocol, call.arguments.isEmpty())
        }
        val batch = buildJsonObject { put("action", "batch"); put("data", "x".repeat(30_000)) }.toString()
        fun chat(arguments: String) = buildJsonObject { put("choices", buildJsonArray { add(buildJsonObject { put("finish_reason", "tool_calls"); put("message", buildJsonObject { put("role", "assistant"); put("tool_calls", buildJsonArray { add(buildJsonObject { put("id", "c1"); put("type", "function"); put("function", buildJsonObject { put("name", "task_progress"); put("arguments", arguments) }) }) }) }) }) }) }
        assertEquals(30_000, DeviceAgentClient.decode(chat(batch), "chat-completions", toolNames = names).calls.single().arguments.text("data").length)
        // The bound is the desktop one; past it the request still fails closed.
        assertTrue(runCatching { DeviceAgentClient.decode(chat("{\"data\":\"" + "x".repeat(ToolStreamDecoder.MAX_ARGUMENT_CHARS) + "\"}"), "chat-completions", toolNames = names) }.isFailure)
        // A device step keeps its small bound.
        val device = buildJsonObject { put("choices", buildJsonArray { add(buildJsonObject { put("finish_reason", "tool_calls"); put("message", buildJsonObject { put("role", "assistant"); put("tool_calls", buildJsonArray { add(buildJsonObject { put("id", "c1"); put("type", "function"); put("function", buildJsonObject { put("name", "android_device"); put("arguments", "{\"action\":\"observe\",\"note\":\"" + "x".repeat(12_000) + "\"}") }) }) }) }) }) }) }
        assertTrue(runCatching { DeviceAgentClient.decode(device, "chat-completions") }.isFailure)
        // Streamed: the same batch arrives in fragments.
        val decoder = ToolStreamDecoder("chat-completions")
        decoder.accept("""{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"task_progress","arguments":""}}]},"finish_reason":null}]}""")
        for (part in batch.chunked(4_000)) decoder.accept(buildJsonObject { put("choices", buildJsonArray { add(buildJsonObject { put("index", 0); put("delta", buildJsonObject { put("tool_calls", buildJsonArray { add(buildJsonObject { put("index", 0); put("function", buildJsonObject { put("arguments", part) }) }) }) }) }) }) }.toString())
        decoder.accept("""{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"""); decoder.accept("[DONE]")
        assertEquals(30_000, DeviceAgentClient.decode(decoder.finish(), "chat-completions", toolNames = names).calls.single().arguments.text("data").length)
    }

    private val truncated = mapOf(
        "chat-completions" to """{"choices":[{"finish_reason":"length","message":{"role":"assistant","content":"The answer starts and then"}}]}""",
        "responses" to """{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"The answer starts and then"}]}]}""",
        "anthropic" to """{"stop_reason":"max_tokens","content":[{"type":"text","text":"The answer starts and then"}]}""")
    private val declined = mapOf(
        "chat-completions" to """{"choices":[{"finish_reason":"content_filter","message":{"role":"assistant","content":""}}]}""",
        "responses" to """{"status":"incomplete","incomplete_details":{"reason":"content_filter"},"output":[]}""",
        "anthropic" to """{"stop_reason":"refusal","content":[]}""")

    // Both used to read "模型未返回完整、有效的 Tool Calling 回执，请检查模型及接口协议": advice for a fault no setting causes.
    @Test fun aReplyCutAtItsLimitOrDeclinedFailsWithWhatHappened() = runBlocking {
        for ((cases, code) in listOf(truncated to "MODEL_OUTPUT_TRUNCATED", declined to "MODEL_REFUSED")) for ((protocol, body) in cases) MockWebServer().use { server ->
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(body)); server.start()
            val error = runCatching { DeviceAgentClient(true).next(Connection(endpoint = server.url("/model").toString(), model = "fixture", protocol = protocol, stream = false), "fixture", emptyList(), "lead", true, listOf(tool("route_task"))) }.exceptionOrNull()
            assertTrue("$protocol $code: $error", error is ModelRequestFailure); error as ModelRequestFailure
            assertEquals(protocol, code, error.code)
            assertFalse("$protocol: not presented as a protocol fault", error.message.orEmpty().contains("接口协议") && code == "MODEL_OUTPUT_TRUNCATED")
            assertFalse("the partial text is never used", error.message.orEmpty().contains("The answer starts"))
            assertEquals(1, server.requestCount)
        }
        // A stop reason nobody knows is still an invalid response.
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("""{"choices":[{"finish_reason":"mystery","message":{"role":"assistant","content":"x"}}]}""")); server.start()
            val error = runCatching { DeviceAgentClient(true).next(Connection(endpoint = server.url("/model").toString(), model = "fixture", stream = false), "fixture", emptyList(), "lead", true, listOf(tool("route_task"))) }.exceptionOrNull() as ModelRequestFailure
            assertEquals("MODEL_RESPONSE_INVALID", error.code)
        }
    }

    // The same replies when they arrive as a stream.
    @Test fun aStreamedReplyCutAtItsLimitFailsWithWhatHappened() = runBlocking {
        val streams = mapOf(
            "chat-completions" to listOf(
                """{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"task_progress","arguments":"{\"action\":\"batch\",\"data\":\"{\\\"items\\\":["}}]},"finish_reason":null}]}""",
                """{"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}""", "[DONE]"),
            "responses" to listOf(
                """{"type":"response.output_text.delta","delta":"The answer starts"}""",
                """{"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]}}"""),
            "anthropic" to listOf(
                """{"type":"message_start","message":{"model":"fixture","usage":{"input_tokens":7}}}""",
                """{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c1","name":"task_progress","input":{}}}""",
                """{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"action\":\"batch\",\"data\":\"{"}}""",
                """{"type":"content_block_stop","index":0}""",
                """{"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":8192}}""",
                """{"type":"message_stop"}"""))
        for ((protocol, frames) in streams) MockWebServer().use { server ->
            server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(frames.joinToString("") { "data: $it\n\n" })); server.start()
            val error = runCatching { DeviceAgentClient(true).next(Connection(endpoint = server.url("/model").toString(), model = "fixture", protocol = protocol, stream = true), "fixture", emptyList(), "lead", true, listOf(tool("task_progress"))) }.exceptionOrNull()
            assertTrue("$protocol: $error", error is ModelRequestFailure); assertEquals(protocol, "MODEL_OUTPUT_TRUNCATED", (error as ModelRequestFailure).code)
        }
        // A broken tool input on a reply that ended normally is still an invalid response, never a call.
        val decoder = ToolStreamDecoder("anthropic")
        listOf("""{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c1","name":"task_progress","input":{}}}""",
            """{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"action\":"}}""",
            """{"type":"content_block_stop","index":0}""", """{"type":"message_delta","delta":{"stop_reason":"tool_use"}}""", """{"type":"message_stop"}""").forEach(decoder::accept)
        val broken = runCatching { decoder.finish() }.exceptionOrNull()
        assertNotNull(broken); assertFalse(broken is ModelRequestFailure)
    }

    // A reply that ended normally and carries the model's refusal is a reply; it failed as "no tool and no answer".
    @Test fun aRefusalThatArrivesCleanlyIsTheAnswer() {
        val words = "I can't help with that request."
        val chat = DeviceAgentClient.decode(json("""{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":null,"refusal":"$words"}}]}"""), "chat-completions", toolNames = setOf("route_task"))
        assertEquals(words, chat.text); assertTrue(chat.calls.isEmpty())
        val responses = DeviceAgentClient.decode(json("""{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"refusal","refusal":"$words"}]}]}"""), "responses", toolNames = setOf("route_task"))
        assertEquals(words, responses.text)
        // Content wins when both are present, and a reply with neither is still not an answer.
        assertEquals("answer", DeviceAgentClient.decode(json("""{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"answer","refusal":null}}]}"""), "chat-completions").text)
        assertTrue(runCatching { DeviceAgentClient.decode(json("""{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":null,"refusal":null}}]}"""), "chat-completions") }.isFailure)
        // Streamed in fragments.
        val decoder = ToolStreamDecoder("chat-completions")
        decoder.accept("""{"choices":[{"index":0,"delta":{"refusal":"I can't help "},"finish_reason":null}]}""")
        decoder.accept("""{"choices":[{"index":0,"delta":{"refusal":"with that request."},"finish_reason":null}]}""")
        decoder.accept("""{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"""); decoder.accept("[DONE]")
        assertEquals(words, DeviceAgentClient.decode(decoder.finish(), "chat-completions", toolNames = setOf("route_task")).text)
    }
}
