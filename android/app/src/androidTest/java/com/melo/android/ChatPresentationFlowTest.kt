package com.melo.android

import android.content.Intent
import android.os.Build
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.font.FontWeight
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.melo.android.core.*
import com.melo.android.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import org.junit.*
import org.junit.Assert.*
import java.io.File

class ChatPresentationFlowTest {
    @get:Rule val ui = createAndroidComposeRule<MainActivity>()
    private val app get() = ApplicationProvider.getApplicationContext<MeloApplication>()
    private var before: AppData? = null
    @Before fun setup() = runBlocking {
        Assume.assumeTrue(Build.FINGERPRINT.contains("generic") || Build.MODEL.contains("sdk_gphone"))
        withTimeout(15_000) { app.engine.runtime.first { it.initialized } }
        before=app.repository.data.value
        Unit
    }
    @After fun restore() = runBlocking {
        // Explicit Emulator-only seed for black-box verification after replacing
        // Debug with the final R8 APK. The read-only AVD overlay is discarded.
        if (InstrumentationRegistry.getArguments().getString("keepPresentationFixture") != "true") before?.let { snapshot -> app.repository.change { snapshot } }
        Unit
    }
    private fun show(id: String) {
        val title = "UI ${id.take(8)}"
        runBlocking { app.repository.editChat(id) { it.copy(title = title) } }
        ui.onAllNodesWithText("中枢").onLast().performClick()
        ui.onAllNodesWithText("对话").onLast().performClick()
        ui.waitUntil(10_000) { ui.onAllNodesWithText(title).fetchSemanticsNodes().isNotEmpty() }
        ui.onNodeWithText(title).performClick()
        ui.waitUntil(10_000) { ui.onAllNodesWithTag("composer").fetchSemanticsNodes().isNotEmpty() }
        ui.waitForIdle()
    }
    private fun scrollToTag(tag: String) { ui.onNodeWithTag("chat-timeline").performScrollToNode(hasTestTag(tag)); ui.onNodeWithTag(tag).assertExists() }

    @Test fun executionIsCollapsedByDefaultSurvivesRecreationAndShowsObservedSources() = runBlocking {
        val id=app.repository.newChat(); val start=now()
        val scene=SharedCoreRuntime.open(app).use { runtime ->
            val created=runtime.value("scene",buildJsonObject { put("action","create");put("runId","presentation-r");put("chatId",id);put("query","UI Fixture");put("at",start) })
            val observed=runtime.value("scene",buildJsonObject { put("action","event");put("scene",created);put("at",start);put("event",buildJsonObject {
                put("kind","operation");put("id","s");put("name","web_search");put("module","search");put("status","completed");put("input","Fixture brunch query");put("output","Fixture returned one source");put("durationMs",12)
                put("sources",buildJsonArray { add(buildJsonObject { put("url","https://fixture.invalid/menu");put("title","Fixture source");put("reading","snippet") }) })
            }) })
            runtime.value("scene",buildJsonObject { put("action","finish");put("scene",observed);put("outcome","partial");put("reason","PHONE_UNAVAILABLE");put("at",start) }).jsonObject
        }
        val run=RunRecord(id="presentation-r",chatId=id,prompt="UI Fixture",status="partial",startedAt=start,finishedAt=start,sharedScene=scene)
        app.repository.change { current -> current.copy(runs=current.runs+run,chats=current.chats.map { if(it.id==id) it.copy(messages=listOf(Message(role="user",content="UI Fixture",createdAt=start),Message(role="assistant",content="Fixture answer",runId=run.id))) else it }) }
        show(id);scrollToTag("execution-toggle-${run.id}")
        ui.onNodeWithTag("execution-content-${run.id}").assertDoesNotExist()
        ui.onNodeWithText("1 次工具调用 · 1 个来源").assertExists()
        assertTrue(ui.onNodeWithTag("execution-card-${run.id}").fetchSemanticsNode().boundsInRoot.bottom <= ui.onNodeWithText("Fixture answer").fetchSemanticsNode().boundsInRoot.top)
        ui.onNodeWithTag("execution-toggle-${run.id}").performClick()
        ui.onNodeWithTag("execution-content-${run.id}").assertExists()
        ui.onNodeWithText("web_search · 完成 · 12 ms").assertExists()
        ui.onNodeWithText("仅来源 / 搜索摘要 · 未记录网页全文读取").assertExists()
        ui.activityRule.scenario.recreate();ui.waitForIdle()
        scrollToTag("execution-content-${run.id}")
        ui.onNodeWithText("停止原因：PHONE_UNAVAILABLE").assertExists()
        File(app.cacheDir,"chat-execution-card.png").outputStream().use { ui.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) }
        ui.onNodeWithTag("execution-toggle-${run.id}").performClick()
        ui.onNodeWithTag("execution-content-${run.id}").assertDoesNotExist()
    }

    @Test fun markdownHasFormattedTextCodeAndScrollableTableWhileLegacyTraceStaysUnknown() = runBlocking {
        val id=app.repository.newChat();val run=RunRecord(chatId=id,prompt="Markdown fixture",status="completed",finishedAt=now())
        val markdown="# Fixture heading\n\n- **Single O** brunch\n\n[Maps link](https://fixture.invalid/map)\n\n```kotlin\nval item_name = \"literal * code\"\n```\n\n| Name | Evidence |\n|---|---|\n| A | Page was read |"
        app.repository.change { current -> current.copy(runs=current.runs+run,chats=current.chats.map { if(it.id==id) it.copy(messages=listOf(Message(role="assistant",content=markdown,runId=run.id))) else it }) }
        show(id)
        ui.waitUntil(15_000) { ui.onAllNodesWithTag("reply-markdown").fetchSemanticsNodes().isNotEmpty() }
        ui.onNodeWithTag("chat-timeline").performScrollToNode(hasText("Single O brunch"))
        val text=ui.onNodeWithText("Single O brunch").fetchSemanticsNode().config[SemanticsProperties.Text].single()
        assertTrue(text.spanStyles.any { it.item.fontWeight==FontWeight.Bold })
        ui.onNodeWithText("**Single O** brunch").assertDoesNotExist()
        ui.onNodeWithText("Maps link").assertExists()
        ui.onNodeWithTag("chat-timeline").performScrollToNode(hasText("val item_name = \"literal * code\""))
        ui.onNodeWithText("val item_name = \"literal * code\"").assertExists()
        scrollToTag("reply-table");ui.onNodeWithTag("reply-table").performTouchInput { swipeLeft() }
        ui.onNodeWithText("Page was read").assertIsDisplayed()
        File(app.cacheDir,"chat-markdown.png").outputStream().use { ui.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) }
        scrollToTag("execution-toggle-${run.id}");ui.onNodeWithText("未记录工具明细").assertExists()
        ui.onNodeWithTag("execution-toggle-${run.id}").performClick()
        ui.onNodeWithText("这条旧记录没有保存工具细节，无法据此推断是否检索或操作过手机。").assertExists()
        assertEquals(before!!.settings.connections,app.repository.data.value.settings.connections)
    }
}
