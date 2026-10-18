package com.melo.android

import com.melo.android.data.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SharedContractTest {
    private fun resource(name: String) = requireNotNull(javaClass.classLoader!!.getResourceAsStream(name)).bufferedReader().use { it.readText() }
    private val schema = SyncSchema(MeloJson.parseToJsonElement(resource("sync.schema.json")).jsonObject)
    private fun expand(value: JsonElement): JsonElement = when (value) {
        is JsonObject -> value["\$repeat"]?.jsonObject?.let { it.text("text").repeat(it.getValue("count").jsonPrimitive.int).jp() } ?: JsonObject(value.mapValues { expand(it.value) })
        is JsonArray -> JsonArray(value.map(::expand))
        else -> value
    }
    @Test fun allSharedNodeAndSwiftFixturesAgree() {
        val fixtures = MeloJson.parseToJsonElement(resource("fixtures.json")).jsonArray
        assertEquals(40, fixtures.size)
        fixtures.forEach { fixture ->
            val row = fixture.jsonObject
            val accepted = runCatching { schema.validate(expand(row.getValue("input")), row.text("definition")) }.isSuccess
            assertEquals(row.text("name"), row.getValue("valid").jsonPrimitive.boolean, accepted)
        }
    }
    private fun snapshot() = Snapshot(chats = listOf(WireChat("chat", "Title", "2026-10-14T00:00:00Z", "2026-10-14T00:00:00Z", listOf(WireMessage("msg", "user", "Hello", "2026-10-14T00:00:00Z")))))
    @Test fun deletionNeverResurrectsAnOfflineChat() {
        val live = snapshot()
        val deleted = live.copy(chats = emptyList(), deletedChats = listOf(Deletion("chat", "2026-10-14T01:00:00Z")))
        assertTrue(SyncProtocol.merge(deleted, live).chats.isEmpty())
        assertEquals(SyncProtocol.merge(live, deleted), SyncProtocol.merge(deleted, live))
    }
    @Test fun changedMessageIdentityRejectsInsteadOfOverwriting() {
        val original = snapshot()
        val changed = original.copy(chats = listOf(original.chats.first().copy(messages = listOf(original.chats.first().messages.first().copy(content = "replacement")))))
        assertTrue(runCatching { SyncProtocol.merge(original, changed) }.isFailure)
    }
    @Test fun concurrentEditsRetainBothVersionsAndResolutionDominatesStaleData() {
        val a = SyncProtocol.put(Workspace(), "agent", "role", jsonObject("name" to "A".jp()), "android")
        val b = SyncProtocol.put(Workspace(), "agent", "role", jsonObject("name" to "B".jp()), "desktop")
        val conflict = SyncProtocol.mergeWorkspace(a, b)
        assertEquals(2, conflict.records.single().versions.size)
        assertTrue(runCatching { SyncProtocol.put(conflict, "agent", "role", jsonObject("name" to "C".jp()), "android") }.isFailure)
        val resolved = SyncProtocol.put(conflict, "agent", "role", jsonObject(), "android", 0)
        assertEquals(1, SyncProtocol.mergeWorkspace(resolved, conflict).records.single().versions.size)
    }
    @Test fun equalPayloadsJoinClocksWithoutSpuriousConflict() {
        val value = jsonObject("name" to "A".jp())
        val a = SyncProtocol.put(Workspace(), "agent", "role", value, "android")
        val b = SyncProtocol.put(Workspace(), "agent", "role", value, "desktop")
        val merged = SyncProtocol.mergeWorkspace(a, b).records.single().versions.single()
        assertEquals(mapOf("android" to 1L, "desktop" to 1L), merged.clock)
    }
    @Test fun syncMustAcknowledgeAllSentDeletions() {
        val sent = Snapshot(deletedChats = listOf(Deletion("gone", "2026-10-14T00:00:00Z")))
        assertTrue(runCatching { SyncProtocol.requireDeletionAcknowledgement(sent, Snapshot()) }.isFailure)
        SyncProtocol.requireDeletionAcknowledgement(sent, sent)
    }
    @Test fun deletionRemovesAllAssociatedContext() {
        val memory = WorkspaceRecord("memory", "memory", listOf(RegisterVersion(mapOf("android" to 1L), jsonObject("chatId" to "gone".jp()))))
        val merged = SyncProtocol.mergeWorkspace(Workspace(records = listOf(memory)), Workspace(), setOf("gone"))
        assertTrue(merged.records.isEmpty())
    }
    @Test fun taskAndHandoffIdentityConflictsMatchTheNodeService() {
        val task = MeloJson.parseToJsonElement("""{"id":"task","title":"Do work","status":"todo","checkpoint":"","revision":1,"sourceDevice":"desktop","updatedAt":"2026-10-14T00:00:00Z"}""").jsonObject
        fun withTask(value: JsonObject) = Snapshot(tasks = JsonArray(listOf(value)))
        val original = withTask(task)
        assertTrue(runCatching { SyncProtocol.merge(original, withTask(JsonObject(task + ("sourceDevice" to "phone".jp())))) }.isFailure)
        assertTrue(runCatching { SyncProtocol.merge(original, withTask(JsonObject(task + ("title" to "conflicting title".jp())))) }.isFailure)
        val next = JsonObject(task + mapOf("revision" to JsonPrimitive(2), "status" to "done".jp()))
        assertEquals("done", SyncProtocol.merge(original, withTask(next)).tasks.single().jsonObject.text("status"))
        val handoff = MeloJson.parseToJsonElement("""{"id":"handoff","taskId":"task","fromDevice":"phone","revision":1,"requestedAt":"2026-10-14T00:00:00Z"}""").jsonObject
        val sent = Snapshot(handoffs = JsonArray(listOf(handoff)))
        val changed = sent.copy(handoffs = JsonArray(listOf(JsonObject(handoff + ("taskId" to "other".jp())))))
        assertTrue(runCatching { SyncProtocol.merge(sent, changed) }.isFailure)
        val duplicate = MeloJson.encodeToJsonElement(original.copy(tasks = JsonArray(listOf(task, task))))
        assertTrue(runCatching { schema.validate(duplicate) }.isFailure)
    }
    @Test fun completionEvidenceFitsTheSharedSchemaAndKeepsSimulationExplicit() {
        val run = RunRecord(chatId = "chat", prompt = "x".repeat(4000), status = "completed", requestedModel = "fixture-model", simulated = true,
            sources = replySources("https://example.com/doc https://user:secret@example.com/private https://example.com/doc"))
        val record = SyncProtocol.put(Workspace(), "message", "assistant", run.messageMetadata(), "android")
        schema.validate(MeloJson.encodeToJsonElement(record), "workspace")
        val value = record.records.single().versions.single().value
        assertTrue(value.getValue("models").jsonArray.single().jsonObject.getValue("simulated").jsonPrimitive.boolean)
        assertEquals(listOf("https://example.com/doc"), run.sources)
    }
    @Test fun processDeathPreservesFinishedToolsAndInterruptsOnlyPendingObservations() {
        val scene = MeloJson.parseToJsonElement("""{"version":1,"runId":"r","status":"running","operations":[{"id":"s","name":"web_search","status":"completed","output":"Observed source"},{"id":"p","name":"phone_use","status":"running"}],"pipeline":[],"sources":[]}""").jsonObject
        val restored = RunRecord(id = "r", chatId = "chat", prompt = "fixture", sharedScene = scene).interrupted("2026-10-18T00:00:00Z")
        assertEquals("interrupted", restored.status)
        val observations = restored.sharedScene!!.getValue("operations").jsonArray
        assertEquals("completed", observations.first().jsonObject.text("status"))
        assertEquals("interrupted", observations.last().jsonObject.text("status"))
        assertEquals("Observed source", observations.first().jsonObject.text("output"))
        val workspace = SyncProtocol.put(Workspace(), "message", "assistant", restored.messageMetadata(), "android")
        schema.validate(MeloJson.encodeToJsonElement(workspace), "workspace")
        val value = workspace.records.single().versions.single().value
        assertEquals("interrupted", value.getValue("scene").jsonObject.text("status"))
    }
    @Test fun nodeNormalizationNeverCreatesSameClockConflicts() {
        val golden = MeloJson.parseToJsonElement(resource("portable-records.json")).jsonArray
        golden.forEach { item ->
            val row = item.jsonObject
            val kind = row.text("kind")
            val raw = row.getValue("input").jsonObject
            val expected = row.getValue("expected").jsonObject
            assertEquals(kind, expected, PortableWorkspace.value(kind, raw))
            val local = Workspace(records = listOf(WorkspaceRecord(kind, "record", listOf(RegisterVersion(mapOf("phone" to 1L), raw)))))
            val remote = Workspace(records = listOf(WorkspaceRecord(kind, "record", listOf(RegisterVersion(mapOf("phone" to 1L), expected)))))
            assertEquals(kind, 1, SyncProtocol.mergeWorkspace(local, remote).records.single().versions.size)
        }
    }
    @Test fun wireDatesUseTheSameMillisecondPrecisionAsTheNodeService() {
        val original = snapshot()
        val chat = original.chats.single()
        val precise = original.copy(chats = listOf(chat.copy(messages = listOf(chat.messages.single().copy(createdAt = "2026-10-14T00:00:00.123456Z")))))
        val returned = precise.copy(chats = listOf(precise.chats.single().copy(messages = listOf(precise.chats.single().messages.single().copy(createdAt = "2026-10-14T00:00:00.123Z")))))
        assertEquals(1, SyncProtocol.merge(precise, returned).chats.single().messages.size)
        SyncProtocol.requireDeletionAcknowledgement(Snapshot(deletedChats = listOf(Deletion("gone", "2026-10-14T00:00:00.123456Z"))), Snapshot(deletedChats = listOf(Deletion("gone", "2026-10-14T00:00:00.123Z"))))
    }
}
