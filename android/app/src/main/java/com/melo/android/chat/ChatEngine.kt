package com.melo.android.chat

import android.content.Context
import android.content.Intent
import com.melo.android.BuildConfig
import com.melo.android.data.*
import com.melo.android.network.*
import com.melo.android.device.*
import kotlinx.serialization.json.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

data class ChatTurn(val runId: String? = null, val partial: String = "", val phase: String = "")
data class ChatRuntime(val initialized: Boolean = false, val turns: Map<String, ChatTurn> = emptyMap(), val error: String? = null, val syncStatus: String? = null) {
    val busyChatId get() = turns.keys.firstOrNull()
    val runId get() = turns.values.firstOrNull()?.runId
    val partial get() = turns.values.firstOrNull()?.partial.orEmpty()
}

class ChatEngine(private val context: Context, val repository: Repository) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mutable = MutableStateFlow(ChatRuntime())
    val runtime: StateFlow<ChatRuntime> = mutable.asStateFlow()
    val client = ModelClient(BuildConfig.DEBUG)
    private val turns = mutableMapOf<String, Job>()
    private var sync: Job? = null
    fun initialize() = scope.launch {
        try { repository.initialize(); mutable.update { it.copy(initialized = true) } }
        catch (_: Exception) { mutable.update { it.copy(error = "本机资料无法载入，原文件已保留。请勿清除 App 数据。") } }
    }
    fun work(block: suspend () -> Unit) = scope.launch {
        try { block() } catch (error: Exception) { if (error !is CancellationException) mutable.update { it.copy(error = error.message ?: "操作失败，原记录已保留。") } }
    }
    fun dismissError() { mutable.update { it.copy(error = null) } }
    fun send(chatId: String, text: String, attachments: List<Attachment> = emptyList(), retry: Boolean = false): Boolean {
        if (turns.containsKey(chatId)) { mutable.update { it.copy(error = "这段对话正在生成，请等待或先停止；输入已保留。") }; return false }
        val device = (context.applicationContext as com.melo.android.MeloApplication).deviceAgent.runtime.value
        if (device.running && device.chatId == chatId) { mutable.update { it.copy(error = "这段对话正在操作手机，请先停止或等待结束。") }; return false }
        val state = repository.data.value
        val chat = state.chats.find { it.id == chatId }
        val connectionId = chat?.connectionId ?: state.settings.activeConnection
        val agentModel = state.agents.find { it.id == chat?.agentId }?.model.orEmpty()
        val mode = chat?.modelMode ?: if (chat?.model != null) "fixed" else state.settings.smartRouting.text("defaultMode").ifBlank { "fixed" }
        val fixedModel = if (mode == "smart") agentModel else chat?.model?.takeIf(String::isNotBlank) ?: agentModel
        val connection = state.settings.connections.find { it.id == connectionId }?.let { if (fixedModel.isBlank()) it else it.copy(model = fixedModel) }
        val instructions = chat?.let { repository.instructions(it, state) }.orEmpty()
        val historyEnabled = state.agents.find { it.id == chat?.agentId }?.source("memory") != false
        val phoneUse = chat?.phoneUseEnabled == true && connection?.protocol != "fixture"
        val capturedAttachments = attachments.toList()
        mutable.update { it.copy(turns = it.turns + (chatId to ChatTurn()), error = null) }
        val turn = scope.launch(start = CoroutineStart.LAZY) {
            var record: RunRecord? = null
            var checkpoint: Job? = null
            try {
                requireNotNull(chat) { "对话已不存在。" }
                require(chat.portableModel == null || chat.connectionId != null) { "此对话的模型连接尚未在本机配置，请在对话设置选择已保存连接；原选择与资料已保留。" }
                requireNotNull(connection) { "请先在「系统 → 模型连接」配置服务，或在 Debug 中添加本地 Fixture。" }
                val key = if (connection.protocol == "fixture") "" else repository.credential(connection.id)
                ConnectionPolicy.validate(connection, key, BuildConfig.DEBUG)
                val message = if (retry) chat.messages.lastOrNull { it.role == "user" } ?: error("没有可重试的提问。") else Message(role = "user", content = text.trim(), attachments = capturedAttachments)
                require(message.content.isNotBlank() || message.attachments.isNotEmpty()) { "请输入内容或选择图片。" }
                record = RunRecord(chatId = chatId, prompt = message.content, requestedModel = connection.model, simulated = connection.protocol == "fixture")
                val run = record
                repository.change { current ->
                    require(current.chats.any { it.id == chatId }) { "对话已删除。" }
                    current.copy(chats = current.chats.map { row -> if (row.id != chatId) row else row.copy(
                        title = if (row.messages.isEmpty()) message.content.take(40).ifBlank { "图片对话" } else row.title,
                        messages = if (retry) row.messages else row.messages + message, updatedAt = now()) },
                        runs = current.runs + run, drafts = current.drafts - chatId)
                }
                updateTurn(chatId) { ChatTurn(run.id) }
                context.startForegroundService(Intent(context, ReplyService::class.java))
                checkpoint = launch {
                    while (isActive) { delay(1000); val partial = mutable.value.turns[chatId]?.partial.orEmpty(); repository.change { current -> current.copy(runs = current.runs.map { if (it.id == run.id && it.status == "running") it.copy(partial = partial) else it }) } }
                }
                val routingKeys = state.settings.connections.associate { it.id to (if (it.protocol == "fixture") "" else repository.credential(it.id)) }
                var executionConnection: Connection = connection
                var executionKey = key
                val routing = SmartRoutingConfig(mode, state.settings.smartRouting, state.settings.connections, routingKeys, fixedModel)
                val selected = if (retry) chat.messages.take(chat.messages.indexOfLast { it.id == message.id } + 1) else chat.messages + message
                val result = withContext(Dispatchers.IO) {
                    if (connection.protocol == "fixture") client.reply(connection, key, selected, instructions, repository::imageData) { partial -> updateTurn(chatId) { it.copy(partial = partial) } }
                    else withTimeout(15 * 60 * 1000L) {
                        SharedChatAgent(context, client, BuildConfig.DEBUG).reply(connection, key, selected, instructions,
                            JsonObject(state.settings.agentRuntime + ("replyLanguage" to JsonPrimitive(state.agents.find { it.id == chat.agentId }?.replyLanguage.orEmpty()))), { search -> if (search.text("credentialRef") == "search") repository.credential(SharedSearchAdapter.credentialId(search.text("endpoint"), BuildConfig.DEBUG)) else "" }, phoneUse, run.id, chatId, repository::imageData,
                            invokePhone = { args ->
                                currentCoroutineContext().ensureActive()
                                check(repository.data.value.chats.any { it.id == chatId }) { "对话已删除，手机操作已停止。" }
                                val research = args.text("purpose") == "research"
                                val researchInstructions = if (research) "\nThis is a live research task. Read the requested facts from current pages and return the findings, app/source, any visible useful links/addresses, and uncertainties in finish.summary (up to 2000 characters). Opening an app alone is not the research goal. Do not send messages, book, purchase or modify account/settings. Never fabricate facts or links. Current device time: ${java.time.ZonedDateTime.now()}." else ""
                                val receipt = (context.applicationContext as com.melo.android.MeloApplication).deviceAgent.invoke(
                                    args.text("goal"), research, ChatDeviceContext(chat, executionConnection, executionKey, instructions + researchInstructions, run.id, currentCoroutineContext()[com.melo.android.core.SharedRunBudget.Scope]?.budget, scopeInstructions = instructions))
                                currentCoroutineContext().ensureActive()
                                if (research && receipt.ok) withContext(Dispatchers.Main) {
                                    runCatching { context.startActivity(Intent(context, com.melo.android.MainActivity::class.java).putExtra("melo_chat_id", chatId).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
                                }
                                receipt
                            },
                            workflowCatalog = {
                                PhoneWorkflowHost(context, repository, (context.applicationContext as com.melo.android.MeloApplication).deviceAgent,
                                    ChatDeviceContext(chat, executionConnection, executionKey, instructions, run.id)).catalog()
                            },
                            invokeWorkflow = { args ->
                                PhoneWorkflowHost(context, repository, (context.applicationContext as com.melo.android.MeloApplication).deviceAgent,
                                    ChatDeviceContext(chat, executionConnection, executionKey, instructions, run.id)).invoke(args)
                            },
                            onPhase = { phase -> updateTurn(chatId) { it.copy(phase = phase) } },
                            onDelta = { partial -> updateTurn(chatId) { it.copy(partial = partial) } },
                            previousScenes = if (historyEnabled) state.runs.filter { it.chatId == chatId }.takeLast(3).map { it.sharedScene } else emptyList(),
                            historyEnabled = historyEnabled, contextLedger = chat.contextLedger, routingConfig = routing, onRoutedConnection = { c, k -> executionConnection = c; executionKey = k },
                            onContextLedger = { ledger -> repository.change { current -> current.copy(chats = current.chats.map { if (it.id == chatId) it.copy(contextLedger = ledger) else it }) } },
                            onScene = { scene -> repository.change { current -> current.copy(runs = current.runs.map { if (it.id == run.id && it.status == "running") it.copy(sharedScene = scene) else it }) } },
                        )
                    }
                }
                currentCoroutineContext().ensureActive()
                check(repository.data.value.chats.any { it.id == chatId }) { "对话已删除，未保存新的回复。" }
                checkpoint.cancelAndJoin(); checkpoint = null
                val observed = repository.data.value.runs.find { it.id == run.id } ?: run
                val sources = (replySources(result.text) + (observed.sharedScene?.get("sources") as? JsonArray).orEmpty().mapNotNull { (it as? JsonObject)?.text("url")?.takeIf { url -> url.startsWith("https://") || url.startsWith("http://") } }).distinct()
                val completed = observed.copy(status = result.outcome, finishedAt = now(), partial = result.text, error = result.stopReason, reportedModel = result.model, simulated = result.simulated, sources = sources)
                val assistant = Message(role = "assistant", content = result.text, runId = run.id)
                repository.change { current ->
                    require(current.chats.any { it.id == chatId }) { "对话已删除，未保存新的回复。" }
                    current.copy(
                    chats = current.chats.map { if (it.id == chatId) it.copy(messages = it.messages + assistant, updatedAt = now()) else it },
                    runs = current.runs.map { if (it.id == run.id) completed else it },
                    workspace = SyncProtocol.put(current.workspace, "message", assistant.id, completed.messageMetadata(), current.deviceId)) }
            } catch (error: Throwable) {
                checkpoint?.cancel()
                val cancelled = error is CancellationException
                withContext(NonCancellable) {
                    val partial = mutable.value.turns[chatId]?.partial.orEmpty()
                    val persistence = runCatching { record?.let { run -> repository.change { current -> current.copy(runs = current.runs.map { if (it.id == run.id) it.copy(status = it.sharedScene?.get("completion")?.jsonObject?.text("outcome")?.takeIf(String::isNotBlank) ?: if (cancelled) "cancelled" else "failed", finishedAt = now(), partial = partial, error = if (cancelled) "请求已取消，提问和部分文字已保留。" else error.message) else it }) } } }.exceptionOrNull()
                    mutable.update { it.copy(error = if (persistence != null) "本次请求状态无法写入本机存储；已保存的提问仍保留，请检查剩余空间后重启。" else if (cancelled) null else error.message ?: "请求失败，原记录已保留。") }
                }
            } finally {
                checkpoint?.cancel()
                turns.remove(chatId)
                mutable.update { it.copy(turns = it.turns - chatId) }
                if (turns.isEmpty()) context.stopService(Intent(context, ReplyService::class.java))
            }
            if (repository.data.value.settings.autoSync && repository.data.value.runs.any { it.id == record?.id && it.finishedAt != null }) synchronize()
        }
        turns[chatId] = turn; turn.start(); return true
    }
    private fun updateTurn(chatId: String, transform: (ChatTurn) -> ChatTurn) { mutable.update { state ->
        val current = state.turns[chatId]
        if (current == null) state else state.copy(turns = state.turns + (chatId to transform(current)))
    } }
    fun cancel(chatId: String? = null) { if (chatId == null) turns.values.toList().forEach { it.cancel() } else turns[chatId]?.cancel() }
    fun synchronize() {
        if (sync?.isActive == true) return
        sync = scope.launch {
            mutable.update { it.copy(syncStatus = "同步中…") }
            try { repository.synchronize(client); mutable.update { it.copy(syncStatus = "同步完成 · ${now()}") } }
            catch (error: Exception) { mutable.update { it.copy(syncStatus = "同步失败，手机资料保留。", error = error.message) } }
        }
    }
}
