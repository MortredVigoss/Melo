package com.melo.android

import android.os.Build
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.state.ToggleableState
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ApplicationProvider
import com.melo.android.data.*
import com.melo.android.network.SharedSearchAdapter
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import org.junit.*
import org.junit.Assert.*
import java.io.File

class SearchSettingsFlowTest {
    @get:Rule val ui = createAndroidComposeRule<MainActivity>()
    private val app get() = ApplicationProvider.getApplicationContext<MeloApplication>()
    private var before: AppData? = null
    @Before fun setup() = runBlocking {
        Assume.assumeTrue(Build.FINGERPRINT.contains("generic") || Build.MODEL.contains("sdk_gphone"))
        withTimeout(15_000) { app.engine.runtime.first { it.initialized } }
        before = app.repository.data.value
        app.repository.change { it.copy(settings = it.settings.copy(connections = emptyList(), agentRuntime = buildJsonObject {})) }
        Unit
    }
    @After fun restore() = runBlocking { before?.let { snapshot -> app.repository.change { snapshot } }; Unit }

    @Test fun searchSettingsSaveCanonicalConfigKeepBlankKeysAndClearOnlyExplicitly() {
        ui.onAllNodesWithText("系统").onFirst().performClick()
        ui.onNodeWithTag("search-enabled").performScrollTo()
        // The prior test restores Repository before this Activity's lifecycle
        // collector catches up. Wait for the initial draft before editing it.
        ui.waitUntil(5_000) { ui.onNodeWithTag("search-enabled").fetchSemanticsNode().config[SemanticsProperties.ToggleableState] == ToggleableState.Off }
        ui.onNodeWithTag("search-provider-brave").performScrollTo().performClick().assertIsSelected()
        ui.onNodeWithTag("search-enabled").performScrollTo().performClick().assertIsOn()
        ui.onNodeWithTag("search-key").performScrollTo().performTextInput("fixture-ui-search-key")
        ui.activityRule.scenario.onActivity { WindowCompat.getInsetsController(it.window, it.window.decorView).hide(WindowInsetsCompat.Type.ime()) }
        ui.waitForIdle()
        ui.onNodeWithTag("save-search").performScrollTo().performClick()
        try { ui.waitUntil(10_000) { app.repository.data.value.settings.agentRuntime["search"]?.jsonObject?.text("provider") == "brave" } }
        catch (error: Throwable) {
            File(app.cacheDir, "shared-search-settings-failure.png").outputStream().use { output -> ui.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output) }
            throw AssertionError("Search settings were not saved: ${app.engine.runtime.value.error}; config=${app.repository.data.value.settings.agentRuntime}", error)
        }
        val config = app.repository.data.value.settings.agentRuntime.getValue("search").jsonObject
        assertEquals("http", config.text("backend")); assertEquals("https://api.search.brave.com/res/v1/web/search", config.text("endpoint"))
        val slot = SharedSearchAdapter.credentialId(config.text("endpoint"), true)
        runBlocking { assertEquals("fixture-ui-search-key", app.repository.credential(slot)) }
        assertFalse(app.repository.snapshot().toString().contains("fixture-ui-search-key"))
        ui.onNodeWithTag("save-search").performScrollTo().performClick(); ui.waitForIdle()
        runBlocking { assertEquals("fixture-ui-search-key", app.repository.credential(slot)) }
        ui.activityRule.scenario.recreate(); ui.waitForIdle()
        ui.onNodeWithTag("search-provider-brave").performScrollTo().assertIsSelected()
        ui.onNodeWithTag("search-clear-key").performScrollTo().performClick()
        ui.onNodeWithTag("save-search").performScrollTo().performClick()
        ui.waitUntil(10_000) { runBlocking { app.repository.credential(slot).isBlank() } }
        File(app.cacheDir, "shared-search-settings-ui.png").outputStream().use { output ->
            ui.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output)
        }
        assertEquals(before!!.runs.size, app.repository.data.value.runs.size)
        assertEquals(before!!.deviceRuns.size, app.repository.data.value.deviceRuns.size)
    }
}
