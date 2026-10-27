package com.melo.android

import com.melo.android.device.CoordinateAnchor
import org.junit.Test
import org.junit.Assert.*

class CoordinateAnchorTest {
    private fun dimCross() = IntArray(1024) { index ->
        val x = index % 32; val y = index / 32
        val distance = minOf(kotlin.math.abs(x-y), kotlin.math.abs(x+y-31))
        val shade = when (distance) { 0 -> 254; 1 -> 246; 2 -> 235; 3 -> 224; else -> 215 }
        (0xff shl 24) or (shade shl 16) or (shade shl 8) or shade
    }
    @Test fun antiAliasedLowContrastCloseControlsRemainUsableButNotReplaceable() {
        val before = dimCross()
        assertTrue(CoordinateAnchor.matches(before, before.copyOf()))
        assertFalse(CoordinateAnchor.matches(before, IntArray(1024) { 0xffd7d7d7.toInt() }))
        assertFalse(CoordinateAnchor.matches(before, IntArray(1024) { before[(it + 5) % 1024] }))
        val gradient = IntArray(1024) { val s = 215 + (it % 32); (0xff shl 24) or (s shl 16) or (s shl 8) or s }
        assertFalse(CoordinateAnchor.matches(gradient, gradient.copyOf()))
    }
    private fun cross() = IntArray(32 * 32) { index -> val x=index%32;val y=index/32; if (x == y || x + y == 31) 0xffffffff.toInt() else 0xff101010.toInt() }
    @Test fun jpegNoiseDoesNotInvalidateTheSameVisibleControl() {
        val original = cross(); val compressed = original.map { if (it == 0xffffffff.toInt()) 0xfffdfdfd.toInt() else 0xff121212.toInt() }.toIntArray()
        assertTrue(CoordinateAnchor.matches(original, compressed))
    }
    @Test fun replacementMovementAndFeaturelessTargetsNeverMatch() {
        assertFalse(CoordinateAnchor.matches(cross(), IntArray(1024) { 0xffff0000.toInt() }))
        assertFalse(CoordinateAnchor.matches(cross(), IntArray(1024) { cross()[(it+5)%1024] }))
        assertFalse(CoordinateAnchor.matches(IntArray(1024), IntArray(1024)))
    }
}
