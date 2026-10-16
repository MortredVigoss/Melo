package com.melo.android.device

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
class DeviceProgress {
    private val seen = mutableSetOf<String>()
    private var unchanged = 0
    private var unresolvedErrors = 0
    fun record(action: String, result: DeviceToolResult): String? {
        if (!result.ok) unresolvedErrors++
        else if (action in setOf("tap", "type_text", "swipe", "back", "home", "open_app")) unresolvedErrors = 0
        val content = JsonObject(result.data.filterKeys { it !in setOf("screen_id", "window_id", "screenshot_error", "stable", "action") })
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(content.toString().toByteArray())
        // Games may expose no nodes while their rendered screen is changing.
        // Keep only a hash; neither pixels nor tree text are persisted here.
        result.jpeg?.let { digest.update(it.toByteArray()) }
        val next = digest.digest().joinToString("") { "%02x".format(it) }
        unchanged = if (seen.add(next)) 0 else unchanged + 1
        return when {
            unresolvedErrors >= 3 -> "多次动作失败，观察成功也未解决阻塞；已停止，请检查目标和权限。"
            unchanged >= 5 -> "连续操作没有产生可确认的进展，已停止；请缩小目标或提供更多线索。"
            else -> null
        }
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
) {
    suspend fun run(goal: String): DeviceOutcome {
        val history = DeviceAgentClient.initial(protocol, goal)
        val progress = DeviceProgress()
        var latestScreen: DeviceToolResult? = null
        var previous: DeviceToolResult? = null
        var recovery = 0
        var finalRecovery = false
        var discoveryRecovery = false
        for (step in 1..maxSteps) {
            currentCoroutineContext().ensureActive()
            onPhase("模型正在决定第 $step 步…")
            DeviceContextBudget.compact(history, protocol)
            val turn = next(history)
            currentCoroutineContext().ensureActive()
            history += turn.wire
            if (turn.calls.isEmpty()) {
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
            val action = call.arguments.text("action")
            onPhase("第 $step 步 · $action")
            val started = System.nanoTime()
            val result = try {
                DeviceTools.validate(call.arguments)
                if (action == "finish") {
                    if (call.arguments.text("outcome") != "achieved" && previous?.data?.text("code") == "app_not_found" && !discoveryRecovery) {
                        discoveryRecovery = true
                        DeviceToolResult.error("Before concluding the app is unavailable, search ALL apps using list_apps(query=shorter name/alternate name/package fragment) and inspect candidates/pagination, or home + observe and launcher search. Do not repeat failing arguments, install apps or change permissions. If still blocked or ambiguous, finish honestly; this recovery is offered only once.", "discovery_required")
                    }
                    else if (call.arguments.text("outcome") != "achieved") DeviceToolResult(buildJsonObject { put("ok", true) })
                    else if (latestScreen?.data?.text("screen_id") != call.arguments.text("screen_id")) DeviceToolResult.error("请使用最近 screen_id。", "stale_evidence")
                    else DeviceCompletion.verify(call.arguments, latestScreen, execute(buildJsonObject { put("action", "observe") }))
                } else execute(call.arguments)
            } catch (e: IllegalArgumentException) { DeviceToolResult.error("工具参数不符合执行契约，请检查 action 与必需字段。", "invalid_arguments") }
            currentCoroutineContext().ensureActive()
            if (!result.ok) recovery++
            val detail = when {
                !result.ok -> result.data.text("error").take(300)
                action == "list_apps" -> "检索 ${result.data["total_apps"]} 个 App，匹配 ${result.data["matched_apps"]} 个，本页 ${result.data["apps"]?.jsonArray?.size ?: 0} 个" + if (result.data["has_more"]?.jsonPrimitive?.booleanOrNull == true) "，还有下一页" else ""
                action == "finish" -> "已记录明确任务结果" + if (result.data.text("verification").isNotBlank()) " · 已重新检查可见证据" else ""
                else -> "执行回执已返回" + if (result.data["screenshot_available"]?.jsonPrimitive?.booleanOrNull == true) " · 已截图" else ""
            }
            onStep(DeviceStep(action, result.ok, detail, callId = call.id, durationMs = (System.nanoTime() - started) / 1_000_000, code = result.data.text("code"), recoveryCount = recovery))
            DeviceAgentClient.appendResult(history, protocol, call, result)
            previous = result
            if (result.data.text("code") == "user_declined") return DeviceOutcome("needs_user", error = "本步操作未获允许；已停止，未自动重试。")
            if (result.data.text("screen_id").isNotBlank() && result.ok) latestScreen = result
            if (action == "finish" && result.ok) return DeviceOutcome(call.arguments.text("outcome"), call.arguments.text("summary"), verification = result.data.text("verification").ifBlank { null })
            progress.record(action, result)?.let { return DeviceOutcome("blocked", error = it) }
        }
        return DeviceOutcome("blocked", error = "达到 $maxSteps 步上限，已停止；已执行步骤保留。")
    }
    private fun message(text: String) = buildJsonObject { put("role", "user"); put("content", text) }
}
