package com.melo.android.organizer

import android.content.ContentUris
import android.content.Intent
import android.provider.CalendarContract
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.melo.android.data.*
import com.melo.android.ui.*
import kotlinx.serialization.json.*
import java.time.*

@Composable fun TodoScreen(repository: OrganizerRepository) {
    val state by repository.data.collectAsState()
    var filter by rememberSaveable { mutableStateOf("today") }
    var query by rememberSaveable { mutableStateOf("") }
    var editing by rememberSaveable { mutableStateOf(false) }
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    var deleting by rememberSaveable { mutableStateOf<String?>(null) }
    val today = LocalDate.now(); val zone = ZoneId.systemDefault()
    val rows = state.core.todos.filter { row ->
        val date = row.dueAt?.let { Instant.ofEpochMilli(it).atZone(zone).toLocalDate() }
        (row.title + " " + row.notes).contains(query, true) && when (filter) { "today" -> !row.completed && date != null && date <= today; "upcoming" -> !row.completed && date != null && date > today; "completed" -> row.completed; else -> true }
    }.sortedWith(compareBy<TodoItem> { it.completed }.thenBy { it.dueAt ?: Long.MAX_VALUE }.thenBy { it.createdAt })
    LazyColumn(Modifier.fillMaxSize().testTag("todo-page"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("待办", style = MaterialTheme.typography.headlineMedium); Button(onClick = { selected = null; editing = true }) { Text("新建待办") } } }
        item { Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) { listOf("today" to "今天", "upcoming" to "即将到期", "all" to "全部", "completed" to "已完成").forEach { (value, label) -> FilterChip(filter == value, { filter = value }, label = { Text(label) }) } } }
        item { OutlinedTextField(query, { query = it }, label = { Text("搜索待办") }, modifier = Modifier.fillMaxWidth(), singleLine = true) }
        if (rows.isEmpty()) item { Text("此视图暂无待办。无日期事项可以在“全部”查看。", color = MeloMuted) }
        items(rows, key = { it.id }) { todo ->
            Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(todo.completed, { done -> repository.work { repository.command("todo_complete", buildJsonObject { put("id", todo.id); put("completed", done) }) } })
                    Column(Modifier.weight(1f).clickable { selected = todo.id; editing = true }) { Text(todo.title, style = MaterialTheme.typography.titleMedium); Text("到期：" + formatOrganizerTime(todo.dueAt), color = MeloMuted, style = MaterialTheme.typography.bodySmall) }
                    IconButton(onClick = { selected = todo.id; editing = true }) { Icon(Icons.Outlined.Edit, "编辑待办") }
                    IconButton(onClick = { deleting = todo.id }) { Icon(Icons.Outlined.DeleteOutline, "删除待办") }
                }
                if (todo.notes.isNotBlank()) Text(todo.notes)
                if (todo.remindAt != null) {
                    val delivery = state.deliveries.lastOrNull { it.key == "todo:${todo.id}" && it.revision == todo.revision }
                    Text((if (todo.reminderMode == "alarm") "强提醒 " else "提醒 ") + formatOrganizerTime(delivery?.snoozeUntil ?: todo.remindAt) + " · " + reminderStatus(todo, state, repository.reminders.capability()), style = MaterialTheme.typography.bodySmall, color = MeloMuted)
                }
            } }
        }
        item { HorizontalDivider(); ReminderPermissions(repository) }
        item { OrganizerErrors(repository) }
    }
    if (editing) OrganizerEditor(repository, "todo", selected) { editing = false }
    deleting?.let { id -> AlertDialog(onDismissRequest = { deleting = null }, title = { Text("删除此待办？") }, text = { Text("关联提醒也会取消。") }, confirmButton = { TextButton(onClick = { repository.work { repository.command("todo_delete", buildJsonObject { put("id", id) }); deleting = null } }) { Text("删除") } }, dismissButton = { TextButton(onClick = { deleting = null }) { Text("取消") } }) }
}
private fun reminderStatus(todo: TodoItem, state: OrganizerData, capability: ReminderEngine.Capability): String {
    if (todo.completed) return "已完成，提醒已取消"
    if (!capability.notifications || !(if (todo.reminderMode == "alarm") capability.alarmChannel else capability.normalChannel)) return "通知未开启"
    val delivery = state.deliveries.lastOrNull { it.key == "todo:${todo.id}" && it.revision == todo.revision }
    return when (delivery?.status) { "posted" -> "通知已发出"; "ringing" -> "正在响铃"; "snoozed" -> "稍后提醒"; "acknowledged" -> "提醒已关闭"; "missed", "timed_out" -> "提醒已错过或超时"; "notifications_blocked" -> "通知被系统阻止"; else -> if (state.planned.any { it.ownerId == todo.id }) if (capability.exact) "已排程" else "已排程，可能延后" else if (todo.remindAt!! < System.currentTimeMillis()) "已过提醒时间" else "待排程（最多提前排程 64 项）" }
}

