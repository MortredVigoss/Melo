package com.melo.android

import android.app.NotificationManager
import android.content.Intent
import android.os.Build
import android.os.ParcelFileDescriptor
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.melo.android.data.*
import com.melo.android.organizer.*
import com.melo.android.chat.SharedChatAgent
import com.melo.android.device.DeviceToolResult
import com.melo.android.network.ModelClient
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*

/** Native fixtures run only on our emulator; never clear a personal phone. */
class OrganizerFlowTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val app get() = ApplicationProvider.getApplicationContext<MeloApplication>()
    private var before: OrganizerData? = null
    private fun shell(command: String) = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command).use { ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { input -> input.readText() } }
    @Before fun setup() = runBlocking<Unit> {
        Assume.assumeTrue(Build.FINGERPRINT.contains("generic") || Build.MODEL.contains("sdk_gphone"))
        app.organizer.initialize(); before = app.organizer.data.value
        app.organizer.update { OrganizerData() }; app.organizer.reminders.reconcile()
        if (Build.VERSION.SDK_INT >= 33) shell("pm grant com.melo.android android.permission.POST_NOTIFICATIONS")
        shell("appops set com.melo.android SCHEDULE_EXACT_ALARM allow")
    }
    @After fun restore() = runBlocking<Unit> {
        if (before == null) return@runBlocking
        if (ReminderService.activeKey != null) app.startService(Intent(app, ReminderService::class.java).setAction("stop"))
        app.organizer.update { before!! }; app.organizer.reminders.reconcile()
        app.getSystemService(NotificationManager::class.java).activeNotifications.filter { it.id and 0x40000000 != 0 }.forEach { app.getSystemService(NotificationManager::class.java).cancel(it.id) }
    }
    private suspend fun waitFor(condition: () -> Boolean) = withTimeout(20000) { while (!condition()) delay(100) }
    private suspend fun todo(title: String, fireAt: Long? = null, mode: String = "notification", request: String = newId()): JsonObject = app.organizer.command("todo_create", buildJsonObject {
        put("title", title); put("reminderMode", mode); fireAt?.let { put("remindAt", iso(it)) }
    }, request)

    @Test fun createEditCompleteAndDeleteUseTheSamePersistentCore() = runBlocking<Unit> {
        val response = todo("Native fixture", request = "same-op")
        val repeat = todo("Native fixture", request = "same-op")
        assertEquals(response.text("id"), repeat.text("id")); assertEquals(1, app.organizer.data.value.core.todos.size)
        val id = response.text("id")
        app.organizer.command("todo_update", buildJsonObject { put("id", id); put("title", "Edited fixture") })
        app.organizer.command("todo_complete", buildJsonObject { put("id", id) })
        assertTrue(app.organizer.data.value.core.todos.single().completed)
        app.organizer.command("todo_delete", buildJsonObject { put("id", id) })
        assertTrue(app.organizer.data.value.core.todos.isEmpty())
    }
    @Test fun deletingOrEditingAnArmedReminderRejectsItsLateReceiver() = runBlocking<Unit> {
        val fire = System.currentTimeMillis() + 60000
        val id = todo("Stale fixture", fire).text("id")
        val original = app.organizer.data.value.planned.single()
        app.organizer.command("todo_update", buildJsonObject { put("id", id); put("title", "New revision") })
        assertNull(app.organizer.claim(original.key, original.revision, original.fireAt))
        app.organizer.acknowledge(original.key, "posted", revision = original.revision, fireAt = original.fireAt)
        assertEquals(2, app.organizer.data.value.planned.single().revision)
        assertTrue(app.organizer.data.value.deliveries.none { it.key == original.key && it.revision == 2 })
        app.organizer.command("todo_delete", buildJsonObject { put("id", id) })
        assertTrue(app.organizer.data.value.planned.isEmpty())
        assertNull(app.organizer.claim(original.key, original.revision, original.fireAt))
    }
    @Test fun ordinaryAlarmReallyPostsAndDeletingOwnerCancelsNotification() = runBlocking<Unit> {
        val id = todo("Notification fixture", System.currentTimeMillis() + 4000).text("id")
        val key = "todo:$id"
        assertTrue(app.organizer.data.value.planned.any { it.key == key })
        waitFor { app.organizer.data.value.deliveries.any { it.key == key && it.status == "posted" } }
        val manager = app.getSystemService(NotificationManager::class.java)
        assertTrue(manager.activeNotifications.any { it.id == ReminderEngine.notificationId(key) })
        app.organizer.command("todo_delete", buildJsonObject { put("id", id) })
        assertFalse(manager.activeNotifications.any { it.id == ReminderEngine.notificationId(key) })
    }
    @Test fun strongAlarmRingsAndSnoozeChangesScheduleWithoutCompletingTodo() = runBlocking<Unit> {
        val id = todo("Alarm fixture", System.currentTimeMillis() + 4000, "alarm").text("id")
        val key = "todo:$id"
        waitFor { ReminderService.activeKey == key && app.organizer.data.value.deliveries.any { it.key == key && it.status == "ringing" } }
        val original = app.organizer.data.value.planned.first { it.key == key }
        app.organizer.reminders.action(original, "snooze5").send()
        waitFor { app.organizer.data.value.deliveries.any { it.key == key && it.status == "snoozed" } && ReminderService.activeKey == null }
        assertFalse(app.organizer.data.value.core.todos.single().completed)
        assertTrue(app.organizer.data.value.planned.single().fireAt > original.fireAt + 240000)
        assertNull(app.organizer.claim(original.key, original.revision, original.fireAt))
    }
    @Test fun bothPagesAreReachableAndTodoEditorPersistsFromCompose() = runBlocking<Unit> {
        if (compose.activity.resources.configuration.screenWidthDp < 600) compose.onNodeWithContentDescription("打开侧边栏").performClick()
        compose.onNodeWithText("待办").performClick()
        compose.waitUntil(20000) { compose.onAllNodesWithTag("todo-page").fetchSemanticsNodes().size == 1 }
        compose.onNodeWithText("新建待办").performClick()
        compose.onNode(hasSetTextAction() and hasText("标题")).performTextInput("Compose fixture")
        compose.activityRule.scenario.recreate()
        compose.onNode(hasSetTextAction() and hasText("Compose fixture")).assertExists()
        compose.onNodeWithText("保存").performClick()
        waitFor { app.organizer.data.value.core.todos.any { it.title == "Compose fixture" } }
        if (compose.activity.resources.configuration.screenWidthDp < 600) compose.onNodeWithContentDescription("打开侧边栏").performClick()
        compose.onNodeWithText("日历").performClick()
        compose.waitUntil(10000) { compose.onAllNodesWithTag("calendar-page").fetchSemanticsNodes().size == 1 }
        compose.onNodeWithText("新建日程").assertExists()
    }
    @Test fun packagedIcsParserHandlesTimezoneRecurrenceOnAndroid() {
        val source = CalendarSource("ics-native", "ics", "Fixture")
        val text = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Melo Fixture//EN\r\nBEGIN:VEVENT\r\nUID:android-ics\r\nDTSTART;TZID=Australia/Sydney:20261026T090000\r\nDTEND;TZID=Australia/Sydney:20261026T100000\r\nRRULE:FREQ=DAILY;COUNT=2\r\nSUMMARY:Android ICS\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
        val rows = IcsParser.parse(text, source, java.time.Instant.parse("2026-10-25T00:00:00Z").toEpochMilli(), java.time.Instant.parse("2026-10-29T00:00:00Z").toEpochMilli(), java.time.ZoneId.of("Australia/Sydney"))
        assertEquals(2, rows.size); assertEquals(9, java.time.Instant.ofEpochMilli(rows[0].startAt).atZone(java.time.ZoneId.of("Australia/Sydney")).hour)
    }
    @Test fun calendarCommandsQueryRealRepositoryAndRejectExternalWrites() = runBlocking<Unit> {
        val start = System.currentTimeMillis() + 3600000
        val created = app.organizer.command("calendar_create_event", buildJsonObject {
            put("title", "Calendar fixture"); put("start", iso(start)); put("end", iso(start + 3600000)); put("timeZone", "Australia/Sydney")
        })
        val queried = app.organizer.command("calendar_list_events", buildJsonObject { put("start", iso(start - 1000)); put("end", iso(start + 7200000)); put("query", "Calendar fixture") })
        assertEquals(1, queried.getValue("events").jsonArray.size)
        assertTrue(runCatching { app.organizer.command("calendar_update_event", buildJsonObject { put("id", "system:123"); put("title", "do not overwrite") }) }.isFailure)
        val reread = OrganizerRepository(app)
        reread.initialize()
        assertEquals(created.text("id"), reread.data.value.core.events.single().id)
        app.organizer.command("calendar_delete_event", buildJsonObject { put("id", created.text("id")) })
        assertTrue(app.organizer.data.value.core.events.isEmpty())
    }
    @Test fun nativeChatOffersOrganizerToolsEveryWorkRoundAndReturnsActualReceipt() = runBlocking<Unit> {
        var work = 0; var checks = 0
        MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val body = MeloJson.parseToJsonElement(request.body.readUtf8()).jsonObject
                    fun text(value: String) = MockResponse().setBody(buildJsonObject { put("model", "fixture"); put("choices", buildJsonArray { add(buildJsonObject { put("message", buildJsonObject { put("role", "assistant"); put("content", value) }); put("finish_reason", "stop") }) }) }.toString())
                    if (body.toString().contains("You are Melo's task completion checker")) {
                        checks++; assertTrue((body["tools"] as? JsonArray).isNullOrEmpty())
                        return text("""{"decision":"complete","reasonType":"fulfilled","reason":"Todo persisted","nextStep":"","requirements":[{"text":"Create todo","status":"met","evidenceIds":["create-todo"]}]}""")
                    }
                    val names = body.getValue("tools").jsonArray.map { it.jsonObject.getValue("function").jsonObject.text("name") }
                    assertTrue(names.containsAll(listOf("todo_list", "todo_create", "todo_update", "todo_complete", "todo_delete", "calendar_list_events", "calendar_create_event", "calendar_update_event", "calendar_delete_event")))
                    assertFalse(names.contains("phone_use")); work++
                    if (work > 1) { assertTrue(body.toString().contains("reminderScheduling")); return text("Todo saved in Melo; no reminder time was requested.") }
                    return MockResponse().setBody("""{"model":"fixture","choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"id":"create-todo","type":"function","function":{"name":"todo_create","arguments":"{\"title\":\"Chat fixture\"}"}}]}}]}""")
                }
            }
            server.start()
            val result = SharedChatAgent(app, ModelClient(true), true).reply(
                connection = Connection(endpoint = server.url("/chat").toString(), model = "fixture", stream = false), key = "fixture-local-only",
                messages = listOf(Message(role = "user", content = "Create a todo named Chat fixture")), instructions = "Local fixture, do not operate the phone.",
                config = buildJsonObject {}, searchCredential = { "" }, phoneEnabled = false, runId = newId(), chatId = "fixture-organizer",
                imageData = { "" }, invokePhone = { DeviceToolResult.error("not allowed", "NOT_ALLOWED") }, onPhase = {}
            )
            assertEquals("completed", result.outcome); assertEquals(2, work); assertEquals(1, checks)
            assertEquals("Chat fixture", app.organizer.data.value.core.todos.single().title)
        }
    }
}
