package com.melo.android

import com.melo.android.chat.*
import com.melo.android.data.*
import com.melo.android.device.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

class ChatPhoneUseTest {
    private val protocols = listOf("chat-completions", "responses", "anthropic")
    private fun args(goal: String = "查 Google Maps 上 Surry Hills 当前营业的餐厅") = buildJsonObject { put("goal", goal); put("purpose", "research") }
    private fun call(arguments: JsonObject = args()) = DeviceTurn("", listOf(DeviceCall("call-1", ChatPhoneUse.name, arguments)), listOf(buildJsonObject { put("role", "assistant"); put("content", "fixture-wire") }))
    private fun receipt() = ChatPhoneUse.receipt(DeviceRun(goal = "fixture", connectionName = "fixture", status = "achieved", answer = "Fixture A 营业状态未知；仅本地样例", finishedAt = now(), verification = "visible_facts"), true)

    @Test fun ordinaryAnswerNeverInvokesPhoneOrRequestsScreen() = runBlocking {
        var invoked = 0
        val result = ChatToolLoop("chat-completions", { DeviceTurn("2", emptyList(), emptyList()) }, { invoked++; receipt() }).run(ChatPhoneUse.history(listOf(Message(role = "user", content = "1+1")), "chat-completions") { error("No images") })
        assertEquals("2", result.text); assertEquals(0, invoked)
    }
    @Test fun failedReceiptEndsTheTurnWithoutAnotherModelOrDeviceRequest() = runBlocking {
        var requests = 0; var invoked = 0
        val result = ChatToolLoop("chat-completions", { requests++; call() }, { invoked++; DeviceToolResult.error("需要开启辅助功能", "device_unavailable") }).run(mutableListOf())
        assertTrue(result.text.contains("需要开启辅助功能")); assertEquals(1, requests); assertEquals(1, invoked)
    }
    @Test fun repeatedCompletedTaskIsRejectedBeforeASecondDeviceInvocation() = runBlocking {
        var invoked = 0
        assertTrue(runCatching { ChatToolLoop("chat-completions", { call() }, { invoked++; receipt() }).run(mutableListOf()) }.isFailure)
        assertEquals(1, invoked)
    }
    @Test fun distinctTasksStillHaveABoundedTurn() = runBlocking {
        var requests = 0; var invoked = 0
        assertTrue(runCatching { ChatToolLoop("chat-completions", { call(args("task ${++requests}")) }, { invoked++; receipt() }).run(mutableListOf()) }.isFailure)
        assertEquals(4, requests); assertEquals(3, invoked)
    }
    @Test fun cancellationPropagatesIntoTheOwnedPhoneInvocation() = runBlocking {
        val entered = CompletableDeferred<Unit>(); var cancelled = false
        val task = launch { ChatToolLoop("chat-completions", { call() }, { entered.complete(Unit); try { awaitCancellation() } finally { cancelled = true } }).run(mutableListOf()) }
        entered.await(); task.cancelAndJoin(); assertTrue(cancelled)
    }
    @Test fun malformedToolCannotReachTheDevice() = runBlocking {
        val invalid = listOf(buildJsonObject { put("goal", "x") }, buildJsonObject { put("goal", "x"); put("purpose", "purchase") }, buildJsonObject { put("goal", "x"); put("purpose", "research"); put("shell", "anything") }, args(" "), args("x".repeat(4001)))
        for (arguments in invalid) {
            var invoked = false
            assertTrue(runCatching { ChatToolLoop("chat-completions", { call(arguments) }, { invoked = true; receipt() }).run(mutableListOf()) }.isFailure)
            assertFalse(invoked)
        }
    }
    @Test fun followUpIncludesEarlierFindingsAndTheCurrentQuestion() {
        for (protocol in protocols) {
            val history = ChatPhoneUse.history(listOf(Message(role = "user", content = "查 Surry Hills 餐厅"), Message(role = "assistant", content = "1. Fixture A；2. Fixture B"), Message(role = "user", content = "第二家还开着吗？")), protocol) { error("No images") }
            assertTrue(history.toString().contains("Fixture B")); assertTrue(history.toString().contains("第二家"))
        }
    }
    @Test fun receiptsContainRequestedSummaryButNoRawStepsOrScreenPixels() {
        val run = DeviceRun(goal = "fixture", connectionName = "fixture", status = "achieved", answer = "Observed result", steps = listOf(DeviceStep("observe", true, "private tree-marker")))
        val result = ChatPhoneUse.receipt(run, true)
        assertEquals("Observed result", result.data.text("summary")); assertFalse(result.data.toString().contains("tree-marker")); assertNull(result.jpeg)
    }
    @Test fun persistedOlderChatsEnableTheSkillAndCanExplicitlyDisableIt() {
        assertTrue(MeloJson.decodeFromString<Conversation>("{}").phoneUseEnabled)
        assertFalse(MeloJson.decodeFromString<Conversation>(MeloJson.encodeToString(Conversation(phoneUseEnabled = false))).phoneUseEnabled)
    }
    @Test fun eachProtocolCallsTheHighLevelToolOverHttpAndContinuesWithItsReceipt() = runBlocking {
        for (protocol in protocols) MockWebServer().use { server ->
            val tool = when (protocol) {
                "responses" -> buildJsonObject { put("status", "completed"); put("output", buildJsonArray { add(buildJsonObject { put("type", "function_call"); put("call_id", "call-1"); put("name", ChatPhoneUse.name); put("arguments", args().toString()) }) }) }
                "anthropic" -> buildJsonObject { put("stop_reason", "tool_use"); put("content", buildJsonArray { add(buildJsonObject { put("type", "tool_use"); put("id", "call-1"); put("name", ChatPhoneUse.name); put("input", args()) }) }) }
                else -> buildJsonObject { put("choices", buildJsonArray { add(buildJsonObject { put("finish_reason", "tool_calls"); put("message", buildJsonObject { put("role", "assistant"); put("tool_calls", buildJsonArray { add(buildJsonObject { put("id", "call-1"); put("type", "function"); put("function", buildJsonObject { put("name", ChatPhoneUse.name); put("arguments", args().toString()) }) }) }) }) }) }) }
            }
            val final = when (protocol) {
                "responses" -> """{"status":"completed","model":"fixture-model","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Fixture 营业状态未知"}]}]}"""
                "anthropic" -> """{"model":"fixture-model","stop_reason":"end_turn","content":[{"type":"text","text":"Fixture 营业状态未知"}]}"""
                else -> """{"model":"fixture-model","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Fixture 营业状态未知","tool_calls":null}}]}"""
            }
            server.enqueue(MockResponse().setBody(tool.toString())); server.enqueue(MockResponse().setBody(final)); server.start()
            val connection = Connection(endpoint = server.url("/chat").toString(), model = "fixture-model", protocol = protocol)
            var invoked = 0
            val result = ChatToolLoop(protocol, { DeviceAgentClient(true).next(connection, "local-fixture-key", it, ChatPhoneUse.context("persona-marker"), chatTools = true) }, { invoked++; assertEquals("research", it.text("purpose")); receipt() })
                .run(ChatPhoneUse.history(listOf(Message(role = "user", content = "查 Google Maps")), protocol) { error("No images") })
            assertEquals("fixture-model", result.model); assertTrue(result.text.contains("未知")); assertEquals(1, invoked)
            val first = server.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()
            assertTrue(first.contains("phone_use")); assertFalse(first.contains("android_device")); assertTrue(first.contains("persona-marker"))
            val second = server.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()
            assertTrue(second.contains("call-1")); assertTrue(second.contains("live_research")); assertFalse(second.contains("local-fixture-key"))
            assertTrue(runCatching { DeviceAgentClient.decode(tool, protocol) }.isFailure)
        }
    }
}
