package com.melo.android

import android.Manifest
import android.content.Context
import android.content.Intent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.rule.GrantPermissionRule
import androidx.test.platform.app.InstrumentationRegistry
import com.melo.android.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.Assume.assumeNotNull
import kotlinx.serialization.json.*
import java.util.concurrent.atomic.AtomicReference

class AndroidFlowTest {
    @get:Rule val permission: GrantPermissionRule = GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val app get() = ApplicationProvider.getApplicationContext<MeloApplication>()
    private fun ready() = runBlocking { withTimeout(10_000) { app.engine.runtime.first { it.initialized } } }
    @Test fun fixtureChatCancellationRetryAndActivityRecreation() {
        ready()
        runBlocking {
            val fixture = Connection(id = "instrumentation-fixture", name = "本地 Fixture", model = "local-fixture", protocol = "fixture")
            app.repository.saveConnection(fixture, null)
            app.repository.change { it.copy(settings = it.settings.copy(activeConnection = fixture.id, reduceMotion = true)) }
        }
        compose.onNodeWithText("开始新对话").performClick()
        compose.waitUntil(8000) { compose.onAllNodesWithTag("composer").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("composer").performTextInput("Android fixture lifecycle check")
        compose.onNodeWithContentDescription("发送").performClick()
        compose.waitUntil(15_000) { app.repository.data.value.runs.any { it.prompt == "Android fixture lifecycle check" && it.status == "completed" } }
        val chat = app.repository.data.value.chats.first { it.messages.any { message -> message.content == "Android fixture lifecycle check" } }
        assertTrue(chat.messages.last().content.contains("没有调用真实模型服务"))
        assertTrue(app.repository.data.value.runs.last().simulated)
        SyncProtocol.validate(app.repository.snapshot(), app.repository.schema)
        compose.activityRule.scenario.recreate()
        compose.waitUntil(8000) { compose.onAllNodesWithTag("composer").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("composer").performTextInput("cancel and retry fixture")
        compose.onNodeWithContentDescription("发送").performClick()
        compose.waitUntil(5000) { compose.onAllNodesWithContentDescription("停止生成").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("停止生成").performClick()
        compose.waitUntil(5000) { app.repository.data.value.runs.last().status == "cancelled" }
        assertEquals(1, app.repository.data.value.chats.first { it.id == chat.id }.messages.count { it.content == "cancel and retry fixture" })
        compose.onNodeWithText("重试这次提问").performScrollTo().performClick()
        compose.waitUntil(15_000) { app.repository.data.value.runs.last().status == "completed" }
        val final = app.repository.data.value.chats.first { it.id == chat.id }
        assertEquals(1, final.messages.count { it.content == "cancel and retry fixture" })
        assertEquals(2, final.messages.count { it.role == "assistant" })
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
        app.startActivity(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
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
