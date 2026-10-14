package com.melo.android

import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.melo.android.chat.ChatRuntime
import com.melo.android.data.*
import com.melo.android.network.EndpointPolicy
import com.melo.android.ui.*
import kotlinx.serialization.json.*

@Composable private fun EditorDialog(title: String, dismiss: () -> Unit, save: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    AlertDialog(onDismissRequest = dismiss, title = { Text(title) }, text = { Column(Modifier.fillMaxWidth().heightIn(max = 520.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp), content = content) },
        confirmButton = { TextButton(onClick = save) { Text("保存") } }, dismissButton = { TextButton(onClick = dismiss) { Text("取消") } })
}
@Composable private fun Field(label: String, value: String, change: (String) -> Unit, lines: Int = 1) { OutlinedTextField(value, change, label = { Text(label) }, modifier = Modifier.fillMaxWidth(), minLines = lines, maxLines = if (lines == 1) 1 else 10) }
@Composable private fun SectionLabel(value: String) { Text(value, style = MaterialTheme.typography.titleMedium, color = MeloGold, modifier = Modifier.padding(top = 20.dp, bottom = 8.dp)) }

@Composable fun ChatOptions(chat: Conversation, data: AppData, vm: MeloViewModel, close: () -> Unit) {
    var title by remember { mutableStateOf(chat.title) }
    var agentId by remember { mutableStateOf(chat.agentId) }
    var projectId by remember { mutableStateOf(chat.projectId) }
    var connectionId by remember { mutableStateOf(chat.connectionId) }
    var pinned by remember { mutableStateOf(chat.pinned) }
    EditorDialog("对话设置", close, save = { vm.engine.work { require(title.isNotBlank()) { "请输入对话名称。" }; vm.repository.editChat(chat.id) { it.copy(title = title.take(500), agentId = agentId, projectId = projectId, connectionId = connectionId, pinned = pinned) }; close() } }) {
        Field("对话名称", title, { title = it })
        Text("角色"); data.agents.forEach { agent -> FilterChip(selected = agentId == agent.id, onClick = { agentId = agent.id }, label = { Text(agent.name) }) }
        Text("项目资料"); FilterChip(selected = projectId == null, onClick = { projectId = null }, label = { Text("不绑定项目") })
        data.projects.filterNot { it.archived }.forEach { project -> FilterChip(selected = projectId == project.id, onClick = { projectId = project.id }, label = { Text(project.name) }) }
        Text("模型连接"); FilterChip(selected = connectionId == null, onClick = { connectionId = null }, label = { Text("使用全局选择") })
        data.settings.connections.forEach { connection -> FilterChip(selected = connectionId == connection.id, onClick = { connectionId = connection.id }, label = { Text("${connection.name} · ${connection.model}") }) }
        Row(verticalAlignment = Alignment.CenterVertically) { Text("置顶", Modifier.weight(1f)); Switch(pinned, { pinned = it }) }
    }
}

@Composable fun AgentsScreen(data: AppData, vm: MeloViewModel, onChat: (String) -> Unit) {
    var editing by remember { mutableStateOf<Agent?>(null) }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
        item { TextButton(onClick = { editing = Agent(name = "") }) { Icon(Icons.Outlined.Add, null); Text("创建角色") } }
        items(data.agents, key = { it.id }) { agent ->
            ListItem(headlineContent = { Text(agent.name) }, supportingContent = { Text(agent.subtitle.ifBlank { agent.instructions.take(100) }) }, modifier = Modifier.clickable { editing = agent }, trailingContent = { TextButton(onClick = { onChat(agent.id) }) { Text("对话") } })
            HorizontalDivider()
        }
    }
    editing?.let { original ->
        var name by remember(original.id) { mutableStateOf(original.name) }; var subtitle by remember(original.id) { mutableStateOf(original.subtitle) }
        var instructions by remember(original.id) { mutableStateOf(original.instructions) }; var identity by remember(original.id) { mutableStateOf(original.identity) }
        var soul by remember(original.id) { mutableStateOf(original.soul) }
        EditorDialog("编辑角色", { editing = null }, { vm.engine.work {
            require(name.isNotBlank()) { "请输入角色名称。" }
            vm.repository.saveAgent(original.copy(name = name.take(200), subtitle = subtitle, instructions = instructions, identity = identity, soul = soul)); editing = null
        } }) { Field("名称", name, { name = it }); Field("简介", subtitle, { subtitle = it }); Field("角色指令", instructions, { instructions = it }, 4); Field("身份", identity, { identity = it }, 2); Field("风格", soul, { soul = it }, 2) }
    }
}

