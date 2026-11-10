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
    // 2026-11-10. A streamed answer without tool calls used to carry `tool_calls: []`; that message is sent
    // back when the completion check asks for another round, and Chat Completions rejects the empty array.
    private fun answerFrames(protocol: String): List<String> = when (protocol) {
        "responses" -> listOf(
            """{"type":"response.output_text.delta","delta":"明天"}""",
            """{"type":"response.output_text.delta","delta":"多云"}""",
            """{"type":"response.completed","response":{"model":"fixture-returned","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"明天多云"}]}]}}""",
        )
        "anthropic" -> listOf(
            """{"type":"message_start","message":{"model":"fixture-returned","usage":{"input_tokens":7}}}""",
            """{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}""",
            """{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"明天"}}""",
            """{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"多云"}}""",
            """{"type":"content_block_stop","index":0}""",
            """{"type":"message_delta","delta":{"stop_reason":"end_turn"}}""",
            """{"type":"message_stop"}""",
        )
        else -> listOf(
            """{"model":"fixture-returned","choices":[{"index":0,"delta":{"role":"assistant","content":"明天"},"finish_reason":null}]}""",
            """{"choices":[{"index":0,"delta":{"content":"多云"},"finish_reason":null}]}""",
            """{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}""",
            "[DONE]",
        )
    }
    @Test fun aStreamedAnswerWithoutCallsCanBeSentBackOnTheNextRequest() {
        val decoder = ToolStreamDecoder("chat-completions")
        answerFrames("chat-completions").forEach(decoder::accept)
        val turn = DeviceAgentClient.decode(decoder.finish(), "chat-completions", toolNames = setOf("web_search"))
        assertEquals("明天多云", turn.text); assertTrue(turn.calls.isEmpty())
        assertNull("a reply without calls has no tool_calls field", turn.wire.single()["tool_calls"])
        // The follow-up request of a repair round: original question, the answer, the checker's feedback.
        val history = DeviceAgentClient.initial("chat-completions", "明天天气") + turn.wire + buildJsonObject { put("role", "user"); put("content", "请补充降雨概率。") }
        val body = DeviceAgentClient.payload(Connection(model = "fixture"), history, chatTools = true, toolSpecs = listOf(spec())).toString()
        assertFalse(body.contains("\"tool_calls\":[]")); assertTrue(body.contains("明天多云"))
        // A reply that does carry calls keeps them.
        val calling = ToolStreamDecoder("chat-completions"); frames("chat-completions").forEach(calling::accept)
        assertEquals(1, calling.finish().getValue("choices").jsonArray.single().jsonObject.getValue("message").jsonObject.getValue("tool_calls").jsonArray.size)
    }
    @Test fun answerTextReachesTheHostWhileItArrivesOnEveryProtocol() = runBlocking {
        for (protocol in protocols) {
            val shown = mutableListOf<String>(); val decoder = ToolStreamDecoder(protocol, onText = shown::add)
            answerFrames(protocol).forEach(decoder::accept)
            assertEquals(protocol, listOf("明天", "明天多云"), shown)
            assertEquals("明天多云", DeviceAgentClient.decode(decoder.finish(), protocol, toolNames = setOf("web_search")).text)
            // A round that only calls a tool shows no answer text.
            val silent = mutableListOf<String>(); val calling = ToolStreamDecoder(protocol, onText = silent::add)
            frames(protocol).forEach(calling::accept); assertTrue(protocol, silent.isEmpty())
        }
        // Through the real HTTP path.
        for (protocol in protocols) MockWebServer().use { server ->
            server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(answerFrames(protocol).joinToString("") { "data: $it\n\n" })); server.start()
            val shown = java.util.Collections.synchronizedList(mutableListOf<String>())
            val turn = DeviceAgentClient(true).next(Connection(endpoint = server.url("/model").toString(), model = "fixture", protocol = protocol, stream = true), "fixture", emptyList(), chatTools = true, toolSpecs = listOf(spec()), onText = { shown.add(it) })
            assertEquals("明天多云", turn.text); assertEquals(protocol, "明天多云", shown.last()); assertTrue(shown.size >= 2)
        }
    }
    // 2026-11-10. Anthropic streams a call without arguments as one empty partial_json; parsing "" failed
    // the whole request, so "我有哪些待办？" (todo_list takes no arguments) could not be answered.
    @Test fun anAnthropicCallWithoutArgumentsKeepsItsEmptyInput() {
        for (deltas in listOf(listOf(""), emptyList(), listOf("", ""), listOf("{}"), listOf("{\"limit\":", "5}"))) {
            val decoder = ToolStreamDecoder("anthropic")
            decoder.accept("""{"type":"message_start","message":{"model":"fixture","usage":{"input_tokens":3}}}""")
            decoder.accept("""{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"todo_list","input":{}}}""")
            for (delta in deltas) decoder.accept(buildJsonObject { put("type", "content_block_delta"); put("index", 0); put("delta", buildJsonObject { put("type", "input_json_delta"); put("partial_json", delta) }) }.toString())
            decoder.accept("""{"type":"content_block_stop","index":0}""")
            decoder.accept("""{"type":"message_delta","delta":{"stop_reason":"tool_use"}}"""); decoder.accept("""{"type":"message_stop"}""")
            val call = DeviceAgentClient.decode(decoder.finish(), "anthropic", toolNames = setOf("todo_list")).calls.single()
            assertEquals("todo_list", call.name)
            assertEquals(deltas.toString(), if (deltas.joinToString("").contains("limit")) buildJsonObject { put("limit", 5) } else buildJsonObject {}, call.arguments)
        }
        // Arguments that are not valid JSON still fail closed.
        val broken = ToolStreamDecoder("anthropic")
        broken.accept("""{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"todo_list","input":{}}}""")
        broken.accept("""{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"limit\":"}}""")
        assertTrue(runCatching { broken.accept("""{"type":"content_block_stop","index":0}""") }.isFailure)
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
