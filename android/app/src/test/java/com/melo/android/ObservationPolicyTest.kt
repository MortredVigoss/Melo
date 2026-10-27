package com.melo.android

import com.melo.android.device.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ObservationPolicyTest {
    private fun nodes(vararg rows: JsonObject) = JsonArray(rows.toList())
    @Test fun readableTextEditableFieldsAndNamedControlsUseTreeFirst() {
        for (row in listOf(buildJsonObject { put("text", "Song title") }, buildJsonObject { put("editable", true) }, buildJsonObject { put("description", "Search"); put("clickable", true) })) {
            assertFalse(ObservationPolicy.needsScreenshot(nodes(row)))
        }
    }
    @Test fun emptyContainersAndUnexposedGraphicsNeedAnImageRegardlessOfNodeCount() {
        assertTrue(ObservationPolicy.needsScreenshot(nodes()))
        assertTrue(ObservationPolicy.needsScreenshot(JsonArray(List(20) { buildJsonObject { put("description", "Canvas"); put("clickable", false) } })))
    }
    @Test fun modelCanRequestMissingVisualContentEvenWithPartialText() {
        assertTrue(ObservationPolicy.needsScreenshot(nodes(buildJsonObject { put("text", "Partial text") }), requested = true))
        DeviceTools.validate(buildJsonObject { put("action", "observe"); put("include_screenshot", true) })
        assertTrue(runCatching { DeviceTools.validate(buildJsonObject { put("action", "wait"); put("include_screenshot", true) }) }.isFailure)
        assertTrue(runCatching { DeviceTools.validate(buildJsonObject { put("action", "observe"); put("include_screenshot", "true") }) }.isFailure)
    }
}