@Composable fun WorkspaceScreen(data: AppData, vm: MeloViewModel, onChat: (String) -> Unit) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var project by remember { mutableStateOf<Project?>(null) }; var note by remember { mutableStateOf<Knowledge?>(null) }; var memory by remember { mutableStateOf<MemoryFact?>(null) }
    var selectedProject by rememberSaveable { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        FlowRow { listOf("项目", "资料", "记忆", "冲突").forEachIndexed { index, label -> FilterChip(selected = tab == index, onClick = { tab = index }, label = { Text(label) }, modifier = Modifier.padding(end = 8.dp)) } }
        when (tab) {
            0 -> LazyColumn {
                item { TextButton(onClick = { project = Project(name = "") }) { Text("新建项目") } }
                if (data.projects.isEmpty()) item { EmptyPage("为对话组织资料", "项目指令和所属资料会用于绑定该项目的对话。") }
                items(data.projects, key = { it.id }) { row -> ListItem(headlineContent = { Text(row.name + if (row.archived) " · 已归档" else "") }, supportingContent = { Text(row.instructions.take(100)) }, modifier = Modifier.clickable { project = row }, trailingContent = { TextButton(onClick = { onChat(row.id) }, enabled = !row.archived) { Text("对话") } }) }
            }
            1 -> LazyColumn {
                item { TextButton(onClick = { note = Knowledge(title = "", content = "", projectId = selectedProject) }) { Text("添加文字资料") }; ProjectPicker(data, selectedProject) { selectedProject = it } }
                items(data.knowledge.filter { !it.deleted && (selectedProject == null || it.projectId == selectedProject) }, key = { it.id }) { row -> ListItem(headlineContent = { Text(row.title) }, supportingContent = { Text(row.content.take(120), maxLines = 3) }, modifier = Modifier.clickable { note = row }) }
                item { Text("只有绑定当前对话项目的资料会作为参考上下文；资料正文不作为系统操作授权。", color = MeloMuted, modifier = Modifier.padding(vertical = 16.dp)) }
            }
            2 -> LazyColumn {
                item { TextButton(onClick = { val chat = data.chats.firstOrNull(); if (chat == null) vm.engine.work { error("请先创建对话，再为它保存记忆。") } else memory = MemoryFact(text = "", chatId = chat.id, agentId = chat.agentId, projectId = chat.projectId) }) { Text("保存记忆") }; Text("手机使用你显式保存的文字记忆；桌面语义检索引擎仍在桌面运行。", color = MeloMuted) }
                items(data.memories, key = { it.id }) { row -> ListItem(headlineContent = { Text(row.text) }, supportingContent = { Text("${row.scope} · ${row.status}") }, modifier = Modifier.clickable { memory = row }) }
            }
            3 -> LazyColumn {
                val conflicts = data.workspace.records.filter { it.versions.size > 1 }
                if (conflicts.isEmpty()) item { EmptyPage("没有待处理冲突", "不同设备的并发修改会保留为多个版本，供你选择。") }
                items(conflicts, key = { "${it.kind}:${it.id}" }) { row ->
                    Text("${row.kind} · ${row.id.take(16)}", color = MeloGold, modifier = Modifier.padding(top = 16.dp))
                    row.versions.forEachIndexed { index, version -> Column {
                        Text(version.value.toString().take(1000)); TextButton(onClick = { vm.engine.work { vm.repository.resolveConflict(row, index) } }) { Text("采用版本 ${index + 1}") }
                    } }
                }
            }
        }
    }
    project?.let { original ->
        var name by remember(original.id) { mutableStateOf(original.name) }; var instructions by remember(original.id) { mutableStateOf(original.instructions) }; var archived by remember(original.id) { mutableStateOf(original.archived) }
        EditorDialog("项目", { project = null }, { vm.engine.work { require(name.isNotBlank()); vm.repository.saveProject(original.copy(name = name.take(200), instructions = instructions, archived = archived)); project = null } }) {
            Field("项目名称", name, { name = it }); Field("项目指令", instructions, { instructions = it }, 4)
            Row(verticalAlignment = Alignment.CenterVertically) { Text("归档", Modifier.weight(1f)); Switch(archived, { archived = it }) }
        }
    }
    note?.let { original ->
        var title by remember(original.id) { mutableStateOf(original.title) }; var content by remember(original.id) { mutableStateOf(original.content) }; var projectId by remember(original.id) { mutableStateOf(original.projectId) }; var deleted by remember(original.id) { mutableStateOf(original.deleted) }
        EditorDialog("文字资料", { note = null }, { vm.engine.work { require(title.isNotBlank()); vm.repository.saveKnowledge(original.copy(title = title.take(500), content = content, projectId = projectId, deleted = deleted)); note = null } }) {
            Field("标题", title, { title = it }); Field("正文", content, { content = it }, 6); ProjectPicker(data, projectId) { projectId = it }
            Row(verticalAlignment = Alignment.CenterVertically) { Text("停用此资料", Modifier.weight(1f)); Switch(deleted, { deleted = it }) }
        }
    }
    memory?.let { original ->
        var text by remember(original.id) { mutableStateOf(original.text) }; var enabled by remember(original.id) { mutableStateOf(original.status == "active") }
        EditorDialog("文字记忆", { memory = null }, { vm.engine.work { require(text.isNotBlank()); vm.repository.saveMemory(original.copy(text = text.take(2000), status = if (enabled) "active" else "forgotten", updatedAt = now())); memory = null } }) {
            Field("记忆内容", text, { text = it }, 5); Text("来源对话：${data.chats.find { it.id == original.chatId }?.title ?: original.chatId}", color = MeloMuted)
            Row(verticalAlignment = Alignment.CenterVertically) { Text("用于后续对话", Modifier.weight(1f)); Switch(enabled, { enabled = it }) }
        }
    }
}

