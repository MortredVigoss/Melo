package com.melo.android

import com.melo.android.device.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class DeviceWindowPolicyTest {
    @Test fun relatedPanesCannotCrossTheForegroundPackageBoundary() {
        val right = DeviceWindowIdentity(2, "com.android.settings", listOf(928, 0, 1856, 2160))
        assertTrue(DeviceWindowPolicy.sameApp(right, right))
        assertTrue(DeviceWindowPolicy.sameApp(right, DeviceWindowIdentity(1, "com.android.settings", listOf(0, 0, 928, 2160))))
        assertFalse(DeviceWindowPolicy.sameApp(right, DeviceWindowIdentity(4, "com.android.settings", listOf(1000, 300, 1700, 1500))))
        assertFalse(DeviceWindowPolicy.sameApp(right, DeviceWindowIdentity(3, "com.melo.android")))
        assertFalse(DeviceWindowPolicy.sameApp(DeviceWindowIdentity(2, ""), DeviceWindowIdentity(1, "")))
    }
    @Test fun windowSelectionCannotBeUsedOnAnActionOrAsAString() {
        DeviceTools.validate(buildJsonObject { put("action", "observe"); put("window_id", 17) })
        for (arguments in listOf(
            buildJsonObject { put("action", "tap"); put("screen_id", "s1"); put("window_id", 17) },
            buildJsonObject { put("action", "observe"); put("window_id", "17") },
            buildJsonObject { put("action", "observe"); put("window_id", -1) },
        )) assertTrue(runCatching { DeviceTools.validate(arguments) }.isFailure)
    }
}
