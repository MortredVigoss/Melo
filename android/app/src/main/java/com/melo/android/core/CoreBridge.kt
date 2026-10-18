package com.melo.android.core

import kotlinx.serialization.json.*

suspend fun SharedCoreRuntime.value(op: String, fields: JsonObject = buildJsonObject {}): JsonElement {
    val reply = evaluate(JsonObject(fields + buildJsonObject { put("version", 1); put("op", op) }))
    check(reply["ok"]?.jsonPrimitive?.boolean == true) { "共享 Agent 拒绝请求：${reply["error"]?.jsonObject?.get("code")?.jsonPrimitive?.content.orEmpty()}" }
    return reply.getValue("value")
}
