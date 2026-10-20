package com.melo.android.device

import com.melo.android.data.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import java.text.Normalizer

@Serializable data class NodeSelector(val viewId: String = "", val text: String = "", val description: String = "", val className: String = "", val editable: Boolean? = null, val scrollable: Boolean? = null) {
    fun matches(node: JsonObject): Boolean =
        (viewId.isBlank() || node.text("view_id") == viewId) && (text.isBlank() || node.text("text") == text) &&
        (description.isBlank() || node.text("description") == description) && (className.isBlank() || node.text("class_name") == className) &&
        (editable == null || node["editable"]?.jsonPrimitive?.booleanOrNull == editable) &&
        (scrollable == null || node["scrollable"]?.jsonPrimitive?.booleanOrNull == scrollable) &&
        node["enabled"]?.jsonPrimitive?.booleanOrNull != false
}
@Serializable data class ScriptStep(val action: String, val packageName: String = "", val windowTitle: String = "", val selector: NodeSelector? = null,
    val parameter: String = "", val text: String = "", val direction: String = "", val durationMs: Int = 600, val timeoutMs: Int = 5000,
    val windowWidth: Int = 0, val windowHeight: Int = 0)
@Serializable data class ScriptAssertion(val packageName: String, val windowTitle: String = "", val visibleText: String = "", val parameter: String = "")
@Serializable data class DeviceScript(val id: String = newId(), val name: String, val goalTemplate: String, val steps: List<ScriptStep>, val completion: ScriptAssertion,
    val parameters: List<String> = emptyList(), val scope: String = "", val sourceRunId: String = "", val revision: Int = 1,
    val enabled: Boolean = true, val verified: Boolean = false, val createdAt: String = now(), val updatedAt: String = createdAt,
    val hits: Int = 0, val successes: Int = 0, val failures: Int = 0, val lastError: String = "", val invalidated: Boolean = false, val schemaVersion: Int = 1,
    val environment: CacheEnvironment? = null)

