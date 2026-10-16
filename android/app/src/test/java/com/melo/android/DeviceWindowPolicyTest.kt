package com.melo.android

import com.melo.android.device.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class DeviceWindowPolicyTest {
    @Test fun focusedAppWithRedactedTreeWinsOverSamsungGestureDecoration() {
        val app = DeviceWindowState(1, focused = true, active = false, layer = 0, rootVisible = false)
        val edge = DeviceWindowState(2, focused = false, active = true, layer = 5, rootVisible = true)
        assertEquals(listOf(1, 2), DeviceWindowPolicy.observationOrder(listOf(edge, app)))
    }
    @Test fun focusedSystemDialogStillBlocksTheUnderlyingAppEvenWithNoReadableTree() {
        val app = DeviceWindowState(1, focused = false, active = false, layer = 0, rootVisible = true)
        val dialog = DeviceWindowState(2, focused = true, active = true, layer = 3, rootVisible = false)
        assertEquals(listOf(2, 1), DeviceWindowPolicy.observationOrder(listOf(app, dialog)))
        assertFalse(DeviceWindowPolicy.sameApp(DeviceWindowIdentity(2, "com.android.permissioncontroller"), DeviceWindowIdentity(1, "com.tencent.mm")))
    }
    @Test fun hiddenRootsKeyboardAndOwnOverlaysDoNotBecomeObservationTargets() {
        val app = DeviceWindowState(1, true, true, 0, false)
        val hidden = DeviceWindowState(2, false, false, 4, false)
        val keyboard = DeviceWindowState(3, true, true, 8, true, excluded = true)
        val ownOverlay = DeviceWindowState(4, true, true, 9, true, excluded = true)
        assertEquals(listOf(1), DeviceWindowPolicy.observationOrder(listOf(hidden, keyboard, ownOverlay, app)))
    }
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
