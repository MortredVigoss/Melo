package com.melo.android.data

import kotlinx.serialization.json.*
import java.time.Instant

/** The same deliberately small JSON Schema subset as mobile-sync/schemaValidator.js. */
class SyncSchema(private val root: JsonObject) {
    fun validate(value: JsonElement, definition: String = "snapshot") {
        check(value, root.getValue("\$defs").jsonObject.getValue(definition).jsonObject)
        fun validDate(value: String) { require(runCatching { Instant.parse(value) }.isSuccess) { "同步日期无效。" } }
        fun workspace(document: JsonObject) {
            val records = document.getValue("records").jsonArray.map { it.jsonObject }
            require(records.map { "${it.text("kind")}:${it.text("id")}" }.distinct().size == records.size) { "同步记录身份重复。" }
            fun validUrl(text: String, endpoint: Boolean = false) {
                if (text.isEmpty()) return
                val uri = java.net.URI(text)
                require(uri.scheme in setOf("http", "https") && uri.host != null && uri.userInfo == null) { "同步网页地址无效。" }
                if (endpoint) require(uri.query == null && uri.fragment == null)
            }
            records.forEach { row -> row.getValue("versions").jsonArray.forEach { version ->
                val item = version.jsonObject.getValue("value").jsonObject
                if (row.text("kind") == "message") item["scene"]?.takeIf { it != JsonNull }?.jsonObject?.get("sources")?.jsonArray?.forEach { source -> validUrl(source.jsonObject.text("url")) }
                if (row.text("kind") == "conversation") item["model"]?.takeIf { it != JsonNull }?.jsonObject?.let { validUrl(it.text("baseURL"), true) }
            } }
            records.filter { it.text("kind") == "memory" }.forEach { row -> row.getValue("versions").jsonArray.forEach {
                val memory = it.jsonObject.getValue("value").jsonObject
                validDate(memory.text("updatedAt")); memory["validTo"]?.takeIf { it != JsonNull }?.let { validDate(it.jsonPrimitive.content) }
                require(memory.text("text").isNotBlank())
                if (memory.text("scope") == "project") require(memory.text("projectId").isNotBlank())
            } }
        }
        fun tasks(document: JsonObject) {
            listOf("tasks" to "updatedAt", "handoffs" to "requestedAt").forEach { (key, dateKey) ->
                val rows = document[key]?.jsonArray.orEmpty().map { it.jsonObject }
                require(rows.map { it.text("id") }.distinct().size == rows.size) { "任务或接力身份重复。" }
                rows.forEach { validDate(it.text(dateKey)) }
            }
        }
        when (definition) {
            "workspace" -> workspace(value.jsonObject)
            "taskSync" -> tasks(value.jsonObject)
            "snapshot" -> {
                val chats = value.jsonObject.getValue("chats").jsonArray.map { it.jsonObject }
                require(chats.map { it.text("id") }.distinct().size == chats.size)
                chats.forEach { chat ->
                    validDate(chat.text("createdAt")); validDate(chat.text("updatedAt"))
                    val messages = chat.getValue("messages").jsonArray.map { it.jsonObject }
                    require(messages.map { it.text("id") }.distinct().size == messages.size)
                    messages.forEach { validDate(it.text("createdAt")) }
                }
                value.jsonObject["workspace"]?.let { workspace(it.jsonObject) }
                value.jsonObject["deletedChats"]?.jsonArray?.forEach { validDate(it.jsonObject.text("deletedAt")) }
                tasks(value.jsonObject)
            }
        }
    }
    private fun check(value: JsonElement, rule: JsonObject) {
        fun fail(): Nothing = throw IllegalArgumentException("同步数据不符合共享协议，手机记录已保留。")
        rule["\$ref"]?.let { check(value, root.getValue("\$defs").jsonObject.getValue(it.jsonPrimitive.content.substringAfterLast('/')).jsonObject); return }
        rule["const"]?.let { if (value != it) fail() }
        rule["enum"]?.let { if (value !in it.jsonArray) fail() }
        rule["not"]?.let { if (runCatching { check(value, it.jsonObject) }.isSuccess) fail() }
        rule["anyOf"]?.let { if (it.jsonArray.none { item -> runCatching { check(value, item.jsonObject) }.isSuccess }) fail() }
        rule["allOf"]?.jsonArray?.forEach { check(value, it.jsonObject) }
        rule["if"]?.let { condition -> if (runCatching { check(value, condition.jsonObject) }.isSuccess) rule["then"]?.let { check(value, it.jsonObject) } }
        val primitive = value as? JsonPrimitive
        val actual = when { value == JsonNull -> "null"; value is JsonObject -> "object"; value is JsonArray -> "array"; primitive!!.isString -> "string"; primitive.booleanOrNull != null -> "boolean"; else -> "number" }
        rule["type"]?.let { spec ->
            val types = if (spec is JsonArray) spec.map { it.jsonPrimitive.content } else listOf(spec.jsonPrimitive.content)
            val integer = actual == "number" && primitive?.longOrNull != null && kotlin.math.abs(primitive.long) <= 9007199254740991L
            if (actual !in types && !("integer" in types && integer)) fail()
        }
        fun bound(n: Double, min: String, max: String) {
            if (rule[min]?.jsonPrimitive?.doubleOrNull?.let { n < it } == true || rule[max]?.jsonPrimitive?.doubleOrNull?.let { n > it } == true) fail()
        }
        when (value) {
            is JsonObject -> {
                bound(value.size.toDouble(), "minProperties", "maxProperties")
                rule["required"]?.jsonArray?.forEach { if (it.jsonPrimitive.content !in value) fail() }
                value.forEach { (key, child) ->
                    rule["propertyNames"]?.let { check(key.jp(), it.jsonObject) }
                    val childRule = rule["properties"]?.jsonObject?.get(key)
                    if (childRule != null) check(child, childRule.jsonObject)
                    else when (val extra = rule["additionalProperties"]) { JsonPrimitive(false) -> fail(); is JsonObject -> check(child, extra); else -> Unit }
                }
            }
            is JsonArray -> { bound(value.size.toDouble(), "minItems", "maxItems"); rule["items"]?.let { item -> value.forEach { check(it, item.jsonObject) } } }
            is JsonPrimitive -> if (value.isString) {
                val text = value.content
                bound(text.codePointCount(0, text.length).toDouble(), "minLength", "maxLength")
                bound(text.length.toDouble(), "x-minUtf16Length", "x-maxUtf16Length")
                rule["pattern"]?.let { if (!Regex(it.jsonPrimitive.content).containsMatchIn(text)) fail() }
            } else value.doubleOrNull?.let { if (!it.isFinite()) fail(); bound(it, "minimum", "maximum") }
            else -> Unit
        }
    }
}

