package com.melo.android

import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import com.melo.android.data.*
import com.melo.android.device.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

class MobileUseFlowTest {
    private val app get() = ApplicationProvider.getApplicationContext<MeloApplication>()
    private suspend fun ready() { withTimeout(10_000) { app.engine.runtime.first { it.initialized } } }
    private fun reply(text: String, seconds: Long) = MockResponse().setBody("""{"model":"fixture-reported","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"$text"}}]}""").setBodyDelay(seconds, TimeUnit.SECONDS)

    @Test fun syncDeletionOfTheOwningChatStopsAnInFlightDeviceTaskBeforeItsAction() = runBlocking {
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java)).use {
            ready()
            MockWebServer().use { server ->
                server.enqueue(MockResponse().setBody("""{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"id":"late","type":"function","function":{"name":"android_device","arguments":"{\"action\":\"observe\"}"}}]}}]}""").setBodyDelay(1, TimeUnit.SECONDS)); server.start()
                val connection = Connection(name = "Deleted chat fixture", endpoint = server.url("/device").toString(), model = "fixture")
                app.repository.saveConnection(connection, "local-fixture-key")
                val id = app.repository.newChat()
                app.repository.editChat(id) { it.copy(connectionId = connection.id) }
                var actions = 0; var ended = false
                val executor = object : DeviceExecutor {
                    override suspend fun begin(displayId: Int, screenshots: Boolean) { }
                    override suspend fun execute(arguments: JsonObject): DeviceToolResult { actions++; return DeviceToolResult.error("Must not act") }
                    override fun end() { ended = true }
                }
                val goal = "Deleted context ${newId()}"
                withContext(Dispatchers.Main) { assertTrue(app.deviceAgent.start(goal, 0, false, executor, id)) }
                withContext(Dispatchers.IO) { assertNotNull(server.takeRequest(5, TimeUnit.SECONDS)) }
                val snapshot = app.repository.snapshot()
                app.repository.acceptSnapshot(snapshot.copy(chats = snapshot.chats.filterNot { it.id == id }, deletedChats = snapshot.deletedChats + Deletion(id)))
                assertFalse(app.repository.data.value.chats.any { it.id == id })
                withTimeout(5000) { while (app.deviceAgent.runtime.value.running) delay(30) }
                assertEquals(0, actions); assertTrue(ended)
                assertEquals("failed", app.repository.data.value.deviceRuns.last { it.goal == goal }.status)
            }
        }
    }

    @Test fun twoChatsSendIndependentlyAndCancellationDoesNotClearAnotherTurn() = runBlocking {
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java)).use {
            ready()
            MockWebServer().use { server ->
                server.dispatcher = object : Dispatcher() {
                    override fun dispatch(request: RecordedRequest): MockResponse = if (request.body.clone().readUtf8().contains("question-A")) reply("reply-A", 8) else reply("reply-B", 2)
                }; server.start()
                val a = Connection(name = "Concurrent A", model = "model-A", endpoint = server.url("/chat").toString(), stream = false)
                val b = a.copy(id = newId(), name = "Concurrent B", model = "model-B")
                app.repository.saveConnection(a, "fixture-A"); app.repository.saveConnection(b, "fixture-B")
                val chatA = app.repository.newChat(); val chatB = app.repository.newChat()
                app.repository.editChat(chatA) { it.copy(connectionId = a.id) }; app.repository.editChat(chatB) { it.copy(connectionId = b.id) }
                withContext(Dispatchers.Main) {
                    assertTrue(app.engine.send(chatA, "question-A")); assertTrue(app.engine.send(chatB, "question-B"))
                    assertFalse(app.engine.send(chatA, "duplicate must stay out"))
                    app.engine.dismissError()
                }
                val requests = withContext(Dispatchers.IO) { listOfNotNull(server.takeRequest(5, TimeUnit.SECONDS), server.takeRequest(5, TimeUnit.SECONDS)) }
                assertEquals(2, requests.size)
                val bodies = requests.map { it.body.readUtf8() }
                assertEquals(1, bodies.count { it.contains("question-A") && it.contains("model-A") })
                assertEquals(1, bodies.count { it.contains("question-B") && it.contains("model-B") })
                withContext(Dispatchers.Main) { app.engine.cancel(chatA) }
                withTimeout(5000) { while (app.repository.data.value.runs.none { it.chatId == chatA && it.status == "cancelled" }) delay(30) }
                assertTrue("B must still own its turn", app.engine.runtime.value.turns.containsKey(chatB))
                withTimeout(8000) { while (app.repository.data.value.runs.none { it.chatId == chatB && it.status == "completed" }) delay(50) }
                withTimeout(2000) { while (app.engine.runtime.value.turns.containsKey(chatB)) delay(20) }
                val chats = app.repository.data.value.chats
                assertEquals(listOf("question-A"), chats.first { it.id == chatA }.messages.map { it.content })
                assertEquals(listOf("question-B", "reply-B"), chats.first { it.id == chatB }.messages.map { it.content })
                assertFalse(chats.any { row -> row.messages.any { it.content.contains("duplicate must stay out") } })
            }
        }
    }
    @Test fun deviceTaskCapturesChatAgentProjectModelAndRejectsASecondOwner() = runBlocking {
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java)).use {
            ready()
            MockWebServer().use { server ->
                server.enqueue(MockResponse().setBody("""{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"id":"blocked","type":"function","function":{"name":"android_device","arguments":"{\"action\":\"finish\",\"outcome\":\"blocked\",\"summary\":\"Fixture needs login\"}"}}]}}]}""").setBodyDelay(1, TimeUnit.SECONDS)); server.start()
                val connection = Connection(name = "Bound device model", endpoint = server.url("/device").toString(), model = "captured-device-model")
                val unrelated = Connection(name = "Other model", model = "local-fixture", protocol = "fixture")
                app.repository.saveConnection(connection, "local-fixture-key"); app.repository.saveConnection(unrelated, null)
                val agent = Agent(name = "Bound agent", instructions = "agent-marker-captured")
                val project = Project(name = "Bound project", instructions = "project-marker-captured")
                app.repository.saveAgent(agent); app.repository.saveProject(project)
                val a = app.repository.newChat(agent.id, project.id); val b = app.repository.newChat()
                app.repository.editChat(a) { it.copy(connectionId = connection.id) }
                var begun = 0; var ended = 0; var executed = 0
                val executor = object : DeviceExecutor {
                    override suspend fun begin(displayId: Int, screenshots: Boolean) { begun++ }
                    override suspend fun execute(arguments: JsonObject): DeviceToolResult { executed++; return DeviceToolResult.error("Should not act") }
                    override fun end() { ended++ }
                }
                val goal = "Device context isolation ${newId()}"
                withContext(Dispatchers.Main) {
                    assertTrue(app.deviceAgent.start(goal, 0, false, executor, a))
                    assertFalse(app.deviceAgent.start("second owner", 0, false, executor, b))
                    assertFalse(app.engine.send(a, "must not overlap device task"))
                    app.engine.dismissError(); app.deviceAgent.dismissError()
                }
                app.repository.editChat(a) { it.copy(connectionId = unrelated.id, agentId = "main", projectId = null) }
                app.repository.change { it.copy(settings = it.settings.copy(activeConnection = unrelated.id)) }
                val request = withContext(Dispatchers.IO) { server.takeRequest(5, TimeUnit.SECONDS) }!!.body.readUtf8()
                assertTrue(request.contains("captured-device-model")); assertTrue(request.contains("agent-marker-captured")); assertTrue(request.contains("project-marker-captured"))
                withTimeout(8000) { while (app.deviceAgent.runtime.value.running) delay(30) }
                val run = app.repository.data.value.deviceRuns.last { it.goal == goal }
                assertEquals(DeviceTaskContext(a, agent.id, project.id, connection.id), run.taskContext)
                assertEquals("blocked", run.status); assertEquals(1, begun); assertEquals(1, ended); assertEquals(0, executed)
                assertEquals(1, server.requestCount)
                assertFalse(MeloJson.encodeToString(app.repository.snapshot()).contains(goal))
                assertTrue(app.repository.data.value.deviceRuns.none { it.goal == "second owner" })
                assertTrue(app.repository.data.value.chats.first { it.id == a }.messages.isEmpty())
            }
        }
    }
}
