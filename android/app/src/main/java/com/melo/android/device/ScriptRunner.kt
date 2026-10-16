package com.melo.android.device

import com.melo.android.data.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

data class ScriptReplay(val outcome: DeviceOutcome, val completedSteps: Int, val unsafeToResume: Boolean)

/** No model dependency: every target is resolved against a new native observation. */
class ScriptRunner(private val execute: suspend (JsonObject) -> DeviceToolResult,
    private val onStep: suspend (DeviceStep) -> Unit = {}, private val onPhase: (String) -> Unit = {}, private val completionTimeoutMs: Int = 10_000) {
    init { require(completionTimeoutMs in 100..10_000) }
    private class ReplayFailure(val code: String, override val message: String) : Exception(message)
    private fun expand(text: String, values: Map<String, String>): String {
        return GoalTemplate.render(text, values)
    }
    private suspend fun observe(window: Int? = null): DeviceToolResult = execute(buildJsonObject {
        put("action", "observe"); window?.let { put("window_id", it) }
    })
    private suspend fun prepare(step: ScriptStep, values: Map<String, String>, deadline: Long = Long.MAX_VALUE): Pair<DeviceToolResult, JsonObject?> {
        val until = minOf(deadline, System.nanoTime() + step.timeoutMs * 1_000_000L)
        var lastError = "目标页面或节点尚未出现。"
        do {
            currentCoroutineContext().ensureActive()
            var screen = observe()
            val title = expand(step.windowTitle, values)
            if (screen.ok && (step.packageName.isBlank() || screen.data.text("package_name") == step.packageName)) {
                if (title.isNotBlank() && screen.data.text("window_title") != title) {
                    val panes = screen.data["related_windows"]?.jsonArray.orEmpty().filter { it.jsonObject.text("title") == title }
                    if (panes.size > 1) throw ReplayFailure("ambiguous_window", "存在多个同名窗口，已停止。")
                    if (panes.size == 1) screen = observe(panes.single().jsonObject["window_id"]!!.jsonPrimitive.int)
                }
                if (screen.ok && (title.isBlank() || screen.data.text("window_title") == title) && (step.packageName.isBlank() || screen.data.text("package_name") == step.packageName)) {
                    val selector = step.selector?.let { it.copy(text = expand(it.text, values), description = expand(it.description, values)) }
                    if (selector == null) return screen to null
                    val nodes = screen.data["nodes"]?.jsonArray.orEmpty().map { it.jsonObject }.filter(selector::matches)
                    if (nodes.size > 1) throw ReplayFailure("ambiguous_target", "节点 selector 匹配多个目标，未执行动作。")
                    if (nodes.size == 1) return screen to nodes.single()
                    lastError = "当前页面找不到脚本目标，未执行动作。"
                }
            } else if (!screen.ok) lastError = screen.data.text("error").ifBlank { "无法观察目标页面。" }
            delay(minOf(250L, ((until - System.nanoTime()) / 1_000_000).coerceAtLeast(1)))
        } while (System.nanoTime() < until)
        throw ReplayFailure("target_not_found", lastError)
    }
    private fun swipe(step: ScriptStep, screen: JsonObject, node: JsonObject): JsonObject {
        val box = node["bounds"]?.jsonArray?.map { it.jsonPrimitive.int } ?: throw ReplayFailure("invalid_bounds", "滚动容器没有可用范围。")
        val width = screen["image_width"]!!.jsonPrimitive.int; val height = screen["image_height"]!!.jsonPrimitive.int
        val left = box[0].coerceIn(0, width - 1); val top = box[1].coerceIn(0, height - 1)
        val right = box[2].coerceIn(0, width - 1); val bottom = box[3].coerceIn(0, height - 1)
        val cx = (left + right) / 2; val cy = (top + bottom) / 2
        val x1 = left + (right - left) / 5; val x2 = right - (right - left) / 5
        val y1 = top + (bottom - top) / 5; val y2 = bottom - (bottom - top) / 5
        val points = when (step.direction) { "up" -> listOf(cx, y2, cx, y1); "down" -> listOf(cx, y1, cx, y2); "left" -> listOf(x2, cy, x1, cy); else -> listOf(x1, cy, x2, cy) }
        return buildJsonObject {
            put("action", "swipe"); put("screen_id", screen.text("screen_id")); put("duration_ms", step.durationMs.coerceAtMost(1500))
            listOf("x", "y", "end_x", "end_y").forEachIndexed { index, key -> put(key, points[index]) }
        }.also(DeviceTools::validate)
    }
    suspend fun run(script: DeviceScript, parameters: Map<String, String>): ScriptReplay {
        ScriptValidator.validate(script)
        require(parameters.keys.all { it in script.parameters } && script.parameters.all { it in parameters } && parameters.values.all { it.length <= 4000 }) { "脚本输入参数缺失或过长。" }
        var completed = 0; var unsafe = false
        try {
            for ((index, step) in script.steps.withIndex()) {
                currentCoroutineContext().ensureActive(); onPhase("本机脚本 · ${index + 1}/${script.steps.size} · ${step.action}")
                val started = System.nanoTime()
                val deadline = started + step.timeoutMs * 1_000_000L
                var receipt: DeviceToolResult? = null
                for (attempt in 0..1) {
                    val prepared = if (step.action in setOf("open_app", "wait")) null else prepare(step, parameters, deadline)
                    val args = when (step.action) {
                        "open_app" -> buildJsonObject { put("action", "open_app"); put("package_name", step.packageName) }
                        "wait" -> buildJsonObject { put("action", "wait"); put("duration_ms", step.durationMs) }
                        "swipe" -> swipe(step, prepared!!.first.data, prepared.second!!)
                        else -> buildJsonObject {
                            put("action", step.action); put("screen_id", prepared!!.first.data.text("screen_id"))
                            prepared.second?.let { put("node_id", it.text("node_id")) }
                            if (step.action == "type_text") put("text", if (step.parameter.isBlank()) step.text else parameters.getValue(step.parameter))
                        }
                    }
                    DeviceTools.validate(args)
                    val previouslyUnsafe = unsafe
                    if (step.action in setOf("tap", "type_text", "swipe", "back")) unsafe = true
                    receipt = execute(args)
                    if (!receipt.ok && receipt.data.text("code") in setOf("stale_screen", "stale_target", "user_declined", "invalid_arguments")) unsafe = previouslyUnsafe
                    if (receipt.ok || receipt.data.text("code") !in setOf("stale_screen", "stale_target") || attempt == 1) break
                }
                val result = receipt!!
                // Even a custom unlabeled button can commit. Never auto-resume a
                // failed cache by replaying previous taps/typing from the beginning.
                if (step.action in setOf("tap", "type_text", "swipe", "back") && (result.ok || result.data.text("code") !in setOf("stale_screen", "stale_target", "user_declined", "invalid_arguments"))) unsafe = true
                onStep(DeviceStep(step.action, result.ok, "本机脚本第 ${index + 1} 步" + if (result.ok) "已返回执行回执" else "失败，已停止", durationMs = (System.nanoTime() - started) / 1_000_000, code = result.data.text("code")))
                if (!result.ok) return ScriptReplay(DeviceOutcome(if (result.data.text("code") == "user_declined") "needs_user" else "blocked", error = result.data.text("error")), completed, unsafe || result.data.text("code") == "user_declined")
                completed++
            }
            onPhase("本机脚本 · 重新检查终态…")
            val assertion = script.completion
            val text = if (assertion.parameter.isNotBlank()) parameters.getValue(assertion.parameter) else expand(assertion.visibleText, parameters)
            val target = ScriptStep("wait", assertion.packageName, assertion.windowTitle, timeoutMs = completionTimeoutMs)
            val until = System.nanoTime() + completionTimeoutMs * 1_000_000L
            var previous = prepare(target, parameters, until).first
            fun visible(): Boolean = text.isBlank() || previous.data["nodes"]?.jsonArray.orEmpty().any { it.jsonObject.text("text") == text || it.jsonObject.text("description") == text }
            while ((!visible() || previous.data["stable"]?.jsonPrimitive?.booleanOrNull == false) && System.nanoTime() < until) { delay(250); if (System.nanoTime() < until) previous = prepare(target, parameters, until).first }
            val claim = buildJsonObject { put("action", "finish"); put("outcome", "achieved"); put("summary", "本机脚本已执行并重新检查终态。"); put("screen_id", previous.data.text("screen_id")); put("expected_package", assertion.packageName); if (text.isNotBlank()) put("visible_text", text) }
            val started = System.nanoTime()
            val verified = DeviceCompletion.verify(claim, previous, observe(previous.data["window_id"]?.jsonPrimitive?.intOrNull))
            onStep(DeviceStep("finish", verified.ok, if (verified.ok) "本机脚本终态已重新校验" else "终态不匹配，未标记完成", durationMs = (System.nanoTime() - started) / 1_000_000, code = verified.data.text("code")))
            return ScriptReplay(if (verified.ok) DeviceOutcome("achieved", claim.text("summary"), verification = "visible_facts") else DeviceOutcome("blocked", error = verified.data.text("error")), completed, unsafe)
        } catch (e: CancellationException) { throw e }
        catch (e: ReplayFailure) {
            onStep(DeviceStep("observe", false, "脚本第 ${completed + 1} 步定位失败，未重放动作", code = e.code))
            return ScriptReplay(DeviceOutcome("blocked", error = e.message), completed, unsafe)
        }
        catch (_: Exception) {
            onStep(DeviceStep("observe", false, "本机脚本执行中断，请检查步骤和目标页面。", code = "script_error"))
            return ScriptReplay(DeviceOutcome("blocked", error = "本机脚本执行中断，请检查步骤和目标页面。"), completed, unsafe)
        }
    }
}
