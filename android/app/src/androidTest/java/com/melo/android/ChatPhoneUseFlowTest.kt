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
    private suspend fun chat(server: MockWebServer, enabled: Boolean = true, stream: Boolean = false): String {
        val connection = Connection(name = "Chat phone local fixture", endpoint = server.url("/chat").toString(), model = "captured-model", stream = stream)
        app.repository.saveConnection(connection, "local-fixture-key")
        val agent = Agent(name = "Phone skill fixture", instructions = "captured-agent-marker")
        val project = Project(name = "Phone project fixture", instructions = "captured-project-marker")
        app.repository.saveAgent(agent); app.repository.saveProject(project)
        return app.repository.newChat(agent.id, project.id).also { id -> app.repository.editChat(id) { it.copy(connectionId = connection.id, phoneUseEnabled = enabled) } }
    }
    private suspend fun complete(id: String) { withTimeout(25_000) { while (app.engine.runtime.value.turns.containsKey(id)) delay(40) } }

    private fun device(id: String, args: JsonObject) = call("phone_action", id, args)
    private fun review(complete: Boolean, conversational: Boolean = false) = MockResponse().setBody(buildJsonObject {
        put("choices", buildJsonArray { add(buildJsonObject { put("finish_reason", "stop"); put("message", buildJsonObject {
            put("role", "assistant"); put("content", buildJsonObject {
                put("decision", if (complete) "complete" else "partial"); put("turnKind", if (conversational) "feedback" else "task")
                put("reasonType", if (complete) "fulfilled" else "unavailable"); put("reason", "Fixture delivery check")
                put("requirements", buildJsonArray { add(buildJsonObject {
                    put("text", if (conversational) "Explain previous execution" else "Read fixture")
                    put("kind", if (conversational) "response" else "external_fact"); put("status", if (complete) "met" else "missing")
                    put("evidenceIds", buildJsonArray { if (complete && !conversational) add("finished") })
                }) })
            }.toString())
        }) }) })
    }.toString())

    @Test fun ordinaryChatUsesOneLoopWithRealNativeReceiptsAndNoChildModel() = runBlocking {
        MockWebServer().use { server ->
            var round = 0
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val body = MeloJson.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                    if (body.toString().contains("You are Melo's task completion checker")) return review(true)
                    val offered = body["tools"]!!.jsonArray.map { it.jsonObject["function"]!!.jsonObject.text("name") }
                    assertTrue("phone_action" in offered); assertTrue("todo_list" in offered); assertTrue("calendar_list_events" in offered)
                    assertFalse("phone_use" in offered); assertFalse("android_device" in offered)
                    return when (++round) {
                        1 -> MockResponse().setHeader("Content-Type", "text/event-stream").setBody(
                            "data: " + """{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"observed","function":{"name":"phone_action","arguments":"{\"action\":\"observe\"}"}}]},"finish_reason":null}]}""" + "\n\n" +
                            "data: " + """{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}""" + "\n\ndata: [DONE]\n\n"
                        ).setBodyDelay(1, TimeUnit.SECONDS)
                        2 -> {
                            val receipt = body["messages"]!!.jsonArray.map { it.jsonObject }.last { it.text("role") == "tool" }
                            val screen = MeloJson.parseToJsonElement(receipt.text("content")).jsonObject
                            assertTrue(screen.toString().contains("Count 0"))
                            device("finished", buildJsonObject { put("action", "finish"); put("outcome", "achieved"); put("summary", "Fixture Count 0")
                                put("screen_id", screen.text("screen_id")); put("expected_package", "com.melo.android"); put("visible_text", "Count 0") })
                        }
                        else -> final()
                    }
                }
            }
            server.start(); val id = chat(server, stream = true)
            withContext(Dispatchers.Main) { assertTrue(app.engine.send(id, "请查看当前测试页面")) }
            val first = withContext(Dispatchers.IO) { server.takeRequest(5, TimeUnit.SECONDS) }!!
            assertTrue(first.body.clone().readUtf8().contains("phone_action"))
            assertTrue(first.body.clone().readUtf8().contains("\"stream\":true"))
            app.repository.draft(id, "next-message-draft-must-survive")
            val moveError = runCatching { app.repository.editChat(id) { it.copy(projectId = null) } }.exceptionOrNull()
            assertTrue(moveError is IllegalArgumentException)
            complete(id)
            val saved = app.repository.data.value
            val run = saved.deviceRuns.single { it.taskContext?.chatId == id }
            assertEquals("achieved", run.status); assertEquals("unified", run.executionMode); assertEquals(0, run.modelRequests)
            assertEquals(listOf("observe", "finish"), run.steps.map { it.action })
            assertEquals(saved.runs.last { it.chatId == id }.id, run.parentRunId)
            assertEquals("completed", saved.runs.last { it.chatId == id }.status)
            assertTrue(saved.chats.first { it.id == id }.messages.last().content.contains("Count 0"))
            repeat(2) {
                val body = withContext(Dispatchers.IO) { server.takeRequest(5, TimeUnit.SECONDS) }!!.body.readUtf8()
                assertTrue(body.contains("captured-model")); assertTrue(body.contains("captured-agent-marker")); assertTrue(body.contains("captured-project-marker"))
                assertFalse(body.contains("local-fixture-key"))
            }
            val checked = withContext(Dispatchers.IO) { server.takeRequest(5, TimeUnit.SECONDS) }!!.body.readUtf8()
            assertTrue(checked.contains("task completion checker")); assertFalse(checked.contains("android_device"))
            assertEquals(4, server.requestCount); assertFalse(app.deviceAgent.runtime.value.running)
            assertEquals("next-message-draft-must-survive", saved.drafts[id])
        }
    }
    @Test fun cancellingChatBeforeTheFirstNativeActionDoesNotAcquireADeviceLease() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(device("late", buildJsonObject { put("action", "observe") }).setBodyDelay(3, TimeUnit.SECONDS))
            server.start(); val id = chat(server)
            withContext(Dispatchers.Main) { assertTrue(app.engine.send(id, "查看取消测试页面")) }
            withContext(Dispatchers.IO) { assertNotNull(server.takeRequest(5, TimeUnit.SECONDS)) }
            withContext(Dispatchers.Main) { app.engine.cancel(id) }
            complete(id)
            val saved = app.repository.data.value
            assertTrue(saved.deviceRuns.none { it.taskContext?.chatId == id })
            assertFalse(app.deviceAgent.runtime.value.running)
            assertEquals(1, saved.chats.first { it.id == id }.messages.size)
            assertEquals("cancelled", saved.runs.last { it.chatId == id }.status)
            assertEquals(1, server.requestCount)
        }
    }
    @Test fun blockedDeviceWorkReturnsToTheSameLoopForAnHonestExplanation() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(device("blocked", buildJsonObject { put("action", "finish"); put("outcome", "blocked"); put("summary", "Fixture 需要登录，未继续") }))
            server.enqueue(final()); server.enqueue(review(false)); server.start(); val id = chat(server)
            withContext(Dispatchers.Main) { assertTrue(app.engine.send(id, "查看测试页面")) }; complete(id)
            assertEquals(3, server.requestCount)
            assertEquals("blocked", app.repository.data.value.deviceRuns.last { it.taskContext?.chatId == id }.status)
            assertFalse(app.deviceAgent.runtime.value.running)
        }
    }
    @Test fun feedbackAboutNavigationNeverStartsAnotherDeviceTask() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("""{"choices":[{"message":{"role":"assistant","content":"收到，这里应在验证导航开始后停止设备操作。"},"finish_reason":"stop"}]}""")); server.enqueue(review(true, conversational = true)); server.start(); val id = chat(server)
            withContext(Dispatchers.Main) { assertTrue(app.engine.send(id, "明明已经开始了导航，你这里还在一直找")) }; complete(id)
            assertEquals(2, server.requestCount)
            assertEquals("completed", app.repository.data.value.runs.last { it.chatId == id }.status)
            assertEquals("answer", app.repository.data.value.runs.last { it.chatId == id }.sharedScene!!.getValue("completion").jsonObject.text("kind"))
            assertTrue(app.repository.data.value.deviceRuns.none { it.taskContext?.chatId == id })
        }
    }
    @Test fun disabledPhoneSkillKeepsNativeOrganizerButCannotStartDeviceSession() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(final()); server.start(); val id = chat(server, false)
            withContext(Dispatchers.Main) { assertTrue(app.engine.send(id, "普通问答")) }; complete(id)
            val body = server.takeRequest(2, TimeUnit.SECONDS)!!.body.readUtf8()
            val names = MeloJson.parseToJsonElement(body).jsonObject.getValue("tools").jsonArray.map { it.jsonObject.getValue("function").jsonObject.text("name") }
            assertFalse(names.contains("phone_action")); assertFalse(names.contains("phone_use")); assertFalse(names.contains("android_device")); assertTrue(names.contains("todo_list"))
            assertEquals(1, server.requestCount); assertTrue(app.repository.data.value.deviceRuns.none { it.taskContext?.chatId == id })
        }
    }
    @Test fun deletingChatDuringPlanningCannotStartADeviceTaskOrRestoreItsMessages() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(device("deleted", buildJsonObject { put("action", "observe") }).setBodyDelay(1, TimeUnit.SECONDS)); server.start()
            val id = chat(server)
            withContext(Dispatchers.Main) { assertTrue(app.engine.send(id, "查看测试页面")) }
            withContext(Dispatchers.IO) { assertNotNull(server.takeRequest(5, TimeUnit.SECONDS)) }
            val snapshot = app.repository.snapshot()
            app.repository.acceptSnapshot(snapshot.copy(chats = snapshot.chats.filterNot { it.id == id }, deletedChats = snapshot.deletedChats + Deletion(id, java.time.Instant.now().plusSeconds(2).toString())))
            complete(id)
            assertTrue(app.repository.data.value.chats.none { it.id == id })
            assertTrue(app.repository.data.value.deviceRuns.none { it.taskContext?.chatId == id }); assertEquals(1, server.requestCount)
        }
    }
    @Test fun gatewayFailurePersistsItsActualCauseAndNeverStartsADeviceTask() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(504).setHeader("x-request-id", "gateway-fixture-1").setBody("private-upstream-error-body")); server.start()
            val id = chat(server, stream = true)
            withContext(Dispatchers.Main) { assertTrue(app.engine.send(id, "搜索 Surry Hills brunch 然后导航开车过去")) }; complete(id)
            val saved = app.repository.data.value; val run = saved.runs.last { it.chatId == id }
            assertTrue(run.error.orEmpty().contains("HTTP 504")); assertFalse(run.error.orEmpty().contains("private-upstream-error-body"))
            assertEquals("MODEL_HTTP_504", run.sharedScene!!.text("stopReason"))
            val steps = run.sharedScene!!.getValue("pipeline").jsonArray.map { it.jsonObject }
            val model = steps.single { it.text("id") == "model:1" }
            assertEquals("failed", model.text("status")); assertTrue(model.text("output").contains("MODEL_HTTP_504"))
            assertEquals(1, server.requestCount); assertTrue(saved.deviceRuns.none { it.taskContext?.chatId == id })
            assertEquals(1, saved.chats.first { it.id == id }.messages.size)
        }
    }
}
