package com.melo.android

import android.app.UiAutomation
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.melo.android.data.*
import com.melo.android.device.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*
import java.util.concurrent.TimeUnit

/** Local HTTP model + the real enabled Accessibility service, never a personal device. */
class ChatPhoneUseFlowTest {
    private val app get() = ApplicationProvider.getApplicationContext<MeloApplication>()
    private lateinit var automation: UiAutomation
    private var before: AppData? = null
    private var enabledBefore = ""
    private val serviceName = "com.melo.android/com.melo.android.device.MeloAccessibilityService"
    private fun shell(command: String) = automation.executeShellCommand(command).use { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { r -> r.readText().trim() } }
    private fun waitFor(check: () -> Boolean) { val end = SystemClock.elapsedRealtime() + 15_000; while (!check() && SystemClock.elapsedRealtime() < end) SystemClock.sleep(80); assertTrue("Condition not reached", check()) }

    @Before fun setup() {
        Assume.assumeTrue(Build.FINGERPRINT.contains("generic") || Build.MODEL.contains("sdk_gphone"))
        automation = InstrumentationRegistry.getInstrumentation().getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        enabledBefore = shell("settings get secure enabled_accessibility_services").takeUnless { it == "null" }.orEmpty()
        shell("settings put secure enabled_accessibility_services " + (enabledBefore.split(':').filter(String::isNotBlank) + serviceName).distinct().joinToString(":"))
        shell("settings put secure accessibility_enabled 1")
        runBlocking {
            app.engine.initialize().join()
            withTimeout(15_000) { app.engine.runtime.first { it.initialized } }
            withContext(Dispatchers.Main) { app.engine.dismissError(); app.deviceAgent.dismissError() }
            before = app.repository.data.value
            app.repository.change { it.copy(deviceScripts = emptyList()) }
        }
        waitFor { DeviceAccess.service != null }
        app.startActivity(Intent(app, DeviceFixtureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        SystemClock.sleep(1000)
    }
    @After fun restore() {
        if (!::automation.isInitialized) return
        runBlocking {
            withContext(Dispatchers.Main) { app.engine.cancel(); app.deviceAgent.cancel(); app.engine.dismissError(); app.deviceAgent.dismissError() }
            withTimeout(15_000) { while (app.engine.runtime.value.turns.isNotEmpty() || app.deviceAgent.runtime.value.running) delay(40) }
            before?.let { snapshot -> app.repository.change { snapshot } }
        }
        if (enabledBefore.isBlank()) shell("settings delete secure enabled_accessibility_services") else shell("settings put secure enabled_accessibility_services $enabledBefore")
        if (serviceName !in enabledBefore.split(':')) waitFor { DeviceAccess.service == null }
    }
    private fun call(name: String, id: String, args: JsonObject) = MockResponse().setBody(buildJsonObject {
        put("choices", buildJsonArray { add(buildJsonObject { put("finish_reason", "tool_calls"); put("message", buildJsonObject {
            put("role", "assistant"); put("tool_calls", buildJsonArray { add(buildJsonObject {
                put("id", id); put("type", "function"); put("function", buildJsonObject { put("name", name); put("arguments", args.toString()) })
            }) })
        }) }) })
    }.toString())
    private fun final() = MockResponse().setBody("""{"model":"captured-model","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Fixture 页面 Count 0，未查询真实餐厅。","tool_calls":null}}]}""")
    private suspend fun chat(server: MockWebServer, enabled: Boolean = true): String {
        val connection = Connection(name = "Chat phone local fixture", endpoint = server.url("/chat").toString(), model = "captured-model", stream = false)
        app.repository.saveConnection(connection, "local-fixture-key")
        val agent = Agent(name = "Phone skill fixture", instructions = "captured-agent-marker")
        val project = Project(name = "Phone project fixture", instructions = "captured-project-marker")
        app.repository.saveAgent(agent); app.repository.saveProject(project)
        return app.repository.newChat(agent.id, project.id).also { id -> app.repository.editChat(id) { it.copy(connectionId = connection.id, phoneUseEnabled = enabled) } }
    }
    private suspend fun complete(id: String) { withTimeout(25_000) { while (app.engine.runtime.value.turns.containsKey(id)) delay(40) } }
    private fun research(goal: String) = call("phone_use", "phone-1", buildJsonObject { put("goal", goal); put("purpose", "research") })

    @Test fun ordinaryChatInvokesRealDeviceThenContinuesWithTheReceiptAndCapturedContext() = runBlocking {
        MockWebServer().use { server ->
            val goal = "Read the current fixture Count 0; report fixture facts only ${newId()}"
            server.dispatcher = object : Dispatcher() {
                var child = 0
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val body = MeloJson.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                    val name = body["tools"]!!.jsonArray.single().jsonObject["function"]!!.jsonObject.text("name")
                    if (name == "phone_use") return if (body.toString().contains("tool_call_id")) final().setBodyDelay(1, TimeUnit.SECONDS) else research(goal).setBodyDelay(1, TimeUnit.SECONDS)
                    child++
                    if (child == 1) return call("android_device", "observe", buildJsonObject { put("action", "observe") })
                    val receipt = body["messages"]!!.jsonArray.map { it.jsonObject }.last { it.text("role") == "tool" }
                    val screen = MeloJson.parseToJsonElement(receipt.text("content")).jsonObject
                    return call("android_device", "finish", buildJsonObject {
                        put("action", "finish"); put("outcome", "achieved"); put("summary", "Fixture 页面显示 Count 0；仅本地样例。")
                        put("screen_id", screen.text("screen_id")); put("expected_package", "com.melo.android"); put("visible_text", "Count 0")
                    })
                }
            }
            server.start(); val id = chat(server)
            withContext(Dispatchers.Main) { assertTrue(app.engine.send(id, "请查看当前测试页面")) }
            val first = withContext(Dispatchers.IO) { server.takeRequest(5, TimeUnit.SECONDS) }!!
            assertTrue(first.body.clone().readUtf8().contains("phone_use"))
            app.repository.draft(id, "next-message-draft-must-survive")
            val capturedProject = app.repository.data.value.projects.first { it.id == app.repository.data.value.chats.first { chat -> chat.id == id }.projectId }
            val moveError = runCatching { app.repository.editChat(id) { it.copy(projectId = null) } }.exceptionOrNull()
            assertTrue("Running project movement must fail before changing membership", moveError is IllegalArgumentException)
            assertEquals(capturedProject.id, app.repository.data.value.chats.first { it.id == id }.projectId)
            app.repository.editChat(id) { it.copy(agentId = "main", connectionId = null, phoneUseEnabled = false) }
            app.repository.saveProject(capturedProject.copy(instructions = "future-turn-project-marker"))
            complete(id); delay(600)
            val saved = app.repository.data.value
            val run = saved.deviceRuns.single { it.taskContext?.chatId == id }
            assertEquals("achieved", run.status); assertEquals("probe", run.executionMode); assertEquals(2, run.modelRequests)
            assertEquals(saved.runs.last { it.chatId == id }.id, run.parentRunId)
            assertTrue(saved.deviceScripts.isEmpty())
            assertEquals(listOf("user", "assistant"), saved.chats.first { it.id == id }.messages.map { it.role })
            assertTrue(saved.chats.first { it.id == id }.messages.last().content.contains("Count 0"))
            repeat(3) {
                val body = withContext(Dispatchers.IO) { server.takeRequest(5, TimeUnit.SECONDS) }!!.body.readUtf8()
                assertTrue(body.contains("captured-model")); assertTrue(body.contains("captured-agent-marker")); assertTrue(body.contains("captured-project-marker"))
                assertFalse(body.contains("future-turn-project-marker"))
                assertFalse(body.contains("local-fixture-key"))
            }
            assertEquals(4, server.requestCount); assertFalse(app.deviceAgent.runtime.value.running)
            assertEquals("next-message-draft-must-survive", saved.drafts[id])
        }
    }

    @Test fun cancellingChatCancelsItsChildBeforeALateModelAction() = runBlocking {
        MockWebServer().use { server ->
            val goal = "Cancellation fixture ${newId()}"
            server.enqueue(research(goal))
            server.enqueue(call("android_device", "observe", buildJsonObject { put("action", "observe") }).setBodyDelay(3, TimeUnit.SECONDS))
            server.start(); val id = chat(server)
            withContext(Dispatchers.Main) { assertTrue(app.engine.send(id, "查看取消测试页面")) }
            withContext(Dispatchers.IO) { assertNotNull(server.takeRequest(5, TimeUnit.SECONDS)); assertNotNull(server.takeRequest(5, TimeUnit.SECONDS)) }
            withContext(Dispatchers.Main) { app.engine.cancel(id) }
            complete(id)
            val saved = app.repository.data.value
            assertEquals("cancelled", saved.deviceRuns.last { it.goal == goal }.status)
            assertTrue(saved.deviceRuns.last { it.goal == goal }.steps.isEmpty())
            assertFalse(app.deviceAgent.runtime.value.running)
            assertEquals(1, saved.chats.first { it.id == id }.messages.size)
            assertEquals("cancelled", saved.runs.last { it.chatId == id }.status)
            assertEquals(2, server.requestCount)
        }
    }

    @Test fun blockedChildEndsTheTurnWithoutTryingAnotherPhoneTask() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(research("Blocked fixture ${newId()}"))
            server.enqueue(call("android_device", "blocked", buildJsonObject { put("action", "finish"); put("outcome", "blocked"); put("summary", "Fixture 需要登录，未继续") }))
            server.start(); val id = chat(server)
            withContext(Dispatchers.Main) { assertTrue(app.engine.send(id, "查看测试页面")) }; complete(id)
            assertEquals(2, server.requestCount)
            assertTrue(app.repository.data.value.chats.first { it.id == id }.messages.last().content.contains("需要登录"))
            assertEquals("blocked", app.repository.data.value.deviceRuns.last { it.taskContext?.chatId == id }.status)
        }
    }

    @Test fun disabledSkillUsesOriginalChatWithoutToolsOrDeviceSession() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(final()); server.start(); val id = chat(server, false)
            withContext(Dispatchers.Main) { assertTrue(app.engine.send(id, "普通问答")) }; complete(id)
            val body = server.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()
            assertFalse(body.contains("\"tools\"")); assertEquals(1, server.requestCount)
            assertTrue(app.repository.data.value.deviceRuns.none { it.taskContext?.chatId == id })
        }
    }

    @Test fun deletingChatDuringPlanningCannotStartADeviceTaskOrRestoreItsMessages() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(research("Deleted fixture ${newId()}").setBodyDelay(1, TimeUnit.SECONDS)); server.start()
            val id = chat(server)
            withContext(Dispatchers.Main) { assertTrue(app.engine.send(id, "查看测试页面")) }
            withContext(Dispatchers.IO) { assertNotNull(server.takeRequest(5, TimeUnit.SECONDS)) }
            val snapshot = app.repository.snapshot()
            app.repository.acceptSnapshot(snapshot.copy(chats = snapshot.chats.filterNot { it.id == id }, deletedChats = snapshot.deletedChats + Deletion(id, java.time.Instant.now().plusSeconds(2).toString())))
            complete(id)
            assertTrue(app.repository.data.value.chats.none { it.id == id })
            assertTrue(app.repository.data.value.deviceRuns.none { it.taskContext?.chatId == id })
            assertEquals(1, server.requestCount)
        }
    }
}
