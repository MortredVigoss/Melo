package com.melo.android.organizer

import androidx.room.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable data class TodoItem(val id: String, val title: String, val notes: String = "", val dueAt: Long? = null, val remindAt: Long? = null, val reminderMode: String = "notification", val completed: Boolean = false, val revision: Int = 1, val createdAt: Long = 0, val updatedAt: Long = 0)
@Serializable data class CalendarEvent(val id: String, val title: String, val notes: String = "", val startAt: Long, val endAt: Long, val timeZone: String = "UTC", val allDay: Boolean = false, val location: String = "", val repeat: String = "none", val repeatUntil: Long? = null, val remindAt: Long? = null, val reminderMode: String = "notification", val revision: Int = 1, val createdAt: Long = 0, val updatedAt: Long = 0)
@Serializable data class OrganizerCore(val version: Int = 1, val todos: List<TodoItem> = emptyList(), val events: List<CalendarEvent> = emptyList(), val receipts: JsonArray = JsonArray(emptyList()))
@Serializable data class CalendarSource(val id: String, val kind: String, val name: String, val enabled: Boolean = true, val color: Long = 0xFFD1B27D, val systemId: Long? = null, val reminders: Boolean = false, val reminderMinutes: Int = 10, val reminderMode: String = "notification", val lastRefresh: Long? = null, val lastError: String? = null, val etag: String? = null, val modified: String? = null)
@Serializable data class CalendarOccurrence(val id: String, val eventId: String, val sourceId: String, val title: String, val startAt: Long, val endAt: Long, val allDay: Boolean = false, val timeZone: String = "UTC", val notes: String = "", val location: String = "", val revision: Int = 1, val systemEventId: Long? = null)
@Serializable data class PlannedReminder(val key: String, val ownerId: String, val sourceId: String = "melo", val title: String, val fireAt: Long, val revision: Int, val mode: String, val kind: String, val scheduledAt: Long = 0)
@Serializable data class ReminderDelivery(val key: String, val revision: Int, val fireAt: Long, val status: String, val at: Long, val snoozeUntil: Long? = null)
@Serializable data class OrganizerData(val version: Int = 1, val core: OrganizerCore = OrganizerCore(), val sources: List<CalendarSource> = emptyList(), val external: List<CalendarOccurrence> = emptyList(), val deliveries: List<ReminderDelivery> = emptyList(), val planned: List<PlannedReminder> = emptyList())

@Entity(tableName = "organizer") data class OrganizerDocument(@PrimaryKey val id: Int = 1, val payload: String)
@Dao interface OrganizerDao { @Query("SELECT * FROM organizer WHERE id = 1") suspend fun load(): OrganizerDocument?; @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun save(document: OrganizerDocument) }
@Database(entities = [OrganizerDocument::class], version = 1, exportSchema = false)
abstract class OrganizerDatabase : RoomDatabase() { abstract fun document(): OrganizerDao }
