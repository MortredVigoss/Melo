package com.melo.android.network

import com.melo.android.data.Connection

/** Shared by saving, chat preflight and the explicit connection probe. */
object ConnectionPolicy {
    private fun base(endpoint: String) = endpoint.trimEnd('/').removeSuffix("/chat/completions").removeSuffix("/messages")
    fun match(connections: List<Connection>, id: String, endpoint: String, protocol: String): Connection? {
        val candidates = connections.filter { base(it.endpoint) == base(endpoint) && it.protocol == protocol }
        return candidates.firstOrNull { it.id == id } ?: candidates.singleOrNull()?.takeUnless { id.startsWith("key-") }
    }
    fun validate(connection: Connection, key: String, debug: Boolean) {
        require(connection.name.isNotBlank()) { "请输入连接名称。" }
        if (connection.protocol == "fixture") {
            check(debug) { "Fixture 仅用于 Debug 版本。" }
            return
        }
        EndpointPolicy.validate(connection.endpoint, debug)
        require(connection.model.isNotBlank()) { "连接「${connection.name}」缺少模型名称，请在「系统 → 模型连接」中填写。" }
        require(key.isNotBlank()) { "连接「${connection.name}」缺少本机 API 凭证，请在「系统 → 模型连接」中填写并保存。" }
    }
}
