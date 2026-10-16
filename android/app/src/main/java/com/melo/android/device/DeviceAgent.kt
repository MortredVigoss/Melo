package com.melo.android.device

import android.content.Context
import android.widget.Toast
import com.melo.android.BuildConfig
import com.melo.android.data.*
import com.melo.android.network.ConnectionPolicy
import com.melo.android.network.ModelClient
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import java.security.MessageDigest
import kotlinx.serialization.json.JsonObject

data class DeviceApproval(val id: String = newId(), val action: String)
data class DeviceRuntime(val running: Boolean = false, val runId: String? = null, val phase: String = "", val error: String? = null, val approval: DeviceApproval? = null, val chatId: String? = null, val scriptId: String? = null)
internal data class ChatDeviceContext(val chat: Conversation, val connection: com.melo.android.data.Connection, val key: String, val instructions: String, val parentRunId: String)

class DeviceAgent(private val context: Context, private val repository: Repository,
                  private val client: DeviceAgentClient = DeviceAgentClient(BuildConfig.DEBUG)) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mutable = MutableStateFlow(DeviceRuntime())
    val runtime = mutable.asStateFlow()
    private var job: Job? = null
    private var approvalReply: CompletableDeferred<Boolean>? = null
    fun dismissError() { mutable.update { it.copy(error = null) } }
    fun cancel() { job?.cancel() }
    suspend fun editScript(original: DeviceScript, edited: DeviceScript) = withContext(NonCancellable) { repository.editDeviceScript(original, edited) }
    suspend fun deleteScript(id: String) = withContext(NonCancellable) {
        if (mutable.value.running && mutable.value.scriptId == id) job?.cancelAndJoin()
        repository.deleteDeviceScript(id)
    }
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
    fun start(goal: String, displayId: Int, screenshots: Boolean, executor: DeviceExecutor? = DeviceAccess.service, chatId: String? = null,
              forceProbe: Boolean = false, scriptId: String? = null, parameters: Map<String, String> = emptyMap()): Boolean =
        startTask(goal, displayId, screenshots, executor, chatId, forceProbe, scriptId, parameters)

    /** Await exactly this Chat's child. Cancelling the parent also tears down its device lease. */
    internal suspend fun invoke(goal: String, research: Boolean, binding: ChatDeviceContext, executor: DeviceExecutor? = DeviceAccess.service): DeviceToolResult = withContext(Dispatchers.Main.immediate) {
        val engine = (context.applicationContext as com.melo.android.MeloApplication).engine
        if (engine.runtime.value.turns[binding.chat.id]?.runId != binding.parentRunId)
            return@withContext DeviceToolResult.error("所属对话已停止，未开始手机操作。", "stale_chat")
        if (!startTask(goal, 0, true, executor, binding.chat.id, research, null, emptyMap(), binding, !research))
            return@withContext DeviceToolResult.error(mutable.value.error ?: "手机正被其他任务使用。", "device_busy")
        val owned = job!!
        try {
            owned.join(); currentCoroutineContext().ensureActive()
            val run = repository.data.value.deviceRuns.lastOrNull { it.parentRunId == binding.parentRunId && it.goal == goal.trim() }
                ?: return@withContext DeviceToolResult.error(mutable.value.error ?: "未取得手机任务回执，请检查辅助功能权限。", "device_unavailable")
            com.melo.android.chat.ChatPhoneUse.receipt(run, research)
        } finally {
            withContext(NonCancellable) { if (owned.isActive) owned.cancelAndJoin() }
        }
    }

    private fun startTask(goal: String, displayId: Int, screenshots: Boolean, executor: DeviceExecutor?, chatId: String?,
                          forceProbe: Boolean, scriptId: String?, parameters: Map<String, String>, binding: ChatDeviceContext? = null, cacheEnabled: Boolean = true): Boolean {
        if (job?.isActive == true || mutable.value.running) { mutable.update { it.copy(error = "已有手机操作任务在运行，请先停止或等待结束；输入已保留。") }; return false }
        if (binding == null && chatId != null && (context.applicationContext as com.melo.android.MeloApplication).engine.runtime.value.turns.containsKey(chatId)) { mutable.update { it.copy(error = "这段对话正在生成，请先停止或等待结束。") }; return false }
        val state = repository.data.value
        val chat = binding?.chat ?: chatId?.let { id -> state.chats.find { it.id == id } }
        val connectionId = chat?.connectionId ?: state.settings.activeConnection
        val connection = binding?.connection ?: state.settings.connections.find { it.id == connectionId }
        val taskContext = chat?.let { DeviceTaskContext(it.id, it.agentId, it.projectId, connection?.id.orEmpty()) }
        val instructions = binding?.instructions ?: if (chat != null) repository.instructions(chat, state) else ""
        val cacheScope = MessageDigest.getInstance("SHA-256").digest("${chat?.agentId.orEmpty()}|${chat?.projectId.orEmpty()}|$displayId|$instructions".toByteArray()).joinToString("") { "%02x".format(it) }
        val manualScript = scriptId?.let { id -> state.deviceScripts.find { it.id == id } }
        val supplied = parameters.toMap()
        val trimmed = goal.trim()
        mutable.value = DeviceRuntime(running = true, chatId = chatId)
        job = scope.launch(start = CoroutineStart.LAZY) {
            var run: DeviceRun? = null
            var begun = false
            var pendingCache: DeviceScript? = null
            var replaySuccess: DeviceScript? = null
            try {
                require(trimmed.isNotBlank() && trimmed.length <= 4000) { "请输入不超过 4000 字符的操作目标。" }
                require(chatId == null || chat != null) { "对话已不存在，未开始操作。" }
                require(scriptId == null || manualScript != null) { "脚本已经被删除。" }
                suspend fun credentials(): Pair<com.melo.android.data.Connection, String> {
                    val selected = connection ?: error("Cache 未命中或已失效，Probe 需要先配置模型连接。")
                    val key = binding?.key ?: repository.credential(selected.id)
                    ConnectionPolicy.validate(selected, key, BuildConfig.DEBUG)
                    require(selected.protocol != "fixture") { "Probe 需要支持 Tool Calling 的模型连接；本机脚本命中无需模型。" }
                    return selected to key
                }
                val device = executor ?: error("请先在 Android 设置中启用 Melo 手机助手的 Accessibility Service。")
                val lookup = if (manualScript != null) CacheLookup(exact = CacheMatch(manualScript, supplied)) else if (forceProbe) CacheLookup() else TaskCacheRouter.lookup(trimmed, state.deviceScripts, cacheScope)
                // A miss needs valid model access before clearing the user's draft;
                // an exact/manual hit must never read credentials at all.
                val modelAccess = if (lookup.exact == null) {
                    require(instructions.length <= 32_000) { "角色或项目指令超过任务预算，请减少资料后重试。" }
                    credentials()
                } else null
                val source = lookup.exact?.script ?: lookup.similar.firstOrNull()
                val mode = when { manualScript != null -> "manual"; lookup.exact != null -> "exact"; lookup.similar.isNotEmpty() -> "similar"; else -> "probe" }
                val started = DeviceRun(goal = trimmed, connectionName = if (lookup.exact != null) "本机缓存" else connection?.name ?: "未配置模型", taskContext = taskContext,
                    executionMode = mode, modelRequests = 0, scriptId = source?.id, scriptRevision = source?.revision, parentRunId = binding?.parentRunId)
                run = started
                repository.change { current ->
                    require(chatId == null || current.chats.any { it.id == chatId }) { "对话已删除。" }
                    current.copy(deviceRuns = (current.deviceRuns + started).takeLast(50), drafts = if (chatId == null || binding != null || scriptId != null) current.drafts else current.drafts - chatId)
                }
                mutable.update { it.copy(running = true, runId = started.id, phase = "正在检查操作缓存…", chatId = chatId, scriptId = source?.id) }
                device.begin(displayId, screenshots && lookup.exact == null && lookup.similar.isEmpty()); begun = true
                val outcome = withTimeout(10 * 60 * 1000L) {
                    val executeDevice: suspend (JsonObject) -> DeviceToolResult = { arguments ->
                        check(chatId == null || repository.data.value.chats.any { it.id == chatId }) { "关联对话已被删除，手机操作已停止。" }
                        device.execute(arguments)
                    }
                    val trace: suspend (DeviceStep) -> Unit = { step -> run = run!!.copy(steps = run!!.steps + step); save(run!!) }
                    val phase: (String) -> Unit = { text -> mutable.update { it.copy(phase = text) } }
                    fun countRequest() { run = run!!.copy(modelRequests = (run!!.modelRequests ?: 0) + 1) }
                    var recipe = lookup.exact
                    var adapted = false
                    if (recipe == null && lookup.similar.isNotEmpty()) {
                        phase("Similar Hit · 正在精简改写候选脚本…")
                        val (selected, key) = modelAccess ?: credentials()
                        val plan = ScriptPlanner(ModelClient(BuildConfig.DEBUG)).adapt(selected, key, trimmed, lookup.similar, cacheScope, instructions, ::countRequest)
                        if (plan != null) { recipe = CacheMatch(plan.script, plan.parameters); adapted = true }
                        else { run = run!!.copy(cacheNote = "相似脚本无法可靠改写，已转入 Probe。"); save(run!!) }
                    }
                    var prefix: List<ScriptStep> = emptyList()
                    var prefixValues: Map<String, String> = emptyMap()
                    if (recipe != null) {
                        val match = recipe
                        val replay = ScriptRunner(executeDevice, trace, phase).run(match.script, match.parameters)
                        if (!adapted && replay.outcome.status != "achieved") repository.invalidateDeviceScript(match.script, replay.outcome.error.orEmpty())
                        if (replay.outcome.status == "achieved") {
                            if (adapted) pendingCache = match.script.copy(sourceRunId = started.id, scope = cacheScope) else replaySuccess = match.script
                            run = run!!.copy(cacheNote = if (adapted) "相似脚本已验证成功。" else "本机重放与终态校验成功；没有调用模型。")
                            return@withTimeout replay.outcome
                        }
                        if (manualScript != null || replay.unsafeToResume || replay.outcome.status == "needs_user") return@withTimeout replay.outcome.copy(
                            status = if (replay.unsafeToResume) "needs_user" else replay.outcome.status,
                            error = (replay.outcome.error ?: "缓存重放失败。") + if (replay.unsafeToResume) " 可能已有页面操作，已停止；不会从头重放。" else "")
                        prefix = match.script.steps.take(replay.completedSteps); prefixValues = match.parameters
                        run = run!!.copy(cacheNote = "缓存失效，已保留 ${replay.completedSteps} 个成功步骤，从当前页面转入 Probe。")
                    }
                    run = run!!.copy(executionMode = "probe", connectionName = connection?.name ?: "未配置模型"); save(run!!)
                    val (selected, key) = modelAccess ?: credentials()
                    currentCoroutineContext().ensureActive()
                    device.configureScreenshots(screenshots)
                    val recorder = ScriptRecorder(trimmed, prefix, prefixValues)
                    val probeGoal = if (prefix.isEmpty()) trimmed else trimmed + "\nHost recovery: ${prefix.size} script steps have ALREADY executed (${prefix.joinToString { it.action }}). Continue only from the current observed page. Do not replay prior effects or restart the script. Verify before finishing."
                    val result = DeviceTaskLoop(selected.protocol,
                        next = { history -> countRequest(); client.next(selected, key, history, instructions) },
                        execute = executeDevice,
                        onStep = { step -> run = run!!.copy(steps = run!!.steps + step); save(run!!) },
                        onPhase = { phase -> mutable.update { it.copy(phase = phase) } },
                        onResult = recorder::record,
                    ).run(probeGoal)
                    if (result.status == "achieved" && cacheEnabled) {
                        pendingCache = recorder.compile(cacheScope, started.id)
                        if (pendingCache == null) run = run!!.copy(cacheNote = "任务成功；未缓存：${recorder.unsupported.ifBlank { "缺少可重放步骤。" }}")
                    }
                    result
                }
                currentCoroutineContext().ensureActive()
                val finished = run!!.copy(status = outcome.status, answer = outcome.answer, error = outcome.error, verification = outcome.verification, finishedAt = now())
                withContext(NonCancellable) { run = repository.commitDeviceOutcome(finished, pendingCache, state.deviceScripts, replaySuccess) }
            } catch (e: Exception) {
                val cancelled = e is CancellationException && e !is TimeoutCancellationException
                val message = when { e is TimeoutCancellationException -> "达到等待或执行时间上限，已停止。"; cancelled -> "已停止，已执行步骤不会撤销。"; else -> e.message ?: "手机助手执行失败。" }
                withContext(NonCancellable) {
                    if (!(cancelled && run?.status == "achieved")) {
                        run?.let { save(it.copy(status = if (cancelled) "cancelled" else "failed", finishedAt = now(), error = message)) }
                        mutable.update { it.copy(error = if (cancelled) null else message) }
                    }
                }
            } finally {
                if (begun) executor?.end()
                approvalReply?.cancel(); approvalReply = null
                mutable.update { it.copy(running = false, phase = "", approval = null, scriptId = null) }
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
