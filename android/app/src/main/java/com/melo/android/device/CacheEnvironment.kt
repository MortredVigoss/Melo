package com.melo.android.device

import kotlinx.serialization.Serializable

/** Device-local compatibility metadata; never a saved observation or authority. */
@Serializable data class CacheEnvironment(val layout: String, val appVersions: Map<String, Long> = emptyMap()) {
    fun supports(script: DeviceScript): Boolean = layout.isNotBlank() && !layout.contains("hinge-pending") &&
        script.environment?.let { saved ->
            saved.layout == layout && script.packages().all { pkg ->
                val version = saved.appVersions[pkg]
                version != null && version >= 0 && appVersions[pkg] == version
            }
        } == true
}

fun DeviceScript.packages(): Set<String> = (steps.map { it.packageName } + completion.packageName).filter(String::isNotBlank).toSet()

fun hingePosture(angle: Float?): String = when {
    angle == null || !angle.isFinite() || angle !in 0f..360f -> "hinge-pending"
    angle <= 10f -> "closed"
    angle >= 170f -> "flat"
    else -> "half"
}