@Composable private fun ProjectPicker(data: AppData, selected: String?, change: (String?) -> Unit) {
    Column { Text("所属项目"); FilterChip(selected = selected == null, onClick = { change(null) }, label = { Text("未绑定") }); data.projects.filterNot { it.archived }.forEach { project -> FilterChip(selected = selected == project.id, onClick = { change(project.id) }, label = { Text(project.name) }) } }
}

@Composable fun SettingsScreen(data: AppData, runtime: ChatRuntime, vm: MeloViewModel) {
    var editing by remember { mutableStateOf<Connection?>(null) }
    var syncEndpoint by remember(data.settings.syncEndpoint) { mutableStateOf(data.settings.syncEndpoint) }
    var syncKey by remember { mutableStateOf("") }
    var userName by remember(data.settings.userName) { mutableStateOf(data.settings.userName) }
    var fontScale by remember(data.settings.fontScale) { mutableFloatStateOf(data.settings.fontScale) }
    var tested by remember { mutableStateOf<String?>(null) }
    val context = LocalContext.current
    val export = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri -> uri?.let { vm.engine.work { vm.repository.exportTo(it); tested = "文字资料已导出，不含凭证与图片文件。" } } }
    val import = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { vm.engine.work { vm.repository.importFrom(it); tested = "资料已合并导入。" } } }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp), contentPadding = PaddingValues(bottom = 30.dp)) {
        item { SectionLabel("模型连接"); Text("凭证仅在这台设备加密保存，不进入资料同步或导出。", color = MeloMuted) }
        items(data.settings.connections, key = { it.id }) { connection ->
            ListItem(headlineContent = { Text(connection.name) }, supportingContent = { Text("${connection.model.ifBlank { "待填写模型" }} · ${connection.protocol}") }, modifier = Modifier.clickable { editing = connection }, leadingContent = {
                RadioButton(selected = data.settings.activeConnection == connection.id, onClick = { vm.engine.work { vm.repository.change { it.copy(settings = it.settings.copy(activeConnection = connection.id)) } } })
            }, trailingContent = { IconButton(onClick = { editing = connection }) { Icon(Icons.Outlined.Edit, "编辑连接") } })
        }
        item { TextButton(onClick = { editing = Connection() }) { Text("添加模型连接") }
            if (BuildConfig.DEBUG) TextButton(onClick = { vm.engine.work {
                val fixture = data.settings.connections.find { it.protocol == "fixture" } ?: Connection(name = "本地 Fixture · 非真实模型", endpoint = "https://fixture.invalid", model = "local-fixture", protocol = "fixture")
                vm.repository.saveConnection(fixture, null); vm.repository.change { it.copy(settings = it.settings.copy(activeConnection = fixture.id)) }; tested = "已选择本地 Fixture，不会调用真实模型。"
            } }) { Text("添加本地 Fixture（开发验证）") }
        }
        item {
            SectionLabel("跨设备同步"); Field("完整 HTTPS 同步地址（/v1/sync）", syncEndpoint, { syncEndpoint = it })
            Spacer(Modifier.height(10.dp)); OutlinedTextField(syncKey, { syncKey = it }, label = { Text("新的同步密钥（留空保留原值）") }, modifier = Modifier.fillMaxWidth(), visualTransformation = PasswordVisualTransformation(), singleLine = true)
            Row { TextButton(onClick = { vm.engine.work { if (syncEndpoint.isNotBlank()) EndpointPolicy.validate(syncEndpoint, BuildConfig.DEBUG); if (syncKey.isNotBlank()) { require(syncKey.length >= 32) { "同步密钥至少 32 个字符。" }; vm.repository.saveCredential("sync", syncKey); syncKey = "" }; vm.repository.change { it.copy(settings = it.settings.copy(syncEndpoint = syncEndpoint.trim())) }; tested = "同步设置已保存，尚未代表服务已验证。" } }) { Text("保存同步设置") }; TextButton(onClick = vm.engine::synchronize, enabled = data.settings.syncEndpoint.isNotBlank()) { Text("立即同步") } }
            Row(verticalAlignment = Alignment.CenterVertically) { Text("回复完成后自动同步", Modifier.weight(1f)); Switch(data.settings.autoSync, { selected -> vm.engine.work { vm.repository.change { it.copy(settings = it.settings.copy(autoSync = selected)) } } }) }
            runtime.syncStatus?.let { Text(it, color = MeloMuted) }
            Text("需要你自己的同步服务；同步回执不代表桌面已执行任务。", color = MeloMuted)
        }
        item {
            SectionLabel("本机偏好"); Field("昵称", userName, { userName = it }); TextButton(onClick = { vm.engine.work { vm.repository.change { it.copy(settings = it.settings.copy(userName = userName.take(100))) } } }) { Text("保存昵称") }
            Row(verticalAlignment = Alignment.CenterVertically) { Text("减少动效", Modifier.weight(1f)); Switch(data.settings.reduceMotion, { selected -> vm.engine.work { vm.repository.change { it.copy(settings = it.settings.copy(reduceMotion = selected)) } } }) }
            Text("字号 ${"%.0f".format(fontScale * 100)}%")
            Slider(value = fontScale, onValueChange = { fontScale = it }, onValueChangeFinished = { vm.engine.work { vm.repository.change { it.copy(settings = it.settings.copy(fontScale = fontScale)) } } }, valueRange = .85f..1.3f, steps = 8)
        }
        item {
            SectionLabel("资料与诊断"); Row { TextButton(onClick = { export.launch("Melo-${java.time.LocalDate.now()}.json") }) { Text("导出文字资料") }; TextButton(onClick = { import.launch(arrayOf("application/json", "text/plain")) }) { Text("合并导入资料") } }
            tested?.let { Text(it, color = MeloGold) }
            Text("Melo ${BuildConfig.VERSION_NAME} · Android ${android.os.Build.VERSION.RELEASE} / API ${android.os.Build.VERSION.SDK_INT}\n${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}\n${data.chats.size} 段对话 · ${data.runs.size} 条执行记录\n凭证：设备本地 Keystore 加密\n桌面工具与桌面语义检索：由桌面执行", color = MeloMuted)
        }
    }
    editing?.let { original ->
        var name by remember(original.id) { mutableStateOf(original.name) }; var endpoint by remember(original.id) { mutableStateOf(original.endpoint) }; var model by remember(original.id) { mutableStateOf(original.model) }
        var protocol by remember(original.id) { mutableStateOf(original.protocol) }; var stream by remember(original.id) { mutableStateOf(original.stream) }; var key by remember(original.id) { mutableStateOf("") }
        var probe by remember(original.id) { mutableStateOf<String?>(null) }; var probing by remember { mutableStateOf(false) }
        EditorDialog("模型连接", { if (!probing) editing = null }, { vm.engine.work {
            require(name.isNotBlank()); if (protocol != "fixture") { EndpointPolicy.validate(endpoint, BuildConfig.DEBUG); require(model.isNotBlank()) { "请输入模型名称。" } }
            vm.repository.saveConnection(original.copy(name = name.take(200), endpoint = endpoint.trim(), model = model.trim(), protocol = protocol, stream = stream), key.takeIf(String::isNotBlank)); editing = null
        } }) {
            Field("连接名称", name, { name = it }); Field("完整模型 Endpoint", endpoint, { endpoint = it }); Field("模型名称", model, { model = it })
            Text("接口协议"); listOf("chat-completions", "responses", "anthropic").forEach { choice -> FilterChip(selected = protocol == choice, onClick = { protocol = choice }, label = { Text(choice) }) }
            if (original.protocol == "fixture") Text("此连接只用于 Debug Fixture，不会联网。", color = MeloGold)
            OutlinedTextField(key, { key = it }, label = { Text("新的 API 凭证（留空保留）") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), singleLine = true)
            Row(verticalAlignment = Alignment.CenterVertically) { Text("流式回复", Modifier.weight(1f)); Switch(stream, { stream = it }) }
            TextButton(enabled = !probing, onClick = { vm.engine.work {
                probing = true
                try {
                    val connection = original.copy(name = name, endpoint = endpoint, model = model, protocol = protocol, stream = stream)
                    val result = vm.engine.client.reply(connection, key.ifBlank { vm.repository.credential(original.id) }, listOf(Message(role = "user", content = "Reply with OK.")), "Answer briefly.", { "" }) { }
                    probe = if (result.simulated) "Fixture 测试通过；没有调用真实模型。" else "本次测试成功 · 服务返回模型：${result.model ?: "未报告"}"
                } finally { probing = false }
            } }) { Text(if (probing) "测试中…" else "发送测试请求") }
            probe?.let { Text(it, color = MeloGold) }
        }
    }
}

