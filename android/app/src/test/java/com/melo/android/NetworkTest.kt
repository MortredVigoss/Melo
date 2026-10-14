package com.melo.android

import com.melo.android.data.*
import com.melo.android.network.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.jsonObject
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

class NetworkTest {
    @Test fun productionEndpointsRejectCleartextCredentialsAndFragments() {
        listOf("http://localhost/v1", "https://user:pass@example.com/v1", "https://example.com/v1#token", "file:///tmp/key", "https://example.com.evil@localhost/v1").forEach {
            assertTrue(it, runCatching { EndpointPolicy.validate(it) }.isFailure)
        }
        EndpointPolicy.validate("https://example.com/v1")
        EndpointPolicy.validate("http://127.0.0.1:1234/v1", true)
        assertTrue(runCatching { EndpointPolicy.validate("http://192.168.1.1/v1", true) }.isFailure)
    }
    @Test fun chatStreamRequiresARealCompletionReceipt() {
        val stream = StreamDecoder("chat-completions")
        stream.accept("""{"model":"provider/model","choices":[{"index":0,"delta":{"content":"你好"}}]}""")
        assertTrue(runCatching { stream.finish() }.isFailure)
        stream.accept("""{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}""")
        stream.accept("[DONE]")
        assertEquals(ModelReply("你好", "provider/model"), stream.finish())
    }
    @Test fun truncatedAndFilteredRepliesCannotBecomeCompletedAnswers() {
        for (reason in listOf("length", "content_filter", "tool_calls")) {
            val stream = StreamDecoder("chat-completions")
            assertTrue(runCatching { stream.accept("""{"choices":[{"delta":{"content":"partial"},"finish_reason":"$reason"}]}""") }.isFailure)
        }
    }
    @Test fun responsesAndAnthropicUseTheirOwnCompletionEvents() {
        val responses = StreamDecoder("responses")
        responses.accept("""{"type":"response.output_text.delta","delta":"OK"}""")
        responses.accept("""{"type":"response.completed","response":{"status":"completed","error":null,"model":"chosen","output":[{"type":"message","content":[{"type":"output_text","text":"OK"}]}]}}""")
        assertEquals("OK", responses.finish().text)
        val anthropic = StreamDecoder("anthropic")
        anthropic.accept("""{"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}""")
        anthropic.accept("""{"type":"message_delta","delta":{"stop_reason":"end_turn"}}""")
        assertTrue(runCatching { anthropic.finish() }.isFailure)
        anthropic.accept("""{"type":"message_stop"}""")
        assertEquals("OK", anthropic.finish().text)
    }
    @Test fun responseTerminalOutputReconcilesMissingOrRevisedDeltas() {
        val stream = StreamDecoder("responses")
        stream.accept("""{"type":"response.output_text.delta","delta":"partial"}""")
        stream.accept("""{"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"final answer"}]}]}}""")
        assertEquals("final answer", stream.finish().text)
        assertTrue(runCatching { ModelClient.decodeResponse(MeloJson.parseToJsonElement("""{"choices":[{"message":{"content":"missing receipt"}}]}""").jsonObject, "chat-completions") }.isFailure)
    }
    @Test fun actualHttpStreamHandlesUnicodeAndCrLf() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody("data: {\"model\":\"fixture/model\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你好\\n世界\"}}]}\r\n\r\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\r\n\r\ndata: [DONE]\r\n\r\n"))
            server.start()
            val client = ModelClient(true)
            val result = client.reply(Connection(endpoint = server.url("/v1/chat/completions").toString(), model = "fixture"), "fixture-not-a-real-key", listOf(Message(role = "user", content = "hello")), "system", { "" }) { }
            assertEquals("你好\n世界", result.text)
            val request = server.takeRequest(1, TimeUnit.SECONDS)!!
            assertEquals("Bearer fixture-not-a-real-key", request.getHeader("Authorization"))
        }
    }
    @Test fun redirectDoesNotForwardCredentials() = runBlocking {
        MockWebServer().use { source -> MockWebServer().use { destination ->
            source.start(); destination.start()
            source.enqueue(MockResponse().setResponseCode(307).addHeader("Location", destination.url("/steal")))
            val result = runCatching { ModelClient(true).reply(Connection(endpoint = source.url("/chat").toString(), model = "fixture"), "fixture-secret", listOf(Message(role = "user", content = "hello")), "", { "" }) { } }
            assertTrue(result.isFailure); assertEquals(0, destination.requestCount)
        } }
    }
    @Test fun nonStreamingJsonWithUnknownLengthIsReadToEof() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setChunkedBody("""{"model":"fixture","choices":[{"message":{"content":"OK"},"finish_reason":"stop"}]}""", 7)); server.start()
            val result = ModelClient(true).reply(Connection(endpoint = server.url("/chat").toString(), model = "fixture", stream = false), "fixture", listOf(Message(role = "user", content = "hello")), "", { "" }) { }
            assertEquals("OK", result.text)
        }
    }
    @Test fun cancellationClosesAnInFlightCall() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n").setBodyDelay(5, TimeUnit.SECONDS)); server.start()
            val work = launch { ModelClient(true).reply(Connection(endpoint = server.url("/chat").toString(), model = "fixture"), "fixture", listOf(Message(role = "user", content = "hello")), "", { "" }) { } }
            withContext(Dispatchers.IO) { server.takeRequest(2, TimeUnit.SECONDS) }
            withTimeout(1000) { work.cancelAndJoin() }
            assertTrue(work.isCancelled)
        }
    }
    @Test fun releaseBuildsCannotUseTheLocalFixture() = runBlocking {
        assertTrue(runCatching { ModelClient(false).reply(Connection(protocol = "fixture"), "", emptyList(), "", { "" }) { } }.isFailure)
    }
}
