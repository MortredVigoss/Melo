package com.melo.android.pet

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.melo.android.MeloApplication
import com.melo.android.data.AppData
import com.melo.android.ui.MeloGold
import com.melo.android.ui.MeloMuted

private fun Context.granted(permission: String) = checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
private fun Context.ignoringBatteryOptimizations() = getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)

/** 「系统 → 桌宠」: the switch, permissions, skin, size, spontaneous actions, speech and background guidance. */
@Composable fun PetSettingsScreen(data: AppData, onChat: (String) -> Unit) {
    val context = LocalContext.current
    val app = context.applicationContext as MeloApplication
    val preferences = app.petPreferences
    val settings by preferences.settings.collectAsStateWithLifecycle()
    val overlay by PetOverlayService.state.collectAsStateWithLifecycle()
    val catalog = remember { runCatching { PetCatalog.load(context) }.getOrNull() }
    var overlayGranted by remember { mutableStateOf(PetOverlayService.canDraw(context)) }
    var microphoneGranted by remember { mutableStateOf(context.granted(Manifest.permission.RECORD_AUDIO)) }
    var notificationsGranted by remember { mutableStateOf(Build.VERSION.SDK_INT < 33 || context.granted(Manifest.permission.POST_NOTIFICATIONS)) }
    var batteryUnrestricted by remember { mutableStateOf(context.ignoringBatteryOptimizations()) }
    var pendingEnable by rememberSaveable { mutableStateOf(false) }
    var sizeDp by remember(settings.sizeDp) { mutableFloatStateOf(settings.sizeDp.toFloat()) }
    var restSeconds by remember(settings.restSeconds) { mutableFloatStateOf(settings.restSeconds.toFloat()) }
    val microphone = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { microphoneGranted = it }
    val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { notificationsGranted = it }
    fun refresh() {
        overlayGranted = PetOverlayService.canDraw(context); microphoneGranted = context.granted(Manifest.permission.RECORD_AUDIO)
        notificationsGranted = Build.VERSION.SDK_INT < 33 || context.granted(Manifest.permission.POST_NOTIFICATIONS); batteryUnrestricted = context.ignoringBatteryOptimizations()
    }
    fun enable() { preferences.update { it.copy(enabled = true) }; PetOverlayService.start(context) }
    fun requestEnable() {
        if (!overlayGranted) {
            pendingEnable = true
            runCatching { context.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}"))) }
            return
        }
        if (!notificationsGranted) notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        if (!microphoneGranted) microphone.launch(Manifest.permission.RECORD_AUDIO)
        enable()
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        refresh()
        if (pendingEnable && overlayGranted) { pendingEnable = false; requestEnable() }
    }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp).testTag("pet-settings"), contentPadding = PaddingValues(bottom = 30.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("桌宠", style = MaterialTheme.typography.headlineSmall, color = MeloGold)
            Text("金冬天或大肥鱼常驻在其他 App 上面：拖动移动，单击换动作，双击说话（回复由 Melo 生成并朗读），长按打开菜单。Melo 退到后台也会留在屏幕上，直到你在这里关闭。", color = MeloMuted)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("显示桌宠", Modifier.weight(1f))
                Switch(settings.enabled, { selected -> if (selected) requestEnable() else { preferences.update { it.copy(enabled = false) }; PetOverlayService.stop(context) } }, Modifier.testTag("pet-enabled"), enabled = catalog != null)
            }
            if (catalog == null) Text("这个安装包没有打包桌宠素材。", color = MaterialTheme.colorScheme.error)
            Text(when {
                settings.enabled && overlay.attached -> "${catalog?.skin(settings.skin)?.name ?: "桌宠"}已在屏幕上 · 当前动作「${overlay.clip}」"
                settings.enabled -> "正在启动…"
                else -> "已关闭"
            }, color = MeloGold)
            if (overlay.error.isNotBlank()) Text(overlay.error, color = MaterialTheme.colorScheme.error)
        }
        item {
            Text("权限", style = MaterialTheme.typography.titleMedium, color = MeloGold)
            PermissionRow("显示在其他应用上层", overlayGranted, "必需；用于悬浮窗") { runCatching { context.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}"))) } }
            PermissionRow("通知", notificationsGranted, "常驻服务的通知，可以静音") { if (Build.VERSION.SDK_INT >= 33) notifications.launch(Manifest.permission.POST_NOTIFICATIONS) }
            PermissionRow("麦克风", microphoneGranted, "双击桌宠说话时使用系统语音识别") { microphone.launch(Manifest.permission.RECORD_AUDIO) }
            Text("锁屏时系统不允许悬浮窗显示，解锁后桌宠会自动回来。", color = MeloMuted)
        }
        item {
            Text("皮肤", style = MaterialTheme.typography.titleMedium, color = MeloGold)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                (catalog?.skins?.values?.sortedBy { it.id != "fish" } ?: emptyList()).forEach { skin ->
                    FilterChip(selected = settings.skin == skin.id, onClick = { preferences.update { it.copy(skin = skin.id) } }, label = { Text(skin.name) }, modifier = Modifier.testTag("pet-skin-${skin.id}"))
                }
            }
            catalog?.let { Text("${it.skins.values.sumOf { skin -> skin.clipCount }} 段动作 · ${"%.0f".format(it.skins.values.sumOf { skin -> skin.totalBytes } / 1048576.0)} MB · ${it.stage.width}×${it.stage.height}", color = MeloMuted, style = MaterialTheme.typography.bodySmall) }
            Text("大小 ${sizeDp.toInt()} dp")
            Slider(value = sizeDp, onValueChange = { sizeDp = it }, onValueChangeFinished = { preferences.update { it.copy(sizeDp = sizeDp.toInt()) } }, valueRange = PetSettings.MIN_SIZE_DP.toFloat()..PetSettings.MAX_SIZE_DP.toFloat(), steps = 10, modifier = Modifier.testTag("pet-size"))
        }
        item {
            Text("自动动作", style = MaterialTheme.typography.titleMedium, color = MeloGold)
            Row(verticalAlignment = Alignment.CenterVertically) { Text("没人碰她时随机做动作", Modifier.weight(1f)); Switch(settings.autoActions, { selected -> preferences.update { it.copy(autoActions = selected) } }, Modifier.testTag("pet-auto")) }
            Text("每个动作之后休息 ${restSeconds.toInt()}–${restSeconds.toInt() * 2} 秒再抽下一个；休息期间只播待机。")
            Slider(value = restSeconds, onValueChange = { restSeconds = it }, onValueChangeFinished = { preferences.update { it.copy(restSeconds = restSeconds.toInt()) } }, valueRange = PetSettings.MIN_REST_SECONDS.toFloat()..PetSettings.MAX_REST_SECONDS.toFloat(), steps = 16, enabled = settings.autoActions)
        }
        item {
            Text("语音", style = MaterialTheme.typography.titleMedium, color = MeloGold)
            Text("识别语言", color = MeloMuted)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.horizontalScroll(rememberScrollState())) {
                PetSettings.LANGUAGES.forEach { (tag, label) -> FilterChip(selected = settings.speechLanguage == tag, onClick = { preferences.update { it.copy(speechLanguage = tag) } }, label = { Text(label) }) }
            }
            Row(verticalAlignment = Alignment.CenterVertically) { Text("朗读 Melo 的回复", Modifier.weight(1f)); Switch(settings.speakReplies, { selected -> preferences.update { it.copy(speakReplies = selected) } }, Modifier.testTag("pet-speak")) }
            Text("使用系统语音识别与系统朗读；识别结果发到专用的「桌宠」对话，用当前默认模型连接。长回复只在气泡显示开头，全文在对话里。朗读时再单击可停止。", color = MeloMuted)
            val chat = PetChat.existing(data, settings.chatId)
            if (chat != null) TextButton(onClick = { onChat(chat.id) }) { Text("打开桌宠对话 · ${chat.messages.size} 条消息") }
            else Text("第一次双击说话时会自动创建「桌宠」对话。", color = MeloMuted)
            if (data.settings.connections.isEmpty()) Text("还没有模型连接：先在「系统 → 模型连接」添加，桌宠才能回复。", color = MaterialTheme.colorScheme.error)
        }
        item {
            Text("后台运行", style = MaterialTheme.typography.titleMedium, color = MeloGold)
            Text("三星 One UI 的省电策略可能在后台关闭桌宠。允许 Melo 不受电池优化限制，并在应用信息的「电池」里选择「不受限制」。", color = MeloMuted)
            Text(if (batteryUnrestricted) "电池优化：已允许后台运行" else "电池优化：仍受限制", color = MeloGold)
            Row {
                TextButton(onClick = { runCatching { context.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))) } }) { Text("允许后台运行") }
                TextButton(onClick = { runCatching { context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))) } }) { Text("应用信息") }
            }
            catalog?.let { Text("素材：${it.skins.values.joinToString(" · ") { skin -> "${skin.name} ${skin.sourceRevision}" }}", color = MeloMuted, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

@Composable private fun PermissionRow(label: String, granted: Boolean, detail: String, request: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) { Text(label); Text(detail, color = MeloMuted, style = MaterialTheme.typography.bodySmall) }
        if (granted) Text("已允许", color = MeloGold) else TextButton(onClick = request) { Text("去授权") }
    }
}

