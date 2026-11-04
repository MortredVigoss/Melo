package com.melo.android.device

/** Captured before refresh: equality prevents silently retargeting a recycled node. */
data class DeviceTarget(val window: Int, val viewId: String, val className: String, val text: String, val description: String,
                        val bounds: List<Int>, val clickable: Boolean, val editable: Boolean, val enabled: Boolean, val visible: Boolean, val password: Boolean, val inputType: Int = 0)

object DeviceTargetPolicy {
    fun unchanged(before: DeviceTarget?, after: DeviceTarget): Boolean = before != null && before == after && after.visible && after.enabled && !after.password
    fun submitNeedsConfirmation(label: String, inputType: Int = 0, browserAddress: Boolean = false, imeAction: Int? = null): Boolean {
        val action = label.trim().lowercase()
        // EditorInfo comes only from the currently focused native input owner.
        // IME_ACTION_SEND (4) always wins over misleading labels or URI hints.
        if (imeAction == 4 || action in setOf("send", "发送", "傳送")) return true
        if (imeAction == 3) return false // IME_ACTION_SEARCH
        if (action in setOf("search", "搜索", "搜尋", "検索", "검색")) return false
        // Android TYPE_CLASS_TEXT | TYPE_TEXT_VARIATION_URI. A generic Enter in
        // a message/form remains a possible commit and retains confirmation.
        val uriEditor = inputType and 0xff == 0x11
        return !((uriEditor || browserAddress) && action in setOf("enter", "go", "前往", "转到", "前往网址", "回车"))
    }
    fun browserAddress(viewId: String, owner: String, browsers: Set<String>): Boolean = owner in browsers &&
        viewId in setOf("$owner:id/url_bar", "$owner:id/urlbar_edit_text", "$owner:id/mozac_browser_toolbar_url_view")
    // An active user-requested task authorizes ordinary navigation. Sensitive
    // native controls keep their confirmation even when addressed by coordinates.
    fun needsConfirmation(action: String, target: DeviceTarget?): Boolean = action == "tap" && target != null && !target.editable &&
        Regex("(^|\\b)(send|submit|delete|remove|pay|purchase|buy|confirm payment|place order)(\\b|$)|发送|提交|删除|付款|支付|购买|下单", RegexOption.IGNORE_CASE)
            .containsMatchIn(listOf(target.text, target.description, target.viewId.substringAfterLast('/')).joinToString(" "))
}
