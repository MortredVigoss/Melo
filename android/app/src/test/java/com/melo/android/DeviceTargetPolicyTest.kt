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
    @Test fun editorSubmissionUsesTheAdvertisedActionAndKeepsSensitiveConfirmation() {
        for (label in listOf("Search", "搜索", "搜尋")) assertFalse(DeviceTargetPolicy.submitNeedsConfirmation(label))
        for (label in listOf("Send", "发送", "Done", "", "Purchase")) assertTrue(DeviceTargetPolicy.submitNeedsConfirmation(label))
        for (args in listOf(buildJsonObject { put("action", "submit_input") }, buildJsonObject { put("action", "submit_input"); put("screen_id", "s") })) assertTrue(runCatching { DeviceTools.validate(args) }.isFailure)
        DeviceTools.validate(buildJsonObject { put("action", "submit_input"); put("screen_id", "s"); put("node_id", "n1") })
    }
    @Test fun browserAddressEnterUsesNavigationAuthorizationButGenericEnterDoesNot() {
        assertFalse(DeviceTargetPolicy.submitNeedsConfirmation("Enter", inputType = 0x11))
        assertFalse(DeviceTargetPolicy.submitNeedsConfirmation("Go", inputType = 0x11))
        assertTrue(DeviceTargetPolicy.submitNeedsConfirmation("Enter", inputType = 1))
        assertTrue(DeviceTargetPolicy.submitNeedsConfirmation("Send", inputType = 0x11))
        assertTrue(DeviceTargetPolicy.submitNeedsConfirmation("", inputType = 0x11))
    }
    @Test fun onlyAnInstalledBrowserAddressWidgetAddsTheGenericEnterNavigationRole() {
        val browsers = setOf("com.android.chrome")
        val address = DeviceTargetPolicy.browserAddress("com.android.chrome:id/url_bar", "com.android.chrome", browsers)
        assertTrue(address)
        assertFalse(DeviceTargetPolicy.browserAddress("chat.app:id/url_bar", "chat.app", browsers))
        assertFalse(DeviceTargetPolicy.browserAddress("com.android.chrome:id/message", "com.android.chrome", browsers))
        assertFalse(DeviceTargetPolicy.submitNeedsConfirmation("Enter", 524289, browserAddress = address))
        assertTrue(DeviceTargetPolicy.submitNeedsConfirmation("Send", 524289, browserAddress = address))
    }
    @Test fun stationaryGesturesCannotDisguiseAClickAsASwipe() {
        fun swipe(endX: Int) = buildJsonObject { put("action", "swipe"); put("screen_id", "s"); put("x", 10); put("y", 10); put("end_x", endX); put("end_y", 10) }
        for (endX in listOf(10, 11, 57)) assertTrue(runCatching { DeviceTools.validate(swipe(endX)) }.isFailure)
        DeviceTools.validate(swipe(200))
    }
    @Test fun focusedEditorSemanticsCanIdentifySearchWithoutTrustingAGenericEnterLabel() {
        assertFalse(DeviceTargetPolicy.submitNeedsConfirmation("Enter", imeAction = 3))
        assertFalse(DeviceTargetPolicy.submitNeedsConfirmation("", imeAction = 3))
        assertTrue(DeviceTargetPolicy.submitNeedsConfirmation("Search", imeAction = 4))
        assertTrue(DeviceTargetPolicy.submitNeedsConfirmation("Enter", imeAction = 4, browserAddress = true))
        assertTrue(DeviceTargetPolicy.submitNeedsConfirmation("Enter", imeAction = null))
        assertTrue(DeviceTargetPolicy.submitNeedsConfirmation("Send", imeAction = 3))
    }
}
