package com.melo.android.network

import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/** Safe diagnostic fields only. Provider bodies, URLs and credentials are not UI errors. */
class ModelRequestFailure(
    val code: String,
    val phase: String,
    message: String,
    val httpStatus: Int? = null,
    val requestId: String? = null,
    cause: Throwable? = null,
) : IOException(message, cause) {
    companion object {
        fun http(status: Int, id: String? = null): ModelRequestFailure {
            val requestId = id?.takeIf { it.matches(Regex("[A-Za-z0-9_.:-]{1,120}")) }
            val detail = when (status) {
                400, 404, 422 -> "接口拒绝请求格式或所选模型，请核对模型与协议"
                401, 403 -> "模型服务拒绝凭证，请检查连接设置"
                429 -> "模型服务限流或额度不足"
                502, 503, 504 -> "模型服务或上游网关暂时不可用"
                in 300..399 -> "模型接口返回 Redirect，已停止转发凭证"
                else -> "模型服务返回请求错误"
            }
            return ModelRequestFailure("MODEL_HTTP_$status", "http-response", "$detail（HTTP $status）。本次响应未触发工具；此前已执行步骤保留。" + requestId?.let { " Request ID: $it" }.orEmpty(), status, requestId)
        }
        fun network(error: IOException, phase: String): ModelRequestFailure {
            if (error is ModelRequestFailure) return error
            val code = when (error) {
                is SocketTimeoutException, is InterruptedIOException -> "MODEL_TIMEOUT"
                is UnknownHostException -> "MODEL_DNS_FAILED"
                is SSLException -> "MODEL_TLS_FAILED"
                is ConnectException -> "MODEL_CONNECT_FAILED"
                else -> "MODEL_CONNECTION_INTERRUPTED"
            }
            val detail = when (code) {
                "MODEL_TIMEOUT" -> "等待模型响应超时"
                "MODEL_DNS_FAILED" -> "无法解析模型服务域名"
                "MODEL_TLS_FAILED" -> "模型服务 TLS 连接失败"
                "MODEL_CONNECT_FAILED" -> "无法连接模型服务"
                else -> "模型连接在完整回执返回前中断"
            }
            return ModelRequestFailure(code, phase, "$detail（$phase）。未完成的工具参数不会执行；此前已执行步骤保留。", cause = error)
        }
        fun invalid(cause: Throwable? = null) = ModelRequestFailure("MODEL_RESPONSE_INVALID", "decode-response", "模型未返回完整、有效的 Tool Calling 回执，请检查模型及接口协议。未完成的工具参数不会执行。", cause = cause)
    }
}
