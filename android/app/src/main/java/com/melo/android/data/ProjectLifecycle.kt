package com.melo.android.data

import kotlinx.serialization.json.*
import java.security.MessageDigest
import java.time.Instant

/** Remove-wins v1 envelopes; no file deletion, tool replay or permission grant. */
object ProjectLifecycle {
    fun markerId(project: String) = "pld_" + MessageDigest.getInstance("SHA-256").digest(project.toByteArray()).joinToString("") { "%02x".format(it) }
    private fun validId(id: String) = id !in setOf("__proto__", "constructor", "prototype") && Regex("[A-Za-z0-9_-]{1,180}").matches(id)
    fun marker(project: String, operation: String, at: String): JsonObject {
        require(validId(project) && validId(operation)); Instant.parse(at)
        return buildJsonObject {
            put("title", "Deleted project"); put("kind", "project-lifecycle-v1"); put("language", "json"); put("deleted", true); put("projectId", JsonNull)
            put("content", buildJsonObject { put("version", 1); put("projectId", project); put("operationId", operation); put("deletedAt", at) }.toString())
        }
    }
    fun markers(workspace: Workspace): Map<String, JsonObject> {
        val result = mutableMapOf<String, JsonObject>()
        for (row in workspace.records.filter { it.kind == "knowledge" && it.id.startsWith("pld_") }) for (version in row.versions) {
            val v = version.value
            require(v.text("kind") == "project-lifecycle-v1" && v["deleted"] == JsonPrimitive(true) && (v["projectId"] == null || v["projectId"] == JsonNull) && v.text("content").length <= 2000) { "项目删除记录不可修改。" }
            val mark = MeloJson.parseToJsonElement(v.text("content")).jsonObject
            require(mark.keys == setOf("version", "projectId", "operationId", "deletedAt") && mark["version"] == JsonPrimitive(1) && row.id == markerId(mark.text("projectId"))) { "项目删除记录身份无效。" }
            marker(mark.text("projectId"), mark.text("operationId"), mark.text("deletedAt"))
            val old = result[mark.text("projectId")]
            if (old == null || mark.text("deletedAt") < old.text("deletedAt")) result[mark.text("projectId")] = mark
        }
        return result
    }
    fun workspace(input: Workspace): Workspace {
        val deleted = markers(input)
        return input.copy(records = input.records.filterNot { it.kind == "project" && it.id in deleted }.map { row ->
            if (row.kind !in setOf("conversation", "knowledge", "memory")) row else row.copy(versions = row.versions.map { version ->
                val v = version.value
                if (v.text("projectId") !in deleted) version else version.copy(value = if (row.kind == "memory") {
                    if (v.text("scope") == "project" && v.text("status") == "active") JsonObject(v + ("status" to "historical".jp())) else v
                } else JsonObject(v + ("projectId" to JsonNull)))
            })
        })
    }
    private fun idle(state: AppData, ids: Set<String>) {
        val chats = state.chats.filter { it.projectId in ids }.map { it.id }.toSet()
        require(state.runs.none { it.chatId in chats && it.status == "running" } && state.deviceRuns.none { it.taskContext?.chatId in chats && it.status == "running" }) { "请先停止项目中进行的任务。" }
    }
    fun apply(state: AppData, workspace: Workspace): AppData {
        val deleted = markers(workspace)
        idle(state, deleted.keys)
        return state.copy(
            projects = state.projects.map { project -> deleted[project.id]?.let { mark -> project.copy(archived = true, deletedAt = mark.text("deletedAt"), deletedSnapshot = project.deletedSnapshot ?: state.workspace.records.firstOrNull { it.kind == "project" && it.id == project.id }?.versions?.singleOrNull()?.value) } ?: project },
            chats = state.chats.map { if (it.projectId in deleted) it.copy(projectId = null) else it },
            knowledge = state.knowledge.map { if (it.projectId in deleted) it.copy(projectId = null) else it },
            memories = state.memories.map { if (it.scope == "project" && it.projectId in deleted && it.status == "active") it.copy(status = "historical") else it },
            workspace = SyncProtocol.mergeWorkspace(workspace, Workspace()),
        )
    }
    fun delete(state: AppData, id: String, operation: String = newId(), at: String = now()): AppData {
        require(state.projects.any { it.id == id }) { "项目不存在。" }
        idle(state, setOf(id))
        val workspace = if (id in markers(state.workspace)) state.workspace else SyncProtocol.put(state.workspace, "knowledge", markerId(id), marker(id, operation, at), state.deviceId)
        return apply(state, workspace)
    }
    fun restore(state: AppData, id: String, replacement: String = newId()): AppData {
        val original = state.projects.first { it.id == id }
        require(original.deletedAt != null)
        original.restoredProjectId?.let { existing ->
            require(state.projects.any { it.id == existing && it.deletedAt == null }) { "请从最近的删除记录恢复。" }; return state
        }
        require(validId(replacement) && state.projects.none { it.id == replacement })
        val restored = original.copy(id = replacement, archived = false, deletedAt = null, restoredProjectId = null, deletedSnapshot = null)
        val value = JsonObject(original.deletedSnapshot.orEmpty() + buildJsonObject {
            put("name", restored.name); put("instructions", restored.instructions); put("archived", false); put("agentOverrides", buildJsonObject {})
        })
        return state.copy(projects = state.projects.map { if (it.id == id) it.copy(restoredProjectId = replacement) else it } + restored,
            workspace = SyncProtocol.put(state.workspace, "project", replacement, value, state.deviceId))
    }
}
