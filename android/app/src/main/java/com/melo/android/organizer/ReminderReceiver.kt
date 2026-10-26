package com.melo.android.organizer

import android.app.NotificationManager
import android.content.*
import androidx.core.content.ContextCompat
import com.melo.android.MeloApplication
import com.melo.android.data.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        val repository = (context.applicationContext as MeloApplication).organizer
        repository.scope.launch {
            try {
                repository.initialize()
                val key = intent.getStringExtra("key").orEmpty()
                if (intent.action == "fire") {
                    val plan = repository.claim(key, intent.getIntExtra("revision", -1), intent.getLongExtra("fireAt", -1)) ?: return@launch
                    val capability = repository.reminders.capability()
                    if (!capability.notifications || !(if (plan.mode == "alarm") capability.alarmChannel else capability.normalChannel)) {
                        repository.acknowledge(key, "notifications_blocked", revision = plan.revision, fireAt = plan.fireAt); return@launch
                    }
                    if (plan.mode == "alarm") {
                        try { repository.deliverIfCurrent(plan) { ContextCompat.startForegroundService(context, Intent(context, ReminderService::class.java).putExtra("key", key)) } }
                        catch (_: Exception) { repository.deliverIfCurrent(plan) { context.getSystemService(NotificationManager::class.java).notify(ReminderEngine.notificationId(key), repository.reminders.notification(plan, false)) }; repository.acknowledge(key, "posted", revision = plan.revision, fireAt = plan.fireAt) }
                    } else {
                        repository.deliverIfCurrent(plan) { context.getSystemService(NotificationManager::class.java).notify(ReminderEngine.notificationId(key), repository.reminders.notification(plan, false)) }
                        repository.acknowledge(key, "posted", revision = plan.revision, fireAt = plan.fireAt)
                    }
                } else if (intent.action in setOf("dismiss", "complete", "snooze5", "snooze10")) {
                    // Explicit immutable app PendingIntents, with stale-revision checks.
                    val delivery = repository.data.value.deliveries.find { it.key == key && it.revision == intent.getIntExtra("revision", -1) && it.fireAt == intent.getLongExtra("fireAt", -1) } ?: return@launch
                    if (intent.action == "complete" && intent.getStringExtra("kind") == "todo") {
                        val id = intent.getStringExtra("ownerId").orEmpty()
                        if (repository.data.value.core.todos.any { it.id == id && it.revision == delivery.revision }) repository.command("todo_complete", buildJsonObject { put("id", id) }, "notification:$key:${delivery.revision}")
                    }
                    if (ReminderService.activeKey == key) context.startService(Intent(context, ReminderService::class.java).setAction("stop"))
                    context.getSystemService(NotificationManager::class.java).cancel(ReminderEngine.notificationId(key))
                    repository.acknowledge(key, if (intent.action!!.startsWith("snooze")) "snoozed" else "acknowledged", when (intent.action) { "snooze5" -> 5; "snooze10" -> 10; else -> null }, revision = delivery.revision, fireAt = delivery.fireAt)
                } else repository.refresh()
            } finally { pending.finish() }
        }
    }
}
