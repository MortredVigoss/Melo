package com.melo.android

import com.melo.android.data.*
import com.melo.android.device.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

// 2026-11-10. A compatible server may send tool calls without an id, or start again at the same id in
// every response. The Core refuses a repeated id, and a call without one failed as an invalid response,
// so such a server could not finish a reply that needed two tool rounds. Every call of a chat reply now
// has an id of its own (as on desktop, src/tools/functionCalling.js), and a result still names the
// provider's own id on the wire wherever the provider gave one.
class ToolCallIdsTest {
    private fun spec(name: String) = buildJsonObject { put("name", name); put("description", "fixture"); put("parameters", buildJsonObject { put("type", "object") }) }
    private val specs = listOf(spec("todo_list"), spec("calendar_list_events"))
    private fun json(value: String) = MeloJson.parseToJsonElement(value).jsonObject
    private fun chat(vararg calls: Pair<String?, String>) = buildJsonObject { put("choices", buildJsonArray { add(buildJsonObject { put("finish_reason", "tool_calls"); put("message", buildJsonObject { put("role", "assistant"); put("content", JsonNull)
        put("tool_calls", buildJsonArray { for ((id, name) in calls) add(buildJsonObject { id?.let { put("id", it) }; put("type", "function"); put("function", buildJsonObject { put("name", name); put("arguments", "{}") }) }) })
    }) }) }) }
    private val done = DeviceToolResult(buildJsonObject { put("ok", true); put("items", JsonArray(emptyList())) })

    @Test fun aServerThatSendsNoIdsInTwoRoundsStillPairsEveryResultWithItsCall() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(chat(null to "todo_list", null to "calendar_list_events").toString()))
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(chat(null to "todo_list").toString()))
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("""{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"done"}}]}"""))
            server.start()
            val connection = Connection(endpoint = server.url("/model").toString(), model = "fixture", protocol = "chat-completions", stream = false)
            val client = DeviceAgentClient(true); val ids = mutableSetOf<String>()
            val history = mutableListOf(buildJsonObject { put("role", "user"); put("content", "what is on my list?") })
            val first = client.next(connection, "fixture", history, "lead", true, specs, callIds = ids)
            assertEquals(listOf("call_1", "call_2"), first.calls.map { it.id }); assertEquals(first.calls.map { it.id }, first.calls.map { it.wireId })
            history += first.wire; for (call in first.calls) DeviceAgentClient.appendResult(history, "chat-completions", call, done)
            val second = client.next(connection, "fixture", history, "lead", true, specs, callIds = ids)
            assertEquals("the second round never repeats an id of the first", listOf("call_3"), second.calls.map { it.id })
            history += second.wire; DeviceAgentClient.appendResult(history, "chat-completions", second.calls.single(), done)
            assertEquals("done", client.next(connection, "fixture", history, "lead", true, specs, callIds = ids).text)
            // What the provider was sent in the third request: each assistant message carries the ids, each result names one of them.
            repeat(2) { server.takeRequest(1, TimeUnit.SECONDS) }
            val sent = json(server.takeRequest(1, TimeUnit.SECONDS)!!.body.readUtf8()).getValue("messages").jsonArray.map { it.jsonObject }
            val carried = sent.filter { it["tool_calls"] != null }.map { message -> message.getValue("tool_calls").jsonArray.map { it.jsonObject.text("id") } }
            assertEquals(listOf(listOf("call_1", "call_2"), listOf("call_3")), carried)
            assertEquals(listOf("call_1", "call_2", "call_3"), sent.filter { it.text("role") == "tool" }.map { it.text("tool_call_id") })
            assertEquals(setOf("call_1", "call_2", "call_3"), ids)
        }
    }

    @Test fun anIdTheProviderRepeatsStaysItsOwnOnTheWireAndIsNewForTheLoop() {
        val replies = mapOf(
            "chat-completions" to chat("call_0" to "todo_list"),
            "responses" to json("""{"status":"completed","output":[{"type":"function_call","id":"fc_1","call_id":"call_0","name":"todo_list","arguments":"{}"}]}"""),
            "anthropic" to json("""{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"call_0","name":"todo_list","input":{}}]}"""))
        for ((protocol, reply) in replies) {
            val ids = mutableSetOf<String>()
            val first = DeviceAgentClient.decode(reply, protocol, toolNames = setOf("todo_list"), callIds = ids).calls.single()
            assertEquals(protocol, "call_0", first.id); assertEquals("call_0", first.wireId)
            val turn = DeviceAgentClient.decode(reply, protocol, toolNames = setOf("todo_list"), callIds = ids)
            val again = turn.calls.single()
            assertNotEquals("$protocol: the loop knows the second call by another id", "call_0", again.id); assertTrue(again.id.isNotBlank())
            assertEquals("$protocol: the provider's own id stays on the wire", "call_0", again.wireId)
            assertTrue("$protocol: its message is sent back as it came", turn.wire.toString().contains("call_0") && !turn.wire.toString().contains(again.id))
            val history = mutableListOf<JsonObject>(); DeviceAgentClient.appendResult(history, protocol, again, done)
            assertTrue("$protocol: the result names the provider's id", history.single().toString().contains("\"call_0\"")); assertFalse(history.single().toString().contains(again.id))
            // A third round is new again.
            assertEquals(3, setOf(first.id, again.id, DeviceAgentClient.decode(reply, protocol, toolNames = setOf("todo_list"), callIds = ids).calls.single().id).size)
        }
        // Twice in one response: the message itself is made unambiguous, a synthesized id never collides with one the provider gave.
        val ids = mutableSetOf<String>()
        val twice = DeviceAgentClient.decode(chat("call_1" to "todo_list", "call_1" to "calendar_list_events", null to "todo_list"), "chat-completions", toolNames = setOf("todo_list", "calendar_list_events"), callIds = ids)
        assertEquals(3, twice.calls.map { it.id }.toSet().size); assertEquals("call_1", twice.calls.first().id)
        assertEquals(twice.calls.map { it.wireId }, twice.wire.single().getValue("tool_calls").jsonArray.map { it.jsonObject.text("id") })
        assertEquals(twice.calls.map { it.id }, twice.calls.map { it.wireId })
        // Without a reply's id set (a device step) the provider's id is still required as it is.
        assertTrue(runCatching { DeviceAgentClient.decode(chat(null to "android_device"), "chat-completions") }.isFailure)
    }
}
