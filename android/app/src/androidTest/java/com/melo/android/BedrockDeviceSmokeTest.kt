package com.melo.android

import android.app.UiAutomation
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.melo.android.core.LoopTrace
import com.melo.android.core.SharedCoreTurn
import com.melo.android.data.*
import com.melo.android.device.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** Explicit opt-in live smoke. Emulator only; no credentials are bundled or logged.
 * Supply cache/bedrock-smoke-key through run-as stdin, then -e bedrockSmoke true.
 * The one-time plaintext inbox is removed before starting any model request.
 */
class BedrockDeviceSmokeTest {
    @Test fun realModelCanSearchAndFinishUsingProductionDeviceTools() = runBlocking {
        val arguments = InstrumentationRegistry.getArguments()
        assumeTrue("Live smoke requires explicit opt-in", arguments.getString("bedrockSmoke") == "true")
        check(Build.FINGERPRINT.contains("generic") || Build.MODEL.contains("sdk_gphone")) { "Live smoke cannot operate a physical phone" }
        val app = ApplicationProvider.getApplicationContext<MeloApplication>()
        withTimeout(15_000) { app.engine.runtime.first { it.initialized } }
        val inbox = File(app.cacheDir, "bedrock-smoke-key")
        check(inbox.isFile) { "Missing one-time credential inbox" }
        val key = try { inbox.readText().trim() } finally { check(inbox.delete()) }
        check(key.length in 20..4096 && key.none(Char::isWhitespace))
        val connection = Connection(id = "bedrock-opus-smoke", name = "Bedrock Opus 5.5 us-west-2", endpoint = "https://bedrock-runtime.us-west-2.amazonaws.com/anthropic/v1/messages", model = "us.anthropic.claude-opus-5-5", protocol = "anthropic", stream = false, contextTokens = 400000)
        app.repository.saveConnection(connection, key)
        app.repository.change { it.copy(settings = it.settings.copy(activeConnection = connection.id)) }
        val automation = InstrumentationRegistry.getInstrumentation().getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        fun shell(command: String): String = automation.executeShellCommand(command).use { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { reader -> reader.readText().trim() } }
        val before = shell("settings get secure enabled_accessibility_services").takeUnless { it == "null" }.orEmpty()
        val serviceName = "com.melo.android/com.melo.android.device.MeloAccessibilityService"
        val services = (before.split(':').filter(String::isNotBlank) + serviceName).distinct().joinToString(":")
        shell("settings put secure enabled_accessibility_services $services")
        shell("settings put secure accessibility_enabled 1")
        val end = SystemClock.elapsedRealtime() + 15_000
        while (DeviceAccess.service == null && SystemClock.elapsedRealtime() < end) delay(100)
        checkNotNull(DeviceAccess.service)
        val target = arguments.getString("target") ?: "fixture"
        val realApp = target != "fixture"
        val goal = if (target == "settings") "打开 Android Settings，使用设置中的搜索输入框搜索 Bluetooth，提交搜索并停留在包含 Bluetooth 条目的搜索结果页。不要切换蓝牙或任何系统设置。终态需要实际结果列表，不能只核对输入框文字。"
        else if (target == "youtube") "打开 YouTube Music，在 App 内搜索浅影阿的牡丹亭，提交搜索并检查实际结果。不要播放、登录、购买或订阅。看到结果时报告歌曲和歌手；无结果或登录阻碍要如实报告。输入不等于提交，使用返回节点的 submit_input 或可见搜索按钮。"
        else "在当前测试页面找到 Fixture input，输入浅影阿 牡丹亭，然后使用输入框的 Search 动作提交。只有看到 Search result: 后面跟刚才完整的查询词才完成；不要播放或操作别的 App。"
        File(app.filesDir, "bedrock-smoke-result.json").writeText(buildJsonObject { put("target", target); put("status", "running") }.toString())
        val steps = mutableListOf<DeviceStep>()
        val recorder = ScriptRecorder(goal)
        var modelCalls = 0
        try {
            if (!realApp) { app.startActivity(Intent(app, DeviceFixtureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)); delay(1000) }
            val service = DeviceAccess.service!!
            withContext(Dispatchers.Main) { service.begin(0, true) }
            val id = newId()
            val result = withTimeout(240_000) {
                LoopTrace.run(app, id, "device", goal, outcome = { outcome: DeviceOutcome -> outcome.status }) {
                    SharedCoreTurn.open(app, id, id, listOf("android_device"), 20, callsPerRound = 1).use { core ->
                        val client = DeviceAgentClient(true)
                        DeviceTaskLoop("anthropic", { history -> modelCalls++; client.next(connection, key, history) }, service::execute, { steps += it }, maxSteps = 20, onResult = recorder::record, core = core).run(goal)
                    }
                }
            }
            var replayStatus = "not_tested"
            val beforeReplay = modelCalls
            if (!realApp && result.status == "achieved") {
                val script = checkNotNull(recorder.compile("smoke", id)) { "Successful search was not recordable: ${recorder.unsupported}" }
                app.startActivity(Intent(app, DeviceFixtureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)); delay(1000)
                val fresh = service.execute(buildJsonObject { put("action", "observe") })
                check(!fresh.data.toString().contains("Search result: 浅影阿 牡丹亭")) { "Fixture was not reset before replay" }
                replayStatus = ScriptRunner(service::execute).run(script, mapOf("input_1" to "浅影阿 牡丹亭")).outcome.status
                assertEquals("achieved", replayStatus); assertEquals(beforeReplay, modelCalls)
            }
            val report = buildJsonObject {
                put("target", target); put("status", result.status); put("modelCalls", modelCalls); put("cacheReplay", replayStatus); put("cacheModelCalls", modelCalls - beforeReplay)
                put("actions", JsonArray(steps.map { it.action.jp() })); put("error", result.error.orEmpty()); put("verification", result.verification.orEmpty()); put("summary", result.answer)
            }
            File(app.filesDir, "bedrock-smoke-result.json").writeText(report.toString())
            assertTrue("Live task did not complete; inspect local smoke report and Trace", result.status == "achieved")
            if (!realApp) assertTrue("Search was never submitted", steps.any { it.action == "submit_input" && it.ok })
        } catch (error: Exception) {
            File(app.filesDir, "bedrock-smoke-result.json").writeText(buildJsonObject { put("target", target); put("status", "error"); put("errorType", error::class.simpleName); put("modelCalls", modelCalls); put("actions", JsonArray(steps.map { it.action.jp() })) }.toString())
            throw error
        } finally {
            withContext(NonCancellable + Dispatchers.Main) { DeviceAccess.service?.end() }
            if (before.isBlank()) shell("settings delete secure enabled_accessibility_services") else shell("settings put secure enabled_accessibility_services $before")
        }
    }
}
