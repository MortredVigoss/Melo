package com.melo.android.device

import kotlin.math.abs

/** Local pixel evidence only; no coordinates are approved from a featureless patch. */
object CoordinateAnchor {
    const val SIDE = 32
    fun matches(before: IntArray, after: IntArray): Boolean {
        if (before.size != SIDE * SIDE || after.size != before.size) return false
        fun light(color: Int) = ((color shr 16 and 255) * 3 + (color shr 8 and 255) * 6 + (color and 255)) / 10
        val lights = before.map(::light)
        val contrast = lights.maxOrNull()!! - lights.minOrNull()!!
        if (contrast < 16) return false
        // Antialiasing spreads a dim control's edge over several samples. Use
        // relative gradients while still rejecting flat/featureless patches.
        val edgeThreshold = maxOf(6, contrast / 5)
        val edges = lights.indices.count { it % SIDE != 0 && abs(lights[it] - lights[it - 1]) > edgeThreshold }
        if (edges < 6) return false
        var sum = 0L; var changed = 0
        for (i in before.indices) {
            val differences = intArrayOf(16, 8, 0).map { shift -> abs((before[i] shr shift and 255) - (after[i] shr shift and 255)) }
            sum += differences.sum()
            if (differences.maxOrNull()!! > 20) changed++
        }
        return sum <= before.size * 3L * 4 && changed <= before.size / 100
    }
}
