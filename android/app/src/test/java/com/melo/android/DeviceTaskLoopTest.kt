package com.melo.android

import com.melo.android.data.*
import com.melo.android.device.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class DeviceTaskLoopTest {
    @Test fun reusedCallIdentityStopsBeforeTheSecondNativeAction() = runBlocking {
        for (protocol in listOf("chat-completions", "responses", "anthropic")) {
            val turns = ArrayDeque(listOf(turn("same-id", args("observe")), turn("same-id", finish())))
            var executed = 0
            val result = runCatching { DeviceTaskLoop(protocol, { turns.removeFirst() }, { executed++; screen() }, {}).run("Inspect fixture") }
            assertTrue("$protocol accepted a reused call ID", result.isFailure)
            assertEquals(1, executed)
        }
    }
    @Test fun inaccessibleLaunchedWindowStopsBeforeAnotherModelCallOrDeviceAction() = runBlocking {
        var requests = 0; var actions = 0
        val traces = mutableListOf<DeviceStep>()
        val result = DeviceTaskLoop("chat-completions", {
            requests++; check(requests == 1)
            turn("open", args("open_app", "package_name" to "com.tencent.mm"))
        }, { actions++; DeviceToolResult.error("Target window unavailable", "foreground_window_unavailable") }, { traces += it }).run("Open WeChat")
        assertEquals("needs_user", result.status); assertEquals(1, requests); assertEquals(1, actions)
        assertEquals("foreground_window_unavailable", traces.single().code)
    }
    @Test fun persistedObservationSummaryIdentifiesTheCapturedWindowWithoutSavingItsContents() = runBlocking {
        for (available in listOf(true, false)) {
            val turns = ArrayDeque(listOf(turn("observe", args("observe")), turn("stop", finish("blocked"))))
            val steps = mutableListOf<DeviceStep>()
            val result = screen(text = "private-fixture-label", pkg = "com.tencent.mm")
            val receipt = DeviceToolResult(JsonObject(result.data + buildJsonObject {
                put("image_width", 521); put("image_height", 1280); put("screenshot_available", available)
                if (!available) put("screenshot_error", "系统禁止截图")
            }))
            DeviceTaskLoop("chat-completions", { turns.removeFirst() }, { receipt }, { steps += it }).run("Inspect only")
            val detail = steps.first().detail
            assertTrue(detail, detail.contains("com.tencent.mm") && detail.contains("521×1280") && detail.contains("1 个节点"))
            assertTrue(detail, detail.contains(if (available) "已截图" else "截图不可用：系统禁止截图"))
            assertFalse(detail.contains("private-fixture-label"))
        }
    }
    private fun args(action: String, vararg fields: Pair<String, String>) = buildJsonObject { put("action", action); fields.forEach { put(it.first, it.second) } }
    private fun screen(id: String = "s1", text: String = "Ready", pkg: String = "fixture.app") = DeviceToolResult(buildJsonObject {
        put("ok", true); put("screen_id", id); put("package_name", pkg); put("stable", true)
        put("nodes", buildJsonArray { add(buildJsonObject { put("node_id", "n1"); put("text", text) }) })
    })
    private fun turn(id: String, arguments: JsonObject): DeviceTurn {
        val call = DeviceCall(id, "android_device", arguments)
        val wire = buildJsonObject { put("role", "assistant"); put("tool_calls", buildJsonArray { add(buildJsonObject {
            put("id", id); put("type", "function"); put("function", buildJsonObject { put("name", "android_device"); put("arguments", arguments.toString()) })
        }) }) }
        return DeviceTurn("", listOf(call), listOf(wire))
    }
    private fun final() = DeviceTurn("已完成（未经校验）", emptyList(), listOf(buildJsonObject { put("role", "assistant"); put("content", "已完成（未经校验）") }))
    private fun finish(outcome: String = "achieved", id: String = "s1", text: String = "Ready") = args("finish", "outcome" to outcome, "summary" to "Fixture result", "screen_id" to id, "visible_text" to text)

    @Test fun plainFinalReplyNeverBecomesAchievedEvenAfterSuccessfulObservation() = runBlocking {
        val turns = ArrayDeque(listOf(turn("observe", args("observe")), final(), final()))
        val result = DeviceTaskLoop("chat-completions", { turns.removeFirst() }, { screen() }, {}).run("Open fixture")
        assertEquals("needs_user", result.status); assertNull(result.verification)
    }
    @Test fun unnamedBulkInventoryIsRejectedBeforeExecutingAnyDeviceRead() = runBlocking {
        val turns = ArrayDeque(listOf(turn("bulk", buildJsonObject { put("action", "list_apps"); put("limit", 200) }), turn("stop", finish("blocked"))))
        val executed = mutableListOf<String>(); val traces = mutableListOf<DeviceStep>()
        val result = DeviceTaskLoop("chat-completions", { turns.removeFirst() }, { executed += it.text("action"); screen() }, { traces += it }).run("Open Fixture")
        assertTrue(executed.isEmpty()); assertEquals("blocked", result.status)
        assertEquals("invalid_arguments", traces.first().code)
        assertTrue(traces.first().detail.contains("query"))
    }
    @Test fun achievedRequiresReobservingAndMatchingExactVisibleFacts() = runBlocking {
        val turns = ArrayDeque(listOf(turn("observe", args("observe")), turn("done", finish())))
        val executed = mutableListOf<String>(); val traces = mutableListOf<DeviceStep>()
        val result = DeviceTaskLoop("chat-completions", { turns.removeFirst() }, { executed += it.text("action"); screen() }, { traces += it }).run("Ready page")
        assertEquals("achieved", result.status); assertEquals("visible_facts", result.verification)
        assertEquals(listOf("observe", "observe"), executed)
        assertEquals(listOf("observe", "done"), traces.map { it.callId })
    }
    @Test fun changedScreenCannotSatisfyAnOldCompletionClaim() = runBlocking {
        val turns = ArrayDeque(listOf(turn("observe", args("observe")), turn("done", finish()), turn("blocked", finish("blocked"))))
        var count = 0; val traces = mutableListOf<DeviceStep>()
        val result = DeviceTaskLoop("chat-completions", { turns.removeFirst() }, { screen(text = if (count++ == 0) "Ready" else "Loading") }, { traces += it }).run("Ready page")
        assertEquals("blocked", result.status); assertEquals("unverified_goal", traces[1].code)
    }
    @Test fun arbitraryOrOldScreenIdsDoNotTriggerCompletionObservation() = runBlocking {
        var calls = 0
        val turns = ArrayDeque(listOf(turn("observe", args("observe")), turn("done", finish(id = "invented")), turn("stop", finish("needs_user"))))
        val traces = mutableListOf<DeviceStep>()
        val result = DeviceTaskLoop("chat-completions", { turns.removeFirst() }, { calls++; screen() }, { traces += it }).run("goal")
        assertEquals(1, calls); assertEquals("needs_user", result.status); assertEquals("stale_evidence", traces[1].code)
    }
    @Test fun completionRejectsMissingFactWrongPackageSubstringAndUnstableFrame() {
        for (claim in listOf(args("finish", "outcome" to "achieved", "summary" to "done", "screen_id" to "s1"), args("finish", "outcome" to "anything", "summary" to "done")))
            assertTrue(runCatching { DeviceTools.validate(claim) }.isFailure)
        assertFalse(DeviceCompletion.verify(finish(text = "Read"), screen(), screen()).ok)
        assertFalse(DeviceCompletion.verify(args("finish", "expected_package" to "wrong", "screen_id" to "s1"), screen(), screen()).ok)
        val unstable = DeviceToolResult(JsonObject(screen().data + ("stable" to JsonPrimitive(false))))
        assertFalse(DeviceCompletion.verify(finish(), screen(), unstable).ok)
    }
    @Test fun progressIdentityIncludesGamePixelsButIgnoresVolatileScreenIds() {
        val data = buildJsonObject { put("ok", true); put("package_name", "fixture.game"); put("nodes", JsonArray(emptyList())) }
        val frames = (0..7).map { DeviceProgress.fingerprint(DeviceToolResult(data, "fixture-frame-$it")) }
        assertEquals(8, frames.toSet().size)
        assertEquals(frames.last(), DeviceProgress.fingerprint(DeviceToolResult(data, "fixture-frame-7")))
        assertEquals(DeviceProgress.fingerprint(screen("a")), DeviceProgress.fingerprint(screen("b")))
    }
    @Test fun observationTransportMetadataAndOptionalPixelsDoNotCreateTreeProgress() {
        val original = screen(text = "Query awaiting submission")
        val variant = DeviceToolResult(JsonObject(original.data + buildJsonObject {
            put("screen_id", "new-capture"); put("window_id", 91); put("action", "observe")
            put("observation_mode", "ui_tree_and_screenshot"); put("screenshot_available", true)
            put("screenshot_hint", "different capture transport"); put("launch_dispatched", false)
            put("code", "already_foreground"); put("hint", "still the same editor")
        }), "different-encoded-jpeg")
        assertEquals(DeviceProgress.fingerprint(original), DeviceProgress.fingerprint(variant))
        assertNotEquals(DeviceProgress.fingerprint(original), DeviceProgress.fingerprint(screen(text = "Actual result")))
    }
    @Test fun declinedNativeConfirmationStopsWithoutInvitingAnotherClick() = runBlocking {
        var modelCalls = 0
        val result = DeviceTaskLoop("chat-completions", { modelCalls++; turn("tap", args("tap", "screen_id" to "s1", "node_id" to "n1")) }, { DeviceToolResult.error("declined", "user_declined") }, {}).run("goal")
        assertEquals("needs_user", result.status); assertEquals(1, modelCalls)
    }
    @Test fun cancellationDuringModelRequestExecutesNothing() = runBlocking {
        val requested = CompletableDeferred<Unit>(); var executed = false
        val job = launch { DeviceTaskLoop("chat-completions", { requested.complete(Unit); delay(10_000); turn("late", args("observe")) }, { executed = true; screen() }, {}).run("goal") }
        requested.await(); job.cancelAndJoin(); assertFalse(executed)
    }
    @Test fun tracesExcludeTypedTextNodeIdsAndScreenshots() = runBlocking {
        val secret = "fixture-do-not-persist"
        val turns = ArrayDeque(listOf(turn("type", args("type_text", "screen_id" to "s1", "node_id" to "private-node", "text" to secret)), turn("stop", finish("blocked"))))
        val traces = mutableListOf<DeviceStep>()
        DeviceTaskLoop("chat-completions", { turns.removeFirst() }, { screen(text = secret) }, { traces += it }).run("goal")
        val saved = MeloJson.encodeToString(traces)
        assertFalse(saved.contains(secret)); assertFalse(saved.contains("private-node")); assertFalse(saved.contains("nodes"))
        assertTrue(traces.all { it.durationMs >= 0 && it.callId.isNotBlank() })
    }
    @Test fun discoveryRecoveryIsOfferedOnceThenRequiresHonestOutcome() = runBlocking {
        var offers = 0
        val turns = ArrayDeque(listOf(turn("miss", args("open_app", "app_name" to "Unknown")), final(), turn("stop", finish("blocked"))))
        val result = DeviceTaskLoop("chat-completions", { history -> if (history.toString().contains("Before concluding the app is unavailable")) offers++; turns.removeFirst() }, { DeviceToolResult.error("missing", "app_not_found") }, {}).run("goal")
        assertEquals("blocked", result.status); assertEquals(1, offers)
    }
    @Test fun structuredFinishCannotBypassTheExistingMissingAppRecovery() = runBlocking {
        val turns = ArrayDeque(listOf(turn("miss", args("open_app", "app_name" to "Unknown")), turn("premature", finish("blocked")), turn("search", args("list_apps", "query" to "shorter")), turn("right", args("open_app", "package_name" to "fixture.app")), turn("verified", finish())))
        val traces = mutableListOf<DeviceStep>()
        val outcome = DeviceTaskLoop("chat-completions", { turns.removeFirst() }, { call ->
            when {
                call.text("app_name") == "Unknown" -> DeviceToolResult.error("missing", "app_not_found")
                call.text("action") == "list_apps" -> DeviceToolResult(buildJsonObject { put("ok", true); put("total_apps", 265); put("matched_apps", 1); put("apps", JsonArray(emptyList())) })
                else -> screen()
            }
        }, { traces += it }).run("Open the requested app")
        assertEquals("achieved", outcome.status)
        assertEquals(1, traces.count { it.code == "discovery_required" })
        assertTrue(traces.any { it.action == "list_apps" && it.ok })
    }
    @Test fun animatedScreensAndInterleavedObservationsCannotHideRepeatedLaunches() = runBlocking {
        var decisions = 0; var launches = 0
        val traces = mutableListOf<DeviceStep>()
        val outcome = DeviceTaskLoop("chat-completions", { history ->
            if (decisions >= 4) assertTrue(history.toString().contains("same app twice"))
            turn("c${decisions}", args(if (decisions++ % 2 == 0) "open_app" else "observe", "package_name" to "fixture.app"))
        }, {
            if (it.text("action") == "open_app") launches++
            val observed = screen(id = newId(), text = "Animation ${newId()}")
            DeviceToolResult(observed.data, "changing-pixels-${newId()}")
        }, { traces += it }).run("Open fixture")
        assertEquals("blocked", outcome.status); assertEquals(2, launches)
        assertEquals(5, decisions); assertEquals("repeated_launch", traces.last().code)
    }
    @Test fun launchNameAndResolvedPackageShareTheSameAttemptBudget() = runBlocking {
        val turns = ArrayDeque(listOf(turn("a", args("open_app", "app_name" to "Fixture")), turn("b", args("open_app", "package_name" to "fixture.app")), turn("c", args("open_app", "app_name" to "Fixture"))))
        var launches = 0
        val result = DeviceTaskLoop("chat-completions", { turns.removeFirst() }, {
            launches++; DeviceToolResult(JsonObject(screen().data + ("target_package" to "fixture.app".jp())), "changing-$launches")
        }, {}).run("Open fixture")
        assertEquals("blocked", result.status); assertEquals(2, launches)
    }
    @Test fun repeatedLaunchCanRecoverByFinishingWithVisibleEvidence() = runBlocking {
        val turns = ArrayDeque(listOf(turn("a", args("open_app", "package_name" to "fixture.app")), turn("b", args("open_app", "package_name" to "fixture.app")), turn("done", finish())))
        val result = DeviceTaskLoop("chat-completions", { turns.removeFirst() }, { screen() }, {}).run("Open fixture")
        assertEquals("achieved", result.status); assertEquals("visible_facts", result.verification)
    }
    @Test fun launchingAnAppDoesNotAutomaticallyCompleteAMultiStepGoal() = runBlocking {
        val turns = ArrayDeque(listOf(turn("open", args("open_app", "package_name" to "fixture.app")), turn("done", finish(text = "Bluetooth")), turn("blocked", finish("blocked"))))
        val result = DeviceTaskLoop("chat-completions", { turns.removeFirst() }, { screen(text = "Settings") }, {}).run("Open settings and find Bluetooth")
        assertEquals("blocked", result.status); assertNull(result.verification)
    }
    @Test fun navigationAllowsAnIntentionalReturnToTheSameAppEntry() {
        val guard = DeviceLaunchGuard(); val launch = args("open_app", "package_name" to "fixture.app")
        repeat(2) { guard.record(launch, screen()) }; assertEquals(2, guard.count(launch))
        guard.record(args("back", "screen_id" to "s1"), screen()); assertEquals(0, guard.count(launch))
        guard.record(launch, screen()); assertEquals(1, guard.count(launch))
    }
    @Test fun completionReobservesTheSelectedPaneInsteadOfTheOtherActivePane() = runBlocking {
        val turns = ArrayDeque(listOf(turn("left", buildJsonObject { put("action", "observe"); put("window_id", 17) }), turn("done", finish())))
        val windows = mutableListOf<Int>()
        val result = DeviceTaskLoop("chat-completions", { turns.removeFirst() }, {
            windows += it["window_id"]!!.jsonPrimitive.int
            DeviceToolResult(JsonObject(screen().data + ("window_id" to JsonPrimitive(17))))
        }, {}).run("Check the main pane")
        assertEquals("achieved", result.status); assertEquals(listOf(17, 17), windows)
    }
}
