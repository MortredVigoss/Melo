package com.melo.android.device

import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.*
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import com.melo.android.MeloApplication
import com.melo.android.data.AppData
import com.melo.android.ui.*

@Composable fun DeviceAgentScreen(data: AppData) {
    val context = LocalContext.current
    val agent = (context.applicationContext as MeloApplication).deviceAgent
    val runtime by agent.runtime.collectAsStateWithLifecycle()
    val connected by DeviceAccess.connected.collectAsStateWithLifecycle()
    var goal by rememberSaveable { mutableStateOf("") }
    var screenshots by rememberSaveable { mutableStateOf(true) }
    var forceProbe by rememberSaveable { mutableStateOf(false) }
    var scriptLibrary by remember { mutableStateOf(false) }
    var displayId by rememberSaveable { mutableIntStateOf(0) }
    var displays by remember { mutableStateOf(emptyList<Pair<Int, String>>()) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { displays = DeviceAccess.service?.displays().orEmpty() }
    LaunchedEffect(connected) { displays = DeviceAccess.service?.displays().orEmpty() }
    val connection = data.settings.connections.find { it.id == data.settings.activeConnection }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp), contentPadding = PaddingValues(bottom = 30.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("手机助手", style = MaterialTheme.typography.headlineSmall, color = MeloGold)
            Text("按目标优先查找操作缓存；未命中时由模型探索，验证成功后自动缓存。", color = MeloMuted)
            TextButton(onClick = { scriptLibrary = true }) { Text("操作缓存 · ${data.deviceScripts.size}") }
            Text(if (connected) "Accessibility Service 已连接" else "需要启用 Accessibility Service", color = MeloGold)
            TextButton(onClick = { context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }, enabled = !runtime.running) { Text("打开系统辅助功能设置") }
            Text("在「已安装的应用 / 服务」中找到「Melo 手机助手」并启用，然后返回这里。", color = MeloMuted)
        }
        item {
            Text("当前模型：${connection?.name ?: "未选择"} · ${connection?.model.orEmpty()}")
            Text("使用「系统 → 模型连接」中的全局选择。服务需要支持 Tool Calling；启用截图还需要支持图片输入。", color = MeloMuted)
            if (displays.size > 1) { Text("操作屏幕"); displays.forEach { (id, label) -> FilterChip(displayId == id, { displayId = id }, label = { Text(label) }, enabled = !runtime.running) } }
            OutlinedTextField(goal, { goal = it }, label = { Text("希望手机帮你做什么？") }, placeholder = { Text("例如：打开设置，搜索蓝牙，停在搜索结果页面") }, minLines = 3, maxLines = 6, modifier = Modifier.fillMaxWidth().testTag("device-goal"), enabled = !runtime.running)
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) { Text("向模型提供截图", Modifier.weight(1f)); Switch(screenshots, { screenshots = it }, enabled = !runtime.running) }
            FilterChip(forceProbe, { forceProbe = !forceProbe }, label = { Text("强制 Probe") }, enabled = !runtime.running)
            Text("缓存命中使用本机步骤。Similar 发送目标和候选脚本；Probe 才提供当前 Display 的界面文字${if (screenshots) "和截图" else ""}。可随时点击悬浮「停止 Melo」。Probe 最多 30 步、脚本最多 60 步，每次 10 分钟。", color = MeloMuted)
            Button(onClick = { if (runtime.running) agent.cancel() else agent.start(goal, displayId, screenshots, forceProbe = forceProbe) }, enabled = runtime.running || connected && goal.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
                Text(if (runtime.running) "停止执行" else "开始执行")
            }
            if (runtime.running) { LinearProgressIndicator(Modifier.fillMaxWidth()); Text(runtime.phase, color = MeloGold) }
        }
        item { Text("执行记录", style = MaterialTheme.typography.titleMedium, color = MeloGold) }
        items(data.deviceRuns.asReversed(), key = { it.id }) { run ->
            ElevatedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(run.goal, style = MaterialTheme.typography.titleMedium)
                Text("${deviceStatus(run.status)} · ${run.connectionName} · ${run.steps.size} 步", color = MeloMuted)
                Text(deviceRunMode(run.executionMode) + (run.modelRequests?.let { " · 模型请求 $it 次" } ?: ""), color = MeloMuted)
                if (run.cacheNote.isNotBlank()) Text(run.cacheNote, style = MaterialTheme.typography.bodySmall)
                if (run.learnedScriptIds.isNotEmpty()) Text("已保存 ${run.learnedScriptIds.size} 个已验证操作 / 子流程；与整项任务结果分开记录。", style = MaterialTheme.typography.bodySmall)
                Text("缓存检查 ${run.cacheLookupMs} ms · 重放 ${run.cacheReplayMs} ms · 探索 ${run.cacheFallbackMs} ms · 不兼容 ${run.cacheIncompatible}", style = MaterialTheme.typography.bodySmall)
                run.steps.forEachIndexed { index, step -> Text("${index + 1}. ${step.action} · ${if (step.ok) "成功" else "失败"} · ${step.detail}", style = MaterialTheme.typography.bodySmall) }
                if (run.answer.isNotBlank()) Text(run.answer)
                run.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            } }
        }
    }
    if (scriptLibrary) DeviceScriptLibrary(data, agent, { scriptLibrary = false }) { script, values -> agent.start(script.goalTemplate, displayId, screenshots, scriptId = script.id, parameters = values) }
}

