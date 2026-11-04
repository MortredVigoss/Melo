package com.melo.android.organizer

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.melo.android.data.*
import kotlinx.serialization.json.*
import kotlinx.coroutines.launch
import java.time.*
import java.time.format.DateTimeFormatter

fun formatOrganizerTime(at: Long?, zone: ZoneId = ZoneId.systemDefault()): String = at?.let { Instant.ofEpochMilli(it).atZone(zone).format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")) } ?: "未设置"
fun iso(at: Long) = Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault()).toOffsetDateTime().toString()
@Composable internal fun TimeField(label: String, value: Long?, onChange: (Long?) -> Unit, clearable: Boolean = true, dateOnly: Boolean = false) {
    val context = LocalContext.current
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        TextButton(onClick = {
            val current = Instant.ofEpochMilli(value ?: (System.currentTimeMillis() + 3600000)).atZone(ZoneId.systemDefault())
            DatePickerDialog(context, { _, y, m, day ->
                val date = LocalDate.of(y, m + 1, day)
                if (dateOnly) onChange(date.atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()) else TimePickerDialog(context, { _, h, minute -> onChange(date.atTime(h, minute).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()) }, current.hour, current.minute, true).show()
            }, current.year, current.monthValue - 1, current.dayOfMonth).show()
        }) { Text(label + "：" + formatOrganizerTime(value)) }
        if (clearable && value != null) TextButton(onClick = { onChange(null) }) { Text("清除") }
    }
}

@Composable fun OrganizerEditor(repository: OrganizerRepository, kind: String, recordId: String?, onDismiss: () -> Unit) {
    val state by repository.data.collectAsState()
    val todo = state.core.todos.find { it.id == recordId }; val event = state.core.events.find { it.id == recordId }
    val isTodo = kind == "todo"
    var title by rememberSaveable(recordId) { mutableStateOf(todo?.title ?: event?.title.orEmpty()) }
    var notes by rememberSaveable(recordId) { mutableStateOf(todo?.notes ?: event?.notes.orEmpty()) }
    var due by rememberSaveable(recordId) { mutableStateOf(todo?.dueAt ?: -1L) }
    var remind by rememberSaveable(recordId) { mutableStateOf(todo?.remindAt ?: event?.remindAt ?: -1L) }
    var mode by rememberSaveable(recordId) { mutableStateOf(todo?.reminderMode ?: event?.reminderMode ?: "notification") }
    var start by rememberSaveable(recordId) { mutableStateOf(event?.startAt ?: (System.currentTimeMillis() + 3600000)) }
    var end by rememberSaveable(recordId) { mutableStateOf(event?.endAt ?: (System.currentTimeMillis() + 7200000)) }
    var allDay by rememberSaveable(recordId) { mutableStateOf(event?.allDay ?: false) }
    var location by rememberSaveable(recordId) { mutableStateOf(event?.location.orEmpty()) }
    var zoneText by rememberSaveable(recordId) { mutableStateOf(event?.timeZone ?: ZoneId.systemDefault().id) }
    var repeat by rememberSaveable(recordId) { mutableStateOf(event?.repeat ?: "none") }
    var repeatUntil by rememberSaveable(recordId) { mutableStateOf(event?.repeatUntil ?: -1L) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    AlertDialog(onDismissRequest = { if (!saving) onDismiss() }, title = { Text((if (recordId == null) "新建" else "编辑") + if (isTodo) "待办" else "日程（整个系列）") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(title, { title = it }, label = { Text("标题") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            OutlinedTextField(notes, { notes = it }, label = { Text("备注") }, modifier = Modifier.fillMaxWidth(), maxLines = 4)
            if (isTodo) TimeField("到期", due.takeIf { it >= 0 }, { due = it ?: -1 }) else {
                Row { Checkbox(allDay, { allDay = it; if (it) { end = Instant.ofEpochMilli(start).atZone(ZoneId.systemDefault()).toLocalDate().plusDays(1).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli() } }); Text("全天", Modifier.padding(top = 12.dp)) }
                TimeField("开始", start, { if (it != null) { val duration = (end - start).coerceAtLeast(3600000); start = it; end = it + duration } }, false, allDay)
                TimeField(if (allDay) "结束（不含当天）" else "结束", end, { if (it != null) end = it }, false, allDay)
                OutlinedTextField(zoneText, { zoneText = it }, label = { Text("时区，例如 Australia/Sydney") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                OutlinedTextField(location, { location = it }, label = { Text("地点") }, modifier = Modifier.fillMaxWidth())
                Text("时间按手机当前时区填写；重复周期使用上方日程时区。", style = MaterialTheme.typography.bodySmall)
                Text("重复")
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { listOf("none" to "无", "daily" to "每天", "weekly" to "每周", "monthly" to "每月").forEach { (value, label) -> FilterChip(repeat == value, { repeat = value }, label = { Text(label) }) } }
                if (repeat != "none") TimeField("重复截止（可选）", repeatUntil.takeIf { it >= 0 }, { repeatUntil = it ?: -1 })
            }
            TimeField("提醒", remind.takeIf { it >= 0 }, { remind = it ?: -1 })
            if (remind >= 0) {
                Row { Checkbox(mode == "alarm", { mode = if (it) "alarm" else "notification" }); Text("闹钟式强提醒", Modifier.padding(top = 12.dp)) }
                Text("普通提醒遵从系统通知设置；强提醒需开启精准闹钟，锁屏弹出还需全屏提醒权限。", style = MaterialTheme.typography.bodySmall)
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }, confirmButton = { TextButton(enabled = !saving && title.isNotBlank(), onClick = {
        saving = true; error = null
        scope.launch {
            try {
                val zone = ZoneId.of(zoneText)
                fun midnight(at: Long) = Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault()).toLocalDate().atStartOfDay(zone).toInstant().toEpochMilli()
                val args = buildJsonObject {
                    recordId?.let { put("id", it) }; put("title", title); put("notes", notes); put("remindAt", if (remind >= 0) iso(remind) else ""); put("reminderMode", mode)
                    if (isTodo) put("due", if (due >= 0) iso(due) else "") else {
                        put("start", iso(if (allDay) midnight(start) else start)); put("end", iso(if (allDay) midnight(end) else end)); put("timeZone", zone.id); put("allDay", allDay); put("location", location); put("repeat", repeat); put("repeatUntil", if (repeatUntil >= 0 && repeat != "none") iso(repeatUntil) else "")
                    }
                }
                repository.command(if (isTodo) if (recordId == null) "todo_create" else "todo_update" else if (recordId == null) "calendar_create_event" else "calendar_update_event", args)
                onDismiss()
            } catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; error = e.message; saving = false }
        }
    }) { Text(if (saving) "保存中…" else "保存") } }, dismissButton = { TextButton(enabled = !saving, onClick = onDismiss) { Text("取消") } })
}
