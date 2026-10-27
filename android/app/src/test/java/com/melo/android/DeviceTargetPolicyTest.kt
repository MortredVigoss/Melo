package com.melo.android

import com.melo.android.device.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class DeviceTargetPolicyTest {
    private val target = DeviceTarget(1, "fixture/button", "Button", "Search", "", listOf(0, 0, 100, 50), true, false, true, true, false)
    @Test fun unrelatedContentChangesCanKeepAnIdenticalTargetValid() { assertTrue(DeviceTargetPolicy.unchanged(target, target.copy())) }
    @Test fun recycledMovedRelabeledHiddenPasswordOrDisabledTargetsAreRejected() {
        for (changed in listOf(target.copy(window = 2), target.copy(text = "Send"), target.copy(viewId = "another"), target.copy(bounds = listOf(0, 0, 200, 50)), target.copy(enabled = false), target.copy(visible = false), target.copy(password = true), target.copy(editable = true)))
            assertFalse(DeviceTargetPolicy.unchanged(target, changed))
        assertFalse(DeviceTargetPolicy.unchanged(null, target))
    }
    @Test fun ordinaryCoordinatesUseTaskAuthorizationAndCommitControlsStillRequireConfirmation() {
        assertFalse(DeviceTargetPolicy.needsConfirmation("tap", null))
        for (label in listOf("发送", "删除聊天", "立即支付", "Send", "Delete account", "Buy now")) assertTrue(DeviceTargetPolicy.needsConfirmation("tap", target.copy(text = label)))
        assertFalse(DeviceTargetPolicy.needsConfirmation("tap", target))
        assertFalse(DeviceTargetPolicy.needsConfirmation("type_text", target))
    }
    @Test fun stationaryGesturesCannotDisguiseAClickAsASwipe() {
        fun swipe(endX: Int) = buildJsonObject { put("action", "swipe"); put("screen_id", "s"); put("x", 10); put("y", 10); put("end_x", endX); put("end_y", 10) }
        for (endX in listOf(10, 11, 57)) assertTrue(runCatching { DeviceTools.validate(swipe(endX)) }.isFailure)
        DeviceTools.validate(swipe(200))
    }
}
