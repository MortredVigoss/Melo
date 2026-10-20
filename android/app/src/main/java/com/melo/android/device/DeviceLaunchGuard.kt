package com.melo.android.device

import com.melo.android.data.text
import kotlinx.serialization.json.JsonObject
import java.util.Locale

/** Launch attempts are bounded independently of animated pixels and screen IDs. */
class DeviceLaunchGuard {
    private val attempts = mutableMapOf<String, Int>()
    private val aliases = mutableMapOf<String, String>()
    private fun key(arguments: JsonObject): String = arguments.text("package_name").ifBlank {
        "name:" + arguments.text("app_name").trim().lowercase(Locale.ROOT)
    }
    fun count(arguments: JsonObject): Int = attempts[aliases[key(arguments)] ?: key(arguments)] ?: 0
    fun record(arguments: JsonObject, result: DeviceToolResult) {
        if (arguments.text("action") == "open_app") {
            if (arguments.text("package_name").isBlank() && arguments.text("app_name").isBlank()) return
            val alias = key(arguments)
            val target = result.data.text("target_package").ifBlank { aliases[alias] ?: alias }
            aliases[alias] = target
            attempts[target] = (attempts[target] ?: 0) + 1
        } else if (result.ok && arguments.text("action") in setOf("tap", "type_text", "swipe", "back", "home")) {
            attempts.clear()
        }
    }
}
