package com.melo.android.device

import android.content.Context
import com.melo.android.core.*
import com.melo.android.data.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.security.MessageDigest

/** Per-parent-turn adapter; Core owns the portable manifest and call contract. */
internal class PhoneWorkflowHost(private val context: Context, private val repository: Repository,
    private val agent: DeviceAgent, private val binding: ChatDeviceContext,
    private val executor: DeviceExecutor? = DeviceAccess.service, private val owner: Job? = null) {
    private val scope = MessageDigest.getInstance("SHA-256").digest("${binding.chat.agentId}|${binding.chat.projectId.orEmpty()}|0|${binding.scopeInstructions}".toByteArray()).joinToString("") { "%02x".format(it) }
    private fun ownerCurrent(): Boolean {
        if (executor == null || executor is MeloAccessibilityService && executor !== DeviceAccess.service) return false
        val state = repository.data.value
        val chat = state.chats.find { it.id == binding.chat.id } ?: return false
        return chat.phoneUseEnabled && chat.agentId == binding.chat.agentId && chat.projectId == binding.chat.projectId && repository.instructions(chat, state) == binding.scopeInstructions
    }
    suspend fun catalog(): List<JsonObject> = withContext(Dispatchers.Main.immediate) {
        if (!ownerCurrent()) return@withContext emptyList()
        val scripts = repository.data.value.deviceScripts.filter { runCatching { ScriptValidator.validate(it) }.isSuccess }
        val environment = executor!!.cacheEnvironment(0, scripts.flatMap { it.packages() }.toSet())
        SharedCoreRuntime.open(context).use { runtime -> runtime.value("workflowCatalog", buildJsonObject { put("catalog", buildJsonObject {
            put("scope", scope)
            environment?.let { put("environment", MeloJson.encodeToJsonElement(it)) }
            put("scripts", JsonArray(scripts.map { script -> buildJsonObject {
                put("id", script.id); put("revision", script.revision); put("name", script.name); put("goalTemplate", script.goalTemplate); put("cacheKind", script.cacheKind)
                put("scope", script.scope); put("enabled", script.enabled); put("verified", script.verified); put("invalidated", script.invalidated)
                put("parameters", JsonArray(script.parameters.map(::JsonPrimitive)))
                script.environment?.let { saved -> put("environment", MeloJson.encodeToJsonElement(saved)) }
            } }))
        }) }).jsonArray.map { it.jsonObject } }
    }
    suspend fun invoke(arguments: JsonObject): DeviceToolResult = withContext(Dispatchers.Main.immediate) {
        if (!ownerCurrent()) return@withContext DeviceToolResult.error("Workflow 的权限或作用域已改变。", "WORKFLOW_SCOPE_CHANGED")
        val currentCatalog = catalog()
        val prepared = SharedCoreRuntime.open(context).use { runtime -> runtime.evaluate(buildJsonObject {
            put("version", 1); put("op", "workflowCall"); put("call", buildJsonObject { put("catalog", JsonArray(currentCatalog)); put("args", arguments) })
        }) }
        if (prepared["ok"]?.jsonPrimitive?.booleanOrNull != true) {
            val error = prepared["error"]?.jsonObject
            return@withContext DeviceToolResult.error(error?.text("message") ?: "Workflow 不可用。", error?.text("code") ?: "WORKFLOW_NOT_AVAILABLE")
        }
        currentCoroutineContext().ensureActive()
        val budget = currentCoroutineContext()[SharedRunBudget.Scope]?.budget
        agent.invokeWorkflow(prepared.getValue("value").jsonObject, binding.copy(budget = budget ?: binding.budget), executor, owner)
    }
}
