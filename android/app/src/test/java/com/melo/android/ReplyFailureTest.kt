package com.melo.android

import com.melo.android.chat.replyFailure
import com.melo.android.core.SharedBudgetExhausted
import com.melo.android.core.SharedTurnStopped
import com.melo.android.network.ModelRequestFailure
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

// 2026-11-10. In one full emulator run a reply the user had stopped was recorded as blocked with
// "共享 Runtime 执行中断": an engine error surfaced in the same moment and its type decided the
// record. These tests pin how the end of a reply is recorded and what is thrown on to the engine,
// which tells "stopped" from "failed" by the type of what reaches it.
class ReplyFailureTest {
    @Test fun aStoppedReplyIsRecordedAsStoppedWhateverElseFailed() {
        val engine = IllegalStateException("共享 Runtime 执行中断（IsolateTerminatedException），已停止；没有自动重放操作。")
        val (reason, thrown) = replyFailure(stopped = true, error = engine)
        assertEquals("CANCELLED", reason)
        assertTrue(thrown is CancellationException)
        assertSame("the engine error stays reachable for diagnosis", engine, thrown.cause)
        val cancellation = CancellationException("stop")
        assertSame(cancellation, replyFailure(true, cancellation).second)
        for (other in listOf(SharedBudgetExhausted(), SharedTurnStopped("ROUND_LIMIT"), ModelRequestFailure("MODEL_HTTP_500", "http-response", "fixture"))) {
            val (stoppedReason, stoppedError) = replyFailure(true, other)
            assertEquals("CANCELLED", stoppedReason); assertTrue(stoppedError is CancellationException)
        }
    }

    @Test fun aReplyThatEndedOnItsOwnKeepsItsReasonAndItsError() {
        val timeout = runBlocking { try { withTimeout(1) { delay(1_000) }; null } catch (error: TimeoutCancellationException) { error } }!!
        val cases = listOf(
            SharedBudgetExhausted() to "BUDGET_EXHAUSTED", timeout to "DEADLINE_EXCEEDED", SharedTurnStopped("NO_PROGRESS") to "NO_PROGRESS",
            CancellationException("scope ended") to "CANCELLED", ModelRequestFailure("MODEL_HTTP_429", "http-response", "fixture") to "MODEL_HTTP_429",
            IllegalStateException("fixture") to "REQUEST_FAILED",
        )
        for ((error, expected) in cases) {
            val (reason, thrown) = replyFailure(stopped = false, error = error)
            assertEquals(expected, reason); assertSame(error, thrown)
        }
    }
}
