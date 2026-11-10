package com.melo.android

import com.melo.android.data.RunRecord
import com.melo.android.ui.WarRoomPresentation
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Layout A (2026-11-06): the war room opens by itself once per live run at its
// first observable step, never for a plain reply, not again after the user
// closed it, and hands back at the end unless the user touched it.
class WarRoomPresentationTest {
    private fun scene(operations: Int = 0, pipeline: List<String> = emptyList(), waiting: Boolean = false) = buildJsonObject {
        put("operations", JsonArray(List(operations) { buildJsonObject { put("id", "op$it"); put("status", if (waiting && it == operations - 1) "waiting" else "running") } }))
        put("pipeline", JsonArray(pipeline.map { buildJsonObject { put("id", it) } }))
    }
    private fun run(id: String, status: String = "running", operations: Int = 0, pipeline: List<String> = emptyList(), waiting: Boolean = false) =
        RunRecord(id = id, chatId = "c", prompt = "q", status = status, sharedScene = scene(operations, pipeline, waiting))

    @Test fun plainReplyNeverOpens() {
        val rules = WarRoomPresentation()
        assertFalse(rules.shouldOpen(run("plain", pipeline = listOf("model:response")), presented = false))
        assertFalse(rules.shouldOpen(RunRecord(id = "none", chatId = "c", prompt = "q"), presented = false))
    }

    @Test fun firstObservableStepOpensOnceAndHandsBack() {
        val rules = WarRoomPresentation()
        assertTrue(rules.shouldOpen(run("r", operations = 1), presented = false))
        assertFalse("once per run", rules.shouldOpen(run("r", operations = 2), presented = false))
        assertFalse("still running", rules.shouldClose(run("r", operations = 2)))
        assertTrue(rules.shouldClose(run("r", status = "completed", operations = 2)))
        assertTrue(rules.shouldOpen(run("assigned", pipeline = listOf("internal:1")), presented = false))
        assertTrue(rules.shouldOpen(run("evaluated", pipeline = listOf("task-evaluation:1")), presented = false))
        assertFalse("already showing", rules.shouldOpen(run("other", operations = 1), presented = true))
    }

    @Test fun aDelayedHandBackNeverClosesALaterShowing() {
        val rules = WarRoomPresentation()
        rules.showingChanged()
        val scheduled = rules.showing
        assertTrue(rules.isCurrent(scheduled))
        rules.showingChanged(); rules.showingChanged() // closed, then reopened within the delay
        assertFalse("the earlier hand-back is stale", rules.isCurrent(scheduled))
    }

    @Test fun closedWhileRunningStaysClosedAndTouchedStaysOpen() {
        val rules = WarRoomPresentation()
        assertTrue(rules.shouldOpen(run("a", operations = 1), presented = false))
        rules.userClosed(run("a", operations = 1))
        assertFalse(rules.shouldOpen(run("a", operations = 3), presented = false))
        assertTrue(rules.shouldOpen(run("b", operations = 1), presented = false))
        rules.touched = true
        assertFalse(rules.shouldClose(run("b", status = "completed", operations = 1)))
        rules.userClosed(run("b", status = "completed", operations = 1))
        assertTrue("closing a finished run is not a dismissal", rules.shouldOpen(run("c2", operations = 1), presented = false))
        assertFalse(WarRoomPresentation.observable(null))
    }

    // 2026-11-10. A run's status after it ends is its outcome, not only "completed": every ended run is finished.
    @Test fun aRunThatEndedWithAnyOutcomeNeverOpensByItselfAndHandsBack() {
        for (outcome in listOf("completed", "partial", "blocked", "needs_user", "budget_exhausted", "unverified", "cancelled", "failed", "interrupted")) {
            val rules = WarRoomPresentation()
            assertTrue(outcome, WarRoomPresentation.finished(outcome))
            assertFalse("opening a chat whose last reply ended $outcome must not open the task space", rules.shouldOpen(run("old-$outcome", status = outcome, operations = 3, pipeline = listOf("internal:1")), presented = false))
            assertTrue(rules.shouldOpen(run("live-$outcome", operations = 1), presented = false))
            assertTrue("a live run that ends $outcome hands back to the chat", rules.shouldClose(run("live-$outcome", status = outcome, operations = 2)))
            assertFalse("an ended run needs nothing from the user here", WarRoomPresentation.needsUser(run("held-$outcome", status = outcome, operations = 1, waiting = true)))
            rules.userClosed(run("live-$outcome", status = outcome, operations = 2))
            assertTrue("closing an ended run is not a dismissal of the next one", rules.shouldOpen(run("next-$outcome", operations = 1), presented = false))
        }
        assertFalse(WarRoomPresentation.finished("running"))
    }
    @Test fun aReasonCodeAlreadyExplainedByTheSummaryIsNotRepeatedAsAnError() {
        for (code in listOf("GOAL_UNAVAILABLE", "LIMIT_DELIVERED", "GOAL_CHECK_UNAVAILABLE", "ROUND_LIMIT", "MISSING_TOOL_EVIDENCE")) {
            org.junit.Assert.assertNull(code, com.melo.android.ui.visibleRunError(code, summarized = true))
            org.junit.Assert.assertEquals("without a summary the code is the only explanation", code, com.melo.android.ui.visibleRunError(code, summarized = false))
        }
        for (message in listOf("模型服务或上游网关暂时不可用（HTTP 504）。", "请求已取消，提问和部分文字已保留。", "Request failed"))
            org.junit.Assert.assertEquals(message, com.melo.android.ui.visibleRunError(message, summarized = true))
        org.junit.Assert.assertNull(com.melo.android.ui.visibleRunError("  ", summarized = false)); org.junit.Assert.assertNull(com.melo.android.ui.visibleRunError(null, summarized = true))
        org.junit.Assert.assertEquals("未核验", com.melo.android.ui.executionStatus("unverified")); org.junit.Assert.assertEquals("等待补充", com.melo.android.ui.executionStatus("needs_user"))
    }

    @Test fun neverCoversAPromptThatNeedsTheUser() {
        val rules = WarRoomPresentation()
        assertTrue(WarRoomPresentation.needsUser(run("held", operations = 1, waiting = true)))
        assertFalse("never opens over a permission prompt", rules.shouldOpen(run("held", operations = 1, waiting = true), presented = false))
        assertTrue(rules.shouldOpen(run("held", operations = 1), presented = false))
        rules.stepAside(run("held", operations = 2, waiting = true))
        rules.userClosed(run("held", operations = 2, waiting = true))
        assertFalse(rules.shouldReturn(run("held", operations = 2, waiting = true)))
        assertTrue("comes back once the prompt is answered; stepping aside is not a dismissal", rules.shouldReturn(run("held", operations = 2)))
    }
}
