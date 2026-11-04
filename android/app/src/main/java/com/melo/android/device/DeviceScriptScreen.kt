package com.melo.android.device

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.melo.android.data.*
import com.melo.android.ui.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

@Composable fun DeviceScriptLibrary(data: AppData, agent: DeviceAgent, onDismiss: () -> Unit, onRun: (DeviceScript, Map<String, String>) -> Boolean) {
    val scope = rememberCoroutineScope()
    val runtime by agent.runtime.collectAsState()
    var editing by remember { mutableStateOf<DeviceScript?>(null) }
    var deleting by remember { mutableStateOf<DeviceScript?>(null) }
    var input by remember { mutableStateOf<DeviceScript?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    fun work(block: suspend () -> Unit) { scope.launch { try { block() } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message ?: "缓存修改失败。" } } }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.widthIn(max = 760.dp).fillMaxWidth(0.96f).fillMaxHeight(0.92f).testTag("cache-library"), shape = MaterialTheme.shapes.large, color = MeloBackground) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("操作缓存", style = MaterialTheme.typography.titleLarge, color = MeloGold); TextButton(onClick = onDismiss) { Text("关闭") } }
                Text("Exact / 参数命中在本机执行；Similar 改写和 Probe 会调用模型。已验证动作和子流程单独缓存，后续任务失败也保留，仅保存在本机。", color = MeloMuted, style = MaterialTheme.typography.bodySmall)
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                if (data.deviceScripts.isEmpty()) Text("还没有缓存。执行一次可验证的手机操作后，会自动记录可复用步骤。", color = MeloMuted)
                LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(data.deviceScripts.sortedByDescending { it.updatedAt }, key = { it.id }) { script ->
                        ElevatedCard(Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                                Text(script.name, style = MaterialTheme.typography.titleMedium, color = MeloGold)
                                Text((when (script.cacheKind) { "action" -> "单个动作"; "subflow" -> "子流程"; else -> "完整流程" }) + " · ${script.steps.size} 步 · r${script.revision} · " + when { !script.enabled -> "已停用"; script.invalidated -> "已失效"; !script.verified -> "待验证"; else -> "已验证" }, color = MeloMuted)
                                Text("命中 ${script.hits} · 成功 ${script.successes} · 失败 ${script.failures}", style = MaterialTheme.typography.bodySmall, color = MeloMuted)
                                Text(script.goalTemplate, style = MaterialTheme.typography.bodySmall)
                                if (script.lastError.isNotBlank()) Text(script.lastError, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                                Row {
                                    TextButton(onClick = { if (script.parameters.isEmpty()) { if (onRun(script, emptyMap())) onDismiss() } else input = script }, enabled = !runtime.running, modifier = Modifier.testTag("cache-run-${script.id}")) { Text("运行") }
                                    TextButton(onClick = { editing = script }, modifier = Modifier.testTag("cache-edit-${script.id}")) { Text("编辑") }
                                    TextButton(onClick = { deleting = script }, modifier = Modifier.testTag("cache-delete-${script.id}")) { Text("删除") }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    editing?.let { original ->
        var name by remember(original.id, original.revision) { mutableStateOf(original.name) }
        val editableKeys = setOf("goalTemplate", "steps", "completion", "parameters", "enabled")
        val json = remember(original.id, original.revision) { Json { prettyPrint = true }.encodeToString(JsonObject(MeloJson.encodeToJsonElement(original).jsonObject.filterKeys { it in editableKeys })) }
        var body by remember(original.id, original.revision) { mutableStateOf(json) }
        var editError by remember { mutableStateOf<String?>(null) }
        AlertDialog(onDismissRequest = { editing = null }, title = { Text("编辑操作缓存") },
            text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(name, { name = it }, label = { Text("名称") }, modifier = Modifier.fillMaxWidth().testTag("cache-name"), singleLine = true)
                Text("可修改步骤、参数、目标模板和完成条件。保存后须运行验证，才参与自动命中。", style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(body, { body = it }, label = { Text("脚本 JSON") }, modifier = Modifier.fillMaxWidth().heightIn(min = 160.dp, max = 350.dp).testTag("cache-json"),
                    textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
                editError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            } },
            confirmButton = { TextButton(onClick = {
                work {
                    try {
                        require(body.toByteArray().size <= ScriptValidator.MAX_BYTES) { "脚本超过 96 KiB。" }
                        val fields = MeloJson.parseToJsonElement(body).jsonObject
                        require(fields.keys.all { it in editableKeys }) { "只允许修改目标模板、步骤、完成条件、参数和 enabled。" }
                        val edited = ScriptValidator.parse(JsonObject(MeloJson.encodeToJsonElement(original).jsonObject + fields + ("name" to name.jp())).toString())
                        agent.editScript(original, edited); editing = null
                    } catch (e: CancellationException) { throw e } catch (e: Exception) { editError = e.message ?: "脚本格式无效。" }
                }
            }, modifier = Modifier.testTag("cache-save")) { Text("保存") } },
            dismissButton = { TextButton(onClick = { editing = null }) { Text("取消") } })
    }
    deleting?.let { target ->
        AlertDialog(onDismissRequest = { deleting = null }, title = { Text("删除「${target.name}」？") }, text = { Text("删除后，同一目标会重新匹配缓存或进入 Probe。正在运行的该脚本会先停止。") },
            confirmButton = { TextButton(onClick = { work { agent.deleteScript(target.id); deleting = null } }, modifier = Modifier.testTag("cache-confirm-delete")) { Text("删除") } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("取消") } })
    }
    input?.let { script ->
        // Never use rememberSaveable for runtime values: no Bundle or cache writes.
        var values by remember(script.id) { mutableStateOf<Map<String, String>>(emptyMap()) }
        AlertDialog(onDismissRequest = { input = null }, title = { Text("脚本输入参数") }, text = {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                item { Text("参数只用于本次执行，不写回缓存。", style = MaterialTheme.typography.bodySmall) }
                items(script.parameters) { key -> OutlinedTextField(values[key].orEmpty(), { values = values + (key to it) }, label = { Text(key) }, modifier = Modifier.fillMaxWidth()) }
            }
        }, confirmButton = { TextButton(onClick = { if (onRun(script, values)) { input = null; onDismiss() } }, enabled = !runtime.running && script.parameters.all { it in values } && values.values.all { it.length <= 4000 }) { Text("运行") } },
            dismissButton = { TextButton(onClick = { input = null }) { Text("取消") } })
    }
}

fun deviceRunMode(mode: String): String = when (mode) { "unified" -> "对话主循环"; "exact" -> "Cache Hit"; "similar" -> "Similar Hit"; "manual" -> "本机脚本"; "revalidate" -> "旧缓存校验"; else -> "Probe" }
