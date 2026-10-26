package com.melo.android.organizer

import android.content.Context
import androidx.room.Room
import androidx.work.*
import com.melo.android.core.SharedCoreRuntime
import com.melo.android.core.value
import com.melo.android.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.time.*
import java.util.concurrent.TimeUnit

class OrganizerRepository(private val context: Context) {
    private val database = Room.databaseBuilder(context, OrganizerDatabase::class.java, "melo-organizer.db").build()
    private val mutex = Mutex()
    private val refreshMutex = Mutex()
    private var loaded = false
    private val mutable = MutableStateFlow(OrganizerData())
    val data: StateFlow<OrganizerData> = mutable.asStateFlow()
    val error = MutableStateFlow<String?>(null)
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val reminders by lazy { ReminderEngine(context, this) }
    private val vault = CredentialVault(context)
    private val system = SystemCalendarProvider(context)

    suspend fun initialize() = mutex.withLock {
        if (loaded) return@withLock
        mutable.value = database.document().load()?.let { MeloJson.decodeFromString<OrganizerData>(it.payload) } ?: OrganizerData()
        check(mutable.value.version == 1) { "Organizer 数据版本不兼容。" }
        val interrupted = mutable.value.copy(deliveries = mutable.value.deliveries.map { if (it.status in setOf("received", "ringing")) it.copy(status = "missed") else it })
        if (interrupted != mutable.value) { database.document().save(OrganizerDocument(payload = MeloJson.encodeToString(interrupted))); mutable.value = interrupted }
        loaded = true
    }
    fun start() = scope.launch {
        try {
            initialize(); reminders.reconcile()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("melo-organizer-refresh", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<OrganizerRefreshWorker>(15, TimeUnit.MINUTES).setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.NOT_REQUIRED).build()).build())
            refresh()
        } catch (e: Exception) { if (e is CancellationException) throw e; error.value = "待办与日历未就绪：" + e.javaClass.simpleName }
    }
    fun work(block: suspend () -> Unit) = scope.launch { try { block(); error.value = null } catch (e: Exception) { if (e is CancellationException) throw e; error.value = e.message?.take(300) ?: "操作未完成。" } }
    suspend fun update(transform: (OrganizerData) -> OrganizerData): OrganizerData {
        initialize()
        return mutex.withLock {
            val next = transform(mutable.value)
            database.document().save(OrganizerDocument(payload = MeloJson.encodeToString(next))); mutable.value = next; next
        }
    }
    suspend fun command(name: String, arguments: JsonObject, requestId: String = newId(), runtime: SharedCoreRuntime? = null): JsonObject {
        initialize()
        if (name.startsWith("calendar_") && arguments.text("timeZone").isNotBlank()) ZoneId.of(arguments.text("timeZone"))
        val result = mutex.withLock {
            suspend fun apply(core: SharedCoreRuntime): JsonObject = core.value("organizer", buildJsonObject { put("command", buildJsonObject {
                put("state", MeloJson.encodeToJsonElement(mutable.value.core)); put("name", name); put("arguments", arguments); put("now", System.currentTimeMillis()); put("id", newId()); put("requestId", requestId)
            }) }).jsonObject
            val value = if (runtime != null) apply(runtime) else SharedCoreRuntime.open(context).use { apply(it) }
            if (value["changed"]?.jsonPrimitive?.boolean == true) {
                val next = mutable.value.copy(core = MeloJson.decodeFromJsonElement<OrganizerCore>(value.getValue("state")))
                database.document().save(OrganizerDocument(payload = MeloJson.encodeToString(next))); mutable.value = next
            }
            value.getValue("result").jsonObject
        }
        if (name == "calendar_list_events") {
            refresh(staleOnly = true)
            val rows = occurrences(result.getValue("start").jsonPrimitive.long, result.getValue("end").jsonPrimitive.long).filter { (it.title + " " + it.notes + " " + it.location).contains(result.text("query"), true) }
            return buildJsonObject { put("ok", true); put("events", MeloJson.encodeToJsonElement(rows)); put("sources", MeloJson.encodeToJsonElement(data.value.sources)); put("externalReadOnly", true); put("externalCacheStart", System.currentTimeMillis() - 90L * 86400000); put("externalCacheEnd", System.currentTimeMillis() + 180L * 86400000); put("cacheNote", "External results outside the cache window are unavailable, not evidence that no events exist.") }
        }
        var scheduleError: String? = null
        if (name != "todo_list") try { reminders.reconcile() } catch (e: Exception) { if (e is CancellationException) throw e; scheduleError = "事项已保存，但系统提醒排程未完成。打开应用重试。"; error.value = scheduleError }
        val capability = reminders.capability()
        val item = result["item"] as? JsonObject
        val at = item?.get("remindAt")?.jsonPrimitive?.longOrNull
        val cancelled = result["deleted"]?.jsonPrimitive?.booleanOrNull == true || item?.get("completed")?.jsonPrimitive?.booleanOrNull == true
        val phase = when {
            scheduleError != null -> "failed"
            cancelled -> "cancelled"
            at == null -> "none"
            data.value.planned.any { it.ownerId == result.text("id") && it.revision == item?.get("revision")?.jsonPrimitive?.intOrNull } -> "scheduled"
            at < System.currentTimeMillis() -> "past_due"
            else -> "deferred"
        }
        return JsonObject(result + ("reminderCapability" to capability.json()) + ("reminderScheduling" to buildJsonObject {
            put("phase", phase); put("notifications", capability.notifications); put("exact", capability.exact); put("fullScreen", capability.fullScreen)
            scheduleError?.let { put("error", it) }
            if (phase == "deferred") put("note", "Only the nearest 64 reminders within 90 days are armed; background reconciliation fills the next slots.")
        }))
    }
    fun occurrences(start: Long, end: Long): List<CalendarOccurrence> {
        require(end > start && end - start <= 366L * 86400000) { "日期范围需在 366 天以内。" }
        val state = data.value
        val external = state.external.filter { row -> state.sources.any { it.id == row.sourceId && it.enabled && (it.kind != "system" || system.allowed()) } && row.startAt < end && row.endAt > start }
        return (state.core.events.flatMap { EventOccurrences.local(it, start, end) } + external).sortedBy { it.startAt }
    }
    fun systemSources() = system.sources()
    fun systemAllowed() = system.allowed()
    suspend fun addSystem(source: CalendarSource) {
        require(source.kind == "system" && system.sources().any { it.id == source.id })
        update { it.copy(sources = it.sources.filterNot { s -> s.id == source.id } + source) }; refresh()
    }
    suspend fun subscribe(name: String, url: String) {
        require(name.isNotBlank() && name.length <= 200) { "请填写来源名称（不超过 200 字）。" }
        val safe = IcsHttp.normalizedUrl(url)
        val source = CalendarSource(newId(), "ics", name.trim())
        vault.set("organizer:${source.id}", safe)
        try { update { it.copy(sources = it.sources + source) } } catch (e: Exception) { vault.set("organizer:${source.id}", ""); throw e }
        refresh()
    }
    suspend fun editSource(source: CalendarSource) {
        require(source.reminderMinutes in 0..10080 && source.reminderMode in setOf("alarm", "notification"))
        update { state -> check(state.sources.any { it.id == source.id }); state.copy(sources = state.sources.map { if (it.id == source.id) source else it }) }
        refresh(staleOnly = true)
    }
    private fun icsCache(id: String): android.util.AtomicFile { require(id.matches(Regex("[A-Za-z0-9_-]{1,100}"))); return android.util.AtomicFile(java.io.File(context.filesDir, "organizer-ics-cache/$id.ics")) }
    suspend fun removeSource(id: String) {
        update { it.copy(sources = it.sources.filterNot { s -> s.id == id }, external = it.external.filterNot { row -> row.sourceId == id }) }
        vault.set("organizer:$id", ""); if (!id.startsWith("system:")) icsCache(id).delete(); reminders.reconcile()
    }
    suspend fun refresh(staleOnly: Boolean = false) = refreshMutex.withLock {
        initialize()
        val now = System.currentTimeMillis(); val start = now - 90L * 86400000; val end = now + 180L * 86400000
        for (source in data.value.sources.filter { it.enabled }) {
            if (staleOnly && source.lastRefresh != null && now - source.lastRefresh < 900000 && (source.kind != "system" || system.allowed())) continue
            try {
                var etag = source.etag; var modified = source.modified
                val rows = withContext(Dispatchers.IO) {
                    if (source.kind == "system") system.read(source, start, end) else {
                        val cache = icsCache(source.id)
                        val response = IcsHttp().fetch(vault.get("organizer:${source.id}"), if (cache.baseFile.exists()) source else source.copy(etag = null, modified = null))
                        etag = response.etag; modified = response.modified
                        val text = response.text ?: cache.openRead().bufferedReader().use { it.readText() }
                        val parsed = IcsParser.parse(text, source, start, end)
                        if (response.text != null) {
                            cache.baseFile.parentFile?.mkdirs()
                            val stream = cache.startWrite()
                            try { stream.write(text.toByteArray(Charsets.UTF_8)); cache.finishWrite(stream) } catch (e: Exception) { cache.failWrite(stream); throw e }
                        }
                        parsed
                    }
                }
                update { current ->
                    val active = current.sources.find { it.id == source.id }
                    // A removed/disabled/edited source must not be resurrected by a late fetch.
                    if (active != source) { if (active == null && source.kind == "ics") icsCache(source.id).delete(); current } else current.copy(sources = current.sources.map { if (it.id == source.id) it.copy(lastRefresh = now, lastError = null, etag = etag, modified = modified) else it }, external = if (rows == null) current.external else current.external.filterNot { it.sourceId == source.id } + rows)
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                update { current -> current.copy(sources = current.sources.map { if (it.id == source.id) it.copy(lastError = if (source.kind == "system") "系统日历无法读取，请检查权限。" else "订阅刷新失败，保留上次数据。请检查链接和 ICS 格式。") else it }) }
            }
        }
        reminders.reconcile()
    }
    suspend fun deliverIfCurrent(plan: PlannedReminder, deliver: () -> Unit): Boolean = mutex.withLock {
        val current = mutable.value
        if (ReminderEngine.desired(current, System.currentTimeMillis()).none { it.key == plan.key && it.revision == plan.revision }) false
        else { deliver(); true }
    }
    suspend fun claim(key: String, revision: Int, fireAt: Long): PlannedReminder? {
        var claimed: PlannedReminder? = null
        update { state ->
            val planned = state.planned.find { it.key == key && it.revision == revision && it.fireAt == fireAt }
            val old = state.deliveries.find { it.key == key && it.revision == revision && it.fireAt == fireAt }
            val now = System.currentTimeMillis()
            if (planned == null || old?.status in setOf("received", "posted", "ringing", "acknowledged", "completed", "timed_out", "missed") || now < fireAt - 1000 || now - fireAt > 120000) state
            else {
                claimed = planned
                state.copy(deliveries = (state.deliveries.filterNot { it.key == key } + ReminderDelivery(key, revision, fireAt, "received", now)).takeLast(2000))
            }
        }
        return claimed
    }
    suspend fun acknowledge(key: String, status: String, snoozeMinutes: Int? = null, revision: Int? = null, fireAt: Long? = null) {
        update { state ->
            val plan = state.planned.find { it.key == key && (revision == null || it.revision == revision) && (fireAt == null || it.fireAt == fireAt) }
            val prior = state.deliveries.find { it.key == key && (revision == null || it.revision == revision) && (fireAt == null || it.fireAt == fireAt) }
            if (plan == null && prior == null || revision != null && state.planned.any { it.key == key && it.revision != revision }) state else state.copy(deliveries = (state.deliveries.filterNot { it.key == key } + ReminderDelivery(key, plan?.revision ?: prior!!.revision, plan?.fireAt ?: prior!!.fireAt, status, System.currentTimeMillis(), snoozeMinutes?.let { System.currentTimeMillis() + it * 60000L })).takeLast(2000))
        }
        reminders.reconcile()
    }
}

class OrganizerRefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = try { (applicationContext as com.melo.android.MeloApplication).organizer.refresh(); Result.success() } catch (e: Exception) { if (e is CancellationException) throw e; Result.retry() }
}
