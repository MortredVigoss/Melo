package com.melo.android

import android.os.Build
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.melo.android.chat.*
import com.melo.android.core.*
import com.melo.android.data.*
import com.melo.android.network.ModelClient
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*
import java.util.concurrent.TimeUnit

class ContextFlowTest {
    private val app get() = ApplicationProvider.getApplicationContext<MeloApplication>()
    @Before fun emulatorOnly() { Assume.assumeTrue(Build.FINGERPRINT.contains("generic") || Build.MODEL.contains("sdk_gphone")) }
    private fun transcript() = listOf(Message(id = "first", role = "user", content = "Original decision: retain account 427; never replace it.")) +
        (1..100).map { Message(id = "m$it", role = if (it % 2 == 0) "user" else "assistant", content = "Earlier quoted details. ".repeat(160)) } +
        listOf(Message(id = "current", role = "user", content = "Repeat the original account decision exactly."))
    private fun tool(protocol: String) = MockResponse().setBody(when (protocol) {
        "responses" -> """{"status":"completed","output":[{"type":"function_call","call_id":"history1","name":"read_history","arguments":"{\"fromMessageId\":\"first\",\"limit\":1}"}]}"""
        "anthropic" -> """{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"history1","name":"read_history","input":{"fromMessageId":"first","limit":1}}]}"""
        else -> """{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"id":"history1","type":"function","function":{"name":"read_history","arguments":"{\"fromMessageId\":\"first\",\"limit\":1}"}}]}}]}"""
    })
    private fun final(protocol: String, text: String = "Retain account 427."): MockResponse {
        val encoded = MeloJson.encodeToString(text)
        return MockResponse().setBody(when (protocol) {
            "responses" -> """{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":$encoded}]}]}"""
            "anthropic" -> """{"stop_reason":"end_turn","content":[{"type":"text","text":$encoded}]}"""
            else -> """{"choices":[{"finish_reason":"stop","message":{"content":$encoded}}]}"""
        })
    }
    @Test fun longHistoryReadsOriginalThroughAllThreeProtocolsAndSurvivesDatabaseReopen() = runBlocking {
        val messages = transcript()
        var saved = buildJsonObject {}
        for (protocol in listOf("chat-completions", "responses", "anthropic")) MockWebServer().use { server ->
            server.start(); server.enqueue(tool(protocol)); server.enqueue(final(protocol))
            server.enqueue(final(protocol, """{"decision":"complete","reasonType":"fulfilled","reason":"Original history read","nextStep":"","requirements":[{"text":"Original account decision","status":"met","evidenceIds":["history1"]}]}"""))
            val result = SharedChatAgent(app, ModelClient(true), true).reply(
                Connection(endpoint = server.url("/model").toString(), model = "fixture", protocol = protocol, stream = false, contextTokens = 16000),
                "fixture-key", messages, "", buildJsonObject {}, { "" }, false, "context-$protocol", "context-chat", { error("No image loading") },
                invokePhone = { error("Reading history cannot invoke a device") }, onPhase = {}, onContextLedger = { saved = it })
            assertEquals("Retain account 427.", result.text)
            assertEquals(3, server.requestCount)
            val first = server.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()
            val second = server.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()
            assertTrue(first.contains("read_history")); assertTrue(first.contains("current") || first.contains("Repeat the original"))
            assertTrue(second.contains("Original decision: retain account 427; never replace it."))
            assertFalse(first.contains("Earlier quoted details. ".repeat(160).repeat(100)))
            val review = server.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()
            assertTrue(review.contains("task completion checker"))
            assertFalse(review.contains("\"name\":\"read_history\""))
            assertTrue(saved.getValue("cards").jsonArray.isNotEmpty())
        }
        val name = "context-fixture-${newId()}.db"
        try {
            val original = AppData(chats = listOf(Conversation(id = "context-chat", messages = messages, contextLedger = saved)))
            Room.databaseBuilder(app, MeloDatabase::class.java, name).build().let { db ->
                db.documents().save(StoredDocument(payload = MeloJson.encodeToString(original))); db.close()
            }
            val restored = Room.databaseBuilder(app, MeloDatabase::class.java, name).build().let { db ->
                val value = MeloJson.decodeFromString<AppData>(db.documents().load()!!.payload); db.close(); value
            }
            assertEquals(original, restored)
            SharedCoreRuntime.open(app).use { runtime ->
                val policy = ChatContext(runtime, 16000)
                val before = policy.prepare(messages, "", emptyList(), saved, true)
                val after = policy.prepare(restored.chats.single().messages, "", emptyList(), restored.chats.single().contextLedger, true)
                assertEquals(before, after)
                assertEquals("NOT_FOUND", policy.read(messages, buildJsonObject { put("fromMessageId", "other-chat-message") }).data.text("code"))
                assertTrue(runCatching { policy.read(messages, buildJsonObject { put("chatId", "other") }) }.isFailure)
            }
        } finally { app.deleteDatabase(name) }
    }

    @Test fun disabledSourcesStayOutOfInstructionsAndHistoryBudgetsStayBounded() = runBlocking {
        val chat = Conversation(projectId = "p")
        val state = AppData(chats = listOf(chat),
            agents = listOf(Agent(id = "main", name = "Melo", contextSources = mapOf("projects" to false, "artifacts" to false, "memory" to false))),
            projects = listOf(Project(id = "p", name = "P", instructions = "PROJECT-SECRET")),
            knowledge = listOf(Knowledge(title = "K", content = "KNOWLEDGE-SECRET", projectId = "p")),
            memories = listOf(MemoryFact(text = "MEMORY-SECRET", chatId = chat.id)))
        val instructions = app.repository.instructions(chat, state)
        assertFalse(instructions.contains("SECRET"))
        SharedCoreRuntime.open(app).use { runtime ->
            val policy = ChatContext(runtime, 16000)
            val prepared = policy.prepare(transcript(), instructions, emptyList(), buildJsonObject {}, false)
            assertFalse(prepared.instructions.contains("Original decision"))
            assertFalse(prepared.instructions.contains("SECRET"))
            val large = Message(role = "user", content = "😀文字".repeat(30000) + "final-marker")
            var offset = 0
            repeat(4) {
                val page = policy.read(listOf(large), buildJsonObject { put("fromMessageId", large.id); put("fromChar", offset) })
                val next = page.data.getValue("continueFromChar").jsonPrimitive.int
                assertTrue(next > offset); offset = next
            }
            val image = Message(role = "user", content = "Describe", attachments = List(3) { Attachment(name = "x", mime = "image/png", file = "unused") })
            assertTrue(runCatching { ChatContext(runtime, 4096).prepare(listOf(image), "", emptyList(), buildJsonObject {}, true) }.isFailure)
            val wire = ChatPhoneUse.history(listOf(image.copy(attachments = image.attachments.take(1))), "chat-completions") { "fixture-base64" }
            var boundary = policy.fit(wire, 0, "", emptyList())
            // appendResult can replace rows when demoting historical screenshots.
            wire[0] = JsonObject(wire[0].toMap())
            boundary = policy.fit(wire, boundary, "", emptyList())
            assertEquals(0, boundary)
            assertTrue(runCatching { runtime.value("contextWirePlan", buildJsonObject { put("context", buildJsonObject {
                put("capacity", 4096); put("costs", buildJsonArray { add(10); add(2000); add(2000) })
                put("roles", buildJsonArray { add("user"); add("assistant"); add("user") }); put("chainStart", 0)
            }) }) }.isFailure)
        }
    }
}
