package com.melo.android.device

import android.content.Context
import android.widget.Toast
import com.melo.android.BuildConfig
import com.melo.android.data.*
import com.melo.android.network.ConnectionPolicy
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*

data class DeviceRuntime(val running: Boolean = false, val runId: String? = null, val phase: String = "", val error: String? = null)

class DeviceAgent(private val context: Context, private val repository: Repository,
                  private val client: DeviceAgentClient = DeviceAgentClient(BuildConfig.DEBUG)) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mutable = MutableStateFlow(DeviceRuntime())
    val runtime = mutable.asStateFlow()
    private var job: Job? = null
    fun dismissError() { mutable.update { it.copy(error = null) } }
    fun cancel() { job?.cancel() }
    fun start(goal: String, displayId: Int, screenshots: Boolean, executor: DeviceExecutor? = DeviceAccess.service) {
        if (job?.isActive == true) return
        job = scope.launch {
            var run: DeviceRun? = null
            var begun = false
            try {
                require(goal.isNotBlank() && goal.length <= 4000) { "请输入不超过 4000 字符的操作目标。" }
                val connection = repository.data.value.settings.let { settings -> settings.connections.find { it.id == settings.activeConnection } } ?: error("请先在系统中选择模型连接。")
                val key = repository.credential(connection.id)
                ConnectionPolicy.validate(connection, key, BuildConfig.DEBUG)
                require(connection.protocol != "fixture") { "手机助手需要支持 Tool Calling 的模型连接。" }
                val device = executor ?: error("请先在 Android 设置中启用 Melo 手机助手的 Accessibility Service。")
                device.begin(displayId, screenshots); begun = true
                val started = DeviceRun(goal = goal.trim(), connectionName = connection.name)
                run = started
                val id = started.id
                repository.change { it.copy(deviceRuns = (it.deviceRuns + started).takeLast(50)) }
                mutable.value = DeviceRuntime(true, id, "正在观察屏幕…")
                val history = DeviceAgentClient.initial(connection.protocol, goal.trim())
                var errors = 0
                var previousResult: DeviceToolResult? = null
                var discoveryRecoveryOffered = false
                withTimeout(10 * 60 * 1000L) {
                    for (step in 1..30) {
                        ensureActive()
                        mutable.update { it.copy(phase = "模型正在决定第 $step 步…") }
                        val turn = client.next(connection, key, history)
                        ensureActive(); history += turn.wire
                        if (turn.calls.isEmpty()) {
                            if (previousResult?.data?.text("code") == "app_not_found" && !discoveryRecoveryOffered) {
                                discoveryRecoveryOffered = true
                                history += buildJsonObject {
                                    put("role", "user")
                                    put("content", "The last open_app failed to find an exact launchable match. Before concluding the app is unavailable, revise your strategy: search ALL apps with list_apps(query=shorter name/known alternate name/package fragment); inspect candidates and pagination. If needed use home + observe to inspect launcher search/icons or game launchers. Do not repeat the same failing arguments, open unrelated candidates, install apps, switch profiles or change permissions. If ambiguous or blocked, explain and stop. Keep the original goal and safety constraints.")
                                }
                                continue
                            }
                            require(run!!.steps.any { it.ok }) { "模型未执行任何工具；请确认连接支持 Tool Calling。" }
                            run = run!!.copy(status = if (previousResult?.ok == false) "blocked" else "completed", answer = turn.text.take(8000), finishedAt = now())
                            save(run!!); return@withTimeout
                        }
                        val call = turn.calls.single()
                        mutable.update { it.copy(phase = "第 $step 步 · ${call.arguments.text("action")}") }
                        val result = device.execute(call.arguments)
                        previousResult = result
                        ensureActive()
                        val detail = if (!result.ok) result.data.text("error").take(300) else if (call.arguments.text("action") == "list_apps") {
                            "检索 ${result.data["total_apps"]} 个 App，匹配 ${result.data["matched_apps"]} 个，本页 ${result.data["apps"]?.jsonArray?.size ?: 0} 个" + if (result.data["has_more"]?.jsonPrimitive?.booleanOrNull == true) "，还有下一页" else ""
                        } else "执行回执已返回" + if (result.data["screenshot_available"]?.jsonPrimitive?.booleanOrNull == true) " · 已截图" else ""
                        // Deliberately omit typed text, raw UI trees and screenshots from disk/sync.
                        run = run!!.copy(steps = run!!.steps + DeviceStep(call.arguments.text("action"), result.ok, detail))
                        save(run!!)
                        DeviceAgentClient.appendResult(history, connection.protocol, call, result)
                        errors = if (result.ok) 0 else errors + 1
                        check(errors < 3) { "连续三步无法执行，已停止。请检查屏幕与权限后重新开始。" }
                    }
                    error("已达到 30 步上限，已停止；可以查看记录后继续发起新任务。")
                }
            } catch (e: Exception) {
                val cancelled = e is CancellationException && e !is TimeoutCancellationException
                val message = when { e is TimeoutCancellationException -> "达到 10 分钟上限，已停止。"; cancelled -> "已停止，已执行步骤不会撤销。"; else -> e.message ?: "手机助手执行失败。" }
                withContext(NonCancellable) {
                    run?.let { save(it.copy(status = if (cancelled) "cancelled" else "failed", finishedAt = now(), error = message)) }
                    mutable.update { it.copy(error = if (cancelled) null else message) }
                }
            } finally {
                if (begun) executor?.end()
                mutable.update { it.copy(running = false, phase = "") }
                val status = repository.data.value.deviceRuns.find { it.id == run?.id }?.status
                val notice = when (status) {
                    "completed" -> "Melo 任务已结束，可返回查看结果"
                    "failed", "blocked" -> "Melo 未完成任务，请返回查看原因"
                    "cancelled" -> "Melo 已停止"
                    else -> null
                }
                if (notice != null) Toast.makeText(context, notice, Toast.LENGTH_LONG).show()
            }
        }
    }
    private suspend fun save(run: DeviceRun) { repository.change { it.copy(deviceRuns = it.deviceRuns.map { row -> if (row.id == run.id) run else row }) } }
}
