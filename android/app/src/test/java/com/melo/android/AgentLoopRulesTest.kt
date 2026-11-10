package com.melo.android

import com.melo.android.chat.citedObservations
import com.melo.android.chat.progressKey
import com.melo.android.chat.refusedCall
import com.melo.android.chat.trimObservations
import com.melo.android.core.coreRefusal
import com.melo.android.data.*
import com.melo.android.device.DeviceCall
import com.melo.android.device.DeviceToolResult
import com.melo.android.ui.resultUnknown
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

// 2026-11-10 follow-up to the Agent audit: small rules of the Android chat loop that decide what the
// model is told, what the completion check can still see and what the user reads. Each test names the
// behaviour it replaced.
class AgentLoopRulesTest {
    // Every refusal of one call used to end with "请先完成前置检索" (finish the prerequisite lookup first).
    @Test fun aRefusedCallIsToldWhatToDoNextForItsOwnReason() {
        assertTrue(refusedCall("PREREQUISITE_MISSING").contains("前置检索"))
        val executed = refusedCall("ALREADY_EXECUTED")
        assertFalse("a call that already succeeded is not sent to search again", executed.contains("前置检索"))
        assertTrue(executed.contains("ALREADY_EXECUTED") && executed.contains("do not repeat"))
        assertTrue(refusedCall("ALREADY_ATTEMPTED").contains("outcome is unknown"))
        assertTrue(refusedCall("INVALID_TOOL_ARGUMENTS").contains("schema"))
        assertTrue(refusedCall("UNKNOWN_TOOL").contains("not offered"))
        // The Core's own text for a call that keeps failing is used as it is.
        val note = "Tool \"fetch_url\" already failed 2 times with identical arguments (SEARCH_HTTP_404). It was not run again."
        assertEquals(note, refusedCall("REPEATED_FAILURE", note))
        assertTrue(refusedCall("REPEATED_FAILURE").contains("REPEATED_FAILURE"))
        for (code in listOf("ALREADY_EXECUTED", "ALREADY_ATTEMPTED", "REPEATED_FAILURE", "INVALID_TOOL_ARGUMENTS", "UNKNOWN_TOOL", "REPEATED_TASK", "PHONE_TASK_LIMIT", "DEADLINE_EXCEEDED"))
            assertFalse(code, refusedCall(code).contains("前置检索"))
        assertTrue("an unlisted code is still named", refusedCall("DEADLINE_EXCEEDED").contains("DEADLINE_EXCEEDED"))
    }

    // Different searches that each found nothing were one repeated result: six of them in a round stopped a member.
    @Test fun differentCallsWithTheSameEmptyResultAreNotARepeatedResult() {
        fun search(query: String, id: String = "c") = DeviceCall(id, "web_search", buildJsonObject { put("query", query) })
        val empty = DeviceToolResult(buildJsonObject { put("ok", true); put("results", JsonArray(emptyList())) })
        val keys = (1..6).map { progressKey(search("variant $it", "c$it"), empty) }
        assertEquals("six different searches are six different steps", 6, keys.toSet().size)
        // The same call with the same result is still a repeat, whatever its call id or the order of its arguments.
        assertEquals(progressKey(search("same", "a"), empty), progressKey(search("same", "b"), empty))
        val ordered = DeviceCall("x", "fetch_url", buildJsonObject { put("url", "https://example.invalid/a"); put("offset", 100) })
        val swapped = DeviceCall("y", "fetch_url", buildJsonObject { put("offset", 100); put("url", "https://example.invalid/a") })
        val page = DeviceToolResult(buildJsonObject { put("ok", true); put("url", "https://example.invalid/a"); put("text", "body") })
        assertEquals(progressKey(ordered, page), progressKey(swapped, page))
        // A new result of the same call is progress.
        assertNotEquals(progressKey(ordered, page), progressKey(ordered, DeviceToolResult(buildJsonObject { put("ok", true); put("url", "https://example.invalid/a"); put("text", "changed") })))
    }

    private fun row(id: String, size: Int = 10): JsonElement = buildJsonObject { put("id", id); put("type", "source"); put("text", "x".repeat(size)) }
    private fun ids(rows: List<JsonElement>) = rows.map { it.jsonObject.text("id") }

