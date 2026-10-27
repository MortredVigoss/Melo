package com.melo.android.device

import com.melo.android.data.*
import kotlinx.serialization.json.*
import kotlin.math.abs

/** Session-only raw values; only compile()'s parameterized recipe may be persisted. */
class ScriptRecorder(private val goal: String, seedSteps: List<ScriptStep> = emptyList(), seedValues: Map<String, String> = emptyMap()) {
    private var screen: JsonObject? = null
    private val steps = seedSteps.toMutableList()
    private val values = seedValues.toMutableMap()
    private var completion: ScriptAssertion? = null
    var unsupported: String = ""; private set
    private fun mask(text: String): String = GoalTemplate.parameterize(text, values)
    private fun selector(node: JsonObject): NodeSelector {
        val editable = node["editable"]?.jsonPrimitive?.booleanOrNull == true
        return NodeSelector(node.text("view_id"), if (editable) "" else node.text("text"), node.text("description"), node.text("class_name"),
            editable.takeIf { it }, (node["scrollable"]?.jsonPrimitive?.booleanOrNull == true).takeIf { it })
    }
    private fun select(data: JsonObject, id: String): JsonObject? = if (id.isBlank()) null else data["nodes"]?.jsonArray?.map { it.jsonObject }?.singleOrNull { it.text("node_id") == id }
    private fun stable(node: JsonObject, data: JsonObject): NodeSelector {
        val target = selector(node)
        require(listOf(target.viewId, target.text, target.description).any(String::isNotBlank)) { "目标缺少稳定 selector。" }
        require(data["nodes"]!!.jsonArray.count { target.matches(it.jsonObject) } == 1) { "目标 selector 不唯一。" }
        return target.copy(text = mask(target.text), description = mask(target.description))
    }
    fun record(arguments: JsonObject, result: DeviceToolResult) {
        val action = arguments.text("action"); val before = screen
        if (!result.ok) {
            if (action in setOf("tap", "type_text", "swipe", "back", "home") && result.data.text("code") !in setOf("stale_screen", "stale_target", "invalid_arguments", "user_declined")) unsupported = "动作失败后无法证明没有产生效果，未缓存这次探索。"
        } else if (unsupported.isBlank()) try {
            when (action) {
                "open_app" -> {
                    val pkg = result.data.text("target_package").ifBlank { arguments.text("package_name") }
                    require(pkg.isNotBlank()) { "无法确定启动目标 package。" }
                    if (steps.lastOrNull()?.let { it.action == "open_app" && it.packageName == pkg } != true) steps += ScriptStep("open_app", packageName = pkg)
                }
                "tap", "type_text" -> {
                    require(before != null) { "动作之前没有可用 observation。" }
                    val node = select(before, arguments.text("node_id")) ?: error("纯坐标点击无法可靠转换为本机脚本。")
                    val target = stable(node, before)
                    val parameter = if (action == "type_text") {
                        val text = arguments.text("text")
                        values.entries.firstOrNull { it.value == text }?.key ?: run {
                            val key = generateSequence(1) { it + 1 }.map { "input_$it" }.first { it !in values }
                            values[key] = text; key
                        }
                    } else ""
                    steps += ScriptStep(action, before.text("package_name"), mask(before.text("window_title")), target, parameter = parameter)
                }
                "swipe" -> {
                    require(before != null) { "滑动之前没有 observation。" }
                    val x = arguments["x"]!!.jsonPrimitive.int; val y = arguments["y"]!!.jsonPrimitive.int
                    val dx = arguments["end_x"]!!.jsonPrimitive.int - x; val dy = arguments["end_y"]!!.jsonPrimitive.int - y
                    val containers = before["nodes"]!!.jsonArray.map { it.jsonObject }.filter { node ->
                        val box = node["bounds"]!!.jsonArray.map { it.jsonPrimitive.int }
                        node["scrollable"]?.jsonPrimitive?.booleanOrNull == true && x in box[0] until box[2] && y in box[1] until box[3]
                    }.sortedBy { node -> node["bounds"]!!.jsonArray.map { it.jsonPrimitive.int }.let { (it[2] - it[0]).toLong() * (it[3] - it[1]) } }
                    val container = containers.firstOrNull() ?: error("滑动未命中可识别的 scrollable 容器。")
                    val direction = if (abs(dx) > abs(dy)) { if (dx > 0) "right" else "left" } else if (dy > 0) "down" else "up"
                    steps += ScriptStep("swipe", before.text("package_name"), mask(before.text("window_title")), stable(container, before), direction = direction,
                        durationMs = (arguments["duration_ms"]?.jsonPrimitive?.intOrNull ?: 400).coerceIn(100, 1500))
                }
                "back" -> { require(before != null); steps += ScriptStep("back", before.text("package_name"), mask(before.text("window_title"))) }
                "home" -> steps += ScriptStep("home")
                "wait" -> steps += ScriptStep("wait", durationMs = (arguments["duration_ms"]?.jsonPrimitive?.intOrNull ?: 600).coerceIn(100, 3000))
                "finish", "checkpoint" -> if ((action == "checkpoint" || arguments.text("outcome") == "achieved") && result.data.text("verification") == "visible_facts") {
                    val text = arguments.text("visible_text")
                    val parameter = values.entries.firstOrNull { it.value.isNotBlank() && it.value == text }?.key.orEmpty()
                    completion = ScriptAssertion(arguments.text("expected_package").ifBlank { result.data.text("package_name") }, mask(result.data.text("window_title")), if (parameter.isBlank()) mask(text) else "", parameter)
                }
            }
        } catch (e: Exception) { unsupported = e.message ?: "本次探索包含无法重放的动作。" }
        // Bind semantic steps to the window geometry where they were verified.
        if (result.ok && before != null && action in setOf("tap", "type_text", "swipe", "back") && unsupported.isBlank() && steps.isNotEmpty()) {
            val last = steps.last()
            steps[steps.lastIndex] = last.copy(windowWidth = before["window_width"]?.jsonPrimitive?.intOrNull ?: 0,
                windowHeight = before["window_height"]?.jsonPrimitive?.intOrNull ?: 0)
        }
        if (result.ok && result.data.text("screen_id").isNotBlank()) screen = result.data
    }
    fun compile(scope: String, runId: String, recordedGoal: String = goal): DeviceScript? {
        if (unsupported.isNotBlank()) return null
        return try {
            val assertion = completion ?: error("没有通过验证的终态。")
            val fields = steps.flatMap { listOf(it.windowTitle, it.selector?.text.orEmpty(), it.selector?.description.orEmpty()) } + listOf(assertion.windowTitle, assertion.visibleText)
            val used = (steps.map { it.parameter } + assertion.parameter + fields.flatMap(GoalTemplate::names)).filter(String::isNotBlank).distinct()
            val activeValues = values.filterKeys { it in used }
            require(activeValues.values.filter(String::isNotBlank).all { value -> recordedGoal.windowed(value.length).count { it == value } <= 1 }) { "目标中的输入值重复，无法无歧义参数化；未缓存。" }
            val template = GoalTemplate.normalize(GoalTemplate.parameterize(recordedGoal.trim(), activeValues))
            DeviceScript(name = template.take(100), goalTemplate = template, steps = steps.toList(), completion = assertion,
                parameters = used, scope = scope, sourceRunId = runId, verified = true, successes = 1).also(ScriptValidator::validate)
        } catch (e: Exception) { unsupported = e.message ?: "脚本不完整，未缓存。"; null }
    }
}
