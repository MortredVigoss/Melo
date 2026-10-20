package com.melo.android

import android.Manifest
import android.content.Context
import android.content.Intent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.test.core.app.ApplicationProvider
import androidx.test.rule.GrantPermissionRule
import androidx.test.platform.app.InstrumentationRegistry
import com.melo.android.data.*
import com.melo.android.device.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.Assume.assumeNotNull
import kotlinx.serialization.json.*
import java.util.concurrent.atomic.AtomicReference
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.SocketPolicy

class AndroidFlowTest {
    @get:Rule val permission: GrantPermissionRule = GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val app get() = ApplicationProvider.getApplicationContext<MeloApplication>()
    private fun ready() = runBlocking { withTimeout(10_000) { app.engine.runtime.first { it.initialized } } }
    @Test fun ordinaryChatContainsDeviceCardsWithoutAModeSwitchAndSurvivesRecreation() {
        ready()
        compose.onNodeWithText("开始新对话").performClick()
        compose.waitUntil(8000) { compose.onAllNodesWithTag("composer").fetchSemanticsNodes().isNotEmpty() }
        val chat = app.repository.data.value.chats.first()
        val run = DeviceRun(goal = "打开设置并检查页面", connectionName = "Local UI Fixture", status = "blocked", answer = "Fixture：需要登录，未执行后续操作。",
            steps = listOf(DeviceStep("observe", true, "Fixture 观察回执", callId = "fixture-ui")), taskContext = DeviceTaskContext(chat.id, chat.agentId, chat.projectId, "fixture-ui-connection"))
        runBlocking { app.repository.change { it.copy(deviceRuns = it.deviceRuns + run) } }
        compose.onNodeWithTag("device-mode").assertDoesNotExist()
        compose.onNodeWithText("输入消息…").assertExists()
        compose.onNodeWithTag("device-task-${run.id}").assertExists()
        compose.onNodeWithText("查看操作步骤").performScrollTo().performClick()
        compose.onNodeWithText("Fixture：需要登录，未执行后续操作。").assertExists()
        compose.onNodeWithTag("composer").performTextInput("保留下一次操作草稿")
        compose.activityRule.scenario.recreate()
        compose.waitUntil(8000) { compose.onAllNodesWithTag("composer").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("composer").assertTextContains("保留下一次操作草稿")
        compose.onNodeWithTag("device-mode").assertDoesNotExist()
        compose.onNodeWithTag("chat-cache-open").assertExists()
        compose.onNodeWithTag("device-task-${run.id}").assertExists()
        assertFalse(MeloJson.encodeToString(app.repository.snapshot()).contains("Local UI Fixture"))
        compose.runOnIdle { if (android.os.Build.VERSION.SDK_INT >= 30) compose.activity.window.decorView.windowInsetsController?.hide(android.view.WindowInsets.Type.ime()) }
        compose.waitForIdle()
        runBlocking { app.repository.editChat(chat.id) { it.copy(messages = it.messages + Message(role = "assistant", content = "Fixture 后续回复", createdAt = java.time.Instant.parse(run.startedAt).plusSeconds(1).toString())) } }
        compose.onNodeWithText("Fixture 后续回复").performScrollTo().assertExists()
        assertTrue("Follow-up replies must appear after the device task", compose.onNodeWithText("Fixture 后续回复").fetchSemanticsNode().boundsInRoot.top > compose.onNodeWithTag("device-task-${run.id}").fetchSemanticsNode().boundsInRoot.top)
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()?.let { bitmap ->
            java.io.File(app.cacheDir, "mobile-use-chat-ui.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }
    @Test fun connectionEditorRequiresALocalCredentialAndBlankEditsPreserveIt() {
        ready()
        val connectionName = "Credential regression ${newId().take(8)}"
        compose.onAllNodesWithText("系统").onFirst().performClick()
        compose.onNodeWithTag("settings-list").performScrollToNode(hasText("添加模型连接"))
        compose.onNodeWithText("添加模型连接").assertIsDisplayed().performClick()
        compose.onNodeWithText("连接名称").performTextReplacement(connectionName)
        compose.onNodeWithText("模型名称").performTextInput("fixture-model")
        compose.onNodeWithText("保存").performClick()
        compose.onNodeWithText("连接「$connectionName」缺少本机 API 凭证，请在「系统 → 模型连接」中填写并保存。").assertExists()
        assertFalse(app.repository.data.value.settings.connections.any { it.name == connectionName })
        compose.onNodeWithText("知道了").performClick()
        compose.onNodeWithTag("connection-key").performScrollTo().performTextInput("local-fixture-secret-only")
        compose.onNodeWithText("保存").performClick()
        compose.waitUntil(5000) { app.repository.data.value.settings.connections.any { it.name == connectionName } }
        compose.onNode(hasText(connectionName) and hasText("本机凭证已保存 · 服务需发送请求验证", substring = true)).assertExists()
        val connection = app.repository.data.value.settings.connections.first { it.name == connectionName }
        compose.onNodeWithTag("settings-list").performScrollToNode(hasText(connectionName))
        compose.onNodeWithText(connectionName).assertIsDisplayed().performClick()
        assertEquals("", compose.onNodeWithTag("connection-key").fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        compose.onNodeWithText("保存").performClick()
        runBlocking {
            val reopened = Repository(app)
            reopened.initialize()
            assertEquals("local-fixture-secret-only", reopened.credential(connection.id))
            assertTrue(reopened.data.value.settings.connections.any { it.id == connection.id })
        }
        assertTrue(app.repository.data.value.runs.none { it.requestedModel == "fixture-model" })
    }
    @Test fun chatOverrideWithMissingCredentialPreservesDraftWithoutCreatingARun() {
        ready()
        val missing = Connection(name = "Old chat override", model = "fixture-model")
        val id = runBlocking {
            val global = Connection(name = "Available global", model = "fixture-model")
            app.repository.saveConnection(global, "fixture-global-key")
            app.repository.change { it.copy(settings = it.settings.copy(connections = it.settings.connections + missing, activeConnection = global.id)) }
            app.repository.newChat().also { chat ->
                app.repository.editChat(chat) { it.copy(connectionId = missing.id) }
                app.repository.draft(chat, "keep this draft")
            }
        }
        compose.runOnIdle { app.engine.send(id, "keep this draft") }
        compose.waitUntil(5000) { app.engine.runtime.value.error?.contains("Old chat override") == true }
        assertTrue(app.engine.runtime.value.error!!.contains("API 凭证"))
        assertEquals("keep this draft", app.repository.data.value.drafts[id])
        assertTrue(app.repository.data.value.chats.first { it.id == id }.messages.isEmpty())
        assertTrue(app.repository.data.value.runs.none { it.chatId == id })
        compose.runOnIdle { app.engine.dismissError() }
    }
    @Test fun fixtureChatCancellationRetryAndActivityRecreation() {
        ready()
        runBlocking {
            val fixture = Connection(id = "instrumentation-fixture", name = "本地 Fixture", model = "local-fixture", protocol = "fixture")
            app.repository.saveConnection(fixture, null)
            app.repository.change { it.copy(settings = it.settings.copy(activeConnection = fixture.id, reduceMotion = true)) }
        }
        compose.onNodeWithText("开始新对话").performClick()
        compose.waitUntil(8000) { compose.onAllNodesWithTag("composer").fetchSemanticsNodes().isNotEmpty() }
        val chatId = app.repository.data.value.chats.first().id
        val prompt = "Android fixture lifecycle check ${newId().take(8)}"
        val retryPrompt = "cancel and retry fixture ${newId().take(8)}"
        compose.onNodeWithTag("composer").performTextInput(prompt)
        compose.onNodeWithContentDescription("发送").performClick()
        try { compose.waitUntil(15_000) { app.repository.data.value.runs.any { it.chatId == chatId && it.prompt == prompt && it.status == "completed" } } }
        catch (e: androidx.compose.ui.test.ComposeTimeoutException) { error("Fixture send did not complete: runtime=${app.engine.runtime.value}, runs=${app.repository.data.value.runs.map { Triple(it.prompt, it.status, it.error) }}") }
        val chat = app.repository.data.value.chats.first { it.id == chatId }
        assertTrue(chat.messages.last().content.contains("没有调用真实模型服务"))
        assertTrue(app.repository.data.value.runs.last { it.chatId == chatId }.simulated)
        SyncProtocol.validate(app.repository.snapshot(), app.repository.schema)
        compose.activityRule.scenario.recreate()
        compose.waitUntil(8000) { compose.onAllNodesWithTag("composer").fetchSemanticsNodes().isNotEmpty() }
        // Hold a real local HTTP response until cancellation. The ordinary
        // fixture completes on a timer, which raced Compose's separate find
        // and click steps on busy CI emulators.
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("""{"model":"local-fixture","choices":[{"message":{"role":"assistant","content":"Controlled retry completed"},"finish_reason":"stop"}]}"""))
            server.start()
            runBlocking {
                val controlled = Connection(id = "controlled-cancellation", name = "Controlled local HTTP", endpoint = server.url("/model").toString(), model = "local-fixture", protocol = "chat-completions", stream = false)
                app.repository.saveConnection(controlled, "local-fixture-key")
                app.repository.editChat(chatId) { it.copy(connectionId = controlled.id) }
            }
            compose.onNodeWithTag("composer").performTextInput(retryPrompt)
            compose.onNodeWithContentDescription("发送").performClick()
            compose.waitUntil(15_000) { server.requestCount == 1 && compose.onAllNodesWithContentDescription("停止生成").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithContentDescription("停止生成").performClick()
            compose.waitUntil(5000) { app.repository.data.value.runs.last { it.chatId == chatId }.status == "cancelled" }
            assertEquals(1, app.repository.data.value.chats.first { it.id == chat.id }.messages.count { it.content == retryPrompt })
            compose.onNodeWithText("重试这次提问").performScrollTo().performClick()
            compose.waitUntil(15_000) { app.repository.data.value.runs.last { it.chatId == chatId }.status == "completed" }
            val final = app.repository.data.value.chats.first { it.id == chat.id }
            assertEquals(1, final.messages.count { it.content == retryPrompt })
            assertEquals(2, final.messages.count { it.role == "assistant" })
            assertEquals(2, server.requestCount)
        }
    }
    @Test fun credentialsAreEncryptedAndExcludedFromPortableState() {
        ready()
        val fixtureSecret = "instrumentation-only-not-a-real-key"
        runBlocking { app.repository.saveCredential("instrumentation-secret", fixtureSecret) }
        val stored = app.getSharedPreferences("melo.credentials", Context.MODE_PRIVATE).getString("instrumentation-secret", "")!!
        assertFalse(stored.contains(fixtureSecret))
        assertEquals(fixtureSecret, runBlocking { app.repository.credential("instrumentation-secret") })
        assertFalse(MeloJson.encodeToString(app.repository.snapshot()).contains(fixtureSecret))
        runBlocking { app.repository.saveCredential("instrumentation-secret", "") }
    }
    @Test fun sharedNeuralSceneRendersFiveConnections() {
        ready()
        fun find(view: View): WebView? {
            if (view is WebView) return view
            if (view is ViewGroup) for (index in 0 until view.childCount) find(view.getChildAt(index))?.let { return it }
            return null
        }
        val result = AtomicReference<JsonObject?>()
        compose.waitUntil(15_000) {
            compose.activity.runOnUiThread {
                find(compose.activity.window.decorView)?.evaluateJavascript("JSON.stringify({height:document.getElementById('neural')?.clientHeight,connections:document.querySelector('canvas')?.dataset.connections})") { value ->
                    runCatching { MeloJson.parseToJsonElement(MeloJson.parseToJsonElement(value).jsonPrimitive.content).jsonObject }.getOrNull()?.let(result::set)
                }
            }
            result.get()?.let { it.text("connections") == "5" && (it["height"]?.jsonPrimitive?.intOrNull ?: 0) > 48 } == true
        }
        compose.onNodeWithText("场景暂时不可用，原生页面和任务记录仍可使用。").assertDoesNotExist()
    }
    @Test fun persistedDraftAndInterruptedTurnRecoverWithoutDuplicatePrompt() {
        ready()
        runBlocking {
            val repository = app.repository
            val id = repository.newChat()
            repository.draft(id, "unsent fixture draft")
            val prompt = Message(role = "user", content = "interrupted fixture turn")
            val run = RunRecord(chatId = id, prompt = prompt.content, partial = "partial fixture")
            repository.change { state -> state.copy(chats = state.chats.map { if (it.id == id) it.copy(messages = listOf(prompt)) else it }, runs = state.runs + run) }
            val reopened = Repository(app)
            reopened.initialize()
            val recovered = reopened.data.value
            assertEquals("unsent fixture draft", recovered.drafts[id])
            assertEquals("interrupted", recovered.runs.first { it.id == run.id }.status)
            assertEquals("partial fixture", recovered.runs.first { it.id == run.id }.partial)
            assertEquals(1, recovered.chats.first { it.id == id }.messages.size)
            // Keep the in-process test repository consistent with the recovered disk state.
            repository.change { recovered }
        }
    }
    @Test fun foregroundReplyContinuesWhileActivityIsStopped() {
        ready()
        val id = runBlocking {
            val connection = Connection(id = "background-fixture", name = "Fixture", protocol = "fixture", model = "local-fixture")
            app.repository.saveConnection(connection, null)
            app.repository.change { it.copy(settings = it.settings.copy(activeConnection = connection.id)) }
            app.repository.newChat()
        }
        compose.runOnIdle { app.engine.send(id, "background fixture check") }
        compose.waitUntil(5000) { app.engine.runtime.value.busyChatId == id }
        compose.runOnIdle { compose.activity.moveTaskToBack(true) }
        compose.waitUntil(15_000) { app.repository.data.value.runs.any { it.chatId == id && it.status == "completed" } }
        // Retain ActivityScenario's launch identity when onNewIntent updates the Activity intent.
        app.startActivity(Intent(compose.activity.intent).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
        compose.waitUntil(5000) { compose.activity.lifecycle.currentState == androidx.lifecycle.Lifecycle.State.RESUMED }
        assertEquals(1, app.repository.data.value.chats.first { it.id == id }.messages.count { it.role == "assistant" })
    }
    @Test fun importedExecutionEvidenceReachesTheSharedRenderer() {
        ready()
        val chatId = newId()
        val run = RunRecord(chatId = chatId, prompt = "synced fixture question", status = "completed", finishedAt = now(), requestedModel = "fixture", simulated = true)
        val user = WireMessage(newId(), "user", run.prompt, run.startedAt)
        val assistant = WireMessage(newId(), "assistant", "Synced fixture answer", java.time.Instant.parse(run.startedAt).plusMillis(1).toString())
        val projectId = newId()
        val workspace = SyncProtocol.put(SyncProtocol.put(Workspace(), "project", projectId, buildJsonObject {
            put("name", "Fixture project"); put("goal", "Preserve desktop context"); put("agentOverrides", buildJsonObject { put("main", buildJsonObject { put("name", "Desktop role") }) })
        }, "fixture-phone"), "message", assistant.id, run.messageMetadata(), "fixture-phone")
        val incoming = Snapshot(chats = listOf(WireChat(chatId, "Synced fixture", run.startedAt, now(), listOf(user, assistant))), workspace = workspace)
        runBlocking { app.repository.acceptSnapshot(incoming) }
        assertEquals(run.id, app.repository.data.value.chats.first { it.id == chatId }.messages.first { it.id == assistant.id }.runId)
        assertTrue(app.repository.data.value.runs.first { it.id == run.id }.simulated)
        runBlocking { app.repository.saveProject(app.repository.data.value.projects.first { it.id == projectId }.copy(name = "Edited on Android")) }
        val projectValue = app.repository.data.value.workspace.records.first { it.id == projectId }.versions.single().value
        assertEquals("Preserve desktop context", projectValue.text("goal"))
        assertEquals("Desktop role", projectValue.getValue("agentOverrides").jsonObject.getValue("main").jsonObject.text("name"))
        compose.onNodeWithText("对话").performClick()
        compose.onNodeWithText("Synced fixture").performScrollTo().performClick()
        compose.onNodeWithText("执行记录").performScrollTo().performClick()
        fun find(view: View): WebView? {
            if (view is WebView) return view
            if (view is ViewGroup) for (index in 0 until view.childCount) find(view.getChildAt(index))?.let { return it }
            return null
        }
        val rendered = AtomicReference(false)
        compose.waitUntil(15_000) {
            compose.activity.runOnUiThread {
                find(compose.activity.window.decorView)?.evaluateJavascript("Number(document.querySelector('.execution-webgl')?.dataset.frames || 0) > 0") { rendered.set(it == "true") }
            }
            rendered.get()
        }
        compose.onNodeWithText("场景暂时不可用，原生页面和任务记录仍可使用。").assertDoesNotExist()
    }
    @Test fun bidirectionalSyncUsesTheExistingNodeServiceWithoutFalseConflicts() {
        ready()
        val endpoint = InstrumentationRegistry.getArguments().getString("syncEndpoint")
        assumeNotNull("Run npm run test:android:connected for the isolated Node fixture service.", endpoint)
        runBlocking {
            val repository = app.repository
            repository.change { it.copy(settings = it.settings.copy(syncEndpoint = endpoint!!)) }
            repository.saveCredential("sync", "android-instrumentation-fixture-token-only")
            val project = Project(name = "Node round trip", instructions = "Fixture context")
            repository.saveProject(project)
            val chatId = repository.newChat(projectId = project.id)
            repository.saveMemory(MemoryFact(text = "Fixture memory", chatId = chatId))
            repository.synchronize(app.engine.client)
            repository.synchronize(app.engine.client)
            assertTrue(repository.data.value.workspace.records.all { it.versions.size == 1 })
            assertTrue(repository.data.value.chats.any { it.id == chatId })
            repository.deleteChat(chatId)
            repository.synchronize(app.engine.client)
            repository.synchronize(app.engine.client)
            assertFalse(repository.data.value.chats.any { it.id == chatId })
            assertTrue(repository.data.value.deletedChats.any { it.id == chatId })
            assertTrue(repository.data.value.memories.none { it.chatId == chatId })
        }
    }
}
