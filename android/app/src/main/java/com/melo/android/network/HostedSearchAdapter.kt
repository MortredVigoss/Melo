package com.melo.android.network

import com.melo.android.core.*
import com.melo.android.data.*
import com.melo.android.device.*
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.*
import java.security.MessageDigest

object HostedSearchAdapter {
    private fun digest(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    suspend fun fingerprint(runtime: SharedCoreRuntime, connection: Connection, key: String): String {
        val identity = runtime.value("connectionIdentity", buildJsonObject {
            put("connection", buildJsonObject {
                put("authMode", "api-key"); put("protocol", connection.protocol); put("endpoint", EndpointPolicy.validate(connection.endpoint, true).toString()); put("model", connection.model)
                put("credentialFingerprint", digest(key))
            })
        }).jsonPrimitive.content
        return digest(identity)
    }
    suspend fun capability(runtime: SharedCoreRuntime, connection: Connection, key: String): String = runtime.value("hostedCapability", buildJsonObject {
        put("proof", connection.searchProof); put("fingerprint", fingerprint(runtime, connection, key)); put("now", System.currentTimeMillis())
    }).jsonObject.text("status")

    suspend fun receipt(runtime: SharedCoreRuntime, turn: DeviceTurn): JsonObject = runtime.value("hostedReceipt", buildJsonObject {
        put("response", buildJsonObject {
            put("items", JsonArray(turn.wire.filter { it.text("type") in setOf("message", "web_search_call") }))
            put("text", turn.text)
        })
    }).jsonObject

    suspend fun probe(context: android.content.Context, connection: Connection, key: String, client: ModelClient, debug: Boolean): JsonObject = withTimeout(60_000) {
        require(connection.protocol == "responses") { "此连接需要使用 Responses 协议，才能验证 Hosted Search。" }
        SharedCoreRuntime.open(context).use { runtime ->
            val turn = DeviceAgentClient(debug, client.http).next(connection, key,
                DeviceAgentClient.initial(connection.protocol, "Search the official Android JavaScriptEngine documentation and cite its URL."),
                "Run web_search once. A plain answer without a completed search is not a successful probe.", true, emptyList(), nativeWebSearch = true)
            val receipt = receipt(runtime, turn)
            runtime.value("hostedProof", buildJsonObject {
                put("receipt", receipt); put("fingerprint", fingerprint(runtime, connection, key)); put("now", System.currentTimeMillis())
            }).jsonObject
        }
    }
}
