package com.melo.android

import com.melo.android.data.*
import com.melo.android.device.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class DeviceScriptTest {
    private val environment = CacheEnvironment("fixture-layout", mapOf("fixture.app" to 1L, "com.android.settings" to 1L))
    private fun args(action: String, vararg values: Pair<String, String>) = buildJsonObject { put("action", action); values.forEach { put(it.first, it.second) } }
    private fun node(id: String = "fresh-node", text: String = "Target", editable: Boolean = false) = buildJsonObject {
        put("node_id", id); put("text", text); put("view_id", "fixture.app:id/target"); put("description", ""); put("class_name", if (editable) "android.widget.EditText" else "android.widget.Button")
        put("enabled", true); put("editable", editable); put("clickable", true); put("bounds", buildJsonArray { add(100); add(100); add(400); add(200) })
    }
    private fun screen(id: String = "fresh-screen", text: String = "Ready", nodes: List<JsonObject> = listOf(node())) = DeviceToolResult(buildJsonObject {
        put("ok", true); put("screen_id", id); put("window_id", 17); put("window_title", "Main"); put("package_name", "fixture.app"); put("stable", true)
        put("image_width", 1000); put("image_height", 1000); put("nodes", JsonArray(nodes + buildJsonObject { put("text", text) }))
    })
    private fun script(goal: String = "Open fixture", steps: List<ScriptStep> = listOf(ScriptStep("open_app", "fixture.app"))) = DeviceScript(
        name = "Fixture", goalTemplate = goal, steps = steps, completion = ScriptAssertion("fixture.app", "Main", "Ready"), scope = "scope", verified = true, environment = environment)
    private fun done(text: String = "Ready") = args("finish", "outcome" to "achieved", "screen_id" to "fresh-screen", "expected_package" to "fixture.app", "visible_text" to text)
    private fun verified(text: String = "Ready") = DeviceToolResult(JsonObject(screen(text = text).data + ("verification" to "visible_facts".jp())))

    @Test fun recordedSearchIncludesSubmissionAndReplaysItWithAFreshEditor() = runBlocking {
        val recorder = ScriptRecorder("Search query in fixture")
        val editor = node(editable = true)
        recorder.record(args("open_app", "package_name" to "fixture.app"), screen(nodes = listOf(editor)))
        recorder.record(args("type_text", "node_id" to "fresh-node", "text" to "query"), screen(nodes = listOf(editor)))
        recorder.record(args("submit_input", "node_id" to "fresh-node"), screen())
        recorder.record(done(), verified())
        val recorded = recorder.compile("scope", "run")!!
        assertEquals(listOf("open_app", "type_text", "submit_input"), recorded.steps.map { it.action })
        val actions = mutableListOf<JsonObject>()
        var entered = ""
        val result = ScriptRunner({ action -> actions += action; if (action.text("action") == "type_text") entered = action.text("text"); screen(nodes = listOf(node(text = entered, editable = true))) }, completionTimeoutMs = 100).run(recorded, mapOf("input_1" to "new query"))
        assertEquals("achieved", result.outcome.status)
        val submit = actions.single { it.text("action") == "submit_input" }
        assertEquals("fresh-screen", submit.text("screen_id")); assertEquals("fresh-node", submit.text("node_id"))
        assertEquals("new query", actions.single { it.text("action") == "type_text" }.text("text"))
    }
    @Test fun cachedTextInputPreparesMissingFocusBeforeTypingAndSubmitting() = runBlocking {
        var focused = false
        var entered = ""
        val actions = mutableListOf<String>()
        val editor = { JsonObject(node(text = entered, editable = true) + ("focused" to JsonPrimitive(focused))) }
        val cached = script("Search {{query}}", listOf(ScriptStep("type_text", "fixture.app", "Main", NodeSelector(viewId = "fixture.app:id/target", editable = true), parameter = "query"), ScriptStep("submit_input", "fixture.app", "Main", NodeSelector(viewId = "fixture.app:id/target", editable = true)))).copy(parameters = listOf("query"))
        val result = ScriptRunner({ action ->
            actions += action.text("action")
            when (action.text("action")) {
                "tap" -> { focused = true; screen(nodes = listOf(editor())) }
                "type_text" -> if (!focused) DeviceToolResult.error("Focus missing", "input_not_focused") else { entered = action.text("text"); screen(nodes = listOf(editor())) }
                "submit_input" -> if (!focused) DeviceToolResult.error("Focus missing", "submission_unavailable") else screen(nodes = listOf(editor()))
                else -> screen(nodes = listOf(editor()))
            }
        }, completionTimeoutMs = 100).run(cached, mapOf("query" to "new query"))
        assertEquals("achieved", result.outcome.status)
        assertTrue(actions.indexOf("tap") in 0 until actions.indexOf("type_text"))
        assertTrue(actions.indexOf("type_text") < actions.indexOf("submit_input"))
    }
    @Test fun orphanSubmissionCannotPublishOrReplayResidualInput() {
        val orphan = script(steps = listOf(ScriptStep("open_app", "fixture.app"), ScriptStep("submit_input", "fixture.app", selector = NodeSelector(viewId = "fixture.app:id/target", editable = true))))
        assertTrue(runCatching { ScriptValidator.validate(orphan) }.isFailure)
        assertNull(TaskCacheRouter.lookup(orphan.goalTemplate, listOf(orphan), "scope", environment).exact)
    }
    @Test fun changedInputStopsBeforeSubmission() = runBlocking {
        val target = NodeSelector(viewId = "fixture.app:id/target", editable = true)
        val cached = script(steps = listOf(ScriptStep("type_text", "fixture.app", selector = target, text = "new query"), ScriptStep("submit_input", "fixture.app", selector = target)))
        val actions = mutableListOf<String>()
        val result = ScriptRunner({ action -> actions += action.text("action"); screen(nodes = listOf(node(text = "old query", editable = true))) }, completionTimeoutMs = 100).run(cached, emptyMap())
        assertEquals("blocked", result.outcome.status)
        assertFalse("submit_input" in actions)
    }
    @Test fun canonicalWorkflowLearnsButtonSubmissionAndChecksTheNewQueryWithoutAModel() = runBlocking {
        val recorder = ScriptRecorder("Original broad task must not become cached research")
        val editor = node(editable = true)
        recorder.record(args("open_app", "package_name" to "fixture.app"), screen(nodes = listOf(editor)))
        recorder.record(args("type_text", "node_id" to "fresh-node", "text" to "alpha"), screen(nodes = listOf(node(text = "alpha", editable = true), node(id = "button", text = "Search"))))
        recorder.record(args("tap", "node_id" to "button"), screen(text = "Search results", nodes = listOf(node(id = "link", text = "alpha Guide"))))
        recorder.record(args("tap", "node_id" to "link"), screen(text = "Result detail", nodes = listOf(node(text = "alpha"))))
        recorder.record(done("Result detail"), DeviceToolResult(JsonObject(screen(text = "Result detail", nodes = listOf(node(text = "alpha"))).data + ("verification" to "visible_facts".jp()))))
        val recipe = recorder.compileCanonical("scope", "root")!!
        assertFalse(recipe.goalTemplate.contains("broad task")); assertFalse(MeloJson.encodeToString(recipe).contains("alpha"))
        assertEquals(listOf("{{input_1}}"), recipe.completion.requiredTexts)
        assertEquals(listOf("input_1"), GoalTemplate.names(recipe.goalTemplate))
        var current = ""; var phase = 0
        val replay = ScriptRunner({ action ->
            if (action.text("action") == "type_text") current = action.text("text")
            if (action.text("action") == "tap") phase++
            when (phase) {
                2 -> screen(text = "Result detail", nodes = listOf(node(text = current)))
                1 -> screen(text = "Search results", nodes = listOf(node(id = "link", text = "$current Guide")))
                else -> screen(nodes = listOf(node(text = current, editable = true), node(id = "button", text = "Search")))
            }
        }, completionTimeoutMs = 100).run(recipe, mapOf("input_1" to "beta"))
        assertEquals("achieved", replay.outcome.status); assertEquals("beta", current)
    }
    @Test fun modelDerivedInputCannotBecomeAnUnbindableParameterOnAnExactGoal() {
        val goal = "Search Android accessibility"
        val typed = "https://www.google.com/search?q=Android+accessibility"
        val recorder = ScriptRecorder(goal)
        recorder.record(args("observe"), screen(nodes = listOf(node(editable = true))))
        recorder.record(args("type_text", "node_id" to "fresh-node", "text" to typed), screen())
        recorder.record(done(), verified())
        val cached = recorder.compile("scope", "source")!!.copy(environment = environment)
        assertTrue(cached.parameters.isEmpty())
        assertEquals(typed, cached.steps.single().text)
        assertEquals(cached.id, TaskCacheRouter.lookup(goal, listOf(cached), "scope", environment).exact?.script?.id)
        assertNull(TaskCacheRouter.lookup("Search another topic", listOf(cached), "scope", environment).exact)
    }
    @Test fun exactHitNormalizesRepresentationWithoutMergingDifferentIntent() {
        val cached = script("打开蓝牙页面")
        assertEquals(cached.id, TaskCacheRouter.lookup("  打开蓝牙页面  ", listOf(cached), "scope", environment).exact!!.script.id)
        assertNull(TaskCacheRouter.lookup("打开蓝牙开关", listOf(cached), "scope", environment).exact)
        assertNull(TaskCacheRouter.lookup("打开蓝牙页面", listOf(cached), "another-owner", environment).exact)
    }
    @Test fun templatesPreserveParameterCaseAndRejectAnExtendedGoal() {
        assertEquals(mapOf("query" to "WiFi"), GoalTemplate.bind("Search {{query}} in Settings", "Search WiFi in Settings"))
        assertEquals(mapOf("query" to "Ａ  B"), GoalTemplate.bind("Search {{query}} in Settings", "Search Ａ  B in Settings"))
        assertNull(GoalTemplate.bind("Search {{query}}", "Search WiFi then send a message"))
        assertNull(GoalTemplate.bind("{{a}}{{b}}", "ambiguous"))
    }
    @Test fun similarityIsOnlyACandidateAndEditedOrInvalidatedEntriesCannotAutoRun() {
        val cached = script("打开系统设置")
        val similar = TaskCacheRouter.lookup("打开手机设置", listOf(cached), "scope", environment)
        assertNull(similar.exact); assertEquals(1, similar.similar.size)
        assertNull(TaskCacheRouter.lookup(cached.goalTemplate, listOf(cached.copy(verified = false)), "scope", environment).exact)
        assertNull(TaskCacheRouter.lookup(cached.goalTemplate, listOf(cached.copy(invalidated = true)), "scope", environment).exact)
        assertTrue(TaskCacheRouter.lookup(cached.goalTemplate, listOf(cached.copy(invalidated = true)), "scope", environment).similar.isEmpty())
        assertNull(TaskCacheRouter.lookup(cached.goalTemplate, listOf(cached.copy(enabled = false)), "scope", environment).exact)
        val bilingual = script("Open Android Settings").copy(steps = listOf(ScriptStep("open_app", "com.android.settings")), completion = ScriptAssertion("com.android.settings", "设置", "设置"))
        assertEquals(bilingual.id, TaskCacheRouter.lookup("打开设置", listOf(bilingual), "scope", environment).similar.single().id)
    }
    @Test fun ambiguousExactMatchesRequirePlanningInsteadOfPickingTheFirst() {
        assertNull(TaskCacheRouter.lookup("Open fixture", listOf(script(), script()), "scope", environment).exact)
    }
    @Test fun unsupportedActionsCoordinatesUnknownFieldsAndFutureFormatsAreRejected() {
        assertTrue(runCatching { ScriptValidator.validate(script(steps = listOf(ScriptStep("bash", "fixture.app")))) }.isFailure)
        assertTrue(runCatching { ScriptValidator.validate(script(steps = listOf(ScriptStep("tap", "fixture.app")))) }.isFailure)
        assertTrue(runCatching { ScriptValidator.validate(script().copy(schemaVersion = 2)) }.isFailure)
        val json = MeloJson.encodeToJsonElement(script()).jsonObject
        assertTrue(runCatching { ScriptValidator.parse(JsonObject(json + ("x" to JsonPrimitive(100))).toString()) }.isFailure)
    }
    @Test fun oldAppDocumentsDefaultToAnEmptyLocalCache() {
        assertTrue(MeloJson.decodeFromString<AppData>("{}").deviceScripts.isEmpty())
    }
    @Test fun recorderRemovesTemporaryIdsAndParameterValuesBeforePersistence() {
        val privateValue = "NeverPersistThisQuery"
        val recorder = ScriptRecorder("Search $privateValue")
        recorder.record(args("observe"), screen(nodes = listOf(node("private-runtime-node", "", true))))
        recorder.record(args("type_text", "screen_id" to "private-runtime-screen", "node_id" to "private-runtime-node", "text" to privateValue), screen(text = privateValue))
        recorder.record(done(privateValue), verified(privateValue))
        val cached = recorder.compile("scope", "source-run")!!
        val encoded = MeloJson.encodeToString(cached)
        assertFalse(encoded.contains(privateValue)); assertFalse(encoded.contains("private-runtime"))
        assertEquals("input_1", cached.steps.single().parameter)
        assertEquals(mapOf("input_1" to "WiFi"), GoalTemplate.bind(cached.goalTemplate, "Search WiFi"))
    }
    @Test fun coordinateOrAmbiguousTargetDoesNotProduceAPretendReplayScript() {
        for (coordinate in listOf(true, false)) {
            val recorder = ScriptRecorder("Tap target")
            recorder.record(args("observe"), screen(nodes = listOf(node(), node("another-id"))))
            recorder.record(if (coordinate) args("tap", "x" to "10", "y" to "10") else args("tap", "node_id" to "fresh-node"), screen())
            recorder.record(done(), verified())
            assertNull(recorder.compile("scope", "run")); assertTrue(recorder.unsupported.isNotBlank())
        }
    }
    @Test fun failedPotentialWriteCannotBecomeACacheEvenIfTheModelLaterFinishes() {
        val recorder = ScriptRecorder("Tap target")
        recorder.record(args("observe"), screen())
        recorder.record(args("tap", "node_id" to "fresh-node"), DeviceToolResult.error("unknown dispatch failure"))
        recorder.record(done(), verified())
        assertNull(recorder.compile("scope", "run"))
    }
    @Test fun replayUsesFreshNodeIdsAndValidatesTheFinalVisibleStateWithoutAModel() = runBlocking {
        var observed = 0; var tapped = 0; var current = ""
        val recipe = script(steps = listOf(ScriptStep("open_app", "fixture.app"), ScriptStep("tap", "fixture.app", "Main", NodeSelector(viewId = "fixture.app:id/target"))))
        val result = ScriptRunner({ arguments ->
            when (arguments.text("action")) {
                "observe" -> { current = "screen-${++observed}"; screen(current, nodes = listOf(node("node-$observed"))) }
                "tap" -> { assertEquals(current, arguments.text("screen_id")); assertEquals("node-$observed", arguments.text("node_id")); tapped++; screen() }
                else -> screen()
            }
        }).run(recipe, emptyMap())
        assertEquals("achieved", result.outcome.status); assertEquals("visible_facts", result.outcome.verification)
        assertEquals(1, tapped); assertEquals(2, result.completedSteps)
    }
    @Test fun duplicateSelectorsStopBeforeAnyClick() = runBlocking {
        var clicks = 0
        val recipe = script(steps = listOf(ScriptStep("tap", "fixture.app", "Main", NodeSelector(text = "Target"))))
        val result = ScriptRunner({ if (it.text("action") == "tap") clicks++; screen(nodes = listOf(node(), node("other"))) }).run(recipe, emptyMap())
        assertEquals("blocked", result.outcome.status); assertEquals(0, clicks); assertFalse(result.unsafeToResume)
    }
    @Test fun failedPotentialWriteRunsOnceAndRequiresUserInsteadOfAutomaticProbe() = runBlocking {
        var clicks = 0
        val recipe = script(steps = listOf(ScriptStep("tap", "fixture.app", "Main", NodeSelector(text = "Target"))))
        val result = ScriptRunner({ if (it.text("action") == "tap") { clicks++; DeviceToolResult.error("uncertain effect") } else screen() }).run(recipe, emptyMap())
        assertEquals(1, clicks); assertEquals("blocked", result.outcome.status); assertTrue(result.unsafeToResume)
    }
    @Test fun cancellationWhileWaitingForATargetDoesNotDispatchAnything() = runBlocking {
        val seen = CompletableDeferred<Unit>(); var clicks = 0
        val recipe = script(steps = listOf(ScriptStep("tap", "fixture.app", "Main", NodeSelector(text = "Missing"))))
        val job = launch { ScriptRunner({ if (it.text("action") == "tap") clicks++; seen.complete(Unit); screen() }).run(recipe, emptyMap()) }
        seen.await(); job.cancelAndJoin(); assertEquals(0, clicks)
    }
    @Test fun wrongFinalFactNeverBecomesAchieved() = runBlocking {
        val recipe = script().copy(completion = ScriptAssertion("fixture.app", "Main", "Not actually visible"))
        val result = ScriptRunner({ screen() }, completionTimeoutMs = 100).run(recipe, emptyMap())
        assertEquals("blocked", result.outcome.status)
    }
    @Test fun recordedLabelsProtectAgainstARepurposedResourceId() = runBlocking {
        val recorder = ScriptRecorder("Tap Target")
        recorder.record(args("observe"), screen())
        recorder.record(args("tap", "node_id" to "fresh-node"), screen())
        recorder.record(done(), verified())
        val cached = recorder.compile("scope", "run")!!
        var clicks = 0
        val result = ScriptRunner({ if (it.text("action") == "tap") clicks++; screen(nodes = listOf(node(text = "Different action"))) })
            .run(cached.copy(steps = cached.steps.map { it.copy(timeoutMs = 100) }), emptyMap())
        assertEquals("blocked", result.outcome.status); assertEquals(0, clicks)
    }
    @Test fun goalParametersCannotTurnAFixedScriptIntoAnArbitraryTaskWildcard() {
        val input = ScriptStep("type_text", "fixture.app", selector = NodeSelector(viewId = "fixture:id/input", editable = true), parameter = "query")
        assertTrue(runCatching { ScriptValidator.validate(script("{{query}}", listOf(input)).copy(parameters = listOf("query"))) }.isFailure)
        assertTrue(runCatching { ScriptValidator.validate(script("Search {{query}}").copy(parameters = listOf("query"))) }.isFailure)
    }
    @Test fun parameterRenderingAndRecordingNeverInterpretInsertedValuesAsTemplates() {
        assertEquals("{{second}}/value", GoalTemplate.render("{{first}}/{{second}}", mapOf("first" to "{{second}}", "second" to "value")))
        assertEquals("{{input_1}} {{input_2}}", GoalTemplate.parameterize("Alpha 1", mapOf("input_1" to "Alpha", "input_2" to "1")))
    }
    @Test fun repeatedGoalValuesDoNotProduceAnAmbiguousOrLeakingTemplate() {
        val recorder = ScriptRecorder("Search PrivateValue then PrivateValue")
        recorder.record(args("observe"), screen(nodes = listOf(node("input", "", true))))
        recorder.record(args("type_text", "node_id" to "input", "text" to "PrivateValue"), screen())
        recorder.record(done(), verified())
        assertNull(recorder.compile("scope", "run"))
    }
    @Test fun exactMatchingCannotFoldEntityNamesOrFixedContentIntoAnotherValue() {
        assertNull(GoalTemplate.bind("Send to Bob: {{body}}", "Send to BOB: Hello"))
        assertNull(GoalTemplate.bind("打开Ａ", "打开A"))
        assertNull(GoalTemplate.bind("Send Hello  world", "Send Hello world"))
    }
}