fun deviceStatus(status: String) = when (status) {
    "running" -> "执行中"; "achieved" -> "已验证可见结果"; "completed" -> "历史记录：模型已结束"; "needs_user" -> "需要你继续或确认"
    "cancelled" -> "已停止"; "interrupted" -> "系统中断"; "blocked" -> "任务受阻"; else -> "执行失败"
}

@Composable fun DeviceTaskCard(run: DeviceRun, active: Boolean, phase: String, onCancel: () -> Unit) {
    var expanded by rememberSaveable(run.id) { mutableStateOf(false) }
    ElevatedCard(Modifier.fillMaxWidth().testTag("device-task-${run.id}")) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("手机操作 · ${deviceStatus(run.status)}", color = MeloGold, style = MaterialTheme.typography.titleSmall)
            Text(run.goal)
            Text("${run.connectionName} · ${run.steps.size} 步 · 仅本机记录", color = MeloMuted, style = MaterialTheme.typography.bodySmall)
            Text(deviceRunMode(run.executionMode) + (run.modelRequests?.let { " · 模型请求 $it 次" } ?: "") + run.finishedAt?.let { end ->
                runCatching { " · ${java.time.Duration.between(java.time.Instant.parse(run.startedAt), java.time.Instant.parse(end)).toMillis().coerceAtLeast(0) / 1000.0}s" }.getOrDefault("")
            }.orEmpty(), color = MeloMuted, style = MaterialTheme.typography.bodySmall)
            if (run.cacheNote.isNotBlank()) Text(run.cacheNote, style = MaterialTheme.typography.bodySmall)
            if (run.learnedScriptIds.isNotEmpty()) Text("已保存 ${run.learnedScriptIds.size} 个已验证操作 / 子流程；与整项任务结果分开记录。", style = MaterialTheme.typography.bodySmall)
            Text("缓存检查 ${run.cacheLookupMs} ms · 重放 ${run.cacheReplayMs} ms · 探索 ${run.cacheFallbackMs} ms · 不兼容 ${run.cacheIncompatible}", style = MaterialTheme.typography.bodySmall)
            if (active) { LinearProgressIndicator(Modifier.fillMaxWidth()); Text(phase); TextButton(onClick = onCancel) { Text("停止手机操作") } }
            if (run.answer.isNotBlank()) Text(run.answer)
            run.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (run.verification == "visible_facts") Text("已重新检查声明的页面文字或 App；其他业务效果仍以实际页面为准。", color = MeloMuted, style = MaterialTheme.typography.bodySmall)
            if (run.steps.isNotEmpty()) {
                TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "收起步骤" else "查看操作步骤") }
                val visible = if (expanded) run.steps else run.steps.takeLast(1)
                visible.forEach { step -> Text("${step.action} · ${if (step.ok) "已执行" else "受阻"} · ${step.detail} · ${step.durationMs} ms${if (step.code.isBlank()) "" else " · ${step.code}"}", style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
}