@Composable fun CalendarScreen(repository: OrganizerRepository) {
    val state by repository.data.collectAsState()
    val context = LocalContext.current
    var dayText by rememberSaveable { mutableStateOf(LocalDate.now().toString()) }
    var monthText by rememberSaveable { mutableStateOf(YearMonth.now().toString()) }
    var editing by rememberSaveable { mutableStateOf(false) }
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    var sources by rememberSaveable { mutableStateOf(false) }
    var deleting by rememberSaveable { mutableStateOf<String?>(null) }
    var sourceFilter by rememberSaveable { mutableStateOf("all") }
    val day = LocalDate.parse(dayText); val month = YearMonth.parse(monthText); val zone = ZoneId.systemDefault()
    val start = day.atStartOfDay(zone).toInstant().toEpochMilli(); val end = day.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
    val rows = remember(state, dayText, sourceFilter) { repository.occurrences(start, end).filter { sourceFilter == "all" || it.sourceId == sourceFilter } }
    LazyColumn(Modifier.fillMaxSize().testTag("calendar-page"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("日历", style = MaterialTheme.typography.headlineMedium); Row { TextButton(onClick = { sources = true }) { Text("来源") }; Button(onClick = { selected = null; editing = true }) { Text("新建日程") } } } }
        item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { monthText = month.minusMonths(1).toString() }) { Text("上月") }; Text(monthText, style = MaterialTheme.typography.titleLarge); TextButton(onClick = { monthText = month.plusMonths(1).toString() }) { Text("下月") }; TextButton(onClick = { monthText = YearMonth.now().toString(); dayText = LocalDate.now().toString() }) { Text("今天") }
        } }
        item { Row { listOf("一", "二", "三", "四", "五", "六", "日").forEach { Text(it, Modifier.weight(1f), textAlign = androidx.compose.ui.text.style.TextAlign.Center, color = MeloMuted) } } }
        val offset = month.atDay(1).dayOfWeek.value - 1
        items((offset + month.lengthOfMonth() + 6) / 7) { week ->
            Row(Modifier.fillMaxWidth()) { repeat(7) { column ->
                val number = week * 7 + column - offset + 1
                Box(Modifier.weight(1f).height(44.dp), contentAlignment = Alignment.Center) {
                    if (number in 1..month.lengthOfMonth()) TextButton(onClick = { dayText = month.atDay(number).toString() }, colors = ButtonDefaults.textButtonColors(contentColor = if (day == month.atDay(number)) MeloGold else MeloText), contentPadding = PaddingValues(0.dp)) { Text(if (day == month.atDay(number)) "[$number]" else "$number") }
                }
            } }
        }
        item { Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            (listOf("all" to "全部", "melo" to "Melo") + state.sources.filter { it.enabled }.map { it.id to it.name }).forEach { (id, label) -> FilterChip(sourceFilter == id, { sourceFilter = id }, label = { Text(label) }) }
        } }
        item { Text(dayText + " · " + rows.size + " 项日程", style = MaterialTheme.typography.titleMedium) }
        if (rows.isEmpty()) item { Text("当天暂无已载入日程。", color = MeloMuted) }
        items(rows, key = { it.id }) { occurrence ->
            Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(occurrence.title, style = MaterialTheme.typography.titleMedium)
                Text(if (occurrence.allDay) "全天" else formatOrganizerTime(occurrence.startAt) + " — " + formatOrganizerTime(occurrence.endAt), color = MeloMuted)
                Text(if (occurrence.sourceId == "melo") "Melo" else (state.sources.find { it.id == occurrence.sourceId }?.name ?: "外部日历") + " · 只读", style = MaterialTheme.typography.bodySmall)
                state.core.events.find { it.id == occurrence.eventId }?.let { local ->
                    local.remindAt?.let { reminder -> Text((if (local.reminderMode == "alarm") "强提醒：" else "提醒：") + formatOrganizerTime(occurrence.startAt - (local.startAt - reminder)), style = MaterialTheme.typography.bodySmall, color = MeloMuted) }
                }
                if (occurrence.location.isNotBlank()) Text(occurrence.location)
                if (occurrence.notes.isNotBlank()) Text(occurrence.notes)
                Row {
                    if (occurrence.sourceId == "melo") {
                        TextButton(onClick = { selected = occurrence.eventId; editing = true }) { Text("编辑系列") }
                        TextButton(onClick = { deleting = occurrence.eventId }) { Text("删除系列") }
                    } else if (occurrence.systemEventId != null) TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, occurrence.systemEventId))) }) { Text("在系统日历打开") }
                }
            } }
        }
        item { TextButton(onClick = { repository.work { repository.refresh() } }) { Text("刷新日历") }; Text("订阅缓存覆盖过去 90 天至未来 180 天；范围外请查看来源日历。", color = MeloMuted, style = MaterialTheme.typography.bodySmall) }
        state.sources.filter { it.lastError != null }.forEach { source -> item(key = "error:" + source.id) { Text(source.name + "：" + source.lastError, color = MaterialTheme.colorScheme.error) } }
        item { HorizontalDivider(); ReminderPermissions(repository); OrganizerErrors(repository) }
    }
    if (editing) OrganizerEditor(repository, "calendar", selected) { editing = false }
    if (sources) OrganizerSources(repository) { sources = false }
    deleting?.let { id -> AlertDialog(onDismissRequest = { deleting = null }, title = { Text("删除整个日程系列？") }, text = { Text("该系列的 Melo 提醒也会取消。") }, confirmButton = { TextButton(onClick = { repository.work { repository.command("calendar_delete_event", buildJsonObject { put("id", id) }); deleting = null } }) { Text("删除") } }, dismissButton = { TextButton(onClick = { deleting = null }) { Text("取消") } }) }
}
@Composable private fun OrganizerErrors(repository: OrganizerRepository) { val error by repository.error.collectAsState(); error?.let { Text(it, color = MaterialTheme.colorScheme.error); TextButton(onClick = { repository.error.value = null }) { Text("知道了") } } }
