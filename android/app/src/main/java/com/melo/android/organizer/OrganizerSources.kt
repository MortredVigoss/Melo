package com.melo.android.organizer

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.melo.android.ui.MeloMuted

@Composable internal fun ReminderPermissions(repository: OrganizerRepository) {
    val context = LocalContext.current
    var tick by remember { mutableIntStateOf(0) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { tick++; repository.work { repository.reminders.reconcile() } }
    val capability = remember(tick) { repository.reminders.capability() }
    androidx.lifecycle.compose.LifecycleResumeEffect(Unit) { tick++; repository.work { repository.reminders.reconcile() }; onPauseOrDispose {} }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text("提醒设置", style = MaterialTheme.typography.titleSmall)
        Text("通知 ${if (capability.notifications) "已开启" else "未开启"} · 精准闹钟 ${if (capability.exact) "已开启" else "未开启"} · 锁屏全屏 ${if (capability.fullScreen) "已开启" else "未开启"}", style = MaterialTheme.typography.bodySmall, color = MeloMuted)
        if (!capability.normalChannel || !capability.alarmChannel) Text("有提醒通知类别被系统关闭。", color = MaterialTheme.colorScheme.error)
        Row {
            TextButton(onClick = { if (Build.VERSION.SDK_INT >= 33 && !capability.notifications) permission.launch(Manifest.permission.POST_NOTIFICATIONS) else context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)) }) { Text("通知") }
            if (Build.VERSION.SDK_INT >= 31) TextButton(onClick = { context.startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + context.packageName))) }) { Text("精准闹钟") }
            if (Build.VERSION.SDK_INT >= 34) TextButton(onClick = { context.startActivity(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + context.packageName))) }) { Text("全屏提醒") }
        }
        if (!capability.exact) Text("未开启精准闹钟，提醒可能延后。", style = MaterialTheme.typography.bodySmall)
        Text("强提醒最长响铃 2 分钟，遵从系统勿扰；设备关机或应用被强制停止时无法保证送达。", style = MaterialTheme.typography.bodySmall, color = MeloMuted)
    }
}

@Composable fun OrganizerSources(repository: OrganizerRepository, onDismiss: () -> Unit) {
    val state by repository.data.collectAsState()
    val context = LocalContext.current
    var name by rememberSaveable { mutableStateOf("") }
    // Subscription URLs may contain secrets. Keep them in memory, never saved instance state.
    var url by remember { mutableStateOf("") }
    var available by remember { mutableStateOf<List<CalendarSource>>(emptyList()) }
    var deleting by remember { mutableStateOf<CalendarSource?>(null) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed -> if (allowed) repository.work { available = repository.systemSources() } }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("日历来源") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Melo 自建日程可编辑；系统与订阅日程只读。")
            Button(onClick = { if (!repository.systemAllowed()) permission.launch(Manifest.permission.READ_CALENDAR) else repository.work { available = repository.systemSources() } }) { Text("选择手机系统日历") }
            Text("Samsung / Google / Exchange 等账号需已同步到手机系统日历；仅安装 App 不一定可见。", style = MaterialTheme.typography.bodySmall)
            available.filter { candidate -> state.sources.none { it.id == candidate.id } }.forEach { source -> TextButton(onClick = { repository.work { repository.addSystem(source) } }) { Text("添加 " + source.name) } }
            HorizontalDivider()
            OutlinedTextField(name, { name = it }, label = { Text("订阅名称") }, singleLine = true)
            OutlinedTextField(url, { url = it }, label = { Text("HTTPS / webcal ICS 链接") }, singleLine = true, visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation())
            Button(enabled = name.isNotBlank() && url.isNotBlank(), onClick = { val n = name; val u = url; repository.work { repository.subscribe(n, u); name = ""; url = "" } }) { Text("添加 ICS 订阅") }
            Text("后台定期刷新，可能因系统省电延后；刷新失败保留上次日程。", style = MaterialTheme.typography.bodySmall)
            state.sources.forEach { source ->
                Card { Column(Modifier.padding(12.dp)) {
                    Text(source.name, style = MaterialTheme.typography.titleSmall, color = androidx.compose.ui.graphics.Color(source.color.toInt()))
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        listOf(0xFFD1B27D to "金", 0xFF91B3BB to "蓝", 0xFFC99A9A to "红", 0xFF9FB59E to "绿", 0xFFB3A1C5 to "紫").forEach { (color, label) -> FilterChip(source.color == color, { repository.work { repository.editSource(source.copy(color = color)) } }, label = { Text(label) }) }
                    }
                    Row { Switch(source.enabled, { enabled -> repository.work { repository.editSource(source.copy(enabled = enabled)) } }); Text("显示来源", Modifier.padding(12.dp)) }
                    Row { Checkbox(source.reminders, { enabled -> repository.work { repository.editSource(source.copy(reminders = enabled)) } }); Text("由 Melo 提前 10 分钟通知", Modifier.padding(top = 12.dp)) }
                    if (source.reminders) Row { Checkbox(source.reminderMode == "alarm", { alarm -> repository.work { repository.editSource(source.copy(reminderMode = if (alarm) "alarm" else "notification")) } }); Text("闹钟式提醒", Modifier.padding(top = 12.dp)) }
                    Text("上次刷新：" + formatOrganizerTime(source.lastRefresh), style = MaterialTheme.typography.bodySmall)
                    source.lastError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    Row { TextButton(onClick = { repository.work { repository.refresh() } }) { Text("刷新") }; TextButton(onClick = { deleting = source }) { Text("移除订阅") } }
                } }
            }
        }
    }, confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } })
    deleting?.let { source -> AlertDialog(onDismissRequest = { deleting = null }, title = { Text("移除 " + source.name + "？") }, text = { Text("只移除此设备副本及 Melo 提醒，不删除远端日程。") }, confirmButton = { TextButton(onClick = { repository.work { repository.removeSource(source.id); deleting = null } }) { Text("移除") } }, dismissButton = { TextButton(onClick = { deleting = null }) { Text("取消") } }) }
}