    // Rows were dropped by age alone, so a long task lost the pages its first findings were recorded from.
    @Test fun aRowTheLedgerCitesOutlivesOlderRowsNothingCites() {
        val state = MeloJson.parseToJsonElement("""{"phase":"working","evaluation":{"items":[{"fields":{"name":{"value":"Model A","evidence":[{"id":"r2","quote":"Model A"}]},"price":{"value":"100","evidence":[{"id":"r5:source:0","quote":"100 AUD"}]}}}],"adjustment":{"reason":"x","evidence":[{"id":"r7"}]}},"requirements":[{"text":"price","status":"met","evidenceIds":["r9","r5:source:0"]}]}""")
        assertEquals(setOf("r2", "r5:source:0", "r7", "r9"), citedObservations(state))
        assertTrue(citedObservations(null).isEmpty())
        val rows = (1..200).map { row(if (it == 5) "r5:source:0" else "r$it") }.toMutableList()
        trimObservations(rows) { citedObservations(state) }
        assertEquals(128, rows.size)
        assertTrue("cited rows are kept", ids(rows).containsAll(listOf("r2", "r5:source:0", "r7", "r9")))
        assertEquals("the newest row is kept", "r200", ids(rows).last())
        assertFalse("an old row nothing cites went first", "r1" in ids(rows))
        // Without citations the oldest rows go, as before.
        val plain = (1..200).map { row("r$it") }.toMutableList()
        trimObservations(plain)
        assertEquals((73..200).map { "r$it" }, ids(plain))
        // The size bound follows the same order, and a short list is left alone.
        val large = (1..40).map { row("r$it", 50_000) }.toMutableList()
        trimObservations(large) { setOf("r1") }
        assertTrue(large.sumOf { it.toString().length } <= 1_200_000); assertEquals("r1", ids(large).first()); assertEquals("r40", ids(large).last())
        val short = (1..30).map { row("r$it", 100_000) }.toMutableList()
        trimObservations(short); assertEquals(30, short.size)
        // When every older row is cited, a cited row goes before the newest one does.
        val allCited = (1..40).map { row("r$it", 50_000) }.toMutableList()
        trimObservations(allCited) { (1..39).map { "r$it" }.toSet() }
        assertEquals("r40", ids(allCited).last()); assertFalse("r1" in ids(allCited))
    }

    // "共享 Agent 拒绝请求：CONTEXT_BUDGET_EXCEEDED" was all the user saw when a message did not fit the model.
    @Test fun aRefusalTheUserCanActOnSaysWhatToDoAndKeepsItsCode() {
        val tooLong = coreRefusal("CONTEXT_BUDGET_EXCEEDED")
        assertTrue(tooLong.contains("上下文容量") && tooLong.contains("缩短")); assertTrue("the loop still recognises it", tooLong.contains("CONTEXT_BUDGET_EXCEEDED"))
        assertTrue(coreRefusal("INPUT_LIMIT").contains("INPUT_LIMIT") && coreRefusal("INPUT_LIMIT").contains("缩短"))
        assertEquals("an internal fault keeps its plain form", "共享 Agent 拒绝请求：PENDING_EFFECT", coreRefusal("PENDING_EFFECT"))
    }

    // Every failed call was marked "结果未知，请先核对再继续", a page that answered 404 included.
    @Test fun onlyACallThatNeverReportedBackHasAnUnknownResult() {
        fun event(id: String, state: String) = buildJsonObject { put("eventId", "run/tool/$id/result"); put("operationId", id); put("resultState", state) }
        val operations = listOf(
            buildJsonObject { put("id", "fetch-1"); put("status", "failed"); put("resultSummary", "网页返回 HTTP 404，没有读到内容。") },
            buildJsonObject { put("id", "write-1"); put("status", "interrupted") },
            buildJsonObject { put("id", "search-1"); put("status", "completed"); put("resultSummary", "检索返回 3 条来源") })
        assertFalse("an error that came back is known", resultUnknown(event("fetch-1", "unknown"), operations))
        assertTrue("a call cut off while it ran is not", resultUnknown(event("write-1", "unknown"), operations))
        assertFalse(resultUnknown(event("search-1", "returned"), operations))
        assertTrue("a row that is missing proves nothing", resultUnknown(event("gone", "unknown"), operations))
    }
}
