package com.melo.android

import android.app.UiAutomation
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import androidx.test.core.app.ApplicationProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.melo.android.data.*
import com.melo.android.device.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** Opt-in live evaluation through production entry points, never a selected recipe.
 * Emulator only: mobileBenchmark=true, case=browser_search, entry=device|chat.
 */
class MobileTaskBenchmarkTest {
    @Test fun repeatedNaturalLanguageTaskMeasuresActualCacheAndWallTime() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue("Explicit live benchmark opt-in required", args.getString("mobileBenchmark") == "true")
        check(Build.FINGERPRINT.contains("generic") || Build.MODEL.contains("sdk_gphone")) { "Emulator required" }
        val app = ApplicationProvider.getApplicationContext<MeloApplication>()
        val runTag = args.getString("runTag") ?: newId()
        val reportCase = args.getString("case") ?: "browser_search"
        val reportEntry = args.getString("entry") ?: "device"
        File(app.filesDir, "mobile-benchmark-$reportCase-$reportEntry.json").writeText(buildJsonObject { put("runTag", runTag); put("status", "initializing"); put("appVersion", BuildConfig.VERSION_NAME); put("results", JsonArray(emptyList())) }.toString())
        // Surface storage/setup failures directly, rather than timing out and
        // accidentally leaving an older benchmark report to be read by the host.
        app.repository.initialize()
        val ready = withTimeout(15_000) { app.engine.runtime.first { it.initialized || it.error != null } }
        check(ready.initialized) { ready.error.orEmpty() }
        check(app.repository.credential("bedrock-opus-smoke").length >= 20) { "Configure emulator Bedrock credential first" }
        val connection = Connection(id = "bedrock-opus-smoke", name = "Bedrock Opus 5.5 us-west-2", endpoint = "https://bedrock-runtime.us-west-2.amazonaws.com/anthropic/v1/messages", model = "us.anthropic.claude-opus-5-5", protocol = "anthropic", stream = false, contextTokens = 400000)
        app.repository.saveConnection(connection, null)
        app.repository.change { it.copy(settings = it.settings.copy(activeConnection = connection.id)) }
        val case = args.getString("case") ?: "browser_search"
        val entry = args.getString("entry") ?: "device"
        require(entry in setOf("device", "chat"))
        val query = args.getString("query") ?: if (case == "browser_search") "Android Accessibility ACTION_IME_ENTER" else "shared core"
        val goal = when (case) {
            "launch" -> "打开 Chrome 浏览器，确认它已经显示并停留当前页面；不要搜索、登录或修改设置。"
            "browser_search" -> "使用 Chrome 浏览器在 Google 搜索 $query，停留在包含相关结果的搜索结果页，不打开广告，不登录。"
            "browser_article" -> "使用 Chrome 浏览器打开 https://example.com，点击网页的 More information 链接，停留在 IANA 的 Example Domains 说明页；确认看到域名说明。不登录、不修改设置。"
            "browser_back" -> "使用 Chrome 打开 https://example.com，点击 More information 阅读 IANA 说明，然后返回 example.com 并停留在 Example Domain 页面。不登录。"
            "local_search" -> "使用 Chrome 打开 http://10.0.2.2:8892，在网页搜索框搜索 $query，提交搜索，打开第一条结果并停留详情页。用详情页可见的 Result detail 和查询词核对完成；不要登录或改设置。"
            "settings_search" -> "打开 Android 设置，使用设置搜索 Bluetooth，停留在实际的搜索结果列表；不要切换任何系统开关。"
            "navigation_fixture" -> "在当前 Navigation Fixture 测试页面，用已经保存的 Home 开始开车导航。确认导航已经开始后停止操作；不要打开路线详情，也不要关闭导航。这是本地测试，不需要查询真实地址。"
            else -> error("Unknown benchmark case")
        }
        val automation = InstrumentationRegistry.getInstrumentation().getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        fun shell(command: String): String = automation.executeShellCommand(command).use { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { reader -> reader.readText().trim() } }
        val before = shell("settings get secure enabled_accessibility_services").takeUnless { it == "null" }.orEmpty()
        val serviceName = "com.melo.android/com.melo.android.device.MeloAccessibilityService"
        val services = (before.split(':').filter(String::isNotBlank) + serviceName).distinct().joinToString(":")
        shell("settings put secure enabled_accessibility_services $services")
        shell("settings put secure accessibility_enabled 1")
        withTimeout(15_000) { while (DeviceAccess.service == null) delay(100) }
        val scopeName = args.getString("scope") ?: newId()
        require(scopeName.matches(Regex("[A-Za-z0-9_-]{1,80}")))
        val agentId = "benchmark-$scopeName"
        app.repository.change { state ->
            if (state.agents.any { it.id == agentId }) state else state.copy(agents = state.agents + state.agents.first().copy(id = agentId, name = "Melo benchmark"))
        }
        val chatId = app.repository.newChat(agentId = agentId)
        app.repository.change { current -> current.copy(chats = current.chats.map { if (it.id == chatId) it.copy(connectionId = connection.id, model = connection.model, modelMode = "fixed", phoneUseEnabled = true) else it }) }
        val rows = mutableListOf<JsonObject>()
        val output = File(app.filesDir, "mobile-benchmark-$case-$entry.json")
        fun save() { output.writeText(buildJsonObject { put("case", case); put("entry", entry); put("runTag", runTag); put("scope", scopeName); put("goal", goal); put("appVersion", BuildConfig.VERSION_NAME); put("results", JsonArray(rows)) }.toString()) }
        save()
        var navigationFixture: ActivityScenario<NavigationFixtureActivity>? = null
        try {
            repeat((args.getString("repeats")?.toIntOrNull() ?: 2).coerceIn(1, 4)) { iteration ->
                // Both attempts begin outside the target App with a cold process.
                withContext(Dispatchers.Main) { app.deviceAgent.cancel(); DeviceAccess.service?.end() }
                // Normalize the last tab, too: Chrome restores it after a stop.
                if (case.startsWith("browser_") || case == "local_search") {
                    shell("am start -W -a android.intent.action.VIEW -d http://10.0.2.2:8893/blank -p com.android.chrome")
                    delay(2000)
                    val baseline = withContext(Dispatchers.Main) {
                        val service = DeviceAccess.service!!; service.begin(0, false)
                        try { service.execute(buildJsonObject { put("action", "observe") }) } finally { service.end() }
                    }
                    check(baseline.data.toString().contains("Benchmark start page")) { "Browser baseline did not load" }
                }
                shell("am force-stop com.android.chrome")
                if (case == "settings_search") {
                    shell("am force-stop com.android.settings")
                    shell("am force-stop com.google.android.settings.intelligence")
                }
                shell("input keyevent HOME")
                val initialDeviceIds = app.repository.data.value.deviceRuns.map { it.id }.toSet()
                val initialRunIds = app.repository.data.value.runs.map { it.id }.toSet()
                val initialScriptIds = app.repository.data.value.deviceScripts.map { it.id }.toSet()
                var unexpected: String? = null
                if (entry == "chat") {
                    // Native foreground lease only; real ChatEngine below owns
                    // planning, registration, model calls and device execution.
                    if (case == "navigation_fixture") {
                        navigationFixture?.close()
                        navigationFixture = ActivityScenario.launch(Intent(app, NavigationFixtureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
                    } else withContext(Dispatchers.Main) { app.startActivity(Intent(app, DeviceFixtureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                    delay(500)
                    if (case == "navigation_fixture") {
                        val baseline = withContext(Dispatchers.Main) {
                            val service = DeviceAccess.service!!; service.begin(0, false)
                            try { service.execute(buildJsonObject { put("action", "observe") }) } finally { service.end() }
                        }
                        check(baseline.data.toString().contains("Saved places") && !app.getSharedPreferences("navigation-fixture", android.content.Context.MODE_PRIVATE).getBoolean("active", false)) { "Navigation fixture baseline was not reset" }
                    }
                }
                val start = SystemClock.elapsedRealtime()
                try {
                    withTimeout(210_000) {
                        if (entry == "device") {
                            check(withContext(Dispatchers.Main) { app.deviceAgent.start(goal, 0, true, chatId = chatId) })
                            while (app.deviceAgent.runtime.value.running) {
                                if (app.deviceAgent.runtime.value.approval != null) error("WAITING_FOR_APPROVAL: ${app.deviceAgent.runtime.value.approval?.action}")
                                delay(100)
                            }
                        } else {
                            check(withContext(Dispatchers.Main) { app.engine.send(chatId, goal) })
                            while (app.engine.runtime.value.turns.containsKey(chatId)) {
                                if (app.deviceAgent.runtime.value.approval != null) error("WAITING_FOR_APPROVAL: ${app.deviceAgent.runtime.value.approval?.action}")
                                delay(100)
                            }
                        }
                    }
                } catch (error: Exception) {
                    unexpected = error.message?.take(500) ?: error::class.simpleName
                    withContext(NonCancellable + Dispatchers.Main) { app.deviceAgent.cancel(); app.engine.cancel(chatId) }
                    delay(300)
                }
                val elapsed = SystemClock.elapsedRealtime() - start
                val state = app.repository.data.value
                val devices = state.deviceRuns.filter { it.id !in initialDeviceIds }
                val chats = state.runs.filter { it.id !in initialRunIds }
                val scripts = state.deviceScripts.filter { it.id !in initialScriptIds }
                val device = devices.lastOrNull()
                val chat = chats.lastOrNull()
                val status = if (entry == "device") device?.status else chat?.status
                val snapshot = withContext(Dispatchers.Main) {
                    val service = DeviceAccess.service!!; service.begin(0, false)
                    try { service.execute(buildJsonObject { put("action", "observe") }) } finally { service.end() }
                }
                val labels = (snapshot.data["nodes"] as? JsonArray).orEmpty().map { it.jsonObject.text("text") }.filter(String::isNotBlank)
                val visibleGoal = snapshot.ok && when (case) {
                    "launch" -> snapshot.data.text("package_name") == "com.android.chrome"
                    "browser_search" -> query in labels && labels.any { it == "Search Results" || it == "搜索结果" }
                    "browser_article" -> "Example Domains" in labels && labels.any { it.contains("iana.org/help/example-domains") }
                    "browser_back" -> "Example Domain" in labels && labels.any { it == "example.com" || it == "https://example.com" }
                    "local_search" -> "Result detail" in labels && query in labels
                    "settings_search" -> labels.any { it.contains("Bluetooth") } && snapshot.data.text("package_name") in setOf("com.android.settings", "com.google.android.settings.intelligence")
                    "navigation_fixture" -> "Navigation active" in labels && app.getSharedPreferences("navigation-fixture", android.content.Context.MODE_PRIVATE).let { it.getBoolean("active", false) && it.getString("destination", "") == "Home" && it.getInt("unexpected", 0) == 0 }
                    else -> false
                }
                // Count wire requests, including the completion checker that is
                // separate from the user-visible model pipeline. Missing Trace
                // is unknown, never a zero-request measurement.
                val ids = (devices.map { it.id } + chats.map { it.id }).toSet()
                val traceEvents = File(app.filesDir, "traces").listFiles().orEmpty().flatMap { directory ->
                    val manifest = runCatching { MeloJson.parseToJsonElement(File(directory, "manifest.json").readText()).jsonObject }.getOrNull()
                    if (manifest?.text("runId") !in ids) emptyList() else runCatching {
                        File(directory, "events.jsonl").useLines { lines -> lines.mapNotNull { line -> runCatching { MeloJson.parseToJsonElement(line).jsonObject }.getOrNull() }.toList() }
                    }.getOrDefault(emptyList())
                }
                fun requests(runIds: Set<String>): JsonElement = if (runIds.isEmpty()) JsonPrimitive(0) else {
                    if (!runIds.all { id -> traceEvents.any { it.text("runId") == id } }) JsonNull
                    else JsonPrimitive(traceEvents.count { it.text("type") == "model.request.started" && it.text("runId") in runIds })
                }
                rows += buildJsonObject {
                    put("iteration", iteration + 1); put("wallMs", elapsed); put("status", status ?: "missing"); unexpected?.let { put("exception", it) }
                    put("runId", chat?.id ?: device?.id.orEmpty()); put("childModelCalls", devices.sumOf { it.modelRequests ?: 0 })
                    put("rootModelCalls", chats.sumOf { row -> (row.sharedScene?.get("pipeline") as? JsonArray).orEmpty().count { it.jsonObject.text("id").startsWith("model:") } })
                    put("rootWireRequests", requests(chats.map { it.id }.toSet())); put("childWireRequests", requests(devices.filter { it.executionMode != "unified" }.map { it.id }.toSet()))
                    put("unifiedDeviceSessions", devices.count { it.executionMode == "unified" }); put("visibleGoalVerified", visibleGoal)
                    put("parentTools", JsonArray(chats.flatMap { row -> (row.sharedScene?.get("operations") as? JsonArray).orEmpty().map { it.jsonObject.text("name").jp() } }))
                    put("deviceRuns", JsonArray(devices.map { row -> buildJsonObject {
                        put("id", row.id); put("status", row.status); put("mode", row.executionMode); put("modelCalls", row.modelRequests ?: 0); put("cacheId", row.cacheId.orEmpty()); put("cacheNote", row.cacheNote)
                        put("cacheLookupMs", row.cacheLookupMs); put("cacheReplayMs", row.cacheReplayMs); put("probeMs", row.cacheFallbackMs)
                        put("error", row.error.orEmpty()); put("summary", row.answer)
                        put("actions", JsonArray(row.steps.map { step -> buildJsonObject { put("action", step.action); put("ok", step.ok); put("code", step.code); put("ms", step.durationMs) } }))
                    } }))
                    put("published", JsonArray(scripts.map { script -> buildJsonObject { put("id", script.id); put("kind", script.cacheKind); put("goalTemplate", script.goalTemplate); put("parameters", JsonArray(script.parameters.map(::JsonPrimitive))); put("actions", JsonArray(script.steps.map { it.action.jp() })) } }))
                    put("package", snapshot.data.text("package_name"))
                    put("visibleLabels", JsonArray(labels.take(35).map { it.take(200).jp() }))
                    put("answer", chat?.partial.orEmpty()); put("error", chat?.error.orEmpty())
                }
                save()
            }
            assertTrue("A task did not achieve its independently checked visible goal; inspect local benchmark JSON", rows.all { it.text("status") in setOf("achieved", "completed") && it["exception"] == null && it["visibleGoalVerified"]?.jsonPrimitive?.booleanOrNull == true })
        } finally {
            withContext(NonCancellable + Dispatchers.Main) { app.deviceAgent.cancel(); app.engine.cancel(chatId); DeviceAccess.service?.end() }
            navigationFixture?.close()
            if (before.isBlank()) shell("settings delete secure enabled_accessibility_services") else shell("settings put secure enabled_accessibility_services $before")
        }
    }
}
