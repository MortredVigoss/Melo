package com.melo.android.organizer

import android.Manifest
import android.app.*
import android.content.*
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.melo.android.MainActivity
import com.melo.android.data.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

/** OS scheduling is reconciled from persisted revisions, never from a running chat. */
class ReminderEngine(private val context: Context, private val repository: OrganizerRepository) {
    private val mutex = Mutex()
    private val alarms get() = context.getSystemService(AlarmManager::class.java)
    private val notifications get() = context.getSystemService(NotificationManager::class.java)
    data class Capability(val notifications: Boolean, val exact: Boolean, val fullScreen: Boolean, val normalChannel: Boolean, val alarmChannel: Boolean) {
        fun json() = buildJsonObject { put("notifications", notifications); put("exact", exact); put("fullScreen", fullScreen); put("normalChannel", normalChannel); put("alarmChannel", alarmChannel) }
    }
    fun channels() {
        notifications.createNotificationChannel(NotificationChannel(NORMAL, "待办与日程", NotificationManager.IMPORTANCE_HIGH).apply { description = "到期提醒、声音与振动"; enableVibration(true) })
        notifications.createNotificationChannel(NotificationChannel(ALARM, "闹钟式提醒", NotificationManager.IMPORTANCE_HIGH).apply { description = "用户选择的持续响铃提醒"; enableVibration(true); setSound(null, null) })
    }
    fun capability(): Capability {
        channels()
        return Capability(NotificationManagerCompat.from(context).areNotificationsEnabled() && (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED), Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms(), Build.VERSION.SDK_INT < 34 || notifications.canUseFullScreenIntent(), notifications.getNotificationChannel(NORMAL)?.importance != NotificationManager.IMPORTANCE_NONE, notifications.getNotificationChannel(ALARM)?.importance != NotificationManager.IMPORTANCE_NONE)
    }
    suspend fun reconcile() = mutex.withLock {
        repository.initialize(); channels()
        val now = System.currentTimeMillis(); val state = repository.data.value
        val all = desired(if (SystemCalendarProvider(context).allowed()) state else state.copy(sources = state.sources.map { if (it.kind == "system") it.copy(reminders = false) else it }), now)
        val plans = all.filter { plan ->
            val delivery = state.deliveries.find { it.key == plan.key && it.revision == plan.revision }
            delivery == null || delivery.status in setOf("snoozed", "received", "ringing")
        }.map { plan ->
            val delivery = state.deliveries.find { it.key == plan.key && it.revision == plan.revision && it.status == "snoozed" }
            if (delivery?.snoozeUntil != null) plan.copy(fireAt = delivery.snoozeUntil) else plan
        }.filter { it.fireAt >= now - 120000 }.sortedBy { it.fireAt }.take(MAX_ARMED).map { it.copy(scheduledAt = now) }
        repository.update { current ->
            val missed = current.planned.filter { it.fireAt < now - 120000 && current.deliveries.none { delivery -> delivery.key == it.key && delivery.revision == it.revision } }.map { ReminderDelivery(it.key, it.revision, it.fireAt, "missed", now) }
            current.copy(planned = plans, deliveries = (current.deliveries + missed).takeLast(2000))
        }
        for (old in state.planned) if (all.none { it.key == old.key && it.revision == old.revision }) {
            alarms.cancel(pending(old)); notifications.cancel(notificationId(old.key))
            // Stop an active alert when its owner was edited/completed/deleted.
            if (ReminderService.activeKey == old.key) context.startService(Intent(context, ReminderService::class.java).setAction("stop"))
        }
        for (delivery in state.deliveries) if (all.none { it.key == delivery.key && it.revision == delivery.revision }) {
            notifications.cancel(notificationId(delivery.key))
            if (ReminderService.activeKey == delivery.key) context.startService(Intent(context, ReminderService::class.java).setAction("stop"))
        }
        for (plan in plans) {
            if (state.deliveries.any { it.key == plan.key && it.revision == plan.revision && it.fireAt == plan.fireAt && it.status in setOf("received", "ringing") }) continue
            try {
                if (plan.mode == "alarm" && capability().exact) alarms.setAlarmClock(AlarmManager.AlarmClockInfo(plan.fireAt.coerceAtLeast(now + 500), openPage(plan.kind)), pending(plan))
                else if (capability().exact) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, plan.fireAt.coerceAtLeast(now + 500), pending(plan))
                else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, plan.fireAt.coerceAtLeast(now + 500), pending(plan))
            } catch (_: SecurityException) { alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, plan.fireAt.coerceAtLeast(now + 500), pending(plan)) }
        }
    }
    private fun pending(plan: PlannedReminder): PendingIntent = PendingIntent.getBroadcast(context, 0, Intent(context, ReminderReceiver::class.java).setAction("fire").setData(Uri.parse("melo-organizer://alarm/" + Uri.encode(plan.key))).putExtra("key", plan.key).putExtra("revision", plan.revision).putExtra("fireAt", plan.fireAt), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    fun openPage(kind: String): PendingIntent = PendingIntent.getActivity(context, if (kind == "todo") 401 else 402, Intent(context, MainActivity::class.java).putExtra("melo_page", if (kind == "todo") "todo" else "calendar").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    fun action(plan: PlannedReminder, action: String): PendingIntent = PendingIntent.getBroadcast(context, 0, Intent(context, ReminderReceiver::class.java).setAction(action).setData(Uri.parse("melo-organizer://$action/" + Uri.encode(plan.key))).putExtra("key", plan.key).putExtra("revision", plan.revision).putExtra("fireAt", plan.fireAt).putExtra("ownerId", plan.ownerId).putExtra("kind", plan.kind), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    fun notification(plan: PlannedReminder, strong: Boolean): Notification {
        val builder = NotificationCompat.Builder(context, if (strong) ALARM else NORMAL).setSmallIcon(android.R.drawable.ic_lock_idle_alarm).setContentTitle(plan.title).setContentText(if (strong) "闹钟式提醒 · 点击处理" else "待办与日程提醒").setContentIntent(openPage(plan.kind)).setCategory(if (strong) NotificationCompat.CATEGORY_ALARM else NotificationCompat.CATEGORY_REMINDER).setPriority(NotificationCompat.PRIORITY_HIGH).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setAutoCancel(!strong).setOngoing(strong).setDeleteIntent(action(plan,"dismiss")).addAction(0,"稍后 5 分钟",action(plan,"snooze5")).addAction(0,"稍后 10 分钟",action(plan,"snooze10")).addAction(0,if (plan.kind == "todo") "完成" else "关闭",action(plan,if (plan.kind == "todo") "complete" else "dismiss"))
        if (strong && capability().fullScreen) {
            val activity = PendingIntent.getActivity(context, 0, Intent(context, AlarmActivity::class.java).setData(Uri.parse("melo-organizer://alert/" + Uri.encode(plan.key))).putExtra("key", plan.key), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            builder.setFullScreenIntent(activity, true)
        }
        return builder.build()
    }
    companion object {
        const val NORMAL = "melo-organizer-reminders"; const val ALARM = "melo-organizer-alarms"; const val MAX_ARMED = 64
        fun notificationId(key: String) = 0x40000000 or (key.hashCode() and 0x0fffffff)
        fun desired(state: OrganizerData, now: Long): List<PlannedReminder> {
            val until = now + 90L * 86400000
            val todos = state.core.todos.filter { !it.completed && it.remindAt != null }.map { PlannedReminder("todo:${it.id}", it.id, title = it.title, fireAt = it.remindAt!!, revision = it.revision, mode = it.reminderMode, kind = "todo") }
            val local = state.core.events.filter { it.remindAt != null }.flatMap { event ->
                val lead = event.startAt - event.remindAt!!
                EventOccurrences.local(event, now - 120000, until + lead).map { row -> PlannedReminder("event:${row.id}", event.id, title = row.title, fireAt = row.startAt - lead, revision = event.revision, mode = event.reminderMode, kind = "calendar") }
            }
            val external = state.external.mapNotNull { row -> state.sources.find { it.id == row.sourceId && it.enabled && it.reminders }?.let { source -> PlannedReminder("event:${row.id}", row.eventId, row.sourceId, row.title, row.startAt - source.reminderMinutes * 60000L, row.revision + source.reminderMinutes + source.reminderMode.hashCode(), source.reminderMode, "calendar") } }
            return (todos + local + external).filter { it.fireAt <= until }
        }
    }
}
