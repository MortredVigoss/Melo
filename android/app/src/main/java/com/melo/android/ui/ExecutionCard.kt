package com.melo.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.melo.android.data.*
import com.melo.android.openUrl
import kotlinx.serialization.json.*
import com.melo.android.core.SharedCoreRuntime
import com.melo.android.core.value
import kotlinx.coroutines.CancellationException
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

fun executionStatus(value: String): String = when (value) {
    "running" -> "进行中"; "completed", "achieved" -> "完成"; "partial" -> "部分完成"; "blocked" -> "受阻"; "needs_user" -> "需要处理"
    "budget_exhausted" -> "预算已用完"; "cancelled" -> "已取消"; "interrupted" -> "已中断"; "failed" -> "失败"; else -> value
}

/** The card is a projection of persisted observations, never a synthetic progress log. */
@Composable fun ExecutionCard(run: RunRecord, phase: String = "", onDetails: () -> Unit = {}) {
    var expanded by rememberSaveable(run.id) { mutableStateOf(false) }
    val scene = run.sharedScene
    val operations = (scene?.get("operations") as? JsonArray).orEmpty().map { it.jsonObject }
    val stages = (scene?.get("pipeline") as? JsonArray).orEmpty().map { it.jsonObject }
    val sources = (scene?.get("sources") as? JsonArray).orEmpty().map { it.jsonObject }
    val context = LocalContext.current
    var canonical by remember(scene) { mutableStateOf((scene?.get("sessionEvents") as? JsonArray).orEmpty().map { it.jsonObject }) }
    LaunchedEffect(scene, expanded) {
        if (expanded && scene != null && scene["sessionEvents"] == null) {
            try {
                SharedCoreRuntime.open(context).use { runtime ->
                    canonical = runtime.value("sessionEvents", buildJsonObject { put("scene", scene) }).jsonArray.map { it.jsonObject }
                }
            } catch (error: Exception) { if (error is CancellationException) throw error }
        }
    }
    val summary = if (scene == null) "未记录工具明细" else "${operations.size} 次工具调用 · ${sources.size} 个来源" +
        if (sources.any { it["accessed"]?.jsonPrimitive?.booleanOrNull == true }) " · 已读取 ${sources.count { it["accessed"]?.jsonPrimitive?.booleanOrNull == true }} 页" else ""
    Surface(color = MeloGold.copy(alpha = .045f), shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().testTag("execution-card-${run.id}")) {
        Column(Modifier.padding(10.dp)) {
            Column(Modifier.fillMaxWidth().clickable { expanded = !expanded }.testTag("execution-toggle-${run.id}").padding(4.dp)) {
                Text("${if (expanded) "收起" else "展开"}执行过程 · ${executionStatus(run.status)}", color = MeloGold, style = MaterialTheme.typography.labelLarge)
                Text(scene?.get("completion")?.jsonObject?.text("summary")?.takeIf(String::isNotBlank) ?: summary, color = MeloMuted, style = MaterialTheme.typography.labelSmall)
                if (run.status == "running" && phase.isNotBlank()) Text(phase, color = MeloMuted, style = MaterialTheme.typography.bodySmall)
            }
            run.error?.takeIf(String::isNotBlank)?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("execution-error-${run.id}")) }
            if (expanded) Column(Modifier.testTag("execution-content-${run.id}"), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                if (scene == null) Text("这条旧记录没有保存工具细节，无法据此推断是否检索或操作过手机。", color = MeloMuted)
                else {
                    val ordered = (operations + stages).sortedBy { it.text("startedAt") }
                    for (event in ordered) ExecutionEvent(event)
                    if (sources.isNotEmpty()) {
                        Text("来源 · 搜索摘要与网页读取分别记录", style = MaterialTheme.typography.labelMedium, color = MeloGold)
                        for (source in sources) {
                            TextButton(onClick = { openUrl(context, source.text("url")) }, contentPadding = PaddingValues(0.dp)) { Text(source.text("title").ifBlank { source.text("url") }, maxLines = 3) }
                            Text(if (source["accessed"]?.jsonPrimitive?.booleanOrNull == true) "已读取网页 · 内容是否最新仍需核对" else "仅来源 / 搜索摘要 · 未记录网页全文读取", color = MeloMuted, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                    if (canonical.isNotEmpty()) {
                        Text("执行记录标识", style = MaterialTheme.typography.labelMedium, color = MeloGold)
                        for (event in canonical) Text(
                            event.text("eventId") + if (event.text("resultState") == "unknown") " · 结果未知，请先核对再继续" else "",
                            modifier = Modifier.testTag("session-event-${event.text("eventId")}"),
                            color = MeloMuted, style = MaterialTheme.typography.labelSmall)
                    }
                    scene.text("stopReason").takeIf(String::isNotBlank)?.let { Text("停止原因：$it", color = MaterialTheme.colorScheme.error) }
                }
                TextButton(onClick = onDetails) { Text("打开任务空间") }
            }
        }
    }
}

@Composable private fun ExecutionEvent(event: JsonObject) {
    var details by rememberSaveable(event.text("id")) { mutableStateOf(false) }
    val summary = event.text("channel") == "reasoning-summary"
    val duration = event["durationMs"]?.jsonPrimitive?.longOrNull ?: runCatching {
        Instant.parse(event.text("finishedAt")).toEpochMilli() - Instant.parse(event.text("startedAt")).toEpochMilli()
    }.getOrNull()
    Column(Modifier.fillMaxWidth()) {
        Text("${event.text("name")} · ${executionStatus(event.text("status"))}${duration?.let { " · ${it.coerceAtLeast(0)} ms" }.orEmpty()}", style = MaterialTheme.typography.labelMedium)
        if (event.text("startedAt").isNotBlank()) Text(runCatching { Instant.parse(event.text("startedAt")).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("MM-dd HH:mm:ss")) }.getOrDefault(event.text("startedAt")), color = MeloMuted, style = MaterialTheme.typography.labelSmall)
        if (summary) Text("服务返回的公开摘要", color = MeloMuted, style = MaterialTheme.typography.labelSmall)
        val output = event.text("output")
        val preview = event.text("resultSummary").ifBlank { output }
        if (preview.isNotBlank()) Text(if (details) output else preview.take(240) + if (preview.length > 240) "…" else "", color = MeloMuted, style = MaterialTheme.typography.bodySmall)
        if (event.text("input").isNotBlank() || output.length > 240 || output != preview) {
            TextButton(onClick = { details = !details }, contentPadding = PaddingValues(0.dp)) { Text(if (details) "收起本步详情" else "展开本步详情") }
            if (details && event.text("input").isNotBlank()) Text(event.text("input"), style = MaterialTheme.typography.bodySmall)
        }
        if (event.text("deviceRunId").isNotBlank()) Text("手机子任务步骤见本轮手机操作卡", color = MeloMuted, style = MaterialTheme.typography.labelSmall)
    }
}
