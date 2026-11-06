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
