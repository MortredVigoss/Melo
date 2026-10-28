package com.melo.android.device

import com.melo.android.data.*
import kotlinx.serialization.json.*

/** Verified parts, independent of the parent task's eventual terminal status.
 * Recipes contain semantic selectors/parameters, never pixels or session IDs.
 */
internal class VerifiedScriptPublisher(
    private val scope: String, private val runId: String,
    private val environment: (Set<String>) -> CacheEnvironment?,
    private val publish: suspend (DeviceScript) -> Unit,
) {
    private var segment: ScriptRecorder? = null
    private var initialEnvironment: CacheEnvironment? = null
    private val published = mutableSetOf<String>()
    private var latest: JsonObject? = null
    private var entered: String? = null
    private suspend fun emit(script: DeviceScript) {
        val current = environment(script.packages()) ?: return
        if (current.layout != initialEnvironment?.layout || !current.supports(script.copy(environment = initialEnvironment))) return
        val bound = script.copy(environment = current)
        // Publish a semantic goal/environment at most once per run. This also
        // prevents a later checkpoint/alias from resurrecting a user-deleted
        // entry which was first learned during this same running task.
        val key = buildJsonArray { add(bound.cacheKind); add(bound.scope); add(bound.goalTemplate); add(MeloJson.encodeToJsonElement(current)) }.toString()
        if (key in published) return
        ScriptValidator.validate(bound)
        publish(bound)
        published += key
    }
    suspend fun record(arguments: JsonObject, result: DeviceToolResult) {
        val action = arguments.text("action")
        val before = latest
        if (result.ok && result.data.text("screen_id").isNotBlank()) latest = result.data
        if (action in setOf("open_app", "back", "home")) entered = null
        if (action == "type_text" && result.ok) entered = arguments.text("text")
        if (action == "open_app" && result.ok) {
            val pkg = result.data.text("target_package")
            // Native open_app already waits for and observes this exact foreground
            // package. Dispatch alone, a wrong pane/package or a missing screen is
            // insufficient. An animated ad inside the app doesn't undo the launch.
            if (pkg.isBlank() || result.data.text("package_name") != pkg || result.data.text("screen_id").isBlank() ||
                (arguments.text("package_name").isNotBlank() && arguments.text("package_name") != pkg)) return
            val recipe = DeviceScript(name = "打开 " + arguments.text("app_name").ifBlank { pkg }.take(90), goalTemplate = "Open app $pkg",
                steps = listOf(ScriptStep("open_app", packageName = pkg)), completion = ScriptAssertion(pkg), scope = scope,
                sourceRunId = runId, verified = true, successes = 1, cacheKind = "action")
            initialEnvironment = environment(recipe.packages())
            segment = ScriptRecorder("Reusable subflow").also { it.record(arguments, result) }
            emit(recipe)
            return
        }
        segment?.record(arguments, result)
        if (action == "submit_input" && result.ok && !entered.isNullOrBlank() && before?.text("package_name") == result.data.text("package_name")) {
            val query = entered!!
            // A populated editor proves input, not a completed search. Learn only
            // when a different, noneditable result exposes the submitted query.
            val fact = result.data["nodes"]?.jsonArray.orEmpty().map { it.jsonObject }.filter { it["editable"]?.jsonPrimitive?.booleanOrNull != true }
                .flatMap { listOf(it.text("text"), it.text("description")) }.firstOrNull { it.isNotBlank() && it.length <= 300 && it.contains(query) }
            if (fact != null && result.data.text("screen_id") != before?.text("screen_id")) {
                val checkpoint = buildJsonObject {
                    put("action", "checkpoint"); put("goal", "Search ${result.data.text("package_name")} for $query")
                    put("expected_package", result.data.text("package_name")); put("visible_text", fact)
                }
                val verified = DeviceToolResult(JsonObject(result.data + ("verification" to JsonPrimitive("visible_facts"))))
                segment?.record(checkpoint, verified)
                segment?.compile(scope, runId, checkpoint.text("goal"))?.copy(cacheKind = "subflow")?.let { emit(it) }
            }
        }
        if (action == "checkpoint" && result.ok && result.data.text("verification") == "visible_facts") {
            segment?.compile(scope, runId, arguments.text("goal"))?.copy(cacheKind = "subflow")?.let { emit(it) }
        }
    }
}