object SyncProtocol {
    const val MAX_BYTES = 8 * 1024 * 1024
    private fun wireDate(value: String): String = java.time.format.DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(Instant.parse(value))
    private fun date(value: String) = require(runCatching { Instant.parse(value) }.isSuccess) { "同步日期无效。" }
    fun validate(snapshot: Snapshot, schema: SyncSchema) {
        val encoded = MeloJson.encodeToString(snapshot)
        require(encoded.toByteArray().size <= MAX_BYTES) { "同步资料超过 8 MiB，原数据已保留。" }
        schema.validate(MeloJson.parseToJsonElement(encoded))
        require(snapshot.chats.map { it.id }.distinct().size == snapshot.chats.size) { "同步对话身份重复。" }
        snapshot.chats.forEach { chat ->
            date(chat.createdAt); date(chat.updatedAt)
            require(chat.messages.map { it.id }.distinct().size == chat.messages.size) { "同步消息身份重复。" }
            chat.messages.forEach { date(it.createdAt) }
        }
        snapshot.deletedChats.forEach { date(it.deletedAt) }
        ProjectLifecycle.markers(snapshot.workspace)
        require(snapshot.workspace.records.map { "${it.kind}:${it.id}" }.distinct().size == snapshot.workspace.records.size) { "同步记录身份重复。" }
    }
    private fun canonical(value: JsonElement): String = when (value) {
        is JsonObject -> value.entries.sortedBy { it.key }.joinToString(",", "{", "}") { "${MeloJson.encodeToString(it.key)}:${canonical(it.value)}" }
        is JsonArray -> value.joinToString(",", "[", "]") { canonical(it) }
        else -> value.toString()
    }
    private fun dominates(a: Map<String, Long>, b: Map<String, Long>) = b.all { (key, count) -> (a[key] ?: 0) >= count }
    private fun versions(input: List<RegisterVersion>): List<RegisterVersion> {
        val unique = input.groupBy { canonical(it.value) }.values.map { group ->
            RegisterVersion(group.flatMap { it.clock.entries }.groupBy({ it.key }, { it.value }).mapValues { it.value.max() }, group.first().value)
        }
        val result = unique.filter { a -> unique.none { b -> b !== a && dominates(b.clock, a.clock) && !dominates(a.clock, b.clock) } }
        require(result.size <= 20) { "离线版本过多，请先处理同步冲突。" }
        return result.sortedBy { canonical(MeloJson.encodeToJsonElement(it)) }
    }
    fun mergeWorkspace(a: Workspace, b: Workspace, deleted: Set<String> = emptySet()): Workspace {
        val rows = ProjectLifecycle.workspace(Workspace(records = a.records + b.records)).records.filterNot { it.kind == "conversation" && it.id in deleted || it.kind in setOf("message", "memory") && it.versions.any { version -> version.value.text("chatId") in deleted } }
        return Workspace(records = rows.groupBy { "${it.kind}:${it.id}" }.toSortedMap().values.map { rowsForId -> rowsForId.first().copy(versions = versions(rowsForId.flatMap { row -> row.versions.map { it.copy(value = PortableWorkspace.value(row.kind, it.value)) } })) })
    }
    fun put(workspace: Workspace, kind: String, id: String, value: JsonObject, device: String, resolveIndex: Int? = null): Workspace {
        val old = workspace.records.find { it.kind == kind && it.id == id }
        require(old == null || old.versions.size == 1 || resolveIndex != null) { "该记录有离线冲突，请先选择保留的版本。" }
        val selected = PortableWorkspace.value(kind, resolveIndex?.let { old?.versions?.getOrNull(it)?.value ?: error("冲突版本已改变，请刷新。") } ?: value)
        if (old?.versions?.size == 1 && PortableWorkspace.value(kind, old.versions.first().value) == selected) return workspace
        val joined = old?.versions.orEmpty().flatMap { it.clock.entries }.groupBy({ it.key }, { it.value }).mapValues { it.value.max() }.toMutableMap()
        joined[device] = (joined[device] ?: 0) + 1
        val row = WorkspaceRecord(kind, id, listOf(RegisterVersion(joined, selected)))
        return workspace.copy(records = (workspace.records.filterNot { it.kind == kind && it.id == id } + row).sortedBy { "${it.kind}:${it.id}" })
    }
    fun merge(a: Snapshot, b: Snapshot): Snapshot {
        val deletions = (a.deletedChats + b.deletedChats).map { it.copy(deletedAt = wireDate(it.deletedAt)) }.groupBy { it.id }.values.map { rows -> rows.maxBy { Instant.parse(it.deletedAt) } }.sortedBy { it.id }
        val deleted = deletions.map { it.id }.toSet()
        val chats = (a.chats + b.chats).filterNot { it.id in deleted }.map { chat -> chat.copy(createdAt = wireDate(chat.createdAt), updatedAt = wireDate(chat.updatedAt), messages = chat.messages.map { it.copy(createdAt = wireDate(it.createdAt)) }) }.groupBy { it.id }.values.map { copies ->
            val newest = copies.maxWith(compareBy<WireChat> { Instant.parse(it.updatedAt) }.thenBy { it.title })
            val messages = copies.flatMap { it.messages }.groupBy { it.id }.values.map { candidates ->
                require(candidates.distinct().size == 1) { "消息身份冲突，原记录已保留。" }; candidates.first()
            }.sortedWith(compareBy<WireMessage> { Instant.parse(it.createdAt) }.thenBy { it.id })
            newest.copy(createdAt = copies.minBy { Instant.parse(it.createdAt) }.createdAt, messages = messages)
        }.sortedWith(compareByDescending<WireChat> { Instant.parse(it.updatedAt) }.thenBy { it.id })
        fun normalize(row: JsonObject, handoff: Boolean): JsonObject = buildJsonObject {
            val fields = if (handoff) listOf("id", "taskId", "fromDevice", "requestedAt", "revision") else listOf("id", "title", "status", "checkpoint", "revision", "sourceDevice", "updatedAt")
            fields.forEach { key -> put(key, row.getValue(key)) }
            val dateKey = if (handoff) "requestedAt" else "updatedAt"
            put(dateKey, java.time.format.DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(Instant.parse(row.text(dateKey))))
            if (!handoff) {
                put("owner", row.text("owner").ifBlank { "main" }.take(100))
                put("chatId", row["chatId"] ?: JsonNull)
                put("needsApproval", row["needsApproval"]?.jsonPrimitive?.booleanOrNull == true)
            }
        }
        fun mergeRows(left: JsonArray, right: JsonArray, handoff: Boolean): JsonArray {
            val rows = linkedMapOf<String, JsonObject>()
            (left + right).forEach { value ->
                val next = normalize(value.jsonObject, handoff)
                val old = rows[next.text("id")]
                if (old != null) {
                    if (handoff) require(old == next) { "接力身份冲突，原记录已保留。" }
                    else require(old.text("sourceDevice") == next.text("sourceDevice") &&
                        (old.getValue("revision") != next.getValue("revision") || old == next)) { "任务 checkpoint 冲突，原记录已保留。" }
                }
                if (old == null || handoff || next.getValue("revision").jsonPrimitive.long > old.getValue("revision").jsonPrimitive.long) rows[next.text("id")] = next
            }
            return JsonArray(rows.toSortedMap().values.toList())
        }
        return Snapshot(chats = chats, deletedChats = deletions, workspace = mergeWorkspace(a.workspace, b.workspace, deleted), tasks = mergeRows(a.tasks, b.tasks, false), handoffs = mergeRows(a.handoffs, b.handoffs, true))
    }
    fun requireDeletionAcknowledgement(sent: Snapshot, received: Snapshot) {
        val acknowledged = received.deletedChats.associate { it.id to Instant.parse(it.deletedAt).toEpochMilli() }
        require(sent.deletedChats.all { acknowledged[it.id]?.let { time -> time >= Instant.parse(it.deletedAt).toEpochMilli() } == true }) { "同步服务未确认删除，请先更新服务；手机记录已保留。" }
    }
}
