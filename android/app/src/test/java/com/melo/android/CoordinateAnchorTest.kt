package com.melo.android

import com.melo.android.device.CoordinateAnchor
import org.junit.Test
import org.junit.Assert.*

class CoordinateAnchorTest {
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
