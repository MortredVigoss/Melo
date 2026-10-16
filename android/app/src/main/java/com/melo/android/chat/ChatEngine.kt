package com.melo.android.chat

import android.content.Context
import android.content.Intent
import com.melo.android.BuildConfig
import com.melo.android.data.*
import com.melo.android.network.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

data class ChatTurn(val runId: String? = null, val partial: String = "")
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
        val connection = state.settings.connections.find { it.id == connectionId }
        val instructions = chat?.let { repository.instructions(it, state) }.orEmpty()
        val capturedAttachments = attachments.toList()
        mutable.update { it.copy(turns = it.turns + (chatId to ChatTurn()), error = null) }
        val turn = scope.launch(start = CoroutineStart.LAZY) {
            var record: RunRecord? = null
            var checkpoint: Job? = null
            try {
                requireNotNull(chat) { "对话已不存在。" }
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
                val selected = if (retry) chat.messages.take(chat.messages.indexOfLast { it.id == message.id } + 1) else chat.messages + message
                val result = withContext(Dispatchers.IO) {
                    client.reply(connection, key, selected, instructions, repository::imageData) { partial -> updateTurn(chatId) { it.copy(partial = partial) } }
                }
                checkpoint.cancelAndJoin(); checkpoint = null
                val sources = replySources(result.text)
                val completed = run.copy(status = "completed", finishedAt = now(), partial = result.text, reportedModel = result.model, simulated = result.simulated, sources = sources)
                val assistant = Message(role = "assistant", content = result.text, runId = run.id)
                repository.change { current -> current.copy(
                    chats = current.chats.map { if (it.id == chatId) it.copy(messages = it.messages + assistant, updatedAt = now()) else it },
                    runs = current.runs.map { if (it.id == run.id) completed else it },
                    workspace = SyncProtocol.put(current.workspace, "message", assistant.id, completed.messageMetadata(), current.deviceId)) }
            } catch (error: Throwable) {
                checkpoint?.cancel()
                val cancelled = error is CancellationException
                withContext(NonCancellable) {
                    val partial = mutable.value.turns[chatId]?.partial.orEmpty()
                    val persistence = runCatching { record?.let { run -> repository.change { current -> current.copy(runs = current.runs.map { if (it.id == run.id) it.copy(status = if (cancelled) "cancelled" else "failed", finishedAt = now(), partial = partial, error = if (cancelled) "请求已取消，提问和部分文字已保留。" else error.message) else it }) } } }.exceptionOrNull()
                    mutable.update { it.copy(error = if (persistence != null) "本次请求状态无法写入本机存储；已保存的提问仍保留，请检查剩余空间后重启。" else if (cancelled) null else error.message ?: "请求失败，原记录已保留。") }
                }
            } finally {
                checkpoint?.cancel()
                turns.remove(chatId)
                mutable.update { it.copy(turns = it.turns - chatId) }
                if (turns.isEmpty()) context.stopService(Intent(context, ReplyService::class.java))
            }
            if (repository.data.value.settings.autoSync && repository.data.value.runs.any { it.id == record?.id && it.status == "completed" }) synchronize()
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