@Composable fun TasksScreen(data: AppData, vm: MeloViewModel, onChat: (String) -> Unit, onExecution: (String) -> Unit) {
    var title by rememberSaveable { mutableStateOf("") }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
        item { SectionLabel("任务"); Field("新任务名称", title, { title = it }); TextButton(enabled = title.isNotBlank(), onClick = { vm.engine.work {
            val task = buildJsonObject { put("id", newId()); put("title", title.take(500)); put("status", "todo"); put("owner", "android"); put("checkpoint", ""); put("revision", 1); put("sourceDevice", data.deviceId); put("updatedAt", now()) }
            vm.repository.change { it.copy(tasks = JsonArray(it.tasks + task)) }; title = ""
        } }) { Text("创建任务") } }
        items(data.tasks, key = { it.jsonObject.text("id") }) { item ->
            val task = item.jsonObject
            ListItem(headlineContent = { Text(task.text("title")) }, supportingContent = { Text("${task.text("status")} · ${task.text("owner")}\n${task.text("checkpoint").take(300)}") })
            if (task.text("status") in setOf("todo", "blocked")) TextButton(onClick = { vm.engine.work {
                val id = task.text("id")
                require(vm.repository.data.value.handoffs.none { it.jsonObject.text("taskId") == id }) { "该任务已有接力请求。" }
                val handoff = buildJsonObject { put("id", newId()); put("taskId", id); put("fromDevice", data.deviceId); put("requestedAt", now()); put("revision", task["revision"] ?: JsonPrimitive(1)) }
                vm.repository.change { it.copy(handoffs = JsonArray(it.handoffs + handoff)) }
            } }) { Text(if (data.handoffs.any { it.jsonObject.text("taskId") == task.text("id") }) "接力已排队，等待同步与桌面接收" else "请求桌面接力") }
        }
        item { SectionLabel("真实执行记录") }
        if (data.runs.isEmpty()) item { EmptyPage("还没有执行记录", "模型请求开始后会记录状态、返回模型、引用与失败信息。") }
        items(data.runs.asReversed(), key = { it.id }) { run ->
            ListItem(headlineContent = { Text(run.prompt.take(90)) }, supportingContent = { Text("${run.status} · ${if (run.simulated) "本地 Fixture" else run.reportedModel ?: run.requestedModel}\n${run.error ?: run.startedAt}") }, modifier = Modifier.clickable { onExecution(run.chatId) }, trailingContent = { TextButton(onClick = { onChat(run.chatId) }) { Text("对话") } })
        }
    }
}

@Composable fun ExecutionScreen(data: AppData, chatId: String, onOpen: (String) -> Unit) {
    val chat = data.chats.find { it.id == chatId }
    val runs = data.runs.filter { it.chatId == chatId }
    Column(Modifier.fillMaxSize()) {
        if (runs.isEmpty()) EmptyPage("该对话没有执行记录", "这里展示真实请求产生的记录。")
        else {
            Text("${runs.size} 次请求 · 引用不代表已读取网页", color = MeloMuted, modifier = Modifier.padding(12.dp))
            SharedScene(buildJsonObject {
                put("chat", buildJsonObject { put("id", chatId); put("messages", MeloJson.encodeToJsonElement(chat?.messages.orEmpty())) })
                put("scenes", JsonArray(runs.map { it.scene() })); put("runId", runs.last().id); put("still", data.settings.reduceMotion)
            }, Modifier.weight(1f).fillMaxWidth(), execution = true, onOpenUrl = onOpen)
        }
    }
}
