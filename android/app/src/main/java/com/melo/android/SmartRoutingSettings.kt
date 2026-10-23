package com.melo.android

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import com.melo.android.data.*
import kotlinx.serialization.json.*

@Composable fun SmartRoutingSettings(data: AppData, vm: MeloViewModel) {
    var editing by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf(data.settings.smartRouting) }
    var revision by remember { mutableIntStateOf(0) }
    fun change(key: String, value: JsonElement) { draft = JsonObject(draft + (key to value)) }
    Column(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("智能（自动）", style = MaterialTheme.typography.titleMedium)
        Text("对话可选具体模型或智能模式；Agent 指定的模型优先。判断默认只发给当前连接。")
        if (!editing) TextButton(onClick = { draft = data.settings.smartRouting; revision = draft["revision"]?.jsonPrimitive?.intOrNull ?: 0; editing = true }) { Text("配置轻 / 标准 / 强档") }
        else {
            Text("默认模式")
            Row { for ((id, label) in listOf("fixed" to "固定模型", "smart" to "智能（自动）")) FilterChip(selected = draft.text("defaultMode", "fixed") == id, onClick = { change("defaultMode", JsonPrimitive(id)) }, label = { Text(label) }) }
            Text("偏好")
            Row { for ((id, label) in listOf("cost" to "省成本", "balanced" to "均衡", "quality" to "优先质量")) FilterChip(selected = draft.text("preference", "balanced") == id, onClick = { change("preference", JsonPrimitive(id)) }, label = { Text(label) }) }
            for ((key, label, fallback) in listOf(Triple("allowCrossConnection", "允许跨连接选模（会将对话发给所选服务）", false), Triple("allowEscalation", "允许本轮升档一次", true))) Row(verticalAlignment = Alignment.CenterVertically) {
                Text(label, Modifier.weight(1f)); Switch(draft[key]?.jsonPrimitive?.booleanOrNull ?: fallback, { change(key, JsonPrimitive(it)) })
            }
            val candidates = data.settings.connections.filter { it.protocol != "fixture" }.flatMap { c -> (c.models + c.model).filter(String::isNotBlank).distinct().map { c to it } }
            if (candidates.size == 1) Text("只配置一个模型时，智能模式等同固定模型。")
            for ((tier, label) in listOf("light" to "轻", "standard" to "标准", "strong" to "强")) {
                Text("$label 档")
                val tiers = (draft["tiers"] as? JsonObject).orEmpty()
                val selected = (tiers[tier] as? JsonArray).orEmpty().map { it.jsonObject }
                fun assign(rows: List<JsonObject>) { change("tiers", JsonObject(tiers + (tier to JsonArray(rows)))) }
                for ((c, model) in candidates.sortedBy { (c,m) -> selected.indexOfFirst { it.text("connectionId") == c.id && it.text("model") == m }.takeIf { it >= 0 } ?: Int.MAX_VALUE }) {
                    val item = selected.find { it.text("connectionId") == c.id && it.text("model") == model }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(item != null, { checked -> assign(if (checked) selected + buildJsonObject { put("connectionId", c.id); put("model", model); put("vision", false) } else selected.filterNot { it == item }) })
                        Text("${c.name} · $model", Modifier.weight(1f))
                    }
                    if (item != null) Row {
                        val rank=selected.indexOf(item)
                        TextButton(enabled=rank>0, onClick={ assign(selected.toMutableList().apply { java.util.Collections.swap(this,rank,rank-1) }) }) { Text("↑") }
                        Text("${rank+1}")
                        TextButton(enabled=rank<selected.size-1, onClick={ assign(selected.toMutableList().apply { java.util.Collections.swap(this,rank,rank+1) }) }) { Text("↓") }
                    }
                    if (item != null) Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(item["vision"]?.jsonPrimitive?.booleanOrNull == true, { checked -> assign(selected.map { if(it == item) JsonObject(it + ("vision" to JsonPrimitive(checked))) else it }) })
                        Text("已确认该模型支持图片输入")
                    }
                }
            }
            Row {
                TextButton(onClick = { vm.engine.work { vm.repository.change { current ->
                    require((current.settings.smartRouting["revision"]?.jsonPrimitive?.intOrNull ?: 0) == revision) { "配置已更新，请取消并重新打开后保存。" }
                    val available = current.settings.connections.flatMap { c -> (c.models + c.model).map { c.id to it } }.toSet()
                    require((draft["tiers"] as? JsonObject).orEmpty().values.flatMap { it.jsonArray }.all { it.jsonObject.let { r -> r.text("connectionId") to r.text("model") } in available }) { "模型目录已变更，请重新配置。" }
                    current.copy(settings = current.settings.copy(smartRouting = JsonObject(draft + ("revision" to JsonPrimitive(revision + 1)))))
                }; editing = false } }) { Text("保存") }
                TextButton(onClick = { editing = false }) { Text("取消") }
            }
        }
    }
}
