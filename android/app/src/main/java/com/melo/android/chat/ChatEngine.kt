package com.melo.android.chat

import android.content.Context
import android.content.Intent
import com.melo.android.BuildConfig
import com.melo.android.data.*
import com.melo.android.network.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

data class ChatRuntime(val initialized: Boolean = false, val busyChatId: String? = null, val runId: String? = null, val partial: String = "", val error: String? = null, val syncStatus: String? = null)

class ChatEngine(private val context: Context, val repository: Repository) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mutable = MutableStateFlow(ChatRuntime())
    val runtime: StateFlow<ChatRuntime> = mutable.asStateFlow()
    val client = ModelClient(BuildConfig.DEBUG)
    private var turn: Job? = null
    private var sync: Job? = null
    fun initialize() = scope.launch {
        try { repository.initialize(); mutable.update { it.copy(initialized = true) } }
        catch (_: Exception) { mutable.update { it.copy(error = "本机资料无法载入，原文件已保留。请勿清除 App 数据。") } }
    }
    fun work(block: suspend () -> Unit) = scope.launch {
        try { block() } catch (error: Exception) { if (error !is CancellationException) mutable.update { it.copy(error = error.message ?: "操作失败，原记录已保留。") } }
    }
    fun dismissError() { mutable.update { it.copy(error = null) } }
    fun send(chatId: String, text: String, attachments: List<Attachment> = emptyList(), retry: Boolean = false) {
        if (turn?.isActive == true) return
        turn = scope.launch {
            var record: RunRecord? = null
            var checkpoint: Job? = null
            try {
                val state = repository.data.value
                val chat = state.chats.first { it.id == chatId }
                val connectionId = chat.connectionId ?: state.settings.activeConnection
                val connection = state.settings.connections.find { it.id == connectionId } ?: error("请先在「系统 → 模型连接」配置服务，或在 Debug 中添加本地 Fixture。")
                val instructions = repository.instructions(chat, state)
                val key = if (connection.protocol == "fixture") "" else repository.credential(connection.id)
                if (connection.protocol != "fixture") { EndpointPolicy.validate(connection.endpoint, BuildConfig.DEBUG); require(connection.model.isNotBlank() && key.isNotBlank()) { "请先完善模型名称和凭证。" } }
                val message = if (retry) chat.messages.lastOrNull { it.role == "user" } ?: error("没有可重试的提问。") else Message(role = "user", content = text.trim(), attachments = attachments)
                require(message.content.isNotBlank() || message.attachments.isNotEmpty()) { "请输入内容或选择图片。" }
                record = RunRecord(chatId = chatId, prompt = message.content, requestedModel = connection.model, simulated = connection.protocol == "fixture")
                val run = record
                repository.change { current ->
                    current.copy(chats = current.chats.map { row -> if (row.id != chatId) row else row.copy(
                        title = if (row.messages.isEmpty()) message.content.take(40).ifBlank { "图片对话" } else row.title,
                        messages = if (retry) row.messages else row.messages + message, updatedAt = now()) },
                        runs = current.runs + run, drafts = current.drafts - chatId)
                }
                mutable.update { it.copy(busyChatId = chatId, runId = run.id, partial = "", error = null) }
                context.startForegroundService(Intent(context, ReplyService::class.java))
                checkpoint = launch {
                    while (isActive) { delay(1000); val partial = mutable.value.partial; repository.change { current -> current.copy(runs = current.runs.map { if (it.id == run.id && it.status == "running") it.copy(partial = partial) else it }) } }
                }
                val saved = repository.data.value.chats.first { it.id == chatId }
                val selected = if (retry) saved.messages.take(saved.messages.indexOfLast { it.id == message.id } + 1) else saved.messages
                val result = withContext(Dispatchers.IO) {
                    client.reply(connection, key, selected, instructions, repository::imageData) { partial -> mutable.update { it.copy(partial = partial) } }
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
                    val partial = mutable.value.partial
                    val persistence = runCatching { record?.let { run -> repository.change { current -> current.copy(runs = current.runs.map { if (it.id == run.id) it.copy(status = if (cancelled) "cancelled" else "failed", finishedAt = now(), partial = partial, error = if (cancelled) "请求已取消，提问和部分文字已保留。" else error.message) else it }) } } }.exceptionOrNull()
                    mutable.update { it.copy(error = if (persistence != null) "本次请求状态无法写入本机存储；已保存的提问仍保留，请检查剩余空间后重启。" else if (cancelled) null else error.message ?: "请求失败，原记录已保留。") }
                }
            } finally {
                checkpoint?.cancel()
                mutable.update { it.copy(busyChatId = null, runId = null, partial = "") }
                context.stopService(Intent(context, ReplyService::class.java))
            }
            if (repository.data.value.settings.autoSync && repository.data.value.runs.any { it.id == record?.id && it.status == "completed" }) synchronize()
        }
    }
    fun cancel() { turn?.cancel() }
    fun synchronize() {
        if (sync?.isActive == true) return
        sync = scope.launch {
            mutable.update { it.copy(syncStatus = "同步中…") }
            try { repository.synchronize(client); mutable.update { it.copy(syncStatus = "同步完成 · ${now()}") } }
            catch (error: Exception) { mutable.update { it.copy(syncStatus = "同步失败，手机资料保留。", error = error.message) } }
        }
    }
}
