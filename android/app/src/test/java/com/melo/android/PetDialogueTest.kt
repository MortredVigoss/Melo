package com.melo.android

import com.melo.android.chat.ChatPhoneUse
import com.melo.android.chat.ChatRuntime
import com.melo.android.chat.ChatTurn
import com.melo.android.data.*
import com.melo.android.pet.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class PetDialogueTest {
    @Test fun markdownIsReducedToReadableText() {
        val markdown = "# 标题\n\n今天**很好**，看 [这里](https://example.com/a)。\n\n- 第一点\n- 第二点\n\n```js\nconsole.log(1)\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n> 引用 `code`"
        val spoken = PetDialogue.speechText(markdown)
        assertEquals("标题\n今天很好，看 这里。\n第一点\n第二点\n（代码略）\n， a ， b ，\n， 1 ， 2 ，\n引用 code", spoken)
        assertFalse(spoken.contains("https://")); assertFalse(spoken.contains("**")); assertFalse(spoken.contains("```"))
    }

    @Test fun bubbleShowsTheBeginningAndPointsToTheApp() {
        assertEquals("好的，我在。", PetDialogue.bubblePreview("好的，我在。"))
        assertEquals("", PetDialogue.bubblePreview("   "))
        val long = "一二三四五六七八九十".repeat(20)
        val preview = PetDialogue.bubblePreview(long)
        assertTrue(preview.startsWith(long.take(PetDialogue.PREVIEW_LIMIT))); assertTrue(preview.endsWith(PetDialogue.PREVIEW_SUFFIX))
        assertEquals(PetDialogue.PREVIEW_LIMIT + PetDialogue.PREVIEW_SUFFIX.length, preview.length)
        assertEquals("第一行 第二行", PetDialogue.bubblePreview("第一行\n\n第二行"))
    }

    @Test fun replyOutcomeWaitsForTheRunAndReadsTheSavedAssistantMessage() {
        val chat = Conversation(id = "pet-chat", messages = listOf(Message(role = "user", content = "你好")))
        val run = RunRecord(id = "run-1", chatId = chat.id, prompt = "你好")
        val running = AppData(chats = listOf(chat), runs = listOf(run))
        assertNull(PetDialogue.replyOutcome(running, chat.id, run.id))
        assertNull(PetDialogue.replyOutcome(running, chat.id, "missing"))
        val completed = running.copy(chats = listOf(chat.copy(messages = chat.messages + Message(role = "assistant", content = "回复 **正文**", runId = run.id))), runs = listOf(run.copy(status = "completed", partial = "回复")))
        val reply = PetDialogue.replyOutcome(completed, chat.id, run.id)!!
        assertTrue(reply.ok); assertEquals("回复 **正文**", reply.text)
        val failed = running.copy(runs = listOf(run.copy(status = "failed", partial = "半截", error = "服务不可用")))
        val failure = PetDialogue.replyOutcome(failed, chat.id, run.id)!!
        assertFalse(failure.ok); assertEquals("半截", failure.text); assertEquals("服务不可用", PetDialogue.failureText(failure))
        assertEquals("这次请求取消了。", PetDialogue.failureText(failure.copy(status = "cancelled", error = null)))
        assertEquals("这次没收到回复，再试一次吧。", PetDialogue.failureText(null))
    }

    @Test fun petChatOnlyReusesALiveUnarchivedConversation() {
        val chat = Conversation(id = "pet", title = PetChat.TITLE)
        val data = AppData(chats = listOf(chat, chat.copy(id = "archived", archived = true)))
        assertEquals("pet", PetChat.existing(data, "pet")?.id)
        assertNull(PetChat.existing(data, "archived")); assertNull(PetChat.existing(data, "gone")); assertNull(PetChat.existing(data, ""))
    }

    @Test fun preferencesClampSizeAndRestToTheSupportedRange() {
        val normalized = PetSettings.normalize(PetSettings(sizeDp = 5, restSeconds = 9999))
        assertEquals(PetSettings.MIN_SIZE_DP, normalized.sizeDp); assertEquals(PetSettings.MAX_REST_SECONDS, normalized.restSeconds)
        assertEquals(30_000L, PetSettings().restMinMs); assertEquals(60_000L, PetSettings().restMaxMs)
        assertTrue(PetSettings.LANGUAGES.first().first.isBlank())
    }

    // ── Asking the pet a question: the two bounded waits (2026-11-14) ──
    // The pet used withTimeout for them. Its exception is a CancellationException, which the surrounding catch
    // has to rethrow, so a timeout ended the coroutine silently and the pet stayed in "想想看…" for good.

    @Test fun aWaitThatRunsOutReturnsNullInsteadOfCancellingTheCaller() = runBlocking {
        val runtime = MutableStateFlow(ChatRuntime(initialized = false))
        var reachedTheLineAfterTheWait = false
        val started = System.nanoTime()
        val state = PetDialogue.awaitState(runtime, 120) { it.initialized }
        reachedTheLineAfterTheWait = true
        assertNull(state)
        assertTrue("the caller goes on to report the failure", reachedTheLineAfterTheWait)
        assertTrue((System.nanoTime() - started) / 1_000_000 in 100..5_000)
    }

    @Test fun aTurnTheEngineGivesUpEndsTheWaitAtOnceAndHasNoRun() = runBlocking {
        // What ChatEngine does without a model connection: the turn is there without a run id, then it is removed
        // and the reason is left in `error`.
        val runtime = MutableStateFlow(ChatRuntime(initialized = true, turns = mapOf("pet-chat" to ChatTurn())))
        launch { delay(60); runtime.update { it.copy(turns = emptyMap(), error = "请先在「系统 → 模型连接」配置服务。") } }
        val started = System.nanoTime()
        val state = PetDialogue.awaitState(runtime, 10_000) { value -> value.turns["pet-chat"].let { it == null || it.runId != null } }
        assertTrue("it does not sit out the ten seconds", (System.nanoTime() - started) / 1_000_000 < 3_000)
        assertNotNull(state); assertNull(state!!.turns["pet-chat"])
        assertEquals("请先在「系统 → 模型连接」配置服务。", state.error)
        assertNull(PetDialogue.startedRunId(state.turns["pet-chat"]?.runId, AppData(), "pet-chat", emptySet()))
    }

    @Test fun aTurnThatStartsARunIsRecognisedWhileLiveAndAfterItFinished() = runBlocking {
        val runtime = MutableStateFlow(ChatRuntime(initialized = true, turns = mapOf("pet-chat" to ChatTurn())))
        launch { delay(40); runtime.update { it.copy(turns = mapOf("pet-chat" to ChatTurn("run-2"))) } }
        val live = PetDialogue.awaitState(runtime, 10_000) { value -> value.turns["pet-chat"].let { it == null || it.runId != null } }
        assertEquals("run-2", PetDialogue.startedRunId(live!!.turns["pet-chat"]?.runId, AppData(), "pet-chat", setOf("run-1")))
        // The turn is already gone (a very fast reply): the run is the one that was not there before the send.
        val data = AppData(runs = listOf(
            RunRecord(id = "run-1", chatId = "pet-chat", prompt = "之前"),
            RunRecord(id = "other", chatId = "another-chat", prompt = "别的对话"),
            RunRecord(id = "run-2", chatId = "pet-chat", prompt = "这次")))
        assertEquals("run-2", PetDialogue.startedRunId(null, data, "pet-chat", setOf("run-1")))
        assertNull("no new run of this chat: nothing started", PetDialogue.startedRunId(null, data, "pet-chat", setOf("run-1", "run-2")))
    }

    @Test fun everyNameAPhoneActionArrivesUnderCountsForTheFailedActionRule() {
        // `phone_action` is the name the product sends; until 2026-11-14 the rule that stops the remaining calls of a
        // response after a failed phone action compared with `phone_use` only.
        assertEquals(setOf("phone_use", "phone_workflow", "phone_action"), ChatPhoneUse.actionTools)
        assertFalse("web_search" in ChatPhoneUse.actionTools)
    }
}