object ScriptValidator {
    const val MAX_BYTES = 96_000
    private val packagePattern = Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+")
    fun validate(script: DeviceScript) {
        require(MeloJson.encodeToString(script).toByteArray().size <= MAX_BYTES) { "脚本超过 96 KiB。" }
        require(script.schemaVersion == 1) { "此脚本格式版本不受支持。" }
        require(script.name.isNotBlank() && script.name.length <= 100 && script.goalTemplate.isNotBlank() && script.goalTemplate.length <= 4000) { "请输入脚本名称和目标模板。" }
        require(script.steps.size in 1..60 && script.revision > 0) { "脚本需要 1–60 个步骤。" }
        script.environment?.let { env ->
            require(env.layout.length in 1..500 && env.appVersions.size <= 61 && env.appVersions.all { (pkg, version) -> packagePattern.matches(pkg) && version >= 0 }) { "缓存环境记录无效。" }
        }
        require(script.parameters.size <= 12 && script.parameters.distinct() == script.parameters && script.parameters.all { it.matches(Regex("[A-Za-z][A-Za-z0-9_]{0,39}")) }) { "输入参数名称重复或无效。" }
        for (step in script.steps) {
            require(step.action in setOf("open_app", "tap", "type_text", "swipe", "home", "back", "wait")) { "脚本动作不受支持。" }
            require(step.durationMs in 100..3000 && step.timeoutMs in 100..10_000 && step.windowTitle.length <= 160) { "步骤等待时间或窗口名称超出范围。" }
            require(step.windowWidth in 0..32000 && step.windowHeight in 0..32000) { "缓存窗口尺寸无效。" }
            require(step.action in setOf("home", "wait") || packagePattern.matches(step.packageName)) { "步骤需要确切 App package。" }
            require(step.parameter.isBlank() || step.parameter in script.parameters) { "步骤引用了未声明的输入参数。" }
            require(step.text.length <= 4000 && (step.parameter.isBlank() || step.text.isEmpty())) { "输入参数不能与固定文字同时出现。" }
            if (step.action in setOf("tap", "type_text", "swipe")) {
                val selector = step.selector ?: error("节点步骤需要稳定 selector，不能保存临时 ID 或裸坐标。")
                require(listOf(selector.viewId, selector.text, selector.description).any(String::isNotBlank)) { "selector 至少需要 viewId、精确 text 或 description。" }
                require(listOf(selector.viewId, selector.text, selector.description, selector.className).all { it.length <= 300 }) { "selector 过长。" }
                if (step.action == "type_text") require(selector.editable == true && (step.parameter.isNotBlank() || step.text.isNotEmpty())) { "输入步骤需要 editable selector 和文字或参数。" }
                if (step.action == "swipe") require(selector.scrollable == true && step.direction in setOf("up", "down", "left", "right")) { "滑动步骤需要 scrollable selector 和方向。" }
            }
        }
        require(packagePattern.matches(script.completion.packageName) && script.completion.windowTitle.length <= 160 && script.completion.visibleText.length <= 300) { "终态需要有效 App 和有界可见证据。" }
        require(script.completion.parameter.isBlank() || script.completion.parameter in script.parameters) { "终态引用了未声明参数。" }
        require(script.completion.parameter.isBlank() || script.completion.visibleText.isBlank()) { "终态文字与参数不能同时填写。" }
        val fields = script.steps.flatMap { listOf(it.windowTitle, it.selector?.text.orEmpty(), it.selector?.description.orEmpty()) } + listOf(script.goalTemplate, script.completion.windowTitle, script.completion.visibleText)
        require(fields.flatMap(GoalTemplate::names).all { it in script.parameters }) { "脚本模板引用了未声明参数。" }
        val used = script.steps.map { it.parameter }.filter(String::isNotBlank) + script.completion.parameter.takeIf(String::isNotBlank).orEmpty().let { if (it.isBlank()) emptyList() else listOf(it) } + fields.dropLast(3).flatMap(GoalTemplate::names) + GoalTemplate.names(script.completion.windowTitle) + GoalTemplate.names(script.completion.visibleText)
        require(script.parameters.all { it in used }) { "每个参数必须用于实际动作或终态，不能只作为目标通配符。" }
        val slots = GoalTemplate.names(script.goalTemplate)
        require(slots.distinct().size == slots.size) { "目标模板中每个参数只能出现一次。" }
        if (slots.isNotEmpty()) {
            val anchor = GoalTemplate.literalText(script.goalTemplate)
            require(anchor.count { it in '㐀'..'䶿' || it in '一'..'鿿' } >= 2 || anchor.count(Char::isLetter) >= 4) { "目标模板需要固定的任务意图，不能匹配任意目标。" }
        }
    }
    fun parse(raw: String): DeviceScript {
        require(raw.toByteArray().size <= MAX_BYTES) { "脚本超过 96 KiB。" }
        val strict = kotlinx.serialization.json.Json { ignoreUnknownKeys = false }
        return strict.decodeFromString<DeviceScript>(raw).also(::validate)
    }
}

