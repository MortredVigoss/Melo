package com.melo.android.device

import kotlinx.coroutines.delay

data class DeviceWindowIdentity(val id: Int, val packageName: String, val bounds: List<Int> = emptyList())
data class DeviceWindowState(val id: Int, val focused: Boolean, val active: Boolean, val layer: Int, val rootVisible: Boolean, val excluded: Boolean = false)
data class DeviceForegroundWindow(val packageName: String, val blockingSystem: Boolean = false)

object DeviceWindowPolicy {
    /** Wait for window delivery, never relaunch or dismiss a foreground system dialog. */
    suspend fun settleLaunch(expectedPackage: String, current: () -> DeviceForegroundWindow,
                             pause: suspend () -> Unit = { delay(150) }): Boolean {
        repeat(20) { attempt ->
            val window = current()
            if (window.packageName == expectedPackage) return true
            if (window.blockingSystem) return false
            if (attempt < 19) pause()
        }
        return false
    }

    /** A redacted Accessibility root is not evidence that its focused window is hidden.
     * Touch-active edge/gesture decorations must not replace the input-focused app.
     * Focused system dialogs stay eligible even when their own tree is unavailable. */
    fun observationOrder(windows: List<DeviceWindowState>): List<Int> = windows
        .filter { !it.excluded && (it.rootVisible || it.focused || it.active) }
        .sortedWith(compareByDescending<DeviceWindowState> { it.focused }.thenByDescending { it.active }.thenByDescending { it.layer })
        .map { it.id }

    /** Called only with visible windows on the selected Display; no hidden task APIs. */
    fun sameApp(active: DeviceWindowIdentity, candidate: DeviceWindowIdentity): Boolean {
        if (active.id == candidate.id) return true
        if (active.packageName.isBlank() || active.packageName != candidate.packageName || active.bounds.size != 4 || candidate.bounds.size != 4) return false
        val a = active.bounds; val b = candidate.bounds
        // A modal of the same app must still invalidate the obscured old window.
        // Related side-by-side panes may share a thin window border, not content.
        val overlap = (minOf(a[2], b[2]) - maxOf(a[0], b[0])).coerceAtLeast(0).toLong() *
            (minOf(a[3], b[3]) - maxOf(a[1], b[1])).coerceAtLeast(0)
        val area = minOf((a[2] - a[0]).toLong() * (a[3] - a[1]), (b[2] - b[0]).toLong() * (b[3] - b[1]))
        return area > 0 && overlap <= area / 100
    }
}
