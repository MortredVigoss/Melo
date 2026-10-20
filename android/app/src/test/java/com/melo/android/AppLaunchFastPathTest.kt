package com.melo.android

import com.melo.android.data.*
import com.melo.android.device.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

class AppLaunchFastPathTest {
    private fun response(protocol: String, id: String, args: JsonObject) = buildJsonObject {
        when (protocol) {
            "responses" -> {
                put("status", "completed")
                put("output", buildJsonArray { add(buildJsonObject { put("type", "function_call"); put("call_id", id); put("name", "android_device"); put("arguments", args.toString()) }) })
            }
            "anthropic" -> {
                put("stop_reason", "tool_use")
                put("content", buildJsonArray { add(buildJsonObject { put("type", "tool_use"); put("id", id); put("name", "android_device"); put("input", args) }) })
            }
            else -> put("choices", buildJsonArray { add(buildJsonObject {
                put("finish_reason", "tool_calls"); put("message", buildJsonObject { put("role", "assistant"); put("tool_calls", buildJsonArray { add(buildJsonObject {
                    put("id", id); put("type", "function"); put("function", buildJsonObject { put("name", "android_device"); put("arguments", args.toString()) })
                }) }) })
            }) })
        }
    }.toString()

    @Test fun namedLaunchUsesTwoModelRequestsAndNoCatalogOrPreflightScreen() = runBlocking {
        for (protocol in listOf("chat-completions", "responses", "anthropic")) MockWebServer().use { server ->
            val catalog = AppCatalog((1..265).map { LaunchableApp("fixture.app$it", "Fixture $it") })
            server.enqueue(MockResponse().setBody(response(protocol, "open", buildJsonObject { put("action", "open_app"); put("app_name", "Fixture 265") })))
            server.enqueue(MockResponse().setBody(response(protocol, "done", buildJsonObject {
                put("action", "finish"); put("outcome", "achieved"); put("summary", "已打开目标 App。"); put("screen_id", "fresh"); put("expected_package", "fixture.app265")
            }))); server.start()
            val connection = Connection(endpoint = server.url("/model").toString(), model = "fixture", protocol = protocol)
            val client = DeviceAgentClient(true); val executed = mutableListOf<String>(); val traces = mutableListOf<DeviceStep>()
            val outcome = DeviceTaskLoop(protocol,
                next = { client.next(connection, "fixture-only-key", it) },
                execute = { args ->
                    executed += args.text("action")
                    if (args.text("action") == "open_app") assertEquals("fixture.app265", catalog.exactName(args.text("app_name")).single().packageName)
                    else assertEquals("observe", args.text("action"))
                    DeviceToolResult(buildJsonObject { put("ok", true); put("screen_id", "fresh"); put("package_name", "fixture.app265"); put("stable", true) })
                }, onStep = { traces += it },
            ).run("打开 Fixture 265")
            assertEquals("achieved", outcome.status); assertEquals("visible_facts", outcome.verification)
            assertEquals(listOf("open_app", "observe"), executed)
            assertEquals(listOf("open_app", "finish"), traces.map { it.action })
            assertEquals(2, server.requestCount)
            repeat(2) {
                val request = server.takeRequest(1, TimeUnit.SECONDS)!!.body.readUtf8()
                assertFalse(request.contains("fixture.app264")); assertFalse(request.contains("total_apps"))
            }
        }
    }
}
