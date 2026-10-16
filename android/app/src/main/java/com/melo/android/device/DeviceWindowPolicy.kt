package com.melo.android.device

data class DeviceWindowIdentity(val id: Int, val packageName: String, val bounds: List<Int> = emptyList())

object DeviceWindowPolicy {
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
