package com.melo.android

import com.melo.android.data.*
import kotlinx.serialization.json.*
import org.junit.Test
import org.junit.Assert.*

class ProjectLifecycleTest {
    @Test fun sameFrozenV1EnvelopeIsAcceptedAcrossHosts() {
        val fixture = javaClass.classLoader!!.getResourceAsStream("project-lifecycle.fixture.json")!!.bufferedReader().use { MeloJson.parseToJsonElement(it.readText()).jsonObject }
        assertEquals(fixture.text("markerId"), ProjectLifecycle.markerId(fixture.text("projectId")))
        val workspace = Workspace(records = listOf(WorkspaceRecord("knowledge", fixture.text("markerId"), listOf(RegisterVersion(mapOf("desktop" to 1L), fixture.getValue("markerValue").jsonObject)))))
        val schema = javaClass.classLoader!!.getResourceAsStream("sync.schema.json")!!.bufferedReader().use { SyncSchema(MeloJson.parseToJsonElement(it.readText()).jsonObject) }
        SyncProtocol.validate(Snapshot(chats = emptyList(), workspace = workspace), schema)
        assertEquals("delete-once", ProjectLifecycle.markers(workspace).getValue(fixture.text("projectId")).text("operationId"))
    }
    @Test fun offlineMergeRetainsTombstonesAndRestoreNeverReusesIdentity() {
        val project = Project(id = "project", name = "Keep files")
        val chat = Conversation(id = "chat", projectId = project.id, messages = listOf(Message(id = "original", role = "user", content = "keep original")))
        val workspace = SyncProtocol.put(Workspace(), "project", project.id, buildJsonObject {
            put("name", project.name); put("goal", "Original goal"); put("agentOverrides", buildJsonObject { put("main", buildJsonObject { put("name", "Override") }) })
        }, "desktop")
        val offline = AppData(projects = listOf(project), chats = listOf(chat), workspace = workspace,
            memories = listOf(MemoryFact(id = "memory", text = "old scope", chatId = chat.id, scope = "project", projectId = project.id)),
            knowledge = listOf(Knowledge(id = "note", title = "Note", content = "keep knowledge", projectId = project.id)))
        val deleted = ProjectLifecycle.delete(offline, project.id, "once", "2026-10-20T00:00:00Z")
        assertEquals(chat.messages, deleted.chats.single().messages)
        assertNull(deleted.chats.single().projectId)
        assertEquals("historical", deleted.memories.single().status)
        assertEquals(project.id, deleted.memories.single().projectId)
        assertEquals("keep knowledge", deleted.knowledge.single().content)
        val reopened = MeloJson.decodeFromString<AppData>(MeloJson.encodeToString(deleted))
        for (merged in listOf(SyncProtocol.mergeWorkspace(reopened.workspace, offline.workspace), SyncProtocol.mergeWorkspace(offline.workspace, reopened.workspace))) {
            assertFalse(merged.records.any { it.kind == "project" && it.id == project.id })
            assertEquals("once", ProjectLifecycle.markers(merged).getValue(project.id).text("operationId"))
        }
        val restored = ProjectLifecycle.restore(reopened, project.id, "restored")
        assertEquals(restored, ProjectLifecycle.restore(restored, project.id, "retry"))
        assertNull(restored.chats.single().projectId)
        val value = restored.workspace.records.first { it.kind == "project" && it.id == "restored" }.versions.single().value
        assertEquals("Original goal", value.text("goal"))
        assertEquals(buildJsonObject {}, value["agentOverrides"])
        assertTrue(ProjectLifecycle.markers(restored.workspace).containsKey(project.id))
    }
    @Test fun activeRunRejectsDeletionAndMalformedOldClientCannotReplaceMarker() {
        val data = AppData(projects = listOf(Project(id = "p", name = "Busy")), chats = listOf(Conversation(id = "c", projectId = "p")), runs = listOf(RunRecord(chatId = "c", prompt = "active")))
        assertThrows(IllegalArgumentException::class.java) { ProjectLifecycle.delete(data, "p") }
        val valid = ProjectLifecycle.delete(data.copy(runs = emptyList()), "p")
        val invalid = valid.workspace.copy(records = valid.workspace.records.map { row -> row.copy(versions = row.versions.map { it.copy(value = JsonObject(it.value + ("deleted" to JsonPrimitive(false)))) }) })
        assertThrows(IllegalArgumentException::class.java) { SyncProtocol.mergeWorkspace(valid.workspace, invalid) }
    }
}
