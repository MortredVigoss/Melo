package com.melo.android

import android.app.UiAutomation
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.melo.android.data.*
import com.melo.android.data.Connection
import com.melo.android.device.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*
import java.security.MessageDigest

/** Real Accessibility + native cache replay, with a local fixture parent model only. */
class PhoneWorkflowFlowTest {
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
            app.engine.initialize().join(); withTimeout(15_000) { app.engine.runtime.first { it.initialized } }
            before = app.repository.data.value
            app.repository.change { it.copy(deviceScripts = emptyList()) }
            withContext(Dispatchers.Main) { app.engine.dismissError(); app.deviceAgent.dismissError() }
        }
        waitFor { DeviceAccess.service != null }
        app.startActivity(Intent(app, DeviceFixtureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); SystemClock.sleep(800)
    }
    @After fun restore() {
        if (!::automation.isInitialized) return
        runBlocking {
            withContext(Dispatchers.Main) { app.engine.cancel(); app.deviceAgent.cancel() }
            withTimeout(15_000) { while (app.engine.runtime.value.turns.isNotEmpty() || app.deviceAgent.runtime.value.running) delay(40) }
            before?.let { state -> app.repository.change { state } }
        }
        if (enabledBefore.isBlank()) shell("settings delete secure enabled_accessibility_services") else shell("settings put secure enabled_accessibility_services $enabledBefore")
        if (serviceName !in enabledBefore.split(':')) waitFor { DeviceAccess.service == null }
    }
    private fun response(content: String) = MockResponse().setBody(buildJsonObject {
        put("choices", buildJsonArray { add(buildJsonObject { put("finish_reason", "stop"); put("message", buildJsonObject { put("role", "assistant"); put("content", content) }) }) })
    }.toString())
    private suspend fun setupChat(server: MockWebServer): Pair<Conversation, DeviceScript> {
        val connection = Connection(name = "Workflow native fixture", endpoint = server.url("/model").toString(), model = "fixture-model", stream = false)
        app.repository.saveConnection(connection, "fixture-key")
        val id = app.repository.newChat()
        app.repository.editChat(id) { it.copy(connectionId = connection.id, phoneUseEnabled = true) }
        val state = app.repository.data.value; val chat = state.chats.first { it.id == id }
        val instructions = app.repository.instructions(chat, state)
        val scope = MessageDigest.getInstance("SHA-256").digest("${chat.agentId}|${chat.projectId.orEmpty()}|0|$instructions".toByteArray()).joinToString("") { "%02x".format(it) }
        val environment = withContext(Dispatchers.Main) { DeviceAccess.service!!.cacheEnvironment(0, setOf("com.android.settings")) }!!
        val recipe = DeviceScript(name = "Open Android settings", goalTemplate = "Open app com.android.settings", steps = listOf(ScriptStep("open_app", "com.android.settings")),
            completion = ScriptAssertion("com.android.settings"), scope = scope, verified = true, environment = environment, cacheKind = "action")
        app.repository.change { it.copy(deviceScripts = listOf(recipe)) }
        return chat to recipe
    }
    @Test fun chatInvokesPublishedActionNativelyAndContinuesParentLoopWithoutAProbe() = runBlocking {
        MockWebServer().use { server ->
            var workflowId = ""; var parentRequests = 0
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val raw = request.body.readUtf8(); val body = MeloJson.parseToJsonElement(raw).jsonObject
                    if (raw.contains("You are Melo's task completion checker")) return response("""{"decision":"complete","reasonType":"fulfilled","reason":"The published open-app subgoal is the entire user request","nextStep":"","requirements":[{"text":"Open settings","status":"met","evidenceIds":["native-open"]}]}""")
                    val offered = body["tools"]!!.jsonArray.map { it.jsonObject["function"]!!.jsonObject.text("name") }
                    assertFalse("Cache replay must not make any child-model request", "android_device" in offered)
                    assertTrue("phone_use" in offered); assertTrue("phone_workflow" in offered)
                    assertTrue("Every round receives the current Skill Manifest", raw.contains(workflowId))
                    return if (++parentRequests == 1) MockResponse().setBody(buildJsonObject {
                        put("choices", buildJsonArray { add(buildJsonObject { put("finish_reason", "tool_calls"); put("message", buildJsonObject {
                            put("role", "assistant"); put("tool_calls", buildJsonArray { add(buildJsonObject {
                                put("id", "native-open"); put("type", "function"); put("function", buildJsonObject { put("name", "phone_workflow"); put("arguments", buildJsonObject { put("workflow_id", workflowId); put("revision", 1); put("parameters", buildJsonObject {}) }.toString()) })
                            }) })
                        }) }) })
                    }.toString()) else response("已打开 Android 设置。")
                }
            }
            server.start(); val (chat, recipe) = setupChat(server); workflowId = "script.${recipe.id}"
            withContext(Dispatchers.Main) { assertTrue(app.engine.send(chat.id, "打开 Android 设置")) }
            withTimeout(30_000) { while (app.engine.runtime.value.turns.containsKey(chat.id)) delay(40) }
            val state = app.repository.data.value
            val run = state.deviceRuns.single { it.taskContext?.chatId == chat.id }
            assertEquals(run.error, "achieved", run.status); assertEquals("manual", run.executionMode)
            assertEquals(0, run.modelRequests); assertEquals("visible_facts", run.verification)
            assertEquals(recipe.id, run.scriptId); assertEquals(2, parentRequests); assertEquals(3, server.requestCount)
            assertTrue(state.chats.first { it.id == chat.id }.messages.last().content.contains("Android"))
        }
    }
    @Test fun editedDeletedOrPermissionRevokedRecipesAreRejectedBeforeNativeExecution() = runBlocking {
        MockWebServer().use { server ->
            server.start(); val (chat, recipe) = setupChat(server)
            val state = app.repository.data.value
            val connection = state.settings.connections.first { it.id == chat.connectionId }
            val host = PhoneWorkflowHost(app, app.repository, app.deviceAgent, ChatDeviceContext(chat, connection, "", app.repository.instructions(chat, state), "not-running"))
            assertEquals(1, host.catalog().size)
            val args = buildJsonObject { put("workflow_id", "script.${recipe.id}"); put("revision", 1); put("parameters", buildJsonObject {}) }
            app.repository.editDeviceScript(recipe, recipe.copy(name = "Edited by user"))
            assertFalse(host.invoke(args).ok); assertTrue(host.catalog().isEmpty())
            app.repository.deleteDeviceScript(recipe.id)
            assertFalse(host.invoke(args).ok)
            app.repository.editChat(chat.id) { it.copy(phoneUseEnabled = false) }
            assertEquals("WORKFLOW_SCOPE_CHANGED", host.invoke(args).data.text("code"))
            assertTrue(app.repository.data.value.deviceRuns.none { it.taskContext?.chatId == chat.id })
            assertEquals(0, server.requestCount)
        }
    }
}
