package com.melo.android.core

import kotlinx.serialization.json.*

suspend fun SharedCoreRuntime.value(op: String, fields: JsonObject = buildJsonObject {}): JsonElement {
    val reply = evaluate(JsonObject(fields + buildJsonObject { put("version", 1); put("op", op) }))
    check(reply["ok"]?.jsonPrimitive?.boolean == true) { coreRefusal(reply["error"]?.jsonObject?.get("code")?.jsonPrimitive?.content.orEmpty()) }
    return reply.getValue("value")
}

/**
 * What the user reads when the Core refuses a request. A refusal the user can act on says what to
 * do; the code stays at the end, where the loop and a bug report can read it. Every other code is
 * an internal fault and is shown as it is. Until 2026-11-10 a message longer than the model could
 * take ended the reply with "共享 Agent 拒绝请求：CONTEXT_BUDGET_EXCEEDED" and nothing else.
 */
internal fun coreRefusal(code: String): String = when (code) {
    "CONTEXT_BUDGET_EXCEEDED" -> "这条消息连同角色与项目资料超过了所选模型的上下文容量，没有发送。请缩短消息、减少绑定的项目资料，或在「系统 → 模型连接」核对这个模型的上下文容量。（CONTEXT_BUDGET_EXCEEDED）"
    "INPUT_LIMIT" -> "这次要处理的内容超过了本机一次能处理的上限，没有发送。请缩短消息，或开始一段新对话。（INPUT_LIMIT）"
    else -> "共享 Agent 拒绝请求：$code"
}
