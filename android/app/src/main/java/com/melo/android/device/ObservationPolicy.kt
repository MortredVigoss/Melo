package com.melo.android.device

import com.melo.android.data.text
import kotlinx.serialization.json.*

/** Inspect structure first; a container caption alone does not expose controls. */
object ObservationPolicy {
    fun needsScreenshot(nodes: JsonArray, requested: Boolean = false): Boolean = requested || nodes.none { row ->
        val node = row.jsonObject
        val enabled = node["enabled"]?.jsonPrimitive?.booleanOrNull != false
        val label = node.text("text").isNotBlank() || node.text("description").isNotBlank() || node.text("view_id").isNotBlank()
        node.text("text").isNotBlank() || enabled && (node["editable"]?.jsonPrimitive?.booleanOrNull == true || label && node["clickable"]?.jsonPrimitive?.booleanOrNull == true)
    }
}
