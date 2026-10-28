package com.melo.android.device

import com.melo.android.data.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

/** Native effects only. The owning Chat loop is the sole model/decision loop. */
internal class DeviceActionSession(
    private val executor: DeviceExecutor,
    private val scope: String,
    initial: DeviceRun,
    private val persist: suspend (DeviceRun) -> Unit,
    private val publish: suspend (DeviceScript) -> Unit,
    private val phase: (String) -> Unit = {},
    private val validateCurrent: () -> Boolean = { true },
    private val scriptCurrent: (DeviceScript) -> Boolean = { true },
    private val onReplay: suspend (DeviceScript, ScriptReplay) -> Unit = { _, _ -> },
) {
    var run = initial; private set
    private var latest: DeviceToolResult? = null
    private var begun = false
    private var terminal = false
    private var closed = false
    private var verifiedSubgoal: DeviceOutcome? = null
    private val effects = mutableListOf<JsonObject>()
    private val launches = DeviceLaunchGuard()
    private val unsafeWorkflows = mutableSetOf<String>()
    private val publisher = VerifiedScriptPublisher(scope, initial.id, { executor.cacheEnvironment(0, it) }, publish)
    private val recorder = ScriptRecorder(initial.goal)
    private var initialLayout: String? = null
    private val versions = mutableMapOf<String, Long>()
    private suspend fun step(action: String, result: DeviceToolResult, started: Long) {
        run = run.copy(steps = run.steps + DeviceStep(action, result.ok,
            result.data.text("error").ifBlank { "主 Loop 原子操作回执" }, durationMs = (System.nanoTime() - started) / 1_000_000,
            code = result.data.text("code")))
        persist(run)
    }
    private suspend fun native(args: JsonObject): DeviceToolResult {
        if (!validateCurrent()) return DeviceToolResult.error("所属对话、权限或设备连接已改变，未执行。", "device_scope_changed")
        if (initialLayout == null) initialLayout = executor.cacheEnvironment(0, emptySet())?.layout
        if (args.text("action") in setOf("open_app", "tap", "type_text", "submit_input", "swipe", "back", "home")) verifiedSubgoal = null
        val before = latest
        val result = executor.execute(args)
        val action = args.text("action")
        if (action in setOf("open_app", "tap", "type_text", "submit_input", "swipe", "back", "home") && (result.ok || result.data.text("effect_state") == "applied")) {
            val target = before?.data?.get("nodes")?.jsonArray.orEmpty().map { it.jsonObject }.singleOrNull { it.text("node_id") == args.text("node_id") }
            effects += buildJsonObject {
                put("action", action); put("package_name", before?.data?.text("package_name").orEmpty())
                target?.let { put("target", buildJsonObject { for (key in listOf("view_id", "text", "description")) it[key]?.let { value -> put(key, value) } }) }
                if (action == "type_text") put("input", args.text("text"))
                if (action == "open_app") put("target_package", result.data.text("target_package"))
                put("effect_state", "applied")
            }
            while (effects.size > 30) effects.removeAt(0)
        }
        if (result.ok && result.data.text("screen_id").isNotBlank()) latest = result
        val pkg = result.data.text("package_name")
        if (pkg.isNotBlank()) executor.cacheEnvironment(0, setOf(pkg))?.appVersions?.get(pkg)?.let { versions.putIfAbsent(pkg, it) }
        recorder.record(args, result)
        publisher.record(args, result)
        return result
    }
    suspend fun execute(args: JsonObject): DeviceToolResult {
        if (closed) return DeviceToolResult.error("设备 Lease 已释放。", "DEVICE_TASK_CLOSED")
        if (terminal && !(run.status == "achieved" && args.text("action") == "observe")) return DeviceToolResult.error("本轮设备工作已结束；请使用已有回执继续回答。", "DEVICE_TASK_FINISHED")
        if (!validateCurrent()) return DeviceToolResult.error("所属对话或权限已改变，未执行。", "device_scope_changed")
        try { DeviceTools.validate(args) } catch (error: IllegalArgumentException) { return DeviceToolResult.error(error.message.orEmpty(), "invalid_arguments") }
        if (!begun) { executor.begin(0, false); begun = true }
        val action = args.text("action")
        phase("手机 · $action")
        val started = System.nanoTime()
        val result = if (action in setOf("checkpoint", "finish")) {
            if (action == "finish" && args.text("outcome") != "achieved") DeviceToolResult(buildJsonObject { put("ok", true); put("status", args.text("outcome")) })
            else if (latest?.data?.text("screen_id") != args.text("screen_id")) DeviceToolResult.error("请使用最近 screen_id。", "stale_evidence")
            else {
                val previous = latest
                val fresh = native(buildJsonObject { put("action", "observe"); previous?.data?.get("window_id")?.let { put("window_id", it) } })
                DeviceCompletion.verify(args, previous, fresh)
            }
        } else if (action == "open_app" && launches.count(args) >= 2) DeviceToolResult.error("已反复请求打开同一 App；请根据已有结果改变策略。", "repeated_launch")
        else native(args)
        launches.record(args, result)
        if (action in setOf("checkpoint", "finish")) { recorder.record(args, result); publisher.record(args, result) }
        if (action == "finish" && result.ok && args.text("outcome") == "achieved") {
            recorder.compileCanonical(scope, run.id)?.copy(cacheKind = "subflow")?.let { script ->
                val env = executor.cacheEnvironment(0, script.packages())
                if (env != null && env.layout == initialLayout && versions.all { (pkg, version) -> env.appVersions[pkg] == version }) {
                    val bound = script.copy(environment = env)
                    if (env.supports(bound)) publish(bound)
                }
            }
        }
        if (action == "finish" && result.ok) {
            terminal = true
            run = run.copy(status = args.text("outcome"), answer = args.text("summary"), verification = result.data.text("verification").ifBlank { null }, finishedAt = now())
        } else if (result.data.text("code") == "user_declined") {
            terminal = true; run = run.copy(status = "needs_user", error = result.data.text("error"), finishedAt = now())
        }
        if (action == "checkpoint" && result.ok) verifiedSubgoal = DeviceOutcome("achieved", args.text("goal"), verification = result.data.text("verification"))
        step(action, result, started)
        return DeviceToolResult(JsonObject(result.data + buildJsonObject {
            put("run_id", run.id); put("goal", run.goal); put("applied_effects", JsonArray(effects)); if (terminal) put("status", run.status)
        }), result.jpeg)
    }
    suspend fun replay(script: DeviceScript, parameters: Map<String, String>): DeviceToolResult {
        if (closed) return DeviceToolResult.error("设备 Lease 已释放。", "DEVICE_TASK_CLOSED")
        if (terminal) return DeviceToolResult.error("本轮设备工作已结束。", "DEVICE_TASK_FINISHED")
        if (script.id in unsafeWorkflows) return DeviceToolResult.error("该 Workflow 已有步骤产生效果；不能从头重放，请根据现状继续。", "WORKFLOW_ALREADY_APPLIED")
        if (!begun) { executor.begin(0, false); begun = true }
        val started = System.nanoTime()
        val result = ScriptRunner(::native, onStep = { row -> run = run.copy(steps = run.steps + row); persist(run) }, onPhase = phase,
            compatible = { validateCurrent() && scriptCurrent(script) && script.environment?.let { saved -> executor.cacheEnvironment(0, script.packages())?.let { it.layout == saved.layout && it.supports(script) } } == true }).run(script, parameters)
        if (result.unsafeToResume && result.outcome.status != "achieved") unsafeWorkflows += script.id
        if (result.outcome.status == "needs_user") {
            terminal = true; run = run.copy(status = "needs_user", error = result.outcome.error, finishedAt = now())
        }
        onReplay(script, result)
        verifiedSubgoal = result.outcome.takeIf { it.status == "achieved" && it.verification == "visible_facts" }
        run = run.copy(scriptId = script.id, scriptRevision = script.revision, cacheId = if (result.outcome.status == "achieved") script.id else run.cacheId,
            cacheReplayMs = run.cacheReplayMs + (System.nanoTime() - started) / 1_000_000)
        persist(run)
        return DeviceToolResult(buildJsonObject {
            latest?.data?.forEach { (key, value) -> put(key, value) }
            put("ok", result.outcome.status == "achieved"); put("status", result.outcome.status); put("run_id", run.id)
            put("applied_effects", JsonArray(effects)); if (result.outcome.status == "achieved") put("cache_id", script.id)
            put("goal", GoalTemplate.render(script.goalTemplate, parameters)); put("verification", result.outcome.verification.orEmpty())
            put("summary", result.outcome.answer); put("completed_steps", result.completedSteps); put("unsafe_to_restart", result.unsafeToResume)
            result.outcome.error?.let { put("error", it); put("code", "WORKFLOW_INCOMPLETE") }
            put("hint", "This receipt covers only the workflow subgoal. Continue remaining work from current state; never repeat applied steps.")
        }, latest?.jpeg)
    }
    suspend fun close(cancelled: Boolean = false, rootCompleted: Boolean = false) {
        try {
            if (!terminal) {
                val proof = verifiedSubgoal.takeIf { rootCompleted && !cancelled && validateCurrent() }
                run = if (proof != null) run.copy(status = "achieved", answer = proof.answer, verification = proof.verification, finishedAt = now())
                else run.copy(status = if (cancelled) "cancelled" else "partial", finishedAt = now(), error = "设备步骤已保留；未提交经过校验的终态。")
                persist(run)
            }
        } finally { closed = true; if (begun) { begun = false; executor.end() } }
    }
}
