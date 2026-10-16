package com.melo.android

import android.Manifest
import android.app.Application
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.speech.RecognizerIntent
import android.speech.tts.TextToSpeech
import androidx.activity.ComponentActivity
import androidx.activity.compose.*
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.Saver
import androidx.compose.ui.*
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.*
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.*
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.*
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.melo.android.chat.*
import com.melo.android.data.*
import com.melo.android.device.*
import com.melo.android.ui.*
import kotlinx.coroutines.delay
import kotlinx.serialization.json.*
import java.util.Locale

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); enableEdgeToEdge(statusBarStyle = androidx.activity.SystemBarStyle.dark(android.graphics.Color.TRANSPARENT), navigationBarStyle = androidx.activity.SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        setContent { MeloTheme { MeloApp() } }
    }
}
class MeloViewModel(application: Application) : AndroidViewModel(application) {
    val engine = (application as MeloApplication).engine
    val repository = engine.repository
}

private enum class Page { Home, Chats, Agents, Workspace, Settings, Tasks, Device }
private data class NavItem(val page: Page, val label: String, val icon: ImageVector)
private val navigation = listOf(NavItem(Page.Home, "中枢", Icons.Outlined.Hub), NavItem(Page.Chats, "对话", Icons.AutoMirrored.Outlined.Chat), NavItem(Page.Agents, "角色", Icons.Outlined.PersonOutline), NavItem(Page.Workspace, "资料", Icons.Outlined.FolderOpen), NavItem(Page.Settings, "系统", Icons.Outlined.Tune))
private data class ChatTimelineItem(val id: String, val at: String, val message: Message? = null, val device: DeviceRun? = null)

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun MeloApp(vm: MeloViewModel = viewModel()) {
    val data by vm.repository.data.collectAsStateWithLifecycle()
    val runtime by vm.engine.runtime.collectAsStateWithLifecycle()
    val deviceAgent = (LocalContext.current.applicationContext as MeloApplication).deviceAgent
    val deviceRuntime by deviceAgent.runtime.collectAsStateWithLifecycle()
    var pageName by rememberSaveable { mutableStateOf(Page.Home.name) }
    val page = Page.valueOf(pageName)
    var chatId by rememberSaveable { mutableStateOf<String?>(null) }
    var showHistory by rememberSaveable { mutableStateOf(false) }
    var executionChat by rememberSaveable { mutableStateOf<String?>(null) }
    val context = LocalContext.current
    val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    fun newChat(agentId: String = "main", projectId: String? = null) { vm.engine.work { chatId = vm.repository.newChat(agentId, projectId); pageName = Page.Chats.name; showHistory = false } }
    BackHandler(enabled = page != Page.Home || executionChat != null || showHistory) {
        when { executionChat != null -> executionChat = null; showHistory -> showHistory = false; else -> pageName = Page.Home.name }
    }
    val keyboard = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    val expanded = LocalConfiguration.current.screenWidthDp >= 600
    Row(Modifier.fillMaxSize().background(MeloBackground)) {
    if (expanded) NavigationRail(containerColor = MeloBackground, modifier = Modifier.fillMaxHeight()) {
        Spacer(Modifier.height(24.dp))
        navigation.forEach { item -> NavigationRailItem(selected = page == item.page, onClick = { pageName = item.page.name }, icon = { Icon(item.icon, null) }, label = { Text(item.label) }) }
    }
    Scaffold(modifier = Modifier.weight(1f), containerColor = MeloBackground, contentWindowInsets = WindowInsets.systemBars,
        bottomBar = { if (!keyboard && !expanded) NavigationBar(containerColor = MeloBackground) {
            navigation.forEach { item -> NavigationBarItem(selected = page == item.page, onClick = { pageName = item.page.name }, icon = { Icon(item.icon, null) }, label = { Text(item.label) }) }
        } },
        topBar = { if (page != Page.Home) TopAppBar(title = { Text(if (executionChat != null) "任务空间" else when (page) {
            Page.Chats -> data.chats.find { it.id == chatId }?.title ?: "对话"; Page.Agents -> "角色"; Page.Workspace -> "工作区"; Page.Settings -> "系统"; Page.Tasks -> "任务与执行"; Page.Device -> "手机助手"; else -> "Melo"
        }, maxLines = 1) }, colors = TopAppBarDefaults.topAppBarColors(containerColor = MeloBackground), navigationIcon = {
            IconButton(onClick = { if (executionChat != null) executionChat = null else if (page == Page.Chats) showHistory = !showHistory else pageName = Page.Home.name }) {
                Icon(if (page == Page.Chats && executionChat == null) Icons.Outlined.History else Icons.AutoMirrored.Outlined.ArrowBack, "返回或历史")
            }
        }, actions = { if (page == Page.Chats) { IconButton(onClick = { pageName = Page.Device.name }) { Icon(Icons.Outlined.TouchApp, "手机助手") }; IconButton(onClick = { newChat() }) { Icon(Icons.Outlined.Add, "新对话") }; IconButton(onClick = { executionChat = chatId }) { Icon(Icons.Outlined.Hub, "任务空间") } } }) }
    ) { padding ->
        CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, LocalDensity.current.fontScale * data.settings.fontScale)) {
            Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding(), contentAlignment = Alignment.TopCenter) {
            Box(Modifier.fillMaxHeight().widthIn(max = 1040.dp).fillMaxWidth()) {
                if (!runtime.initialized) Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) { CircularProgressIndicator(); Text("载入本机资料…") }
                else if (executionChat != null) ExecutionScreen(data, executionChat!!, onOpen = { openUrl(context, it) })
                else when (page) {
                    Page.Home -> HomeScreen(data, runtime, onNewChat = { newChat() }, onPage = { pageName = it.name })
                    Page.Chats -> {
                        val selected = data.chats.find { it.id == chatId }
                        if (showHistory || selected == null) HistoryScreen(data, onSelect = { chatId = it; showHistory = false }, onNew = { newChat() }, onArchive = { id -> vm.engine.work { vm.repository.editChat(id) { it.copy(archived = !it.archived) } } }, onDelete = { id -> vm.engine.work { vm.repository.deleteChat(id) } })
                        else ChatScreen(selected, data, runtime, vm, onSend = { text, images ->
                            if (android.os.Build.VERSION.SDK_INT >= 33) notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                            vm.engine.send(selected.id, text, images)
                        }, onExecution = { executionChat = selected.id })
                    }
                    Page.Agents -> AgentsScreen(data, vm, onChat = { newChat(it) })
                    Page.Workspace -> WorkspaceScreen(data, vm, onChat = { newChat(projectId = it) })
                    Page.Settings -> SettingsScreen(data, runtime, vm)
                    Page.Device -> DeviceAgentScreen(data)
                    Page.Tasks -> TasksScreen(data, vm, onChat = { chatId = it; pageName = Page.Chats.name }, onExecution = { executionChat = it })
                }
                runtime.error?.let { message -> AlertDialog(onDismissRequest = vm.engine::dismissError, title = { Text("未完成") }, text = { Text(message) }, confirmButton = { TextButton(onClick = vm.engine::dismissError) { Text("知道了") } }) }
                deviceRuntime.error?.let { message -> AlertDialog(onDismissRequest = deviceAgent::dismissError, title = { Text("手机助手未完成") }, text = { Text(message) }, confirmButton = { TextButton(onClick = deviceAgent::dismissError) { Text("知道了") } }) }
                deviceRuntime.approval?.let { pending -> AlertDialog(onDismissRequest = { deviceAgent.confirmApproval(pending.id, false) }, title = { Text("确认本步${pending.action}") }, text = { Text("请核对当前屏幕和你的目标。允许只用于这一步；屏幕或目标改变后需要重新观察。也可在目标 App 上使用 Melo 悬浮按钮确认。") }, confirmButton = { TextButton(onClick = { deviceAgent.confirmApproval(pending.id, true) }) { Text("允许本步") } }, dismissButton = { TextButton(onClick = { deviceAgent.confirmApproval(pending.id, false) }) { Text("拒绝并停止") } }) }
            }
            }
        }
    }
    }
}

