package com.melo.android

import com.melo.android.data.*
import com.melo.android.device.*
import com.melo.android.network.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

class ToolStreamDecoderTest {
    private val protocols = listOf("chat-completions", "responses", "anthropic")
    private fun frames(protocol: String): List<String> = when (protocol) {
        "responses" -> listOf(
            """{"type":"response.function_call_arguments.delta","delta":"{\"action\":\"observe\"}"}""",
            """{"type":"response.completed","response":{"model":"fixture-returned","status":"completed","usage":{"input_tokens":42},"output":[{"type":"function_call","id":"fc_1","call_id":"call_1","name":"phone_action","arguments":"{\"action\":\"observe\"}"}]}}""",
        )
        "anthropic" -> listOf(
            """{"type":"message_start","message":{"model":"fixture-returned","usage":{"input_tokens":42}}}""",
            """{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"phone_action","input":{}}}""",
            """{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"action\":"}}""",
            """{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"observe\"}"}}""",
            """{"type":"content_block_stop","index":0}""",
            """{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}""",
            """{"type":"message_stop"}""",
        )
        else -> listOf(
            """{"model":"fixture-returned","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"phone_action","arguments":"{\"action\":"}}]},"finish_reason":null}]}""",
            """{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"observe\"}"}}]},"finish_reason":null}]}""",
            """{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":42}}""",
            "[DONE]",
        )
    }
    private fun spec() = buildJsonObject { put("name", "phone_action"); put("description", "fixture"); put("parameters", buildJsonObject { put("type", "object") }) }

    @Test fun fragmentedToolsBecomeDispatchableOnlyAfterTheTerminalReceipt() {
        for (protocol in protocols) {
            val progress = mutableListOf<String>(); val decoder = ToolStreamDecoder(protocol, progress::add)
            val frames = frames(protocol)
            frames.dropLast(if (protocol == "chat-completions") 2 else 1).forEach(decoder::accept)
            assertTrue(runCatching { decoder.finish() }.isFailure)
            frames.takeLast(if (protocol == "chat-completions") 2 else 1).forEach(decoder::accept)
            val result = DeviceAgentClient.decode(decoder.finish(), protocol, toolNames = setOf("phone_action"))
            assertEquals("call_1", result.calls.single().id); assertEquals("observe", result.calls.single().arguments.text("action")); assertEquals(42L, result.inputTokens)
            assertTrue(progress.any { it.contains("工具参数") })
        }
    }
    @Test fun actualHttpSseIsParsedForAllProtocolsAndJsonFallbackStillWorks() = runBlocking {
        for (protocol in protocols) MockWebServer().use { server ->
            server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream; charset=utf-8").setBody(": heartbeat\n\n" + frames(protocol).joinToString("") { "data: $it\n\n" })); server.start()
            val progress = mutableListOf<String>()
            val result = DeviceAgentClient(true).next(Connection(endpoint = server.url("/model").toString(), model = "fixture", protocol = protocol, stream = true), "fixture", emptyList(), chatTools = true, toolSpecs = listOf(spec()), onProgress = progress::add)
            assertEquals("observe", result.calls.single().arguments.text("action")); assertTrue(progress.isNotEmpty())
            val req = server.takeRequest(1, TimeUnit.SECONDS)!!
            assertTrue(req.getHeader("Accept")!!.contains("text/event-stream")); assertEquals(true, MeloJson.parseToJsonElement(req.body.readUtf8()).jsonObject["stream"]!!.jsonPrimitive.boolean)
        }
    }
    @Test fun aDroppedOrInvalidStreamNeverReturnsAReadyToolCall() = runBlocking {
        for (protocol in protocols) MockWebServer().use { server ->
            val partial = frames(protocol).take(1).joinToString("") { "data: $it\n\n" }
            server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(partial)); server.start()
            val error = runCatching { DeviceAgentClient(true).next(Connection(endpoint = server.url("/model").toString(), model = "fixture", protocol = protocol), "fixture", emptyList(), toolSpecs = listOf(spec())) }.exceptionOrNull()
            assertTrue(error is ModelRequestFailure); assertEquals("MODEL_RESPONSE_INVALID", (error as ModelRequestFailure).code); assertEquals(1, server.requestCount)
        }
    }
    @Test fun signedThinkingIsPreservedOnTheWireWithoutBeingShownAsProgress() {
        val phases = mutableListOf<String>(); val decoder = ToolStreamDecoder("anthropic", phases::add)
        listOf(
            """{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}""",
            """{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"private-thinking-marker"}}""",
            """{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"opaque-signature"}}""",
            """{"type":"content_block_stop","index":0}""",
            """{"type":"content_block_start","index":1,"content_block":{"type":"text","text":"answer"}}""",
            """{"type":"content_block_stop","index":1}""",
            """{"type":"message_delta","delta":{"stop_reason":"end_turn"}}""",
            """{"type":"message_stop"}""",
        ).forEach(decoder::accept)
        val value = decoder.finish(); assertTrue(value.toString().contains("opaque-signature")); assertTrue(value.toString().contains("private-thinking-marker"))
        assertFalse(phases.toString().contains("private-thinking-marker")); assertEquals("answer", DeviceAgentClient.decode(value, "anthropic").text)
    }
    @Test fun terminalErrorAndOversizedArgumentsFailClosed() {
        for (protocol in protocols) assertTrue(runCatching { ToolStreamDecoder(protocol).accept("""{"error":{"message":"private-provider-data"}}""") }.isFailure)
        val decoder = ToolStreamDecoder("chat-completions")
        val value = buildJsonObject { put("choices", buildJsonArray { add(buildJsonObject {
            put("index", 0); put("delta", buildJsonObject { put("tool_calls", buildJsonArray { add(buildJsonObject { put("index", 0); put("function", buildJsonObject { put("arguments", "x".repeat(12_001)) }) }) }) })
        }) }) }
        assertTrue(runCatching { decoder.accept(value.toString()) }.isFailure)
    }
    @Test fun compatiblePrivateReasoningIsRetainedForTheNextWireRequestAndNeverDisplayed() {
        val phases = mutableListOf<String>(); val decoder = ToolStreamDecoder("chat-completions", phases::add)
        decoder.accept("""{"choices":[{"index":0,"delta":{"reasoning_content":"private-wire-marker"},"finish_reason":null}]}""")
        frames("chat-completions").forEach(decoder::accept)
        val turn = DeviceAgentClient.decode(decoder.finish(), "chat-completions", toolNames = setOf("phone_action"))
        assertTrue(turn.wire.toString().contains("private-wire-marker")); assertFalse(turn.text.contains("private-wire-marker")); assertFalse(phases.toString().contains("private-wire-marker"))
    }
    @Test fun cancellationAfterStreamHeadersClosesTheCallInsteadOfReturningItsTool() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(frames("chat-completions").joinToString("") { "data: $it\n\n" }).setBodyDelay(3, TimeUnit.SECONDS)); server.start()
            var returned = false
            val connected = CompletableDeferred<Unit>()
            val job = launch { DeviceAgentClient(true).next(Connection(endpoint = server.url("/model").toString(), model = "fixture"), "fixture", emptyList(), toolSpecs = listOf(spec()), onProgress = { connected.complete(Unit) }); returned = true }
            withContext(Dispatchers.IO) { assertNotNull(server.takeRequest(2, TimeUnit.SECONDS)) }
            withTimeout(2000) { connected.await() }
            withTimeout(1000) { job.cancelAndJoin() }; assertFalse(returned); assertTrue(job.isCancelled); assertEquals(1, server.requestCount)
        }
    }
}
