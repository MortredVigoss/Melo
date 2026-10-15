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
    var displayId by rememberSaveable { mutableIntStateOf(0) }
    var displays by remember { mutableStateOf(emptyList<Pair<Int, String>>()) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { displays = DeviceAccess.service?.displays().orEmpty() }
    LaunchedEffect(connected) { displays = DeviceAccess.service?.displays().orEmpty() }
    val connection = data.settings.connections.find { it.id == data.settings.activeConnection }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp), contentPadding = PaddingValues(bottom = 30.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("手机助手", style = MaterialTheme.typography.headlineSmall, color = MeloGold)
            Text("按你的要求观察屏幕并操作 App，每一步由模型根据当前屏幕决定。", color = MeloMuted)
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
            Text("点击开始后，当前 Display 的界面文字${if (screenshots) "和截图" else ""}会发送给上述模型服务。只在本次任务期间操作，可随时点击悬浮「停止 Melo」。每次最多 30 步 / 10 分钟。", color = MeloMuted)
            Button(onClick = { if (runtime.running) agent.cancel() else agent.start(goal, displayId, screenshots) }, enabled = runtime.running || connected && goal.isNotBlank() && connection != null, modifier = Modifier.fillMaxWidth()) {
                Text(if (runtime.running) "停止执行" else "开始执行")
            }
            if (runtime.running) { LinearProgressIndicator(Modifier.fillMaxWidth()); Text(runtime.phase, color = MeloGold) }
        }
        item { Text("执行记录", style = MaterialTheme.typography.titleMedium, color = MeloGold) }
        items(data.deviceRuns.asReversed(), key = { it.id }) { run ->
            ElevatedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(run.goal, style = MaterialTheme.typography.titleMedium)
                Text("${when (run.status) { "running" -> "执行中"; "completed" -> "模型已结束任务"; "cancelled" -> "已停止"; "interrupted" -> "系统中断"; else -> "未完成" }} · ${run.connectionName} · ${run.steps.size} 步", color = MeloMuted)
                run.steps.forEachIndexed { index, step -> Text("${index + 1}. ${step.action} · ${if (step.ok) "成功" else "失败"} · ${step.detail}", style = MaterialTheme.typography.bodySmall) }
                if (run.answer.isNotBlank()) Text(run.answer)
                run.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            } }
        }
    }
    runtime.error?.let { AlertDialog(onDismissRequest = agent::dismissError, title = { Text("手机助手未完成") }, text = { Text(it) }, confirmButton = { TextButton(onClick = agent::dismissError) { Text("知道了") } }) }
}