@Composable private fun HomeScreen(data: AppData, runtime: ChatRuntime, onNewChat: () -> Unit, onPage: (Page) -> Unit) {
    LazyColumn(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, contentPadding = PaddingValues(20.dp)) {
        item { Spacer(Modifier.height(20.dp)); Text("Melo", style = MaterialTheme.typography.headlineLarge, color = MeloGold); Text("想法在这里连接", color = MeloMuted) }
        item { SharedScene(buildJsonObject { put("selected", 0); put("compact", false); put("still", data.settings.reduceMotion); put("transmitting", runtime.busyChatId != null) }, Modifier.fillMaxWidth().height(300.dp), onSelect = { id -> onPage(when (id) { 1 -> Page.Chats; 4 -> Page.Agents; 2 -> Page.Workspace; 5 -> Page.Tasks; else -> Page.Settings }) }) }
        item { FilledTonalButton(onClick = onNewChat, modifier = Modifier.fillMaxWidth().widthIn(max = 500.dp)) { Icon(Icons.Outlined.Add, null); Spacer(Modifier.width(8.dp)); Text("开始新对话") }; Spacer(Modifier.height(16.dp)) }
        item { OutlinedButton(onClick = { onPage(Page.Device) }, modifier = Modifier.fillMaxWidth().widthIn(max = 500.dp)) { Icon(Icons.Outlined.TouchApp, null); Spacer(Modifier.width(8.dp)); Text("手机助手") }; Spacer(Modifier.height(12.dp)) }
        item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) { TextButton(onClick = { onPage(Page.Agents) }) { Text("角色") }; TextButton(onClick = { onPage(Page.Workspace) }) { Text("工作区") }; TextButton(onClick = { onPage(Page.Tasks) }) { Text("任务空间") }; TextButton(onClick = { onPage(Page.Settings) }) { Text("系统") } } }
        item { Text("${data.chats.size} 段对话 · ${data.agents.size} 个角色 · 保存在本机", color = MeloMuted, style = MaterialTheme.typography.bodySmall) }
        if (data.settings.connections.isEmpty()) item { TextButton(onClick = { onPage(Page.Settings) }) { Text("配置模型连接") } }
    }
}

