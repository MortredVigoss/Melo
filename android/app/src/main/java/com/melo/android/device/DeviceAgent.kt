package com.melo.android.device

import android.content.Context
import android.widget.Toast
import com.melo.android.BuildConfig
import com.melo.android.data.*
import com.melo.android.network.ConnectionPolicy
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

data class DeviceApproval(val id: String = newId(), val action: String)
data class DeviceRuntime(val running: Boolean = false, val runId: String? = null, val phase: String = "", val error: String? = null, val approval: DeviceApproval? = null, val chatId: String? = null)

class DeviceAgent(private val context: Context, private val repository: Repository,
                  private val client: DeviceAgentClient = DeviceAgentClient(BuildConfig.DEBUG)) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mutable = MutableStateFlow(DeviceRuntime())
    val runtime = mutable.asStateFlow()
    private var job: Job? = null
    private var approvalReply: CompletableDeferred<Boolean>? = null
    fun dismissError() { mutable.update { it.copy(error = null) } }
    fun cancel() { job?.cancel() }
    fun confirmApproval(id: String, allow: Boolean) {
        if (mutable.value.approval?.id == id) approvalReply?.complete(allow)
    }
    suspend fun requestApproval(action: String): Boolean {
        check(job?.isActive == true && approvalReply == null) { "没有可确认的设备任务。" }
        val pending = DeviceApproval(action = action)
        val reply = CompletableDeferred<Boolean>(); approvalReply = reply
        mutable.update { it.copy(approval = pending, phase = "等待本步操作确认…") }
        return try { withTimeout(120_000) { reply.await() } }
        finally { approvalReply = null; mutable.update { it.copy(approval = null) } }
    }
    /** One device lease; bind context before the first asynchronous boundary. */
    fun start(goal: String, displayId: Int, screenshots: Boolean, executor: DeviceExecutor? = DeviceAccess.service, chatId: String? = null): Boolean {
        if (job?.isActive == true || mutable.value.running) { mutable.update { it.copy(error = "已有手机操作任务在运行，请先停止或等待结束；输入已保留。") }; return false }
        if (chatId != null && (context.applicationContext as com.melo.android.MeloApplication).engine.runtime.value.turns.containsKey(chatId)) { mutable.update { it.copy(error = "这段对话正在生成，请先停止或等待结束。") }; return false }
        val state = repository.data.value
        val chat = chatId?.let { id -> state.chats.find { it.id == id } }
        val connectionId = chat?.connectionId ?: state.settings.activeConnection
        val connection = state.settings.connections.find { it.id == connectionId }
        val taskContext = if (chat != null && connection != null) DeviceTaskContext(chat.id, chat.agentId, chat.projectId, connection.id) else null
        val instructions = if (chat != null) repository.instructions(chat, state) else ""
        val trimmed = goal.trim()
        mutable.value = DeviceRuntime(running = true, chatId = chatId)
        job = scope.launch(start = CoroutineStart.LAZY) {
            var run: DeviceRun? = null
            var begun = false
            try {
                require(trimmed.isNotBlank() && trimmed.length <= 4000) { "请输入不超过 4000 字符的操作目标。" }
                require(chatId == null || chat != null) { "对话已不存在，未开始操作。" }
                val selected = connection ?: error("请先为此对话选择模型连接。")
                val key = repository.credential(selected.id)
                ConnectionPolicy.validate(selected, key, BuildConfig.DEBUG)
                require(selected.protocol != "fixture") { "手机助手需要支持 Tool Calling 的模型连接。" }
                val device = executor ?: error("请先在 Android 设置中启用 Melo 手机助手的 Accessibility Service。")
                val started = DeviceRun(goal = trimmed, connectionName = selected.name, taskContext = taskContext)
                run = started
                repository.change { current ->
                    require(chatId == null || current.chats.any { it.id == chatId }) { "对话已删除。" }
                    current.copy(deviceRuns = (current.deviceRuns + started).takeLast(50), drafts = if (chatId == null) current.drafts else current.drafts - chatId)
                }
                mutable.update { it.copy(running = true, runId = started.id, phase = "正在观察屏幕…", chatId = chatId) }
                device.begin(displayId, screenshots); begun = true
                val outcome = withTimeout(10 * 60 * 1000L) {
                    DeviceTaskLoop(selected.protocol,
                        next = { history -> client.next(selected, key, history, instructions) },
                        execute = { arguments ->
                            check(chatId == null || repository.data.value.chats.any { it.id == chatId }) { "关联对话已被删除，手机操作已停止。" }
                            device.execute(arguments)
                        },
                        onStep = { step -> run = run!!.copy(steps = run!!.steps + step); save(run!!) },
                        onPhase = { phase -> mutable.update { it.copy(phase = phase) } }
                    ).run(trimmed)
                }
                run = run!!.copy(status = outcome.status, answer = outcome.answer, error = outcome.error, verification = outcome.verification, finishedAt = now())
                save(run!!)
            } catch (e: Exception) {
                val cancelled = e is CancellationException && e !is TimeoutCancellationException
                val message = when { e is TimeoutCancellationException -> "达到等待或执行时间上限，已停止。"; cancelled -> "已停止，已执行步骤不会撤销。"; else -> e.message ?: "手机助手执行失败。" }
                withContext(NonCancellable) {
                    run?.let { save(it.copy(status = if (cancelled) "cancelled" else "failed", finishedAt = now(), error = message)) }
                    mutable.update { it.copy(error = if (cancelled) null else message) }
                }
            } finally {
                if (begun) executor?.end()
                approvalReply?.cancel(); approvalReply = null
                mutable.update { it.copy(running = false, phase = "", approval = null) }
                val status = repository.data.value.deviceRuns.find { it.id == run?.id }?.status
                val notice = when (status) {
                    "achieved" -> "Melo 已检查任务的可见结果"
                    "needs_user" -> "Melo 需要你确认或继续操作"
                    "failed", "blocked" -> "Melo 未完成任务，请返回查看原因"
                    "cancelled" -> "Melo 已停止"
                    else -> null
                }
                if (notice != null) Toast.makeText(context, notice, Toast.LENGTH_LONG).show()
            }
        }
        job!!.start(); return true
    }
    private suspend fun save(run: DeviceRun) { repository.change { it.copy(deviceRuns = it.deviceRuns.map { row -> if (row.id == run.id) run else row }) } }
}
