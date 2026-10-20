package com.melo.android.device

/** Captured before refresh: equality prevents silently retargeting a recycled node. */
data class DeviceTarget(val window: Int, val viewId: String, val className: String, val text: String, val description: String,
                        val bounds: List<Int>, val clickable: Boolean, val editable: Boolean, val enabled: Boolean, val visible: Boolean, val password: Boolean)

object DeviceTargetPolicy {
    fun unchanged(before: DeviceTarget?, after: DeviceTarget): Boolean = before != null && before == after && after.visible && after.enabled && !after.password
    // Conservative known commit controls. Self-drawn/novel semantics still require
    // model policy; coordinate taps always require a native confirmation.
    fun needsConfirmation(action: String, target: DeviceTarget?): Boolean = action == "tap" && (target == null ||
        Regex("(^|\\b)(send|submit|delete|remove|pay|purchase|buy|confirm payment|place order)(\\b|$)|发送|提交|删除|付款|支付|购买|下单", RegexOption.IGNORE_CASE)
            .containsMatchIn(listOf(target.text, target.description, target.viewId.substringAfterLast('/')).joinToString(" ")))
}
