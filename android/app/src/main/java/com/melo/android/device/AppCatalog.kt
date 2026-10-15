package com.melo.android.device

import kotlinx.serialization.json.*
import java.text.Normalizer
import java.util.Locale
import kotlin.math.abs

data class LaunchableApp(val packageName: String, val name: String, val aliases: List<String> = emptyList())

/** Search the entire session catalog before paging. Similar names are suggestions, never launch targets. */
class AppCatalog(entries: List<LaunchableApp>) {
    private val apps = entries.groupBy { it.packageName }.map { (_, variants) ->
        val first = variants.first()
        first.copy(aliases = variants.flatMap { listOf(it.name) + it.aliases }.distinct().filter { it != first.name }.sorted())
    }.sortedWith(compareBy<LaunchableApp> { normalized(it.name) }.thenBy { it.packageName })

    fun exactName(name: String): List<LaunchableApp> {
        val query = normalized(name)
        if (query.isEmpty()) return emptyList()
        return apps.filter { app -> (listOf(app.name) + app.aliases).any { normalized(it) == query } }
    }
    fun exactPackage(name: String) = apps.filter { it.packageName == name }

    fun page(query: String = "", offset: Int = 0, limit: Int = 100): JsonObject {
        require(query.length <= 160 && (query.isBlank() || normalized(query).isNotEmpty())) { "query 必须包含名称或包名，且不超过 160 字符。" }
        require(offset >= 0 && limit in 1..200) { "offset 必须非负，limit 必须为 1–200。" }
        val needle = normalized(query)
        val matches = apps.mapNotNull { app -> match(app, needle)?.let { Triple(app, it.first, it.second) } }
            .sortedWith(compareByDescending<Triple<LaunchableApp, Int, String>> { it.second }.thenBy { normalized(it.first.name) }.thenBy { it.first.packageName })
        val rows = matches.drop(offset).take(limit)
        val next = offset + rows.size
        return buildJsonObject {
            put("ok", true); put("query", query); put("total_apps", apps.size); put("matched_apps", matches.size)
            put("offset", offset); put("limit", limit); put("has_more", next < matches.size)
            if (next < matches.size) put("next_offset", next)
            put("search_scope", "All launchable apps in Melo's current Android profile; query is applied BEFORE pagination.")
            put("scope_note", "Launcher shortcuts, cloud games, hidden apps and other profiles may need launcher UI search; no match does not prove the game is not installed.")
            put("apps", buildJsonArray { rows.forEach { (app, _, kind) -> add(buildJsonObject {
                put("package_name", app.packageName); put("name", app.name); put("match", kind)
                if (app.aliases.isNotEmpty()) put("aliases", JsonArray(app.aliases.map(::JsonPrimitive)))
            }) } })
        }
    }

    fun openFailure(packageName: String, appName: String, ambiguous: Boolean): DeviceToolResult {
        val query = appName.ifBlank { packageName }
        val candidates = page(query, limit = 10)
        return DeviceToolResult(JsonObject(candidates + mapOf(
            "ok" to JsonPrimitive(false),
            "code" to JsonPrimitive(if (ambiguous) "app_ambiguous" else "app_not_found"),
            "error" to JsonPrimitive(if (ambiguous) "多个 App 名称相同，请核对候选并使用 package_name，不要代选。" else "没有精确匹配的可启动 App；请核对候选，改用短名称或包名搜索，必要时使用 Launcher 搜索。不能据此断言未安装。")
        )))
    }

    private fun match(app: LaunchableApp, query: String): Pair<Int, String>? {
        if (query.isEmpty()) return 0 to "all"
        val names = (listOf(app.name) + app.aliases).map(::normalized)
        val pkg = normalized(app.packageName)
        if (query == pkg) return 110 to "exact_package"
        if (query in names) return 100 to "exact_name"
        if (names.any { it.startsWith(query) }) return 90 to "name_prefix"
        if (names.any { query in it }) return 80 to "name_contains"
        if (query in pkg) return 70 to "package_contains"
        if (query.length !in 3..64) return null
        val threshold = if (query.length <= 5) 1 else 2
        val distance = (names + pkg).filter { it.length <= 64 && abs(it.length - query.length) <= threshold }
            .minOfOrNull { editDistance(query, it) } ?: return null
        return if (distance <= threshold) (50 - distance) to "similar_name" else null
    }

    private fun editDistance(a: String, b: String): Int {
        val rows = Array(a.length + 1) { IntArray(b.length + 1) }
        for (i in 0..a.length) rows[i][0] = i
        for (j in 0..b.length) rows[0][j] = j
        for (i in 1..a.length) for (j in 1..b.length) {
            rows[i][j] = minOf(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + if (a[i - 1] == b[j - 1]) 0 else 1)
            if (i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1]) rows[i][j] = minOf(rows[i][j], rows[i - 2][j - 2] + 1)
        }
        return rows[a.length][b.length]
    }
    private fun normalized(value: String) = Normalizer.normalize(value, Normalizer.Form.NFKD)
        .lowercase(Locale.ROOT).replace(Regex("\\p{M}+"), "").filter { it.isLetterOrDigit() }
}
