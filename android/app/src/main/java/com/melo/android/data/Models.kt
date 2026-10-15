package com.melo.android.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import java.time.Instant
import java.util.UUID
import com.melo.android.device.DeviceRun

val MeloJson = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }
fun newId(): String = UUID.randomUUID().toString()
fun now(): String = Instant.now().toString()

@Serializable data class Attachment(val id: String = newId(), val name: String, val mime: String, val file: String)
@Serializable data class Message(val id: String = newId(), val role: String, val content: String, val createdAt: String = now(), val attachments: List<Attachment> = emptyList(), val runId: String? = null)
@Serializable data class Conversation(val id: String = newId(), val title: String = "新对话", val createdAt: String = now(), val updatedAt: String = createdAt, val messages: List<Message> = emptyList(), val agentId: String = "main", val projectId: String? = null, val connectionId: String? = null, val archived: Boolean = false, val pinned: Boolean = false)
@Serializable data class Agent(val id: String = newId(), val name: String, val subtitle: String = "", val instructions: String = "", val identity: String = "", val soul: String = "", val systemPrompt: String = "", val mood: String = "warm", val model: String = "") {
    fun prompt(): String = listOf(identity, soul, systemPrompt, instructions).filter(String::isNotBlank).joinToString("\n")
}
@Serializable data class Project(val id: String = newId(), val name: String, val instructions: String = "", val archived: Boolean = false)
@Serializable data class Knowledge(val id: String = newId(), val title: String, val content: String, val projectId: String? = null, val deleted: Boolean = false)
@Serializable data class MemoryFact(val id: String = newId(), val text: String, val chatId: String, val agentId: String = "main", val scope: String = "chat", val status: String = "active", val projectId: String? = null, val updatedAt: String = now())
@Serializable data class Connection(val id: String = newId(), val name: String = "新连接", val endpoint: String = "https://api.openai.com/v1/chat/completions", val model: String = "", val protocol: String = "chat-completions", val stream: Boolean = true)
@Serializable data class Settings(val connections: List<Connection> = emptyList(), val activeConnection: String? = null, val syncEndpoint: String = "", val reduceMotion: Boolean = false, val fontScale: Float = 1f, val userName: String = "", val autoSync: Boolean = false)
@Serializable data class RunRecord(val id: String = newId(), val chatId: String, val prompt: String, val status: String = "running", val startedAt: String = now(), val finishedAt: String? = null, val requestedModel: String = "", val reportedModel: String? = null, val partial: String = "", val error: String? = null, val simulated: Boolean = false, val sources: List<String> = emptyList(), val sharedScene: JsonObject? = null)
@Serializable data class Deletion(val id: String, val deletedAt: String = now())
@Serializable data class RegisterVersion(val clock: Map<String, Long>, val value: JsonObject)
@Serializable data class WorkspaceRecord(val kind: String, val id: String, val versions: List<RegisterVersion>)
@Serializable data class Workspace(val version: Int = 1, val records: List<WorkspaceRecord> = emptyList())
@Serializable data class WireMessage(val id: String, val role: String, val content: String, val createdAt: String)
@Serializable data class WireChat(val id: String, val title: String, val createdAt: String, val updatedAt: String, val messages: List<WireMessage>)
@Serializable data class Snapshot(val version: Int = 1, val chats: List<WireChat> = emptyList(), val deletedChats: List<Deletion> = emptyList(), val workspace: Workspace = Workspace(), val tasks: JsonArray = JsonArray(emptyList()), val handoffs: JsonArray = JsonArray(emptyList()))
@Serializable data class AppData(val version: Int = 1, val deviceId: String = "android-${newId()}", val chats: List<Conversation> = emptyList(), val agents: List<Agent> = listOf(Agent(id = "main", name = "Melo", subtitle = "一起把事情完成", instructions = "清晰、准确地回答用户，明确区分已执行与建议操作。")), val projects: List<Project> = emptyList(), val knowledge: List<Knowledge> = emptyList(), val memories: List<MemoryFact> = emptyList(), val runs: List<RunRecord> = emptyList(), val deletedChats: List<Deletion> = emptyList(), val workspace: Workspace = Workspace(), val tasks: JsonArray = JsonArray(emptyList()), val handoffs: JsonArray = JsonArray(emptyList()), val drafts: Map<String, String> = emptyMap(), val settings: Settings = Settings(), val deviceRuns: List<DeviceRun> = emptyList())

fun jsonObject(vararg fields: Pair<String, JsonElement>): JsonObject = JsonObject(mapOf(*fields))
fun String.jp(): JsonPrimitive = JsonPrimitive(this)
fun JsonObject.text(key: String, default: String = ""): String = (get(key) as? JsonPrimitive)?.contentOrNull ?: default
