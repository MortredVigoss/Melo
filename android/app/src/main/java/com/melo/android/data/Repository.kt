package com.melo.android.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.util.Base64
import com.melo.android.network.ModelClient
import com.melo.android.network.ConnectionPolicy
import com.melo.android.BuildConfig
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.io.File

class Repository(private val context: Context) {
    private val storage = LocalStorage(context)
    private val mutex = Mutex()
    private val mutable = MutableStateFlow(AppData())
    val data: StateFlow<AppData> = mutable.asStateFlow()
    private var loaded = false
    val schema by lazy { SyncSchema(MeloJson.parseToJsonElement(context.assets.open("protocol/sync.schema.json").bufferedReader().use { it.readText() }).jsonObject) }
    suspend fun initialize() = mutex.withLock {
        if (loaded) return@withLock
        val saved = storage.load()
        val recovered = saved.copy(runs = saved.runs.map { if (it.status == "running") it.interrupted() else it },
            deviceRuns = saved.deviceRuns.map { if (it.status == "running") it.copy(status = "interrupted", finishedAt = now(), error = "上次手机操作被系统中断；不会自动恢复执行。") else it })
        if (saved != recovered) storage.save(recovered)
        mutable.value = recovered; loaded = true
    }
    suspend fun change(transform: (AppData) -> AppData): AppData = mutex.withLock {
        check(loaded) { "本机资料尚未载入，不能覆盖。" }
        val next = transform(mutable.value)
        storage.save(next); mutable.value = next; next
    }
    suspend fun credential(id: String): String = withContext(Dispatchers.IO) { storage.credentials.get(id) }
    suspend fun saveCredential(id: String, value: String) = withContext(Dispatchers.IO) { storage.credentials.set(id, value) }
    suspend fun newChat(agentId: String = "main", projectId: String? = null): String {
        val chat = Conversation(agentId = agentId, projectId = projectId)
        change { current -> current.copy(chats = listOf(chat) + current.chats, workspace = chatRecord(current, chat)) }
        return chat.id
    }
    private fun portableEdit(data: AppData, kind: String, id: String, fields: JsonObject): Workspace {
        val existing = data.workspace.records.find { it.kind == kind && it.id == id }?.versions?.singleOrNull()?.value.orEmpty()
        return SyncProtocol.put(data.workspace, kind, id, JsonObject(existing + fields), data.deviceId)
    }
    private fun chatRecord(data: AppData, chat: Conversation): Workspace = portableEdit(data, "conversation", chat.id, buildJsonObject {
        put("agentId", chat.agentId); put("projectId", chat.projectId?.jp() ?: JsonNull)
        val connection = data.settings.connections.find { it.id == (chat.connectionId ?: data.settings.activeConnection) }
        if (connection != null && connection.protocol in setOf("chat-completions", "anthropic")) put("model", buildJsonObject {
            put("connectionID", connection.id); put("name", connection.name); put("model", connection.model)
            put("baseURL", com.melo.android.network.EndpointPolicy.validate(connection.endpoint, com.melo.android.BuildConfig.DEBUG).newBuilder().query(null).build().toString())
            put("authMode", "api-key"); put("apiProtocol", connection.protocol)
        }) else put("model", JsonNull)
    })
    suspend fun editChat(id: String, transform: (Conversation) -> Conversation) = change { current ->
        val edited = transform(current.chats.first { it.id == id }).copy(updatedAt = now())
        current.copy(chats = current.chats.map { if (it.id == id) edited else it }, workspace = chatRecord(current, edited))
    }
    suspend fun deleteChat(id: String) = change { current ->
        require(current.runs.none { it.chatId == id && it.status == "running" }) { "请先停止当前请求。" }
        require(current.deviceRuns.none { it.taskContext?.chatId == id && it.status == "running" }) { "请先停止这段对话的手机操作任务。" }
        val deletions = current.deletedChats.filterNot { it.id == id } + Deletion(id)
        current.copy(chats = current.chats.filterNot { it.id == id }, deletedChats = deletions,
            drafts = current.drafts - id, runs = current.runs.filterNot { it.chatId == id },
            memories = current.memories.filterNot { it.chatId == id }, deviceRuns = current.deviceRuns.filterNot { it.taskContext?.chatId == id }, workspace = SyncProtocol.mergeWorkspace(current.workspace, Workspace(), setOf(id)))
    }
    suspend fun draft(chatId: String, text: String) = change { it.copy(drafts = it.drafts + (chatId to text)) }
    suspend fun saveAgent(agent: Agent) = change { current ->
        val value = MeloJson.encodeToJsonElement(agent).jsonObject.let { JsonObject(it.filterKeys { it != "id" }) }
        current.copy(agents = current.agents.filterNot { it.id == agent.id } + agent, workspace = portableEdit(current, "agent", agent.id, value))
    }
    suspend fun saveProject(project: Project) = change { current ->
        val value = buildJsonObject { put("name", project.name); put("instructions", project.instructions); put("archived", project.archived) }
        current.copy(projects = current.projects.filterNot { it.id == project.id } + project, workspace = portableEdit(current, "project", project.id, value))
    }
    suspend fun saveKnowledge(note: Knowledge) = change { current ->
        val value = buildJsonObject { put("title", note.title); put("content", note.content); put("projectId", note.projectId?.jp() ?: JsonNull); put("deleted", note.deleted) }
        current.copy(knowledge = current.knowledge.filterNot { it.id == note.id } + note, workspace = portableEdit(current, "knowledge", note.id, value))
    }
    suspend fun saveMemory(fact: MemoryFact) = change { current ->
        val value = MeloJson.encodeToJsonElement(fact).jsonObject.toMutableMap().apply {
            put("memoryID", current.workspace.records.find { it.kind == "memory" && it.id == fact.id }?.versions?.singleOrNull()?.value?.get("memoryID") ?: fact.id.jp())
            put("userEdited", JsonPrimitive(true))
        }
        current.copy(memories = current.memories.filterNot { it.id == fact.id } + fact, workspace = portableEdit(current, "memory", fact.id, JsonObject(value)))
    }
    suspend fun resolveConflict(record: WorkspaceRecord, index: Int) = change { current ->
        project(current.copy(workspace = SyncProtocol.put(current.workspace, record.kind, record.id, record.versions[index].value, current.deviceId, index)))
    }
    fun instructions(chat: Conversation, state: AppData = data.value): String {
        val agent = state.agents.find { it.id == chat.agentId } ?: state.agents.first()
        val project = state.projects.find { it.id == chat.projectId && !it.archived }
        val notes = state.knowledge.filter { !it.deleted && it.projectId != null && it.projectId == project?.id }
        val memories = state.memories.filter { fact -> fact.status == "active" && state.chats.any { it.id == fact.chatId } &&
            when (fact.scope) { "personal" -> true; "agent" -> fact.agentId == chat.agentId; "project" -> fact.projectId != null && fact.projectId == chat.projectId; else -> fact.chatId == chat.id } }
        return listOf("你运行在 Melo Android 中。只根据实际能力回答；不能声称操作了桌面、读取未提供的文件或运行了不存在的工具。", agent.prompt(), project?.instructions.orEmpty(),
            notes.joinToString("\n\n") { "参考资料：${it.title}\n${it.content}" }, memories.joinToString("\n") { "用户保存的记忆：${it.text}" }).filter(String::isNotBlank).joinToString("\n\n")
    }
    suspend fun saveConnection(connection: Connection, newKey: String?) {
        val replacement = newKey?.trim()?.takeIf(String::isNotBlank)
        val key = replacement ?: if (connection.protocol == "fixture") "" else credential(connection.id)
        ConnectionPolicy.validate(connection, key, BuildConfig.DEBUG)
        if (replacement != null) saveCredential(connection.id, replacement)
        change { current -> current.copy(settings = current.settings.copy(connections = current.settings.connections.filterNot { it.id == connection.id } + connection, activeConnection = current.settings.activeConnection ?: connection.id)) }
    }
    fun snapshot(state: AppData = data.value): Snapshot = Snapshot(
        chats = state.chats.map { chat -> WireChat(chat.id, chat.title, chat.createdAt, chat.updatedAt, chat.messages.map { WireMessage(it.id, it.role, it.content, it.createdAt) }) },
        deletedChats = state.deletedChats, workspace = state.workspace, tasks = state.tasks, handoffs = state.handoffs)
    suspend fun synchronize(client: ModelClient) {
        val before = data.value
        val sent = snapshot(before)
        SyncProtocol.validate(sent, schema)
        val raw = client.sync(before.settings.syncEndpoint, credential("sync"), sent)
        schema.validate(raw)
        val received = MeloJson.decodeFromJsonElement<Snapshot>(raw)
        SyncProtocol.validate(received, schema)
        SyncProtocol.requireDeletionAcknowledgement(sent, received)
        change { current -> applySnapshot(current, SyncProtocol.merge(snapshot(current), received)) }
    }
    suspend fun exportTo(uri: Uri) = withContext(Dispatchers.IO) {
        val snapshot = snapshot(); SyncProtocol.validate(snapshot, schema)
        context.contentResolver.openOutputStream(uri, "wt")?.use { it.write(MeloJson.encodeToString(snapshot).toByteArray()) } ?: error("无法写入导出文件。")
    }
    suspend fun importFrom(uri: Uri) {
        val content = withContext(Dispatchers.IO) {
            context.contentResolver.openInputStream(uri)?.use { stream ->
                val buffer = java.io.ByteArrayOutputStream()
                val chunk = ByteArray(8192)
                while (true) { val count = stream.read(chunk); if (count < 0) break; require(buffer.size() + count <= SyncProtocol.MAX_BYTES) { "导入文件超过 8 MiB。" }; buffer.write(chunk, 0, count) }
                val bytes = buffer.toByteArray()
                require(bytes.size <= SyncProtocol.MAX_BYTES) { "导入文件超过 8 MiB。" }; String(bytes)
            } ?: error("无法读取导入文件。")
        }
        val raw = MeloJson.parseToJsonElement(content)
        schema.validate(raw)
        val incoming = MeloJson.decodeFromJsonElement<Snapshot>(raw)
        SyncProtocol.validate(incoming, schema)
        acceptSnapshot(incoming)
    }
    suspend fun acceptSnapshot(incoming: Snapshot) {
        SyncProtocol.validate(incoming, schema)
        change { current -> applySnapshot(current, SyncProtocol.merge(snapshot(current), incoming)) }
    }
    private fun applySnapshot(current: AppData, merged: Snapshot): AppData {
        val oldChats = current.chats.associateBy { it.id }
        val chats = merged.chats.map { wire ->
            val old = oldChats[wire.id]
            val messages = old?.messages.orEmpty().associateBy { it.id }
            (old ?: Conversation(id = wire.id, createdAt = wire.createdAt)).copy(title = wire.title, updatedAt = wire.updatedAt,
                messages = wire.messages.map { message -> messages[message.id] ?: Message(message.id, message.role, message.content, message.createdAt) })
        }
        return project(current.copy(chats = chats, deletedChats = merged.deletedChats, workspace = merged.workspace, tasks = merged.tasks, handoffs = merged.handoffs,
            memories = current.memories.filter { fact -> chats.any { it.id == fact.chatId } }, drafts = current.drafts.filterKeys { id -> chats.any { it.id == id } }))
    }
    private fun project(input: AppData): AppData {
        var state = input
        input.workspace.records.filter { it.versions.size == 1 }.forEach { record ->
            val value = PortableWorkspace.value(record.kind, record.versions.first().value)
            when (record.kind) {
                "agent" -> { val row = MeloJson.decodeFromJsonElement<Agent>(JsonObject(value + ("id" to record.id.jp()))); state = state.copy(agents = state.agents.filterNot { it.id == row.id } + row) }
                "project" -> { val row = MeloJson.decodeFromJsonElement<Project>(JsonObject(value + ("id" to record.id.jp()))); state = state.copy(projects = state.projects.filterNot { it.id == row.id } + row) }
                "knowledge" -> { val row = MeloJson.decodeFromJsonElement<Knowledge>(JsonObject(value + ("id" to record.id.jp()))); state = state.copy(knowledge = state.knowledge.filterNot { it.id == row.id } + row) }
                "memory" -> { val row = MeloJson.decodeFromJsonElement<MemoryFact>(value); if (state.chats.any { it.id == row.chatId }) state = state.copy(memories = state.memories.filterNot { it.id == row.id } + row) }
                "conversation" -> state = state.copy(chats = state.chats.map { if (it.id == record.id) it.copy(agentId = value.text("agentId", "main"), projectId = value.text("projectId").ifBlank { null }) else it })
                "message" -> {
                    val scene = value["scene"]?.takeIf { it != JsonNull }?.jsonObject ?: return@forEach
                    val chat = state.chats.find { it.id == value.text("chatId") } ?: return@forEach
                    val index = chat.messages.indexOfFirst { it.id == record.id }
                    if (index < 0) return@forEach
                    val message = chat.messages[index]
                    val runId = scene.text("runId")
                    val model = value["models"]?.jsonArray?.firstOrNull()?.jsonObject
                    val stage = scene["operations"]?.jsonArray?.firstOrNull()?.jsonObject
                    val imported = RunRecord(id = runId, chatId = chat.id, prompt = chat.messages.take(index).lastOrNull { it.role == "user" }?.content.orEmpty(),
                        status = scene.text("status"), startedAt = stage?.text("startedAt")?.ifBlank { null } ?: message.createdAt,
                        finishedAt = stage?.text("finishedAt")?.ifBlank { null } ?: message.createdAt,
                        requestedModel = model?.text("requestedModel").orEmpty(), reportedModel = model?.text("reportedModel")?.ifBlank { null },
                        partial = message.content, simulated = model?.get("simulated")?.jsonPrimitive?.booleanOrNull == true,
                        sources = scene["sources"]?.jsonArray.orEmpty().map { it.jsonObject.text("url") }.filter(String::isNotBlank), sharedScene = scene)
                    if (state.runs.none { it.id == runId }) state = state.copy(runs = state.runs + imported)
                    state = state.copy(chats = state.chats.map { if (it.id == chat.id) it.copy(messages = it.messages.map { row -> if (row.id == record.id) row.copy(runId = runId) else row }) else it })
                }
            }
        }
        return state
    }
    suspend fun importImage(uri: Uri): Attachment = withContext(Dispatchers.IO) {
        val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver, uri)) { decoder, info, _ ->
            val scale = maxOf(info.size.width, info.size.height) / 2048.0
            if (scale > 1) decoder.setTargetSize((info.size.width / scale).toInt(), (info.size.height / scale).toInt())
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        val id = newId(); val file = File(context.filesDir, "images/$id.jpg").apply { parentFile!!.mkdirs() }
        try { file.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it)) }; require(file.length() <= 4 * 1024 * 1024) { "图片过大，请先缩小后再导入。" } }
        catch (error: Exception) { file.delete(); throw error }
        finally { bitmap.recycle() }
        Attachment(id, "图片-${id.take(8)}", "image/jpeg", file.name)
    }
    fun imageData(attachment: Attachment): String {
        val root = File(context.filesDir, "images").canonicalFile
        val file = File(root, attachment.file).canonicalFile
        require(file.parentFile == root && file.length() <= 4 * 1024 * 1024) { "图片引用无效。" }
        return Base64.encodeToString(file.readBytes(), Base64.NO_WRAP)
    }
}