object GoalTemplate {
    private val slot = Regex("\\{\\{([A-Za-z][A-Za-z0-9_]{0,39})\\}\\}")
    fun literalText(template: String) = slot.replace(template, "")
    fun render(template: String, values: Map<String, String>): String = slot.replace(template) { values[it.groupValues[1]] ?: error("缺少脚本输入参数。") }
    fun parameterize(text: String, values: Map<String, String>): String {
        val entries = values.entries.filter { it.value.isNotBlank() }.sortedByDescending { it.value.length }
        if (entries.isEmpty()) return text
        val literal = Regex(entries.joinToString("|") { Regex.escape(it.value) })
        return literal.replace(text) { match -> "{{${entries.singleOrNull { it.value == match.value }?.key ?: error("输入值相同，无法确定参数角色。")}}}" }
    }
    // Entity names, fixed text and input values are case/Unicode sensitive.
    // Aggressive normalization belongs only in candidate retrieval, never execution.
    fun normalize(value: String): String = value.trim()
    fun names(template: String) = slot.findAll(template).map { it.groupValues[1] }.toList()
    fun bind(template: String, goal: String): Map<String, String>? {
        val source = normalize(template)
        val matches = slot.findAll(source).toList()
        // Normalize cache keys, never the user's bound input value.
        val target = if (matches.isEmpty()) normalize(goal) else goal.trim()
        if (matches.isEmpty()) return if (source == target) emptyMap() else null
        if (matches.size > 12 || matches.map { it.groupValues[1] }.distinct().size != matches.size) return null
        val regex = StringBuilder("^"); var end = 0
        for (match in matches) { if (match.range.first == end && end != 0) return null; regex.append(Regex.escape(source.substring(end, match.range.first))).append("(.{1,4000}?)"); end = match.range.last + 1 }
        regex.append(Regex.escape(source.substring(end))).append("$")
        val found = Regex(regex.toString()).matchEntire(target) ?: return null
        val values = matches.mapIndexed { index, match -> match.groupValues[1] to found.groupValues[index + 1] }.toMap()
        // Conservative: an extended goal must not be swallowed as a text parameter.
        if (values.values.any { Regex("[;,\\n，。！？]|然后|并|同时|接着|再|另外|顺便|之后|随后|还要|以及|\\b(?:then|and|delete|send|purchase)\\b", RegexOption.IGNORE_CASE).containsMatchIn(it) }) return null
        return values
    }
}

data class CacheMatch(val script: DeviceScript, val parameters: Map<String, String>)
data class CacheLookup(val exact: CacheMatch? = null, val similar: List<DeviceScript> = emptyList(), val incompatible: Int = 0)
object TaskCacheRouter {
    private fun tokens(text: String): Set<String> {
        val normalized = Normalizer.normalize(text, Normalizer.Form.NFKC).lowercase().replace(Regex("打开|启动|进入|帮我|麻烦|手机|系统|应用|页面|一下|请"), " ")
        // Explicit Han ranges work on both Android ICU and the desktop JDK.
        val stopWords = setOf("open", "please", "the", "app", "android", "go", "to", "in", "a", "com", "id")
        val words = Regex("[a-z0-9]+|[㐀-䶿一-鿿]+").findAll(normalized).flatMap { match ->
            if (match.value.any { it.code > 127 } && match.value.length > 1) match.value.windowed(2, 1).asSequence() else sequenceOf(match.value)
        }.filterNot { it in stopWords }.toSet()
        return words
    }
    fun lookup(goal: String, scripts: List<DeviceScript>, scope: String, environment: CacheEnvironment?): CacheLookup {
        val owned = scripts.filter { it.enabled && it.verified && !it.invalidated && it.scope == scope && runCatching { ScriptValidator.validate(it) }.isSuccess }
        val eligible = owned.filter { environment?.supports(it) == true }
        val incompatible = owned.size - eligible.size
        val exact = eligible.filterNot { it.invalidated }.mapNotNull { script ->
            GoalTemplate.bind(script.goalTemplate, goal)?.takeIf { bindings -> script.parameters.all { it in bindings } }?.let { CacheMatch(script, it) }
        }
        if (exact.size == 1) return CacheLookup(exact.single(), incompatible = incompatible)
        val wanted = tokens(goal)
        val ranked = eligible.map { script ->
            val other = tokens(script.goalTemplate)
            val keywords = tokens(script.completion.windowTitle + " " + script.steps.joinToString(" ") { it.packageName.substringAfterLast('.') + " " + it.windowTitle + " " + it.selector?.text.orEmpty() + " " + it.selector?.description.orEmpty() + " " + it.selector?.viewId?.substringAfterLast('/').orEmpty() })
            val goalScore = if (wanted.isEmpty() || other.isEmpty()) 0.0 else wanted.intersect(other).size.toDouble() / wanted.union(other).size
            val targetScore = if (wanted.isEmpty()) 0.0 else 0.6 * wanted.intersect(keywords).size / wanted.size
            script to maxOf(goalScore, targetScore)
        }.filter { it.second >= 0.2 }.sortedByDescending { it.second }.take(3).map { it.first }
        return CacheLookup(similar = ranked, incompatible = incompatible)
    }
}
