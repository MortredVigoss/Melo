package com.melo.android.device

import com.melo.android.core.SharedCoreTurn

import com.melo.android.data.*
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.*
import java.security.MessageDigest

data class DeviceOutcome(val status: String, val answer: String = "", val error: String? = null, val verification: String? = null)

/** Model prose and a successful gesture are never a completion receipt. */
object DeviceCompletion {
    fun verify(arguments: JsonObject, previous: DeviceToolResult?, current: DeviceToolResult): DeviceToolResult {
        if (previous == null || !previous.ok || previous.data.text("screen_id").isBlank() || arguments.text("screen_id") != previous.data.text("screen_id"))
            return DeviceToolResult.error("完成证据未引用最近画面，请重新观察。", "stale_evidence")
        if (!current.ok) return current
        if (current.data["stable"]?.jsonPrimitive?.booleanOrNull == false) return DeviceToolResult.error("校验期间页面仍在变化，请等待稳定后重新检查。", "unstable_evidence")
        if (current.data.text("screen_id").isBlank()) return DeviceToolResult.error("无法取得可校验画面。", "unverified_goal")
        val expectedPackage = arguments.text("expected_package")
        val expectedText = arguments.text("visible_text")
        fun matches(screen: JsonObject): Boolean {
            if (expectedPackage.isNotBlank() && screen.text("package_name") != expectedPackage) return false
            if (expectedText.isNotBlank() && screen["nodes"]?.jsonArray.orEmpty().none {
                val node = it.jsonObject
                node.text("text") == expectedText || node.text("description") == expectedText
            }) return false
            return true
        }
        return if (matches(previous.data) && matches(current.data)) DeviceToolResult(JsonObject(current.data + ("verification" to "visible_facts".jp())))
        else DeviceToolResult.error("最新画面不符合声明的完成证据，请调整操作或诚实报告受阻。", "unverified_goal")
    }
}