@Composable private fun HistoryScreen(data: AppData, onSelect: (String) -> Unit, onNew: () -> Unit, onArchive: (String) -> Unit, onDelete: (String) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var archived by rememberSaveable { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<Conversation?>(null) }
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        OutlinedTextField(query, { query = it }, label = { Text("搜索对话与正文") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        Row(verticalAlignment = Alignment.CenterVertically) { FilterChip(selected = archived, onClick = { archived = !archived }, label = { Text(if (archived) "已归档" else "当前对话") }); Spacer(Modifier.weight(1f)); TextButton(onClick = onNew) { Text("新建") } }
        val rows = data.chats.filter { it.archived == archived && (query.isBlank() || it.title.contains(query, true) || it.messages.any { m -> m.content.contains(query, true) }) }.sortedWith(compareByDescending<Conversation> { it.pinned }.thenByDescending { it.updatedAt })
        if (rows.isEmpty()) EmptyPage(if (data.chats.isEmpty()) "还没有对话" else "没有匹配的对话", "从新对话开始，或调整搜索条件。")
        LazyColumn { items(rows, key = { it.id }) { chat ->
            ListItem(headlineContent = { Text(chat.title) }, supportingContent = { Text(chat.messages.lastOrNull()?.content.orEmpty().take(100), maxLines = 2) }, modifier = Modifier.clickable { onSelect(chat.id) }, trailingContent = {
                Row { IconButton(onClick = { onArchive(chat.id) }) { Icon(Icons.Outlined.Archive, "归档或恢复") }; IconButton(onClick = { deleting = chat }) { Icon(Icons.Outlined.DeleteOutline, "删除对话") } }
            }); HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        } }
    }
    deleting?.let { chat -> AlertDialog(onDismissRequest = { deleting = null }, title = { Text("删除「${chat.title}」？") }, text = { Text("删除标记会参与同步，其他设备的旧副本不会恢复它。") }, confirmButton = { TextButton(onClick = { onDelete(chat.id); deleting = null }) { Text("删除") } }, dismissButton = { TextButton(onClick = { deleting = null }) { Text("保留") } }) }
}

@Composable private fun ChatScreen(chat: Conversation, data: AppData, runtime: ChatRuntime, vm: MeloViewModel, onSend: (String, List<Attachment>) -> Unit, onExecution: () -> Unit) {
    var draft by rememberSaveable(chat.id) { mutableStateOf(data.drafts[chat.id].orEmpty()) }
    var images by rememberSaveable(chat.id, stateSaver = Saver<List<Attachment>, String>(
        save = { MeloJson.encodeToString(it) }, restore = { MeloJson.decodeFromString<List<Attachment>>(it) }
    )) { mutableStateOf<List<Attachment>>(emptyList()) }
    var options by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val focus = LocalFocusManager.current
    val turn = runtime.turns[chat.id]
    val deviceAgent = (context.applicationContext as MeloApplication).deviceAgent
    val deviceRuntime by deviceAgent.runtime.collectAsStateWithLifecycle()
    val deviceRuns = data.deviceRuns.filter { it.taskContext?.chatId == chat.id }
    val timeline = remember(chat.messages, deviceRuns) {
        (chat.messages.map { ChatTimelineItem("message-${it.id}", it.createdAt, message = it) } + deviceRuns.map { ChatTimelineItem("device-${it.id}", it.startedAt, device = it) })
            .sortedBy { runCatching { java.time.Instant.parse(it.at).toEpochMilli() }.getOrDefault(0L) }
    }
    val deviceBusy = deviceRuntime.running && deviceRuntime.chatId == chat.id
    val busy = turn != null || deviceBusy
    var deviceMode by rememberSaveable(chat.id) { mutableStateOf(false) }
    var screenshots by rememberSaveable(chat.id) { mutableStateOf(true) }
    var forceProbe by rememberSaveable(chat.id) { mutableStateOf(false) }
    var scriptLibrary by remember { mutableStateOf(false) }
    val list = rememberLazyListState()
    var speech by remember { mutableStateOf<TextToSpeech?>(null) }
    DisposableEffect(context) { val instance = TextToSpeech(context) { }; speech = instance; onDispose { instance.stop(); instance.shutdown() } }
    val dictation = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == android.app.Activity.RESULT_OK) result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.let { draft = if (draft.isBlank()) it else "$draft $it" }
    }
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(4)) { uris -> vm.engine.work { images = (images + uris.map { vm.repository.importImage(it) }).take(4) } }
    LaunchedEffect(chat.id, draft) { delay(350); vm.engine.work { vm.repository.draft(chat.id, draft) } }
    LaunchedEffect(turn?.runId) { if (turn?.runId != null) { draft = ""; images = emptyList(); focus.clearFocus() } }
    LaunchedEffect(deviceRuntime.runId) { if (deviceBusy && deviceRuntime.runId != null) { draft = ""; focus.clearFocus() } }
    LaunchedEffect(chat.messages.size, turn?.partial?.length, deviceRuns.lastOrNull()?.steps?.size) { if (list.layoutInfo.totalItemsCount > 0) list.animateScrollToItem(list.layoutInfo.totalItemsCount - 1) }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            val agent = data.agents.find { it.id == chat.agentId }
            Text(agent?.name ?: "Melo", color = MeloGold)
            Text(" · " + (data.settings.connections.find { it.id == (chat.connectionId ?: data.settings.activeConnection) }?.model?.ifBlank { "未配置模型" } ?: "未配置模型"), color = MeloMuted, maxLines = 1, modifier = Modifier.weight(1f))
            IconButton(onClick = { options = true }, enabled = !busy) { Icon(Icons.Outlined.Tune, "对话设置") }
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 16.dp), state = list, verticalArrangement = Arrangement.spacedBy(14.dp), contentPadding = PaddingValues(vertical = 12.dp)) {
            if (chat.messages.isEmpty() && deviceRuns.isEmpty()) item { EmptyPage("开始这段对话", "消息与草稿保存在这台设备；模型服务需要网络。") }
            items(timeline, key = { it.id }) { row ->
                val deviceRun = row.device
                if (deviceRun != null) DeviceTaskCard(deviceRun, active = deviceRuntime.running && deviceRuntime.runId == deviceRun.id, phase = deviceRuntime.phase, onCancel = deviceAgent::cancel)
                else {
                val message = row.message!!
                Column(Modifier.fillMaxWidth(), horizontalAlignment = if (message.role == "user") Alignment.End else Alignment.Start) {
                    Text(if (message.role == "user") "你" else agentName(data, chat), color = MeloMuted, style = MaterialTheme.typography.labelSmall)
                    Surface(color = if (message.role == "user") MeloGold.copy(alpha = .10f) else MeloSurface, shape = RoundedCornerShape(16.dp), modifier = Modifier.widthIn(max = 760.dp)) {
                        Column(Modifier.padding(14.dp)) { SelectionContainer { ReplyText(message.content) }; if (message.attachments.isNotEmpty()) Text("${message.attachments.size} 张参考图片", color = MeloGold) }
                    }
                    if (message.role == "assistant") Row {
                        TextButton(onClick = { speech?.language = Locale.getDefault(); speech?.speak(message.content, TextToSpeech.QUEUE_FLUSH, null, message.id) }) { Text("朗读") }
                        TextButton(onClick = { context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, message.content), "分享回复")) }) { Text("分享") }
                        if (message.runId != null) TextButton(onClick = onExecution) { Text("执行记录") }
                    }
                }
                }
            }
            if (turn != null) item { Column { Text(if (turn.partial.isBlank()) "正在等待服务…" else turn.partial); Text("生成中 · 尚未保存为完整回复", color = MeloMuted, style = MaterialTheme.typography.labelSmall) } }
            val failed = data.runs.lastOrNull { it.chatId == chat.id && it.status in setOf("failed", "cancelled", "interrupted") }
            if (!busy && failed != null && chat.messages.lastOrNull()?.role == "user") item {
                Column { Text(failed.error ?: "上次请求未完成。", color = MaterialTheme.colorScheme.error); if (failed.partial.isNotBlank()) Text(failed.partial, color = MeloMuted); TextButton(onClick = { vm.engine.send(chat.id, "", retry = true) }) { Text("重试这次提问") } }
            }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            FilterChip(selected = !deviceMode, onClick = { deviceMode = false }, label = { Text("对话") }, enabled = !busy)
            Spacer(Modifier.width(8.dp))
            FilterChip(selected = deviceMode, onClick = { deviceMode = true }, label = { Text("操作手机") }, enabled = !busy, modifier = Modifier.testTag("device-mode"))
            if (deviceMode) { Spacer(Modifier.weight(1f)); TextButton(onClick = { scriptLibrary = true }, modifier = Modifier.testTag("chat-cache-open")) { Text("操作缓存") } }
        }
        if (deviceMode) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                FilterChip(selected = forceProbe, onClick = { forceProbe = !forceProbe }, label = { Text("强制 Probe") }, enabled = !busy, modifier = Modifier.testTag("force-probe"))
                Spacer(Modifier.weight(1f)); Text("截图", color = MeloMuted); Switch(screenshots, { screenshots = it }, enabled = !busy)
            }
            Text("优先匹配本机缓存；Similar / Probe 会将目标和界面文字${if (screenshots) "、截图" else ""}发送给所选模型。验证成功的可重放步骤自动缓存，输入默认参数化。", Modifier.padding(horizontal = 12.dp), color = MeloMuted, style = MaterialTheme.typography.bodySmall)
        }
        if (images.isNotEmpty()) Row(Modifier.padding(horizontal = 12.dp)) { Text("已选 ${images.size} 张图片", color = MeloGold); TextButton(onClick = { images = emptyList() }) { Text("移除") } }
        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.Bottom) {
            IconButton(onClick = { photos.launch(androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, enabled = !busy && !deviceMode) { Icon(Icons.Outlined.AddPhotoAlternate, "添加图片") }
            OutlinedTextField(draft, { draft = it }, placeholder = { Text(if (deviceMode) "希望手机帮你做什么？" else "输入消息…") }, modifier = Modifier.weight(1f).testTag("composer"), maxLines = 6, shape = RoundedCornerShape(20.dp))
            IconButton(onClick = { try { dictation.launch(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM).putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)) } catch (_: Exception) { vm.engine.work { error("此设备没有可用的系统语音输入服务，可使用键盘麦克风。") } } }, enabled = !busy) { Icon(Icons.Outlined.MicNone, "语音输入") }
            IconButton(onClick = {
                when {
                    deviceBusy -> deviceAgent.cancel()
                    turn != null -> vm.engine.cancel(chat.id)
                    deviceMode -> if (images.isNotEmpty()) vm.engine.work { error("操作手机使用实时屏幕，请先移除已选参考图片。") } else deviceAgent.start(draft, 0, screenshots, chatId = chat.id, forceProbe = forceProbe)
                    else -> onSend(draft, images)
                }
            }, enabled = busy || draft.isNotBlank() || !deviceMode && images.isNotEmpty()) { Icon(if (busy) Icons.Outlined.StopCircle else Icons.AutoMirrored.Outlined.Send, if (busy) "停止生成" else "发送", tint = MeloGold) }
        }
    }
    if (options) ChatOptions(chat, data, vm) { options = false }
    if (scriptLibrary) DeviceScriptLibrary(data, deviceAgent, { scriptLibrary = false }) { script, values ->
        deviceAgent.start(script.goalTemplate, 0, screenshots, chatId = chat.id, scriptId = script.id, parameters = values)
    }
}

private fun agentName(data: AppData, chat: Conversation) = data.agents.find { it.id == chat.agentId }?.name ?: "Melo"
@Composable private fun ReplyText(text: String) {
    val content = buildAnnotatedString {
        val links = Regex("https?://[^\\s<>\\)\\]]+").findAll(text).toList(); var position = 0
        links.forEach { link -> append(text.substring(position, link.range.first)); withLink(LinkAnnotation.Url(link.value)) { append(link.value) }; position = link.range.last + 1 }; append(text.substring(position))
    }
    Text(content, style = MaterialTheme.typography.bodyLarge)
}
@Composable fun EmptyPage(title: String, detail: String) { Column(Modifier.fillMaxWidth().padding(vertical = 36.dp), horizontalAlignment = Alignment.CenterHorizontally) { Text(title, style = MaterialTheme.typography.titleMedium); Spacer(Modifier.height(8.dp)); Text(detail, color = MeloMuted, modifier = Modifier.padding(horizontal = 12.dp)) } }
fun openUrl(context: android.content.Context, url: String) {
    val uri = Uri.parse(url)
    if (uri.scheme in setOf("https", "http") && uri.userInfo == null) runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
}
