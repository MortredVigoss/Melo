package com.melo.android

import androidx.test.core.app.ApplicationProvider
import com.melo.android.core.SharedCoreTurn
import com.melo.android.data.*
import com.melo.android.device.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SharedDeviceProgressTest {
    private suspend fun openCore() = SharedCoreTurn.open(ApplicationProvider.getApplicationContext<MeloApplication>(), newId(), newId(), listOf("android_device"), 30, callsPerRound = 1)
    private fun args(action: String, vararg fields: Pair<String, String>) = buildJsonObject { put("action", action); fields.forEach { put(it.first, it.second) } }
    private fun screen(id: String = "s1", text: String = "Ready", pkg: String = "fixture.app") = DeviceToolResult(buildJsonObject {
        put("ok", true); put("screen_id", id); put("package_name", pkg); put("stable", true)
        put("nodes", buildJsonArray { add(buildJsonObject { put("node_id", "n1"); put("text", text) }) })
    })
    private fun turn(id: String, arguments: JsonObject): DeviceTurn {
        val call = DeviceCall(id, "android_device", arguments)
        val wire = buildJsonObject { put("role", "assistant"); put("tool_calls", buildJsonArray { add(buildJsonObject {
            put("id", id); put("type", "function"); put("function", buildJsonObject { put("name", "android_device"); put("arguments", arguments.toString()) })
        }) }) }
        return DeviceTurn("", listOf(call), listOf(wire))
    }
    @Test fun observationCannotResetRepeatedActionErrors() = runBlocking {
        openCore().use { core ->
        var index = 0; var executed = 0
        // Distinct valid targets isolate the error streak from duplicate-launch protection.
        val result = DeviceTaskLoop("chat-completions", { turn("c${index}", args(if (index++ % 2 == 0) "open_app" else "observe", "app_name" to "Missing$index")) }, {
            executed++; if (it.text("action") == "observe") screen() else DeviceToolResult.error("not found", "app_not_found")
        }, {}, core = core).run("goal")
        assertEquals("blocked", result.status); assertEquals(5, executed)
        assertTrue(result.error!!.contains("REPEATED_DEVICE_FAILURE"))
        }
    }
    @Test fun repeatedSuccessfulObservationStopsWithoutBurningAllThirtySteps() = runBlocking {
        openCore().use { core ->
        var calls = 0
        val result = DeviceTaskLoop("chat-completions", { turn("o${calls++}", args("observe")) }, { screen(id = newId()) }, {}, core = core).run("goal")
        assertEquals("blocked", result.status); assertEquals(6, calls)
        }
    }
    @Test fun alternatingAlreadySeenScreensAndCatalogsStillCountsAsNoProgress() = runBlocking {
        openCore().use { core ->
        var calls = 0
        val result = DeviceTaskLoop("chat-completions", { turn("c${calls}", args(if (calls++ % 2 == 0) "observe" else "list_apps", "query" to "Fixture")) }, {
            if (it.text("action") == "observe") screen(id = newId()) else DeviceToolResult(buildJsonObject { put("ok", true); put("apps", JsonArray(emptyList())) })
        }, {}, core = core).run("goal")
        assertEquals("blocked", result.status); assertTrue(calls <= 8)
        }
    }
}