/** In-memory hashes only; UI text and action arguments never enter persisted traces. */
object DeviceProgress {
    fun fingerprint(result: DeviceToolResult): String {
        val content = JsonObject(result.data.filterKeys { it !in setOf("screen_id", "window_id", "screenshot_error", "stable", "action") })
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(content.toString().toByteArray())
        // Games may expose no nodes while their rendered screen is changing.
        // Keep only a hash; neither pixels nor tree text are persisted here.
        result.jpeg?.let { digest.update(it.toByteArray()) }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}

/** Pure coroutine loop: fixtureable without a phone, service or live model. */
class DeviceTaskLoop(
    private val protocol: String,
    private val next: suspend (List<JsonObject>) -> DeviceTurn,
    private val execute: suspend (JsonObject) -> DeviceToolResult,
    private val onStep: suspend (DeviceStep) -> Unit,
    private val onPhase: (String) -> Unit = {},
    private val maxSteps: Int = 30,
    private val onResult: (JsonObject, DeviceToolResult) -> Unit = { _, _ -> },
    private val core: SharedCoreTurn? = null,
) {
    suspend fun run(goal: String): DeviceOutcome {
        val history = DeviceAgentClient.initial(protocol, goal)
        val launches = DeviceLaunchGuard()
        val callIds = mutableSetOf<String>()
        var latestScreen: DeviceToolResult? = null
        var previous: DeviceToolResult? = null
        var recovery = 0
        var finalRecovery = false
        var discoveryRecovery = false
        for (step in 1..maxSteps) {
            currentCoroutineContext().ensureActive()
            onPhase("模型正在决定第 $step 步…")
            DeviceContextBudget.compact(history, protocol)
            if (core?.active == false) return DeviceOutcome("blocked", error = "共享 Agent 已停止（${core.reason}）。已有步骤保留。")
            core?.request()
            val turn = next(history)
            currentCoroutineContext().ensureActive()
            for (call in turn.calls) {
                require(call.id.isNotBlank() && call.id.length <= 256 && callIds.add(call.id)) { "模型返回了无效或重复的调用编号，已停止，未重复执行。" }
            }
            history += turn.wire
            if (turn.calls.isEmpty()) {
                core?.event("feedback")
                if (previous?.data?.text("code") == "app_not_found" && !discoveryRecovery) {
                    discoveryRecovery = true; recovery++
                    history += message("The last open_app failed. Before concluding the app is unavailable, search ALL apps with list_apps(query=shorter name/alternate language/package fragment), inspect candidates and pagination, or use home + observe and launcher search. Never repeat the same failing arguments or open unrelated candidates. Do not install apps or change permissions. Keep the user's goal.")
                    continue
                }
                if (!finalRecovery) {
                    finalRecovery = true; recovery++
                    history += message("A final text reply is not a verified outcome. Use android_device action=finish with outcome=achieved, blocked or needs_user and summary. achieved requires latest screen_id and expected_package and/or exact visible_text grounded in returned nodes. If the goal cannot be checked from visible facts, use needs_user. Do not invent evidence.")
                    continue
                }
                return DeviceOutcome(if (previous?.ok == false) "blocked" else "needs_user", turn.text.take(2000), "模型未提交可校验结果，未标记为完成。")
            }
            val call = turn.calls.single()
            core?.calls(turn.calls.map { it.id to it.name }, turn.calls.associate { it.id to it.arguments }, requireAll = false)
            val action = call.arguments.text("action")
            onPhase("第 $step 步 · $action")
            val started = System.nanoTime()
            val repeatedLaunch = action == "open_app" && launches.count(call.arguments) >= 2
            val result = try {
                DeviceTools.validate(call.arguments)
                if (core != null && !core.permits(call.id)) DeviceToolResult.error("Shared loop refused this operation.", core.rejection(call.id))
                else if (repeatedLaunch) DeviceToolResult.error("同一 App 已反复请求打开；已停止重复执行。请检查现有页面或缩小目标。", "repeated_launch")
                else if (action == "finish") {
                    if (call.arguments.text("outcome") != "achieved" && previous?.data?.text("code") == "app_not_found" && !discoveryRecovery) {
                        discoveryRecovery = true
                        DeviceToolResult.error("Before concluding the app is unavailable, search ALL apps using list_apps(query=shorter name/alternate name/package fragment) and inspect candidates/pagination, or home + observe and launcher search. Do not repeat failing arguments, install apps or change permissions. If still blocked or ambiguous, finish honestly; this recovery is offered only once.", "discovery_required")
                    }
                    else if (call.arguments.text("outcome") != "achieved") DeviceToolResult(buildJsonObject { put("ok", true) })
                    else if (latestScreen?.data?.text("screen_id") != call.arguments.text("screen_id")) DeviceToolResult.error("请使用最近 screen_id。", "stale_evidence")
                    else DeviceCompletion.verify(call.arguments, latestScreen, execute(buildJsonObject {
                        put("action", "observe")
                        latestScreen?.data?.get("window_id")?.jsonPrimitive?.intOrNull?.let { put("window_id", it) }
                    }))
                } else execute(call.arguments)
            } catch (e: IllegalArgumentException) { DeviceToolResult.error("工具参数不符合执行契约：" + (e.message?.take(300) ?: "请检查 action 与必需字段。"), "invalid_arguments") }
            currentCoroutineContext().ensureActive()
            if (!result.ok) recovery++
            val detail = when {
                !result.ok -> result.data.text("error").take(300)
                action == "list_apps" -> "检索 ${result.data["total_apps"]} 个 App，匹配 ${result.data["matched_apps"]} 个，本页 ${result.data["apps"]?.jsonArray?.size ?: 0} 个" + if (result.data["has_more"]?.jsonPrimitive?.booleanOrNull == true) "，还有下一页" else ""
                action == "finish" -> "已记录明确任务结果" + if (result.data.text("verification").isNotBlank()) " · 已重新检查可见证据" else ""
                else -> "执行回执已返回" + if (result.data.text("screen_id").isNotBlank()) {
                    " · ${result.data.text("package_name").ifBlank { "未知窗口" }} · ${result.data["image_width"]}×${result.data["image_height"]} · ${result.data["nodes"]?.jsonArray?.size ?: 0} 个节点" +
                        if (result.data["screenshot_available"]?.jsonPrimitive?.booleanOrNull == true) " · 已截图"
                        else result.data.text("screenshot_error").takeIf(String::isNotBlank)?.let { " · 截图不可用：${it.take(120)}" }.orEmpty()
                } else ""
            }
            onStep(DeviceStep(action, result.ok, detail, callId = call.id, durationMs = (System.nanoTime() - started) / 1_000_000, code = result.data.text("code"), recoveryCount = recovery))
            DeviceAgentClient.appendResult(history, protocol, call, result)
            onResult(call.arguments, result)
            if (core?.active == true) core.result(call.id, result.ok, code = result.data.text("code"), output = result.data.toString())
            launches.record(call.arguments, result)
            if (result.data.text("code") == "foreground_window_unavailable") return DeviceOutcome("needs_user", error = result.data.text("error"))
            if (repeatedLaunch) return DeviceOutcome("blocked", error = result.data.text("error"))
            if (action == "open_app" && launches.count(call.arguments) >= 2) history += message("You have already requested this same app twice. Do not call open_app for it again without a meaningful navigation action. Inspect the returned package_name, window_title and related_windows. A foldable app can show a main navigation pane and a different detail pane simultaneously; use observe(window_id=...) for a related pane. If the requested visible goal is already satisfied, call finish with evidence now. Otherwise navigate toward the remaining goal or finish blocked; repeatedly launching is not progress.")
            previous = result
            if (result.data.text("code") == "user_declined") return DeviceOutcome("needs_user", error = "本步操作未获允许；已停止，未自动重试。")
            if (result.data.text("screen_id").isNotBlank() && result.ok) latestScreen = result
            if (core?.active == false) return DeviceOutcome("blocked", error = "共享 Agent 已停止（${core.reason}）。已有步骤保留。")
            if (action == "finish" && result.ok) return DeviceOutcome(call.arguments.text("outcome"), call.arguments.text("summary"), verification = result.data.text("verification").ifBlank { null })
            core?.observeDevice(action, result.ok, DeviceProgress.fingerprint(result))
            if (core?.active == false) return DeviceOutcome("blocked", error = "共享 Agent 已停止（${core.reason}）。已有步骤保留。")
        }
        return DeviceOutcome("blocked", error = "达到 $maxSteps 步上限，已停止；已执行步骤保留。")
    }
    private fun message(text: String) = buildJsonObject { put("role", "user"); put("content", text) }
}
